/**
 * The schema's promises, pinned on its text: the six tables are private, final rows are immutable
 * outside the RPC, identical rewrites are no-ops, record rows are never
 * deleted or truncated and the revisions log is append-only, only a withdrawal
 * publishes a null, a withdrawal lasts until a correction (no job can lift its
 * gap) and clears the row's source host and as_of, a revision changes the value
 * or does nothing, a published value always names its source host and as_of
 * (in the RPC and as a table check), the two
 * refusals a job meets in normal operation carry their own SQLSTATE, the check
 * lists match contract.ts, and the RPC is not callable by anon.
 *
 * The live behaviour is checked by sql/check-schema.sql, a single DO block
 * that always rolls back; src/adapters/__tests__/postgres-schema.test.ts runs
 * it against an in-process Postgres. The last test here pins that it walks
 * every path above.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURSOR_RENDER,
  GAP_STATUSES,
  METHOD_ROUND_TOTALS,
  METHOD_SCAN,
  REASON_CODES,
  RECORD_SQLSTATE,
  REVISE_RPC,
  REVISION_KINDS,
  SERIES_NAMES,
  VALUE_STATUSES,
} from "../contract";

/** As written (SQLSTATE codes must stay upper case), with LF line ends whatever the checkout did. */
const RAW = readFileSync(
  join(process.cwd(), "sql", "schema.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");
const SQL = RAW.toLowerCase();

const CHECK = readFileSync(
  join(process.cwd(), "sql", "check-schema.sql"),
  "utf-8",
).replace(/\r\n/g, "\n");

/** The body of a function, from its signature to the closing $$, as written. */
function fnBody(name: string): string {
  const start = RAW.indexOf(`create or replace function public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return RAW.slice(start, RAW.indexOf("\n$$;", start));
}

function quoted(list: string): string[] {
  return (list.match(/'[^']*'/g) ?? []).map((q) => q.slice(1, -1)).sort();
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** The quoted values of `check (<column> in (...))` inside one create table. */
function checkList(table: string, column: string): string[] {
  const start = SQL.indexOf(`create table if not exists public.${table} (`);
  expect(start, table).toBeGreaterThan(-1);
  const body = SQL.slice(start, SQL.indexOf("\n);", start));
  const m = new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`).exec(body);
  if (!m) throw new Error(`no check list for ${table}.${column}`);
  return quoted(m[1]);
}

/** The body of revise_network_record, from its signature to the closing $$. */
function rpcBody(): string {
  const start = SQL.indexOf("create or replace function public.revise_network_record(");
  expect(start).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf("\n$$;", start));
}

const TABLES = [
  "network_record_rounds",
  "network_record_snapshots",
  "scan_record_cursor",
  "network_record_values",
  "network_record_revisions",
  "network_record_gaps",
];

describe("00310_network_record.sql", () => {
  it.each(TABLES)("%s is created, RLS on, anon and authenticated revoked", (t) => {
    expect(SQL).toContain(`create table if not exists public.${t} (`);
    expect(SQL).toContain(`alter table public.${t} enable row level security;`);
    expect(SQL).toContain(`revoke all on public.${t} from anon, authenticated;`);
  });

  it("creates no policy, so the rendered files are the only public read path", () => {
    expect(SQL).not.toContain("create policy");
  });

  it("guards final rows with a trigger that skips identical rewrites", () => {
    expect(SQL).toContain("before update on public.network_record_values");
    expect(SQL).toContain("new.value is not distinct from old.value");
    expect(SQL).toContain("return null;");
    expect(SQL).toContain("current_setting('cctools.record_revise', true)");
  });

  it("never lets a record row be deleted or truncated, and keeps the revisions log append-only", () => {
    const noDelete = "execute function public.network_record_no_delete\\(\\);";
    for (const t of ["network_record_values", "network_record_gaps"]) {
      expect(SQL).toMatch(new RegExp(`before delete on public\\.${t}\\s+for each row ${noDelete}`));
    }
    expect(SQL).toMatch(
      new RegExp(`before update or delete on public\\.network_record_revisions\\s+for each row ${noDelete}`),
    );
    // Row-level delete triggers never fire on TRUNCATE.
    for (const t of ["network_record_values", "network_record_revisions", "network_record_gaps"]) {
      expect(SQL).toMatch(new RegExp(`before truncate on public\\.${t}\\s+for each statement ${noDelete}`));
    }
  });

  it("keeps revise_network_record away from anon", () => {
    expect(SQL).toContain(`create or replace function public.${REVISE_RPC}(`);
    expect(SQL).toContain("security definer");
    expect(SQL).toContain("set search_path = public");
    const sig = `public.${REVISE_RPC}(date, text, numeric, text, text, text, text, timestamptz)`;
    expect(SQL).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
    expect(SQL).toContain(`grant execute on function ${sig} to service_role;`);
    expect(SQL.match(/on function public\.revise_network_record\(/g)).toHaveLength(2);
  });

  it("indexes every non-key column the jobs filter on, and keeps resolved gaps as history", () => {
    expect(SQL).toContain("on public.network_record_rounds (start_issuing_at)");
    expect(SQL).toContain("on public.network_record_revisions (date)");
    expect(SQL).toContain("on public.network_record_gaps (date, series, reason_code) where resolved_at is null");
    expect(SQL).not.toContain("unique (date, series, reason_code)");
  });

  it("checks the same enums as contract.ts, so an added series cannot fail only at insert time", () => {
    const methods = sorted([METHOD_SCAN, METHOD_ROUND_TOTALS]);
    expect(checkList("network_record_values", "series")).toEqual(sorted(SERIES_NAMES));
    expect(checkList("network_record_revisions", "series")).toEqual(sorted(SERIES_NAMES));
    expect(checkList("network_record_gaps", "series")).toEqual(sorted([...SERIES_NAMES, "all"]));
    expect(checkList("network_record_values", "status")).toEqual(sorted(VALUE_STATUSES));
    expect(checkList("network_record_values", "method")).toEqual(methods);
    expect(checkList("network_record_rounds", "method")).toEqual(methods);
    for (const m of checkList("network_record_snapshots", "method")) expect(methods).toContain(m);
    expect(checkList("network_record_revisions", "kind")).toEqual(sorted(REVISION_KINDS));
    expect(checkList("network_record_gaps", "reason_code")).toEqual(sorted(REASON_CODES));
    expect(checkList("network_record_gaps", "status")).toEqual(sorted(GAP_STATUSES));
    const rpcKinds = /if p_kind not in \(([^)]*)\)/.exec(rpcBody());
    expect(rpcKinds).not.toBeNull();
    expect(quoted(rpcKinds?.[1] ?? "")).toEqual(sorted(REVISION_KINDS));
  });

  it("rounds p_value to the column's 10 places before any comparison, so a revision never logs old = new", () => {
    const rpc = rpcBody();
    const at = rpc.indexOf("p_value := round(p_value, 10);");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(rpc.indexOf("if p_kind = 'withdrawal' and p_value is not null"));
    expect(at).toBeLessThan(rpc.indexOf("v_old.value is not distinct from p_value"));

    // The no-op test is the value alone: a revision whose value is unchanged
    // (a correction, backfill or method revision that only names another host
    // or as_of) logs nothing, bumps nothing and keeps the stored provenance.
    expect(rpc).toMatch(/v_unchanged := v_old\.value is not distinct from p_value;/);
    const noop = rpc.search(
      /if v_unchanged and \(p_kind <> 'withdrawal' or exists \([^;]*\)\) then\s+return v_old\.revision;\s+end if;/,
    );
    expect(noop).toBeGreaterThan(-1);
    // Everything that logs or writes a value comes after it, and the log and
    // the write sit in one block that only a changed value enters.
    expect(noop).toBeLessThan(rpc.indexOf("perform set_config('cctools.record_revise', 'on', true);"));
    const block = /if not v_unchanged then\s+(insert into public\.network_record_revisions[\s\S]*?returning revision into v_rev;)\s+end if;/.exec(rpc);
    expect(block).not.toBeNull();
    expect(rpc.match(/insert into public\.network_record_revisions/g)).toHaveLength(1);
    expect(rpc.match(/update public\.network_record_values/g)).toHaveLength(1);
    expect(block?.[1]).toContain("update public.network_record_values");
  });

  it("keeps a withdrawal: only a correction brings a value back, and that correction resolves the gap", () => {
    const rpc = rpcBody();
    const guard = rpc.search(
      /if p_kind <> 'correction' and p_value is not null and exists \(\s*select 1 from public\.network_record_gaps\s+where date = p_date and series = p_series\s+and reason_code = 'withdrawn' and resolved_at is null\s*\) then\s+raise exception/,
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(rpc.indexOf("insert into public.network_record_revisions"));
    expect(rpc).toMatch(
      /if p_kind = 'correction' and p_value is not null then\s+update public\.network_record_gaps\s+set status = 'resolved', resolved_at = now\(\)\s+where date = p_date and series = p_series\s+and reason_code = 'withdrawn' and resolved_at is null;/,
    );
  });

  it("lets only a withdrawal set a value to null, checked before anything is decided or logged", () => {
    const rpc = rpcBody();
    const at = rpc.search(
      /if p_value is null and p_kind <> 'withdrawal' then\s+raise exception 'only a withdrawal sets a value to null';/,
    );
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(rpc.indexOf("v_unchanged :="));
    expect(at).toBeLessThan(rpc.indexOf("insert into public.network_record_revisions"));
  });

  it("records the withdrawn gap even when the value was already null, without logging old = new", () => {
    const rpc = rpcBody();
    expect(rpc).toMatch(
      /if v_unchanged and \(p_kind <> 'withdrawal' or exists \(\s*select 1 from public\.network_record_gaps\s+where date = p_date and series = p_series\s+and reason_code = 'withdrawn' and resolved_at is null\s*\)\) then\s+return v_old\.revision;/,
    );
    expect(rpc).toMatch(/if not v_unchanged then\s+insert into public\.network_record_revisions/);
    const blockEnd = rpc.indexOf("end if;", rpc.indexOf("returning revision into v_rev;"));
    const gapInsert = rpc.indexOf("insert into public.network_record_gaps");
    expect(blockEnd).toBeGreaterThan(-1);
    expect(gapInsert).toBeGreaterThan(blockEnd);
    expect(rpc.indexOf("insert into public.scan_record_cursor")).toBeGreaterThan(gapInsert);
  });

  it("guards an open withdrawn gap, so no job can lift a withdrawal and let finalize republish it", () => {
    expect(SQL).toContain("before update on public.network_record_gaps");
    const start = SQL.indexOf("create or replace function public.network_record_gaps_guard()");
    expect(start).toBeGreaterThan(-1);
    const guard = SQL.slice(start, SQL.indexOf("\n$$;", start));
    expect(guard).toMatch(
      /if old\.reason_code = 'withdrawn' and old\.resolved_at is null\s+and coalesce\(current_setting\('cctools\.record_revise', true\), ''\) <> 'on' then\s+raise exception/,
    );
    expect(SQL).toContain("revoke all on function public.network_record_gaps_guard() from public, anon, authenticated;");
    const rpc = rpcBody();
    const on = rpc.indexOf("perform set_config('cctools.record_revise', 'on', true);");
    const off = rpc.indexOf("perform set_config('cctools.record_revise', 'off', true);");
    expect(on).toBeGreaterThan(-1);
    expect(on).toBeLessThan(rpc.indexOf("update public.network_record_values"));
    expect(off).toBeGreaterThan(rpc.indexOf("insert into public.network_record_gaps"));
    expect(off).toBeGreaterThan(rpc.indexOf("update public.network_record_gaps"));
    expect(off).toBeLessThan(rpc.indexOf("insert into public.scan_record_cursor"));
  });

  it("marks the record dirty after a revision, so a manual withdrawal reaches the files at the next render", () => {
    const rpc = rpcBody();
    const mark = rpc.indexOf("insert into public.scan_record_cursor as c (id, detail, updated_at)");
    expect(mark).toBeGreaterThan(rpc.indexOf("update public.network_record_values"));
    expect(mark).toBeGreaterThan(rpc.indexOf("return v_old.revision;"));
    const tail = rpc.slice(mark);
    expect(tail).toContain(`'${CURSOR_RENDER}'`);
    expect(tail).toContain(
      `jsonb_build_object('dirty_at', to_char(now() at time zone 'utc', 'yyyy-mm-dd"t"hh24:mi:ss.ms"z"'))`,
    );
    expect(tail).toMatch(/on conflict \(id\) do update\s+set detail = c\.detail \|\| excluded\.detail,\s+updated_at = excluded\.updated_at;/);
  });

  it("gives the two refusals a job meets in normal operation their own SQLSTATE, so a job skips them by code", () => {
    const { FINAL_CHANGED, WITHDRAWN } = RECORD_SQLSTATE;
    const using = (code: string) => `using errcode = '${code}';`;

    // The values guard: a withdrawn value is WITHDRAWN, any other final row FINAL_CHANGED.
    const guard = fnBody("network_record_values_guard");
    const withdrawnAt = guard.search(
      new RegExp(
        `if exists \\(\\s*select 1 from public\\.network_record_gaps\\s+where date = old\\.date and series = old\\.series\\s+and reason_code = 'withdrawn' and resolved_at is null\\s*\\) then\\s+raise exception '[^']*',\\s+old\\.date, old\\.series ${using(WITHDRAWN)}`,
      ),
    );
    expect(withdrawnAt).toBeGreaterThan(-1);
    expect(guard.indexOf(using(FINAL_CHANGED))).toBeGreaterThan(withdrawnAt);
    expect(guard).not.toContain("P0001");

    // The gaps guard and the RPC's refusal to lift a withdrawal: WITHDRAWN.
    const gaps = fnBody("network_record_gaps_guard");
    expect(gaps).toContain(using(WITHDRAWN));
    expect(gaps).not.toContain("P0001");
    expect(fnBody(REVISE_RPC)).toMatch(
      new RegExp(`was withdrawn; only a correction can restore it', p_date, p_series\\s+${using(WITHDRAWN)}`),
    );

    // Every other refusal stays P0001: it means a bug and fails the run.
    const codes = new Set([...RAW.matchAll(/errcode = '([^']*)'/g)].map((m) => m[1]));
    expect([...codes].sort()).toEqual([FINAL_CHANGED, "P0001", WITHDRAWN].sort());
  });

  it("carries provenance through the RPC: a published value always names its source host and as_of", () => {
    const rpc = rpcBody();
    expect(rpc).toMatch(
      /p_method\s+text default null,\s+p_source_host\s+text default null,\s+p_as_of\s+timestamptz default null\s*\)/,
    );
    expect(rpc).toContain("v_method := coalesce(p_method, v_old.method);");

    // A withdrawn row names no host and no as_of; any other kind keeps the
    // row's own unless it passes new ones.
    expect(rpc).toMatch(
      /if p_kind = 'withdrawal' then\s+v_source_host := null;\s+v_as_of := null;\s+else\s+v_source_host := coalesce\(p_source_host, v_old\.source_host\);\s+v_as_of := coalesce\(p_as_of, v_old\.as_of\);\s+end if;/,
    );

    // A gap's row and a withdrawn row have neither, so filling their null
    // without them is refused (a restoring correction included), before
    // anything is decided or logged.
    const need = rpc.search(/if p_value is not null and \(v_source_host is null or v_as_of is null\) then\s+raise exception/);
    expect(need).toBeGreaterThan(-1);
    expect(need).toBeGreaterThan(rpc.indexOf("v_as_of := null;"));
    expect(need).toBeLessThan(rpc.indexOf("v_unchanged :="));
    expect(need).toBeLessThan(rpc.indexOf("insert into public.network_record_revisions"));

    // The new provenance is written with the changed value.
    expect(rpc).toMatch(
      /update public\.network_record_values\s+set value = p_value,\s+method = v_method,\s+source_host = v_source_host,\s+as_of = v_as_of,\s+revision = revision \+ 1,/,
    );
    expect(rpc).toMatch(/values \(p_date, p_series, v_old\.value, p_value, p_kind, p_reason, v_method\);/);
  });

  it("never has a logged revision skipped by the guard as an identical rewrite", () => {
    // The guard skips only a rewrite whose value is unchanged (among its four
    // columns). The RPC logs and writes only when the value changes, so every
    // update it logged reaches the row.
    const guard = fnBody("network_record_values_guard");
    const skipped = [...guard.matchAll(/new\.(\w+) is not distinct from old\.\1/g)].map((m) => m[1]).sort();
    expect(skipped).toEqual(["as_of", "method", "source_host", "value"]);
    const rpc = rpcBody();
    const test = rpc.slice(rpc.indexOf("v_unchanged :="), rpc.indexOf(";", rpc.indexOf("v_unchanged :=")));
    const compared = [...test.matchAll(/v_old\.(\w+) (?:is not distinct from|=)/g)].map((m) => m[1]);
    expect(compared).toEqual(["value"]);
  });

  it("refuses at the table any value that does not name its source host and as_of", () => {
    const start = SQL.indexOf("create table if not exists public.network_record_values (");
    const body = SQL.slice(start, SQL.indexOf("\n);", start));
    expect(body).toMatch(
      /constraint network_record_values_provenance\s+check \(value is null or \(source_host is not null and as_of is not null\)\)/,
    );
  });

  it("has a live check that always rolls back and walks every path the schema promises", () => {
    const code = CHECK.replace(/--.*$/gm, "").trim();
    // One DO block whose last act is to raise, so nothing it wrote survives,
    // whatever the client does with transactions. Only read-only counts follow.
    expect(code.startsWith("do $check$")).toBe(true);
    const end = code.indexOf("end\n$check$;");
    expect(end).toBeGreaterThan(-1);
    const block = code.slice(0, end);
    expect(block.trimEnd().endsWith("raise exception 'RECORD CHECK (rolled back): %', v_verdict;")).toBe(true);
    expect(code.slice(end + "end\n$check$;".length).trim()).toMatch(/^select [^;]*;$/);
    expect(code).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);

    for (const path of [
      "identical rewrite of a final row is a silent no-op",
      "direct change of a final value is refused (FINAL_CHANGED)",
      "a final row is never deleted",
      "correction changes the value and logs it",
      "correction with an unchanged value is a no-op and keeps the provenance",
      "the revisions log is never updated",
      "no record table can be truncated",
      "a value without its source host and as_of is refused by the table check",
      "withdraw a non-null value, clearing its source host and as_of",
      "backfill after a withdrawal is refused (WITHDRAWN)",
      "direct update of a withdrawn value is refused (WITHDRAWN)",
      "direct update of a withdrawn gap is refused (WITHDRAWN)",
      "correct after a withdrawal without provenance is refused",
      "correct after a withdrawal resolves the withdrawn gap",
      "only a withdrawal sets a value to null",
      "withdraw an already-null value",
      "backfill of a gap's null without provenance is refused",
      "backfill of a gap's null publishes its source host and as_of",
      "rewriting the backfilled row as computed is a no-op",
      "the render cursor gets dirty_at in finalize's ISO format",
    ]) {
      expect(CHECK, path).toContain(`-- check: ${path}\n`);
    }
    for (const code of [...Object.values(RECORD_SQLSTATE), "23514"]) expect(CHECK).toContain(`'${code}'`);
    expect(CHECK).toContain("p_source_host =>");
    expect(CHECK).toContain("p_as_of =>");
  });
});

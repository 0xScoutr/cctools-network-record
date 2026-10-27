-- Live check of sql/schema.sql, run once right after the schema is applied.
--
-- The no-delete and no-truncate triggers mean a test row that survived could
-- never be removed without DDL, so this never relies on a client-side
-- BEGIN/ROLLBACK (a tool that autocommits each statement would keep the rows).
-- It is one DO block that ends by raising an error: Postgres rolls back all a
-- failed statement did, whatever the client does, and the verdict travels in
-- the error message. Test rows use 2000-01-01, a day no job ever writes.
--
-- Run the DO block, then the counts query after it as a separate call.
-- Expected: the DO block fails with
--   RECORD CHECK (rolled back): all checks ok
-- and the three counts are 0. Any other message is a finding: stop and report
-- it. The test suite runs it against an in-process Postgres
-- (src/adapters/__tests__/postgres-store.test.ts, "sql/schema.sql in
-- Postgres") and pins its text
-- (src/open-record/__tests__/migration-contract.test.ts).

do $check$
declare
  v_fail    text[] := '{}';
  v_rev     integer;
  v_revs    integer;
  v_count   integer;
  v_row     public.network_record_values%rowtype;
  v_dirty   text;
  v_verdict text;
begin
  -- Null when the statement was refused with the expected SQLSTATE, else what
  -- happened instead. A refused statement rolls back only itself.
  create function pg_temp.refused(p_sql text, p_code text) returns text
  language plpgsql as $f$
  begin
    execute p_sql;
    return 'not refused: ' || p_sql;
  exception when others then
    if sqlstate = p_code then
      return null;
    end if;
    return format('refused with %s instead of %s (%s): %s', sqlstate, p_code, sqlerrm, p_sql);
  end
  $f$;

  -- A final value with its provenance, and two final gaps (null value, no
  -- host, no as_of, an open gap row), as finalize leaves them.
  insert into public.network_record_values (date, series, value, status, source_host, method, as_of, finalized_at)
  values ('2000-01-01', 'rounds', 140, 'final', 'check.invalid', 'scan-1', '2000-01-02T00:00:00Z', now()),
         ('2000-01-01', 'app_rewards_cc', null, 'final', null, 'scan-1', null, now()),
         ('2000-01-01', 'featured_apps', null, 'final', null, 'scan-1', null, now());
  insert into public.network_record_gaps (date, series, reason_code, reason, status)
  values ('2000-01-01', 'app_rewards_cc', 'source_unavailable', 'check: the source was down', 'open'),
         ('2000-01-01', 'featured_apps', 'source_unavailable', 'check: the source was down', 'open');
  -- A render cursor that already carries a key, so the RPC's merge is checked.
  insert into public.scan_record_cursor as c (id, detail)
  values ('render', '{"check_keep": true}'::jsonb)
  on conflict (id) do update set detail = c.detail || excluded.detail;

  -- check: identical rewrite of a final row is a silent no-op
  update public.network_record_values set value = 140, retrieved_at = now()
   where date = '2000-01-01' and series = 'rounds';
  get diagnostics v_count = row_count;
  select * into v_row from public.network_record_values where date = '2000-01-01' and series = 'rounds';
  v_fail := v_fail || case when v_count = 0 and v_row.value = 140 and v_row.revision = 0 then null
                           else format('identical rewrite: %s rows, value %s, revision %s', v_count, v_row.value, v_row.revision) end;

  -- check: direct change of a final value is refused (FINAL_CHANGED)
  v_fail := v_fail || pg_temp.refused(
    $q$update public.network_record_values set value = 141 where date = '2000-01-01' and series = 'rounds'$q$, 'RN001');

  -- check: a final row is never deleted
  v_fail := v_fail || pg_temp.refused(
    $q$delete from public.network_record_values where date = '2000-01-01' and series = 'rounds'$q$, 'P0001');

  -- check: correction changes the value and logs it
  v_rev := public.revise_network_record('2000-01-01', 'rounds', 141, 'correction', 'check: correction');
  select * into v_row from public.network_record_values where date = '2000-01-01' and series = 'rounds';
  select count(*) into v_revs from public.network_record_revisions where date = '2000-01-01' and series = 'rounds';
  v_fail := v_fail || case when v_rev = 1 and v_row.value = 141 and v_row.revision = 1 and v_revs = 1 then null
                           else format('correction: revision %s, value %s, %s logged', v_rev, v_row.value, v_revs) end;

  -- check: correction with an unchanged value is a no-op and keeps the provenance
  v_rev := public.revise_network_record('2000-01-01', 'rounds', 141.00000000001, 'correction', 'check: same value',
                                        p_source_host => 'other.invalid', p_as_of => '2000-01-02T00:05:00Z');
  select * into v_row from public.network_record_values where date = '2000-01-01' and series = 'rounds';
  select count(*) into v_revs from public.network_record_revisions where date = '2000-01-01' and series = 'rounds';
  v_fail := v_fail || case when v_rev = 1 and v_row.revision = 1 and v_revs = 1 and v_row.value = 141
                                and v_row.source_host = 'check.invalid'
                                and v_row.as_of = '2000-01-02T00:00:00Z'::timestamptz then null
                           else format('unchanged-value correction: revision %s, %s logged, host %s, as_of %s',
                                       v_rev, v_revs, v_row.source_host, v_row.as_of) end;

  -- check: the revisions log is never updated
  v_fail := v_fail || pg_temp.refused(
    $q$update public.network_record_revisions set reason = 'rewritten' where date = '2000-01-01'$q$, 'P0001');

  -- check: no record table can be truncated
  v_fail := v_fail || pg_temp.refused($q$truncate public.network_record_values$q$, 'P0001');
  v_fail := v_fail || pg_temp.refused($q$truncate public.network_record_revisions$q$, 'P0001');
  v_fail := v_fail || pg_temp.refused($q$truncate public.network_record_gaps$q$, 'P0001');

  -- check: a value without its source host and as_of is refused by the table check
  v_fail := v_fail || pg_temp.refused(
    $q$insert into public.network_record_values (date, series, value, status, source_host, method, as_of)
       values ('2000-01-01', 'supply_cc', 1, 'provisional', null, 'scan-1', '2000-01-02T00:00:00Z')$q$, '23514');
  v_fail := v_fail || pg_temp.refused(
    $q$insert into public.network_record_values (date, series, value, status, source_host, method, as_of)
       values ('2000-01-01', 'supply_cc', 1, 'provisional', 'check.invalid', 'scan-1', null)$q$, '23514');

  -- check: withdraw a non-null value, clearing its source host and as_of
  v_rev := public.revise_network_record('2000-01-01', 'rounds', null, 'withdrawal', 'check: withdrawn');
  select * into v_row from public.network_record_values where date = '2000-01-01' and series = 'rounds';
  v_fail := v_fail || case when v_rev = 2 and v_row.value is null
                                and v_row.source_host is null and v_row.as_of is null and exists (
                                  select 1 from public.network_record_gaps
                                   where date = '2000-01-01' and series = 'rounds' and reason_code = 'withdrawn'
                                     and status = 'open' and resolved_at is null) then null
                           else format('withdrawal: revision %s, value %s, host %s, as_of %s, or no open withdrawn gap',
                                       v_rev, v_row.value, v_row.source_host, v_row.as_of) end;

  -- check: backfill after a withdrawal is refused (WITHDRAWN)
  v_fail := v_fail || pg_temp.refused(
    $q$select public.revise_network_record('2000-01-01', 'rounds', 141, 'backfill', 'check: late data',
         p_source_host => 'check.invalid', p_as_of => '2000-01-02T00:00:00Z')$q$, 'RN002');

  -- check: direct update of a withdrawn value is refused (WITHDRAWN)
  v_fail := v_fail || pg_temp.refused(
    $q$update public.network_record_values set value = 141 where date = '2000-01-01' and series = 'rounds'$q$, 'RN002');

  -- check: direct update of a withdrawn gap is refused (WITHDRAWN)
  v_fail := v_fail || pg_temp.refused(
    $q$update public.network_record_gaps set status = 'resolved', resolved_at = now()
        where date = '2000-01-01' and series = 'rounds' and reason_code = 'withdrawn'$q$, 'RN002');

  -- check: correct after a withdrawal without provenance is refused
  v_fail := v_fail || pg_temp.refused(
    $q$select public.revise_network_record('2000-01-01', 'rounds', 141, 'correction', 'check: restored')$q$, 'P0001');

  -- check: correct after a withdrawal resolves the withdrawn gap
  v_rev := public.revise_network_record('2000-01-01', 'rounds', 141, 'correction', 'check: restored',
                                        p_source_host => 'check.invalid', p_as_of => '2000-01-02T00:05:00Z');
  select * into v_row from public.network_record_values where date = '2000-01-01' and series = 'rounds';
  v_fail := v_fail || case when v_rev = 3 and v_row.value = 141 and v_row.source_host = 'check.invalid'
                                and v_row.as_of = '2000-01-02T00:05:00Z'::timestamptz
                                and not exists (
                                  select 1 from public.network_record_gaps
                                   where date = '2000-01-01' and series = 'rounds' and reason_code = 'withdrawn'
                                     and resolved_at is null)
                                and exists (
                                  select 1 from public.network_record_gaps
                                   where date = '2000-01-01' and series = 'rounds' and reason_code = 'withdrawn'
                                     and status = 'resolved' and resolved_at is not null) then null
                           else format('correction after withdrawal: revision %s, value %s, or the withdrawn gap is still open', v_rev, v_row.value) end;

  -- check: only a withdrawal sets a value to null
  v_fail := v_fail || pg_temp.refused(
    $q$select public.revise_network_record('2000-01-01', 'rounds', null, 'correction', 'check: null correction')$q$, 'P0001');

  -- check: withdraw an already-null value
  select count(*) into v_revs from public.network_record_revisions;
  v_rev := public.revise_network_record('2000-01-01', 'featured_apps', null, 'withdrawal', 'check: withdrawn null');
  v_rev := public.revise_network_record('2000-01-01', 'featured_apps', null, 'withdrawal', 'check: withdrawn null again');
  v_fail := v_fail || case when v_rev = 0
                                and (select count(*) from public.network_record_revisions) = v_revs
                                and (select count(*) from public.network_record_gaps
                                      where date = '2000-01-01' and series = 'featured_apps'
                                        and reason_code = 'withdrawn' and resolved_at is null) = 1 then null
                           else format('withdrawing a null: revision %s, or it logged old = new, or not exactly one open withdrawn gap', v_rev) end;

  -- check: backfill of a gap's null without provenance is refused
  v_fail := v_fail || pg_temp.refused(
    $q$select public.revise_network_record('2000-01-01', 'app_rewards_cc', 5, 'backfill', 'check: late data')$q$, 'P0001');

  -- check: backfill of a gap's null publishes its source host and as_of
  v_rev := public.revise_network_record('2000-01-01', 'app_rewards_cc', 5, 'backfill', 'check: late data',
                                        p_source_host => 'check.invalid', p_as_of => '2000-01-02T00:00:00Z');
  select * into v_row from public.network_record_values where date = '2000-01-01' and series = 'app_rewards_cc';
  v_fail := v_fail || case when v_rev = 1 and v_row.value = 5 and v_row.source_host = 'check.invalid'
                                and v_row.as_of = '2000-01-02T00:00:00Z'::timestamptz then null
                           else format('backfill of a null: revision %s, value %s, host %s, as_of %s',
                                       v_rev, v_row.value, v_row.source_host, v_row.as_of) end;

  -- check: rewriting the backfilled row as computed is a no-op
  update public.network_record_values
     set value = 5, source_host = 'check.invalid', as_of = '2000-01-02T00:00:00Z',
         retrieved_at = now(), finalized_at = now()
   where date = '2000-01-01' and series = 'app_rewards_cc';
  get diagnostics v_count = row_count;
  select * into v_row from public.network_record_values where date = '2000-01-01' and series = 'app_rewards_cc';
  v_fail := v_fail || case when v_count = 0 and v_row.revision = 1 then null
                           else format('rewrite after backfill: %s rows, revision %s', v_count, v_row.revision) end;

  -- check: the render cursor gets dirty_at in finalize's ISO format
  select detail->>'dirty_at' into v_dirty from public.scan_record_cursor where id = 'render';
  v_fail := v_fail || case when v_dirty ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
                                and v_dirty::timestamptz = date_trunc('milliseconds', now())
                                and (select detail->>'check_keep' from public.scan_record_cursor where id = 'render') = 'true'
                                then null
                           else format('dirty mark: %s, or the merge dropped an existing key', coalesce(v_dirty, 'missing')) end;

  v_fail := array_remove(v_fail, null);
  v_verdict := case when cardinality(v_fail) = 0 then 'all checks ok'
                    else 'FAILED: ' || array_to_string(v_fail, '; ') end;
  raise exception 'RECORD CHECK (rolled back): %', v_verdict;
end
$check$;

select (select count(*) from public.network_record_values where date = '2000-01-01') as values_left,
       (select count(*) from public.network_record_revisions where date = '2000-01-01') as revisions_left,
       (select count(*) from public.network_record_gaps where date = '2000-01-01') as gaps_left;

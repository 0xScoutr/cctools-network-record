-- The open daily record of the Canton Network: the record's tables, their
-- guards and the one door for changing a final value.
--
-- Six tables, three trigger functions, one RPC. Written for Supabase
-- (Postgres with the roles anon, authenticated and service_role); on plain
-- Postgres, run sql/plain-postgres-roles.sql first so those roles exist.
--
-- No public read path here: RLS on with no policies and anon/authenticated
-- revoked, so the files rendered behind /api/open/network-record/v1/ are the
-- only public view.

-- 1. One row per mining round: raw inputs, so every day stays recomputable.
--    Amounts are unconstrained numeric (a coupon total times a 10-place rate
--    has 20 places); the published daily values are rounded to 10.
create table if not exists public.network_record_rounds (
  round                      bigint primary key,
  opens_at                   timestamptz,
  start_issuing_at           timestamptz,
  closed_at                  timestamptz,
  tick_duration_us           bigint,
  issuance_config            jsonb,
  amulet_price               numeric,
  app_rewards_cc             numeric,
  validator_rewards_cc       numeric,
  sv_rewards_cc              numeric,
  dev_fund_cc                numeric,
  faucet_rewards_cc          numeric,
  unfeatured_app_rewards_cc  numeric,
  unclaimed_rewards_cc       numeric,
  split                      jsonb,
  issuing_contract_id        text,
  update_id                  text,
  migration_id               integer,
  source_host                text not null,
  method                     text not null check (method in ('scan-1', 'scan-rt-1')),
  repaired                   boolean not null default false,
  retrieved_at               timestamptz not null default now()
);
create index if not exists network_record_rounds_start_idx
  on public.network_record_rounds (start_issuing_at);

-- 2. One row per day: the ACS snapshot at D+1 00:00:00Z, as read.
create table if not exists public.network_record_snapshots (
  date                 date primary key,
  record_time          timestamptz not null,
  migration_id         integer not null,
  source_host          text not null,
  method               text not null default 'scan-1' check (method in ('scan-1')),
  last_round           bigint,
  reference_round      bigint,
  reference_price_usd  numeric,
  super_validators     integer,
  sv_voting_threshold  integer,
  featured_apps        integer,
  validator_licenses   integer,
  retrieved_at         timestamptz not null default now()
);

-- 3. Collector state, so a restart resumes instead of skipping.
create table if not exists public.scan_record_cursor (
  id            text primary key,
  last_round    bigint,
  last_date     date,
  last_poll_at  timestamptz,
  detail        jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

-- 4. The published values, long format: one row per (date, series).
create table if not exists public.network_record_values (
  date          date not null,
  series        text not null check (series in (
                  'first_round', 'last_round', 'rounds', 'supply_cc', 'net_supply_change_cc',
                  'reference_price_usd', 'issuance_cc', 'app_rewards_cc', 'validator_rewards_cc',
                  'sv_rewards_cc', 'dev_fund_cc', 'faucet_rewards_cc', 'unfeatured_app_rewards_cc',
                  'unclaimed_rewards_cc', 'super_validators', 'sv_voting_threshold',
                  'featured_apps', 'validator_licenses', 'app_reward_coupons',
                  'validator_reward_coupons')),
  value         numeric(38,10),
  status        text not null check (status in ('provisional', 'final')),
  source_host   text,
  method        text not null check (method in ('scan-1', 'scan-rt-1')),
  as_of         timestamptz,
  retrieved_at  timestamptz not null default now(),
  finalized_at  timestamptz,
  revision      integer not null default 0,
  revised_at    timestamptz,
  primary key (date, series),
  -- A value, provisional or final, names the host it came from and the
  -- instant it is as of (LICENSE_SCOPE). A null (a gap's row, a
  -- withdrawn row) may name neither.
  constraint network_record_values_provenance
    check (value is null or (source_host is not null and as_of is not null))
);

-- 5. Every change to a final value.
create table if not exists public.network_record_revisions (
  id          bigint generated always as identity primary key,
  date        date not null,
  series      text not null check (series in (
                'first_round', 'last_round', 'rounds', 'supply_cc', 'net_supply_change_cc',
                'reference_price_usd', 'issuance_cc', 'app_rewards_cc', 'validator_rewards_cc',
                'sv_rewards_cc', 'dev_fund_cc', 'faucet_rewards_cc', 'unfeatured_app_rewards_cc',
                'unclaimed_rewards_cc', 'super_validators', 'sv_voting_threshold',
                'featured_apps', 'validator_licenses', 'app_reward_coupons',
                'validator_reward_coupons')),
  old_value   numeric(38,10),
  new_value   numeric(38,10),
  kind        text not null check (kind in ('backfill', 'correction', 'withdrawal', 'method')),
  reason      text not null,
  method      text not null,
  revised_at  timestamptz not null default now()
);
create index if not exists network_record_revisions_date_idx
  on public.network_record_revisions (date);

-- 6. Why a value is missing. Resolved rows stay, with resolved_at.
create table if not exists public.network_record_gaps (
  id            bigint generated always as identity primary key,
  date          date not null,
  -- A series of the contract, or all for a gap that covers the whole day.
  series        text not null check (series in (
                  'first_round', 'last_round', 'rounds', 'supply_cc', 'net_supply_change_cc',
                  'reference_price_usd', 'issuance_cc', 'app_rewards_cc', 'validator_rewards_cc',
                  'sv_rewards_cc', 'dev_fund_cc', 'faucet_rewards_cc', 'unfeatured_app_rewards_cc',
                  'unclaimed_rewards_cc', 'super_validators', 'sv_voting_threshold',
                  'featured_apps', 'validator_licenses', 'app_reward_coupons',
                  'validator_reward_coupons', 'all')),
  reason_code   text not null check (reason_code in (
                  'not_collected', 'source_unavailable', 'source_not_available_before',
                  'pending_past_deadline', 'withdrawn', 'not_derivable', 'sources_disagree',
                  'sanity_gate_failed', 'round_missed')),
  reason        text not null,
  status        text not null check (status in ('open', 'backfill_planned', 'permanent', 'resolved')),
  detected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  evidence_url  text
);
-- One open gap per (date, series, reason_code). Resolved rows keep their
-- resolved_at; a gap that recurs later is a new row.
create unique index if not exists network_record_gaps_open_uniq
  on public.network_record_gaps (date, series, reason_code) where resolved_at is null;

alter table public.network_record_rounds enable row level security;
alter table public.network_record_snapshots enable row level security;
alter table public.scan_record_cursor enable row level security;
alter table public.network_record_values enable row level security;
alter table public.network_record_revisions enable row level security;
alter table public.network_record_gaps enable row level security;

revoke all on public.network_record_rounds from anon, authenticated;
revoke all on public.network_record_snapshots from anon, authenticated;
revoke all on public.scan_record_cursor from anon, authenticated;
revoke all on public.network_record_values from anon, authenticated;
revoke all on public.network_record_revisions from anon, authenticated;
revoke all on public.network_record_gaps from anon, authenticated;

-- A final value changes only through revise_network_record(), which logs it.
-- An identical rewrite of a final row (a repair run writing the same value)
-- is skipped: nothing changes and nothing is logged.
--
-- The two refusals that normal operation meets carry their own SQLSTATE, so a
-- job can skip them by code (contract.ts RECORD_SQLSTATE) and still fail on
-- anything else: RN002 for a withdrawn value, which finalize meets every hour
-- for a week after a withdrawal, and RN001 for any other final row.
create or replace function public.network_record_values_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'final' then
    if new.status = 'final'
       and new.value is not distinct from old.value
       and new.method is not distinct from old.method
       and new.source_host is not distinct from old.source_host
       and new.as_of is not distinct from old.as_of then
      return null;
    end if;
    if coalesce(current_setting('cctools.record_revise', true), '') <> 'on' then
      if exists (
           select 1 from public.network_record_gaps
            where date = old.date and series = old.series
              and reason_code = 'withdrawn' and resolved_at is null
         ) then
        raise exception 'network_record_values % % was withdrawn; only a correction through revise_network_record() restores it',
          old.date, old.series using errcode = 'RN002';
      end if;
      raise exception 'network_record_values % % is final; change it through revise_network_record()',
        old.date, old.series using errcode = 'RN001';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists network_record_values_guard on public.network_record_values;
create trigger network_record_values_guard
  before update on public.network_record_values
  for each row execute function public.network_record_values_guard();

-- Record rows are never deleted, the revisions log is never rewritten, and
-- no record table is truncated (row-level triggers never see a TRUNCATE).
create or replace function public.network_record_no_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception '% on % is refused: record rows are never deleted or rewritten; resolve or revise instead',
    tg_op, tg_table_name using errcode = 'P0001';
end;
$$;

drop trigger if exists network_record_values_no_delete on public.network_record_values;
create trigger network_record_values_no_delete
  before delete on public.network_record_values
  for each row execute function public.network_record_no_delete();
drop trigger if exists network_record_revisions_append_only on public.network_record_revisions;
create trigger network_record_revisions_append_only
  before update or delete on public.network_record_revisions
  for each row execute function public.network_record_no_delete();
drop trigger if exists network_record_gaps_no_delete on public.network_record_gaps;
create trigger network_record_gaps_no_delete
  before delete on public.network_record_gaps
  for each row execute function public.network_record_no_delete();

drop trigger if exists network_record_values_no_truncate on public.network_record_values;
create trigger network_record_values_no_truncate
  before truncate on public.network_record_values
  for each statement execute function public.network_record_no_delete();
drop trigger if exists network_record_revisions_no_truncate on public.network_record_revisions;
create trigger network_record_revisions_no_truncate
  before truncate on public.network_record_revisions
  for each statement execute function public.network_record_no_delete();
drop trigger if exists network_record_gaps_no_truncate on public.network_record_gaps;
create trigger network_record_gaps_no_truncate
  before truncate on public.network_record_gaps
  for each statement execute function public.network_record_no_delete();

-- A withdrawal lasts until a human correction. The jobs resolve and rewrite
-- gaps directly, so an open 'withdrawn' gap is guarded here as well: only
-- revise_network_record() may change it. Otherwise a job resolving "every
-- other reason" of a series would lift the withdrawal, and the next finalize
-- would publish the withdrawn number again as late data. RN002, like a
-- withdrawn value: finalize leaves withdrawn series out of its gap resolution.
create or replace function public.network_record_gaps_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.reason_code = 'withdrawn' and old.resolved_at is null
     and coalesce(current_setting('cctools.record_revise', true), '') <> 'on' then
    raise exception 'network_record_gaps % % was withdrawn; only a correction through revise_network_record() lifts it',
      old.date, old.series using errcode = 'RN002';
  end if;
  return new;
end;
$$;

drop trigger if exists network_record_gaps_guard on public.network_record_gaps;
create trigger network_record_gaps_guard
  before update on public.network_record_gaps
  for each row execute function public.network_record_gaps_guard();

-- The one door for changing a final value. p_method, p_source_host and
-- p_as_of default to null, which keeps the row's own; a withdrawal clears
-- the source host and as_of instead. A revision changes the value or does
-- nothing: new provenance is written only with a new value.
create or replace function public.revise_network_record(
  p_date         date,
  p_series       text,
  p_value        numeric,
  p_kind         text,
  p_reason       text,
  p_method       text default null,
  p_source_host  text default null,
  p_as_of        timestamptz default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old public.network_record_values%rowtype;
  v_rev integer;
  v_method text;
  v_source_host text;
  v_as_of timestamptz;
  v_unchanged boolean;
begin
  -- The column keeps 10 places. Rounding first means a value that only
  -- differs past the 10th place is a no-op, not a revision with old = new.
  p_value := round(p_value, 10);

  if p_kind not in ('backfill', 'correction', 'withdrawal', 'method') then
    raise exception 'unknown revision kind %', p_kind;
  end if;
  if coalesce(length(trim(p_reason)), 0) = 0 then
    raise exception 'a revision needs a reason';
  end if;

  select * into v_old from public.network_record_values
   where date = p_date and series = p_series
   for update;
  if not found then
    raise exception 'no value for % %', p_date, p_series;
  end if;
  if v_old.status <> 'final' then
    raise exception '% % is provisional; write it directly', p_date, p_series;
  end if;
  if p_kind = 'withdrawal' and p_value is not null then
    raise exception 'a withdrawal sets the value to null';
  end if;
  -- Only a withdrawal records why a value is missing (its 'withdrawn' gap).
  -- A null from any other kind would publish a null with no reason, and the
  -- next finalize would fill it back in as late data.
  if p_value is null and p_kind <> 'withdrawal' then
    raise exception 'only a withdrawal sets a value to null';
  end if;
  if p_kind = 'backfill' and v_old.value is not null then
    raise exception 'a backfill fills a null';
  end if;
  -- A withdrawal lasts. Finalize recomputes the last 7 days every hour from
  -- the same raw rows, so it would otherwise put the withdrawn number back as
  -- a backfill. Only a human correction may restore a value. RN002, so
  -- finalize can skip it by code.
  if p_kind <> 'correction' and p_value is not null and exists (
       select 1 from public.network_record_gaps
        where date = p_date and series = p_series
          and reason_code = 'withdrawn' and resolved_at is null
     ) then
    raise exception '% % was withdrawn; only a correction can restore it', p_date, p_series
      using errcode = 'RN002';
  end if;

  -- A published value names the host it came from and the instant it is as
  -- of (LICENSE_SCOPE). A withdrawn row names neither, like a
  -- gap's row, so filling either null (a restoring correction included) must
  -- pass both.
  v_method := coalesce(p_method, v_old.method);
  if p_kind = 'withdrawal' then
    v_source_host := null;
    v_as_of := null;
  else
    v_source_host := coalesce(p_source_host, v_old.source_host);
    v_as_of := coalesce(p_as_of, v_old.as_of);
  end if;
  if p_value is not null and (v_source_host is null or v_as_of is null) then
    raise exception '% % would publish a value without its source host and as_of; pass p_source_host and p_as_of',
      p_date, p_series;
  end if;
  -- The value alone decides: a revision that would log old = new (a
  -- correction, backfill or method revision naming only another host, as_of
  -- or method) is a no-op, and the stored provenance stays as first recorded.
  -- A logged update always changes the value, so the values guard never skips
  -- it as an identical rewrite.
  v_unchanged := v_old.value is not distinct from p_value;
  -- Nothing to change is a no-op, except withdrawing a value that is already
  -- null: nothing is logged (old = new), but the 'withdrawn' gap must still be
  -- recorded once, or a later backfill could publish the number.
  if v_unchanged and (p_kind <> 'withdrawal' or exists (
       select 1 from public.network_record_gaps
        where date = p_date and series = p_series
          and reason_code = 'withdrawn' and resolved_at is null
     )) then
    return v_old.revision;
  end if;

  -- On for the rest of the change: the values guard and the gaps guard both
  -- let this function through, and nothing else.
  perform set_config('cctools.record_revise', 'on', true);
  v_rev := v_old.revision;
  if not v_unchanged then
    insert into public.network_record_revisions (date, series, old_value, new_value, kind, reason, method)
    values (p_date, p_series, v_old.value, p_value, p_kind, p_reason, v_method);

    update public.network_record_values
       set value = p_value,
           method = v_method,
           source_host = v_source_host,
           as_of = v_as_of,
           revision = revision + 1,
           revised_at = now(),
           retrieved_at = now()
     where date = p_date and series = p_series
    returning revision into v_rev;
  end if;

  if p_kind = 'withdrawal' then
    insert into public.network_record_gaps (date, series, reason_code, reason, status)
    values (p_date, p_series, 'withdrawn', p_reason, 'open')
    on conflict (date, series, reason_code) where resolved_at is null
      do update set reason = excluded.reason, status = 'open';
  end if;
  if p_kind = 'correction' and p_value is not null then
    update public.network_record_gaps
       set status = 'resolved', resolved_at = now()
     where date = p_date and series = p_series
       and reason_code = 'withdrawn' and resolved_at is null;
  end if;
  perform set_config('cctools.record_revise', 'off', true);

  -- Mark the record dirty (scan_record_cursor 'render', the same detail.dirty_at
  -- the finalize job writes), so a manual revision reaches the served files at
  -- the next render instead of the 24-hour re-render.
  insert into public.scan_record_cursor as c (id, detail, updated_at)
  values ('render',
          jsonb_build_object('dirty_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
          now())
  on conflict (id) do update
    set detail = c.detail || excluded.detail,
        updated_at = excluded.updated_at;

  return v_rev;
end;
$$;

revoke all on function public.revise_network_record(date, text, numeric, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.revise_network_record(date, text, numeric, text, text, text, text, timestamptz) to service_role;
revoke all on function public.network_record_values_guard() from public, anon, authenticated;
revoke all on function public.network_record_no_delete() from public, anon, authenticated;
revoke all on function public.network_record_gaps_guard() from public, anon, authenticated;

-- Registry supply readings for the Postgres reference adapter: one row per
-- totalSupplyAsOf instant of the Scan token registry's Canton Coin
-- totalSupply, written by the supply collector (src/scan-record/supply.ts,
-- runSupplyCollection with postgresSupplyWriter) and read by getSupplyAt
-- (src/adapters/postgres-store.ts), which finalize asks for the reading at
-- D+1 00:00:00Z. Not part of the record's guarded tables. The CCTools
-- deployment keeps the same readings in its own asset tables, which the
-- Supabase adapter reads instead.
create table if not exists public.network_record_supply (
  supply_as_of  timestamptz primary key,
  total_supply  numeric not null,
  source_host   text not null,
  retrieved_at  timestamptz not null default now()
);
alter table public.network_record_supply enable row level security;
revoke all on public.network_record_supply from anon, authenticated;

-- Registry supply readings for the Postgres reference adapter
-- (src/adapters/postgres-store.ts, getSupplyAt): one row per exact instant,
-- written by whatever reads the Scan token registry's totalSupply at
-- D+1 00:00:00Z. Not part of the record's guarded tables; the CCTools
-- deployment keeps these readings in its own asset tables instead.
create table if not exists public.network_record_supply (
  supply_as_of  timestamptz primary key,
  total_supply  numeric not null,
  source_host   text not null,
  retrieved_at  timestamptz not null default now()
);
alter table public.network_record_supply enable row level security;
revoke all on public.network_record_supply from anon, authenticated;

-- The three roles sql/schema.sql grants and revokes on, for a Postgres that
-- is not Supabase. Run once, before sql/schema.sql. They log in as nobody:
-- the jobs connect as the database owner, and the files are the public view.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$roles$;

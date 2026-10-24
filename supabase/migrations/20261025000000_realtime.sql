-- Publishes these tables to Supabase Realtime, which applies each subscriber's RLS.
-- Idempotent.

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'events', 'responses', 'proposals', 'votes', 'items'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

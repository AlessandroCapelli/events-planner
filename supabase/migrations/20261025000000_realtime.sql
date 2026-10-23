-- Aggiornamenti in tempo reale: Supabase Realtime inoltra ai client iscritti le modifiche
-- di queste tabelle, applicando la RLS di ciascun utente. Idempotente.

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

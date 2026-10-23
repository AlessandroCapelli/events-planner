-- Correzioni additive: non rieseguire o modificare le migration già applicate.
begin;

drop policy "items: create" on public.items;
create policy "items: create" on public.items
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.event_is_writable(event_id)
    and (claimed_by is null or claimed_by = auth.uid())
  );

-- La data proposta potrebbe essere scaduta dopo la sua creazione.
create or replace function public.adopt_proposal(pid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.proposals;
  current_start timestamptz;
begin
  select * into p from public.proposals where id = pid;
  if not found or not public.can_manage_event(p.event_id) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  select starts_at into current_start from public.events where id = p.event_id for update;
  if not found or not public.is_open(current_start) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if not public.is_open(coalesce(p.starts_at, current_start)) then
    raise exception 'event_in_past' using errcode = '22023';
  end if;

  update public.events
     set starts_at = coalesce(p.starts_at, starts_at),
         location = coalesce(p.location, location)
   where id = p.event_id;
  delete from public.responses where event_id = p.event_id;
  delete from public.proposals where id = pid;
end $$;

-- Auth e profilo (compreso il ruolo iniziale) nascono nella stessa transazione.
-- raw_app_meta_data è scrivibile solo dal backend amministrativo, non dall'utente.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, is_admin)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), left(split_part(new.email, '@', 1), 60)),
    coalesce(new.raw_app_meta_data -> 'initial_admin' = 'true'::jsonb, false)
  );
  return new;
end $$;

commit;

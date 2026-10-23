-- Invitati: un evento è per tutto il gruppo (predefinito) oppure solo per alcuni membri.
-- La visibilità è definita in un solo punto, event_visible_to(), usato da RLS, Realtime e calendario.
-- Creazione e modifica passano da save_event(), che salva evento e invitati in un'unica transazione.

alter table public.events add column invite_only boolean not null default false;

-- Realtime inoltra le cancellazioni a tutti gli iscritti senza RLS, con la sola chiave primaria.
-- Con chiavi (evento, utente) rivelerebbe chi era invitato o aveva risposto a un evento privato:
-- si usano chiavi surrogate casuali e l'unicità di (evento, utente) passa a un vincolo unique.
create table public.invitations (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events on delete cascade,
  user_id  uuid not null references public.profiles on delete cascade,
  unique (event_id, user_id)
);
create index on public.invitations (user_id);

alter table public.responses drop constraint responses_pkey;
alter table public.responses add column id uuid not null default gen_random_uuid() primary key;
alter table public.responses add unique (event_id, user_id);

alter table public.votes drop constraint votes_pkey;
alter table public.votes add column id uuid not null default gen_random_uuid() primary key;
alter table public.votes add unique (proposal_id, user_id);

-- Chi vede un evento: tutti se è per il gruppo; altrimenti creatore, invitati e admin.
-- Interna: accetta un utente qualsiasi, quindi non è eseguibile dal client (svelerebbe chi è invitato).
create function public.event_visible_to(eid uuid, uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.events e
    where e.id = eid
      and (
        not e.invite_only
        or e.created_by = uid
        or exists (select 1 from public.profiles p where p.id = uid and p.is_admin)
        or exists (select 1 from public.invitations i where i.event_id = e.id and i.user_id = uid)
      )
  )
$$;
revoke execute on function public.event_visible_to(uuid, uuid) from public, anon, authenticated;

create function public.can_see_event(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.event_visible_to(eid, auth.uid())
$$;
grant execute on function public.can_see_event(uuid) to authenticated;

-- Le scritture su risposte, proposte, voti e oggetti richiedono ora anche la visibilità.
-- Rinominare mantiene i riferimenti nelle policy esistenti.
alter function public.event_is_open(uuid) rename to event_is_writable;
alter function public.proposal_is_open(uuid) rename to proposal_is_writable;

create or replace function public.event_is_writable(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_see_event(eid)
     and exists (select 1 from public.events where id = eid and public.is_open(starts_at))
$$;

create or replace function public.proposal_is_writable(pid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.proposals where id = pid and public.event_is_writable(event_id))
$$;

-- events: si legge solo ciò che si vede; si scrive solo tramite save_event()
drop policy "events: read" on public.events;
create policy "events: read" on public.events
  for select to authenticated using (public.can_see_event(id));

drop policy "events: create" on public.events;
drop policy "events: update" on public.events;
revoke insert, update on public.events from authenticated;
revoke update (title, description, location, starts_at) on public.events from authenticated;

-- invitations: visibili insieme all'evento; si modificano solo tramite save_event()
alter table public.invitations enable row level security;
revoke all on public.invitations from anon, authenticated;
grant all on public.invitations to service_role;
grant select on public.invitations to authenticated;
create policy "invitations: read" on public.invitations
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = invitations.event_id));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'invitations'
  ) then
    alter publication supabase_realtime add table public.invitations;
  end if;
end $$;

-- Crea (p_id null) o modifica un evento con i suoi invitati.
create function public.save_event(
  p_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_location text,
  p_description text,
  p_invite_only boolean default false,
  p_invitees uuid[] default '{}'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  eid uuid := p_id;
  invitees uuid[] := coalesce(p_invitees, '{}');
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if eid is null then
    if p_starts_at <= now() then
      raise exception 'event_in_past' using errcode = '22023';
    end if;
    insert into public.events (title, starts_at, location, description, invite_only, created_by)
    values (p_title, p_starts_at, p_location, p_description, p_invite_only, auth.uid())
    returning id into eid;
  else
    if not public.can_manage_event(eid) or not public.event_is_writable(eid) then
      raise exception 'not_allowed' using errcode = '42501';
    end if;
    if not public.is_open(p_starts_at) then
      raise exception 'event_in_past' using errcode = '22023';
    end if;
    update public.events
       set title = p_title, starts_at = p_starts_at, location = p_location,
           description = p_description, invite_only = p_invite_only
     where id = eid;
  end if;

  delete from public.invitations
   where event_id = eid and (not p_invite_only or not (user_id = any (invitees)));

  if p_invite_only then
    insert into public.invitations (event_id, user_id)
    select eid, u from unnest(invitees) as u
    where u is distinct from (select created_by from public.events where id = eid)
    on conflict do nothing;

    -- Chi non vede più l'evento esce anche da risposte, voti e prenotazioni.
    delete from public.responses r
     where r.event_id = eid and not public.event_visible_to(eid, r.user_id);
    delete from public.votes v using public.proposals p
     where p.id = v.proposal_id and p.event_id = eid and not public.event_visible_to(eid, v.user_id);
    update public.items set claimed_by = null
     where event_id = eid and claimed_by is not null and not public.event_visible_to(eid, claimed_by);
  end if;

  return eid;
end $$;

revoke execute on function public.save_event(uuid, text, timestamptz, text, text, boolean, uuid[]) from public, anon;
grant execute on function public.save_event(uuid, text, timestamptz, text, text, boolean, uuid[]) to authenticated;

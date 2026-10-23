-- Aggiorna save_event sui database che hanno già applicato invitations.sql.
-- Conserva firma e permessi; consente eventi iniziati da meno di 12 ore.

create or replace function public.save_event(
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

  -- Un evento si crea o si modifica finché è "aperto" (iniziato da meno di 12 ore, come per l'archivio):
  -- così si può creare anche un evento che inizia adesso o è appena iniziato.
  if not public.is_open(p_starts_at) then
    raise exception 'event_in_past' using errcode = '22023';
  end if;

  if eid is null then
    insert into public.events (title, starts_at, location, description, invite_only, created_by)
    values (p_title, p_starts_at, p_location, p_description, p_invite_only, auth.uid())
    returning id into eid;
  else
    if not public.can_manage_event(eid) or not public.event_is_writable(eid) then
      raise exception 'not_allowed' using errcode = '42501';
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

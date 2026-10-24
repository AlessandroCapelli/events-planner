-- save_event() takes the membership lock too: an invitee removed from the group at the same time
-- can no longer keep an invitation. Signature and grants are unchanged.

create or replace function public.save_event(
  p_id uuid,
  p_group_id uuid,
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
  if not public.is_open(p_starts_at) then
    raise exception 'event_in_past' using errcode = '22023';
  end if;
  -- Same lock as membership changes, so invitees are checked against settled memberships.
  perform pg_advisory_xact_lock(20261030, 1);
  if not public.is_member(p_group_id) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  if eid is null then
    insert into public.events (group_id, title, starts_at, location, description, invite_only, created_by)
    values (p_group_id, p_title, p_starts_at, p_location, p_description, p_invite_only, auth.uid())
    returning id into eid;
  else
    if not public.can_manage_event(eid) or not public.event_is_writable(eid) then
      raise exception 'not_allowed' using errcode = '42501';
    end if;
    update public.events
       set group_id = p_group_id, title = p_title, starts_at = p_starts_at, location = p_location,
           description = p_description, invite_only = p_invite_only
     where id = eid;
  end if;

  delete from public.invitations i
   where i.event_id = eid
     and (not p_invite_only
          or not (i.user_id = any (invitees))
          or not exists (select 1 from public.memberships m where m.group_id = p_group_id and m.user_id = i.user_id));

  if p_invite_only then
    insert into public.invitations (event_id, user_id)
    select eid, u from unnest(invitees) as u
    where u is distinct from (select created_by from public.events where id = eid)
      and exists (select 1 from public.memberships m where m.group_id = p_group_id and m.user_id = u)
    on conflict do nothing;
  end if;

  -- Users who can no longer see the event lose their responses, votes and claims.
  delete from public.responses r
   where r.event_id = eid and not public.event_visible_to(eid, r.user_id);
  delete from public.votes v using public.proposals p
   where p.id = v.proposal_id and p.event_id = eid and not public.event_visible_to(eid, v.user_id);
  update public.items set claimed_by = null
   where event_id = eid and claimed_by is not null and not public.event_visible_to(eid, claimed_by);

  return eid;
end $$;

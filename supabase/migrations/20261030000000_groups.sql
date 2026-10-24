-- Groups: every user belongs to at least one group and every event to exactly one.
-- Events are visible only to the members of their group; invite-only events narrow that further to
-- the creator, the invitees and the group's admins. Profiles are visible to people who share a group
-- or an event. Groups and memberships are managed by admins through the functions below.

create table public.groups (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);
create unique index groups_name_key on public.groups (lower(name));

-- Random surrogate key, so Realtime DELETEs don't reveal who left which group.
create table public.memberships (
  id       uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups on delete cascade,
  user_id  uuid not null references public.profiles on delete cascade,
  unique (group_id, user_id)
);
create index on public.memberships (user_id);

insert into public.groups (name) values ('Default');
insert into public.memberships (group_id, user_id)
select g.id, p.id from public.groups g cross join public.profiles p;

alter table public.events add column group_id uuid references public.groups on delete cascade;
update public.events set group_id = (select id from public.groups);
alter table public.events alter column group_id set not null;
create index on public.events (group_id);

-- ── Visibility ─────────────────────────────────────────────────────────────

create function public.is_member(gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships where group_id = gid and user_id = auth.uid())
$$;

create or replace function public.event_visible_to(eid uuid, uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.events e
    join public.memberships m on m.group_id = e.group_id and m.user_id = uid
    where e.id = eid
      and (
        not e.invite_only
        or e.created_by = uid
        or exists (select 1 from public.profiles p where p.id = uid and p.is_admin)
        or exists (select 1 from public.invitations i where i.event_id = e.id and i.user_id = uid)
      )
  )
$$;

-- Admins manage only the events they can see.
create or replace function public.can_manage_event(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_see_event(eid)
     and (public.is_admin() or exists (select 1 from public.events where id = eid and created_by = auth.uid()))
$$;

-- People who share a group, plus anyone appearing in a visible event, so the archive keeps its names.
create function public.can_see_profile(pid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select pid = auth.uid()
      or public.is_admin()
      or exists (
        select 1 from public.memberships mine
        join public.memberships theirs on theirs.group_id = mine.group_id
        where mine.user_id = auth.uid() and theirs.user_id = pid
      )
      or exists (select 1 from public.events e where e.created_by = pid and public.can_see_event(e.id))
      or exists (select 1 from public.responses r where r.user_id = pid and public.can_see_event(r.event_id))
      or exists (select 1 from public.proposals p where p.created_by = pid and public.can_see_event(p.event_id))
      or exists (select 1 from public.items i where pid in (i.created_by, i.claimed_by) and public.can_see_event(i.event_id))
$$;

revoke execute on function public.is_member(uuid), public.can_see_profile(uuid) from public, anon;
grant execute on function public.is_member(uuid), public.can_see_profile(uuid) to authenticated;

-- ── Users ──────────────────────────────────────────────────────────────────

-- Adds the new user to the groups in raw_app_meta_data.initial_groups (set by the admin API), or to the
-- oldest group when none are given, e.g. for users created from the Supabase dashboard.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  group_ids uuid[] := array(
    select jsonb_array_elements_text(coalesce(new.raw_app_meta_data -> 'initial_groups', '[]'::jsonb))::uuid
  );
begin
  -- Serialize membership changes and group deletion, including dashboard user creation.
  perform pg_advisory_xact_lock(20261030, 1);
  insert into public.profiles (id, display_name, is_admin)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), left(split_part(new.email, '@', 1), 60)),
    coalesce(new.raw_app_meta_data -> 'initial_admin' = 'true'::jsonb, false)
  );
  if cardinality(group_ids) = 0 then
    group_ids := array(select id from public.groups order by created_at, id limit 1);
  end if;
  if cardinality(group_ids) = 0 then
    raise exception 'no_group' using errcode = '23514';
  end if;
  insert into public.memberships (group_id, user_id) select g, new.id from unnest(group_ids) as g;
  return new;
end $$;

-- ── Writes ─────────────────────────────────────────────────────────────────

drop function public.save_event(uuid, text, timestamptz, text, text, boolean, uuid[]);

-- Creates (p_id null) or updates an event together with its group and invitees.
create function public.save_event(
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

-- Creates (p_id null) or renames a group. Admins only.
create function public.save_group(p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  gid uuid := p_id;
begin
  if not public.is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if gid is null then
    insert into public.groups (name) values (btrim(p_name)) returning id into gid;
  else
    update public.groups set name = btrim(p_name) where id = gid;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  return gid;
end $$;

-- Deletes a group with all its events, unless one of its members would be left without a group.
create function public.delete_group(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(20261030, 1);
  if exists (
    select 1 from public.memberships m
    where m.group_id = p_id
      and not exists (select 1 from public.memberships o where o.user_id = m.user_id and o.group_id <> p_id)
  ) then
    raise exception 'last_group' using errcode = '23514';
  end if;
  delete from public.groups where id = p_id;
end $$;

-- Replaces the groups of a user (at least one). In open events the user can no longer see, their
-- responses, votes, claims and invitations are removed; past events keep them.
create function public.set_user_groups(p_user uuid, p_groups uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if cardinality(coalesce(p_groups, '{}')) = 0 then
    raise exception 'no_group' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(20261030, 1);
  delete from public.memberships where user_id = p_user and not (group_id = any (p_groups));
  insert into public.memberships (group_id, user_id)
  select g, p_user from unnest(p_groups) as g
  on conflict do nothing;

  delete from public.invitations i using public.events e
   where i.user_id = p_user and e.id = i.event_id and public.is_open(e.starts_at)
     and not exists (select 1 from public.memberships m where m.group_id = e.group_id and m.user_id = p_user);
  delete from public.responses r using public.events e
   where r.user_id = p_user and e.id = r.event_id and public.is_open(e.starts_at)
     and not public.event_visible_to(e.id, p_user);
  delete from public.votes v using public.proposals p, public.events e
   where v.user_id = p_user and p.id = v.proposal_id and e.id = p.event_id and public.is_open(e.starts_at)
     and not public.event_visible_to(e.id, p_user);
  update public.items i set claimed_by = null from public.events e
   where i.claimed_by = p_user and e.id = i.event_id and public.is_open(e.starts_at)
     and not public.event_visible_to(e.id, p_user);
end $$;

revoke execute on function
  public.save_event(uuid, uuid, text, timestamptz, text, text, boolean, uuid[]), public.save_group(uuid, text),
  public.delete_group(uuid), public.set_user_groups(uuid, uuid[])
  from public, anon;
grant execute on function
  public.save_event(uuid, uuid, text, timestamptz, text, text, boolean, uuid[]), public.save_group(uuid, text),
  public.delete_group(uuid), public.set_user_groups(uuid, uuid[])
  to authenticated;

-- ── Privileges and Row Level Security ──────────────────────────────────────

alter table public.groups      enable row level security;
alter table public.memberships enable row level security;
revoke all on public.groups, public.memberships from anon, authenticated;
grant all on public.groups, public.memberships to service_role;
grant select on public.groups, public.memberships to authenticated;

create policy "groups: read" on public.groups
  for select to authenticated using (public.is_admin() or public.is_member(id));
create policy "memberships: read" on public.memberships
  for select to authenticated using (public.is_admin() or public.is_member(group_id));

drop policy "profiles: read" on public.profiles;
create policy "profiles: read" on public.profiles
  for select to authenticated using (public.can_see_profile(id));

drop policy "events: delete" on public.events;
create policy "events: delete" on public.events
  for delete to authenticated
  using (public.can_see_event(id) and (public.is_admin() or (created_by = auth.uid() and public.is_open(starts_at))));

do $$
declare
  t text;
begin
  foreach t in array array['groups', 'memberships'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

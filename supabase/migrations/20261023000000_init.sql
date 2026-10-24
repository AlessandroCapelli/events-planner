-- Schema, Row Level Security and functions of Events Planner.
-- An event is "open" until 12 hours after it starts; after that it is read-only.

-- ── Tables ─────────────────────────────────────────────────────────────────

create table public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

create table public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 120),
  description text check (char_length(description) <= 2000),
  location    text check (char_length(location) <= 200),
  starts_at   timestamptz not null,
  created_by  uuid default auth.uid() references public.profiles on delete set null,
  created_at  timestamptz not null default now(),
  invite_only boolean not null default false
);
create index on public.events (starts_at);

-- Realtime sends DELETEs to every subscriber, unfiltered, with only the primary key.
-- An (event, user) key would leak who was invited to or answered a private event,
-- so these tables use random surrogate keys plus a unique (event, user) constraint.
create table public.invitations (
  id       uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events on delete cascade,
  user_id  uuid not null references public.profiles on delete cascade,
  unique (event_id, user_id)
);
create index on public.invitations (user_id);

create table public.responses (
  event_id uuid not null references public.events on delete cascade,
  user_id  uuid not null default auth.uid() references public.profiles on delete cascade,
  status   text not null check (status in ('yes', 'maybe', 'no')),
  guests   smallint not null default 0 check (guests between 0 and 20),
  id       uuid not null default gen_random_uuid() primary key,
  unique (event_id, user_id)
);

create table public.proposals (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events on delete cascade,
  starts_at  timestamptz,
  location   text check (char_length(location) <= 200),
  created_by uuid default auth.uid() references public.profiles on delete set null,
  created_at timestamptz not null default now(),
  check (starts_at is not null or location is not null)
);
create index on public.proposals (event_id);

create table public.votes (
  proposal_id uuid not null references public.proposals on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles on delete cascade,
  value       smallint not null check (value in (-1, 1)),
  id          uuid not null default gen_random_uuid() primary key,
  unique (proposal_id, user_id)
);

create table public.items (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events on delete cascade,
  label      text not null check (char_length(label) between 1 and 120),
  claimed_by uuid references public.profiles on delete set null,
  created_by uuid default auth.uid() references public.profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on public.items (event_id);

create table public.calendar_tokens (
  user_id    uuid primary key references public.profiles on delete cascade,
  token      text not null unique,
  created_at timestamptz not null default now()
);

-- ── Helpers ────────────────────────────────────────────────────────────────

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

create function public.is_open(ts timestamptz) returns boolean
language sql stable as $$
  select ts > now() - interval '12 hours'
$$;

create function public.can_manage_event(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_admin()
      or exists (select 1 from public.events where id = eid and created_by = auth.uid())
$$;

-- Everyone sees group events; invite-only events are visible to creator, invitees and admins.
-- Internal: it takes any user id, so clients cannot execute it.
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

-- Child rows can only be written while their event is visible and open.
create function public.event_is_writable(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.can_see_event(eid)
     and exists (select 1 from public.events where id = eid and public.is_open(starts_at))
$$;

create function public.proposal_is_writable(pid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.proposals where id = pid and public.event_is_writable(event_id))
$$;

grant execute on function
  public.is_admin(), public.is_open(timestamptz), public.can_manage_event(uuid), public.can_see_event(uuid),
  public.event_is_writable(uuid), public.proposal_is_writable(uuid)
  to authenticated;

-- Creates the profile with its initial admin role in the same transaction as the auth user.
-- raw_app_meta_data can only be written by the admin API, never by the user.
create function public.handle_new_user() returns trigger
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Writes ─────────────────────────────────────────────────────────────────

-- Creates (p_id null) or updates an event together with its invitees.
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

    -- Users who can no longer see the event lose their responses, votes and claims.
    delete from public.responses r
     where r.event_id = eid and not public.event_visible_to(eid, r.user_id);
    delete from public.votes v using public.proposals p
     where p.id = v.proposal_id and p.event_id = eid and not public.event_visible_to(eid, v.user_id);
    update public.items set claimed_by = null
     where event_id = eid and claimed_by is not null and not public.event_visible_to(eid, claimed_by);
  end if;

  return eid;
end $$;

-- Applies a proposal to its open event, clears the responses given for the old version and
-- deletes the proposal. Event creator or admin only.
create function public.adopt_proposal(pid uuid) returns void
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

revoke execute on function
  public.save_event(uuid, text, timestamptz, text, text, boolean, uuid[]), public.adopt_proposal(uuid)
  from public, anon;
grant execute on function
  public.save_event(uuid, text, timestamptz, text, text, boolean, uuid[]), public.adopt_proposal(uuid)
  to authenticated;

-- ── Calendar feed ──────────────────────────────────────────────────────────

create function public.get_calendar_token() returns text
language sql stable security definer set search_path = '' as $$
  select token from public.calendar_tokens where user_id = auth.uid()
$$;

-- Creates or replaces the token (two random UUIDs, 244 bits); the previous URL stops working.
create function public.rotate_calendar_token() returns text
language sql security definer set search_path = '' as $$
  insert into public.calendar_tokens (user_id, token)
  values (auth.uid(), replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (user_id) do update set token = excluded.token, created_at = now()
  returning token
$$;

create function public.delete_calendar_token() returns void
language sql security definer set search_path = '' as $$
  delete from public.calendar_tokens where user_id = auth.uid()
$$;

-- Events visible to the token owner, except the declined ones. Used only by the
-- "calendar" Edge Function (service role).
create function public.calendar_feed(p_token text)
returns table (id uuid, title text, starts_at timestamptz, location text, description text, my_status text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  uid uuid;
begin
  select user_id into uid from public.calendar_tokens where token = p_token;
  if uid is null then
    raise exception 'invalid_token' using errcode = 'P0002';
  end if;
  return query
    select e.id, e.title, e.starts_at, e.location, e.description, r.status
    from public.events e
    left join public.responses r on r.event_id = e.id and r.user_id = uid
    where public.event_visible_to(e.id, uid)
      and r.status is distinct from 'no'
    order by e.starts_at, e.id;
end $$;

revoke execute on function public.get_calendar_token(), public.rotate_calendar_token(), public.delete_calendar_token() from public, anon;
grant execute on function public.get_calendar_token(), public.rotate_calendar_token(), public.delete_calendar_token() to authenticated;
revoke execute on function public.calendar_feed(text) from public, anon, authenticated;
grant execute on function public.calendar_feed(text) to service_role;

-- ── Privileges ─────────────────────────────────────────────────────────────
-- Explicit grants, independent of the "Automatically expose new tables" setting.
-- Events and invitations are written only through save_event(), calendar tokens only
-- through the functions above.

alter table public.profiles        enable row level security;
alter table public.events          enable row level security;
alter table public.invitations     enable row level security;
alter table public.responses       enable row level security;
alter table public.proposals       enable row level security;
alter table public.votes           enable row level security;
alter table public.items           enable row level security;
alter table public.calendar_tokens enable row level security;

revoke all on public.profiles, public.events, public.invitations, public.responses, public.proposals,
  public.votes, public.items, public.calendar_tokens from anon, authenticated;
grant all on public.profiles, public.events, public.invitations, public.responses, public.proposals,
  public.votes, public.items, public.calendar_tokens to service_role;
grant select on public.profiles, public.events, public.invitations, public.responses, public.proposals,
  public.votes, public.items to authenticated;
grant delete on public.events, public.responses, public.proposals, public.votes, public.items to authenticated;
grant insert on public.responses, public.proposals, public.votes, public.items to authenticated;
grant update on public.responses, public.votes to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant update (claimed_by) on public.items to authenticated;

-- ── Row Level Security ─────────────────────────────────────────────────────

create policy "profiles: read" on public.profiles
  for select to authenticated using (true);
create policy "profiles: update self" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "events: read" on public.events
  for select to authenticated using (public.can_see_event(id));
create policy "events: delete" on public.events
  for delete to authenticated
  using (public.is_admin() or (created_by = auth.uid() and public.is_open(starts_at)));

-- Subqueries on events inherit its RLS, so child rows are visible exactly when their event is.
create policy "invitations: read" on public.invitations
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = invitations.event_id));

create policy "responses: read" on public.responses
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = responses.event_id));
create policy "responses: insert own" on public.responses
  for insert to authenticated
  with check (user_id = auth.uid() and public.event_is_writable(event_id));
create policy "responses: update own" on public.responses
  for update to authenticated
  using (user_id = auth.uid() and public.event_is_writable(event_id))
  with check (user_id = auth.uid() and public.event_is_writable(event_id));
create policy "responses: delete own" on public.responses
  for delete to authenticated
  using (user_id = auth.uid() and public.event_is_writable(event_id));

create policy "proposals: read" on public.proposals
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = proposals.event_id));
create policy "proposals: create" on public.proposals
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (starts_at is null or starts_at > now())
    and public.event_is_writable(event_id)
  );
create policy "proposals: delete" on public.proposals
  for delete to authenticated
  using (public.event_is_writable(event_id) and (created_by = auth.uid() or public.can_manage_event(event_id)));

create policy "votes: read" on public.votes
  for select to authenticated
  using (exists (select 1 from public.proposals p where p.id = votes.proposal_id));
create policy "votes: insert own" on public.votes
  for insert to authenticated
  with check (user_id = auth.uid() and public.proposal_is_writable(proposal_id));
create policy "votes: update own" on public.votes
  for update to authenticated
  using (user_id = auth.uid() and public.proposal_is_writable(proposal_id))
  with check (user_id = auth.uid() and public.proposal_is_writable(proposal_id));
create policy "votes: delete own" on public.votes
  for delete to authenticated
  using (user_id = auth.uid() and public.proposal_is_writable(proposal_id));

-- Anyone can claim a free item or release their own; a new item can only be pre-claimed by its creator.
create policy "items: read" on public.items
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = items.event_id));
create policy "items: create" on public.items
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and public.event_is_writable(event_id)
    and (claimed_by is null or claimed_by = auth.uid())
  );
create policy "items: claim" on public.items
  for update to authenticated
  using ((claimed_by is null or claimed_by = auth.uid()) and public.event_is_writable(event_id))
  with check (claimed_by is null or claimed_by = auth.uid());
create policy "items: delete" on public.items
  for delete to authenticated
  using (public.event_is_writable(event_id) and (created_by = auth.uid() or public.can_manage_event(event_id)));

-- ── Realtime ───────────────────────────────────────────────────────────────
-- Supabase Realtime forwards changes of these tables, applying each subscriber's RLS.

do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'events', 'responses', 'proposals', 'votes', 'items', 'invitations'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

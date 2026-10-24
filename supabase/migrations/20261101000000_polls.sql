-- Polls: any participant of an open event can ask the others a question with 2 to 10 options, single
-- or multiple choice. Polls are written only through create_poll() and vote_poll(); like the rest of the
-- event, they become read-only when the event ends.

create table public.polls (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events on delete cascade,
  question   text not null check (char_length(question) between 1 and 200),
  multiple   boolean not null default false,
  created_by uuid default auth.uid() references public.profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on public.polls (event_id);

create table public.poll_options (
  id       uuid primary key default gen_random_uuid(),
  poll_id  uuid not null references public.polls on delete cascade,
  label    text not null check (char_length(label) between 1 and 100),
  position smallint not null
);
create index on public.poll_options (poll_id);

-- Random surrogate key, so Realtime DELETEs don't reveal who voted for what.
create table public.poll_votes (
  id        uuid primary key default gen_random_uuid(),
  poll_id   uuid not null references public.polls on delete cascade,
  option_id uuid not null references public.poll_options on delete cascade,
  user_id   uuid not null default auth.uid() references public.profiles on delete cascade,
  unique (option_id, user_id)
);
create index on public.poll_votes (poll_id);

-- ── Access cleanup ─────────────────────────────────────────────────────────

-- Removes the responses, votes, poll votes and claims of people who can no longer see an open event;
-- past events keep them. p_event and p_user narrow it to one event or one user. Internal.
create function public.prune_hidden(p_event uuid, p_user uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.responses r using public.events e
   where e.id = r.event_id and public.is_open(e.starts_at)
     and (p_event is null or e.id = p_event) and (p_user is null or r.user_id = p_user)
     and not public.event_visible_to(e.id, r.user_id);
  delete from public.votes v using public.proposals p, public.events e
   where p.id = v.proposal_id and e.id = p.event_id and public.is_open(e.starts_at)
     and (p_event is null or e.id = p_event) and (p_user is null or v.user_id = p_user)
     and not public.event_visible_to(e.id, v.user_id);
  delete from public.poll_votes pv using public.polls p, public.events e
   where p.id = pv.poll_id and e.id = p.event_id and public.is_open(e.starts_at)
     and (p_event is null or e.id = p_event) and (p_user is null or pv.user_id = p_user)
     and not public.event_visible_to(e.id, pv.user_id);
  update public.items i set claimed_by = null from public.events e
   where e.id = i.event_id and public.is_open(e.starts_at) and i.claimed_by is not null
     and (p_event is null or e.id = p_event) and (p_user is null or i.claimed_by = p_user)
     and not public.event_visible_to(e.id, i.claimed_by);
$$;
revoke execute on function public.prune_hidden(uuid, uuid) from public, anon, authenticated;

-- save_event() and set_user_groups() now clean up through prune_hidden(), poll votes included.
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

  perform public.prune_hidden(eid, null);

  return eid;
end $$;

create or replace function public.set_user_groups(p_user uuid, p_groups uuid[]) returns void
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
  perform public.prune_hidden(null, p_user);
end $$;

-- ── Polls ──────────────────────────────────────────────────────────────────

-- Creates a poll with its options (blank and repeated options are dropped) and returns its id.
create function public.create_poll(p_event uuid, p_question text, p_multiple boolean, p_options text[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
  labels text[] := array(
    select label from (
      select btrim(o) as label, min(n) as first
      from unnest(p_options) with ordinality as t(o, n)
      where btrim(o) <> ''
      group by btrim(o)
    ) as distinct_options
    order by first
  );
begin
  if auth.uid() is null or not public.event_is_writable(p_event) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if cardinality(labels) not between 2 and 10 then
    raise exception 'poll_options' using errcode = '22023';
  end if;
  insert into public.polls (event_id, question, multiple)
  values (p_event, btrim(p_question), coalesce(p_multiple, false))
  returning id into pid;
  insert into public.poll_options (poll_id, label, position)
  select pid, label, n from unnest(labels) with ordinality as t(label, n);
  return pid;
end $$;

-- Replaces the caller's choices in a poll; an empty array removes them.
create function public.vote_poll(p_poll uuid, p_options uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare
  poll public.polls;
  choices uuid[] := coalesce(p_options, '{}');
begin
  select * into poll from public.polls where id = p_poll for update;
  if not found or auth.uid() is null or not public.event_is_writable(poll.event_id) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if exists (
    select 1 from unnest(choices) as c
    where not exists (select 1 from public.poll_options o where o.id = c and o.poll_id = p_poll)
  ) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if not poll.multiple and cardinality(choices) > 1 then
    raise exception 'single_choice' using errcode = '22023';
  end if;
  delete from public.poll_votes
   where poll_id = p_poll and user_id = auth.uid() and not (option_id = any (choices));
  insert into public.poll_votes (poll_id, option_id, user_id)
  select p_poll, c, auth.uid() from unnest(choices) as c
  on conflict do nothing;
end $$;

revoke execute on function public.create_poll(uuid, text, boolean, text[]), public.vote_poll(uuid, uuid[]) from public, anon;
grant execute on function public.create_poll(uuid, text, boolean, text[]), public.vote_poll(uuid, uuid[]) to authenticated;

-- ── Privileges and Row Level Security ──────────────────────────────────────

alter table public.polls        enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes   enable row level security;
revoke all on public.polls, public.poll_options, public.poll_votes from anon, authenticated;
grant all on public.polls, public.poll_options, public.poll_votes to service_role;
grant select on public.polls, public.poll_options, public.poll_votes to authenticated;
grant delete on public.polls to authenticated;

create policy "polls: read" on public.polls
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = polls.event_id));
create policy "polls: delete" on public.polls
  for delete to authenticated
  using (public.event_is_writable(event_id) and (created_by = auth.uid() or public.can_manage_event(event_id)));
create policy "poll options: read" on public.poll_options
  for select to authenticated
  using (exists (select 1 from public.polls p where p.id = poll_options.poll_id));
create policy "poll votes: read" on public.poll_votes
  for select to authenticated
  using (exists (select 1 from public.polls p where p.id = poll_votes.poll_id));

do $$
declare
  t text;
begin
  foreach t in array array['polls', 'poll_options', 'poll_votes'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

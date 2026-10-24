-- Initial schema: tables, helper functions and Row Level Security.
-- An event is "open" until 12 hours after it starts.

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
  created_at  timestamptz not null default now()
);
create index on public.events (starts_at);

create table public.responses (
  event_id uuid references public.events on delete cascade,
  user_id  uuid default auth.uid() references public.profiles on delete cascade,
  status   text not null check (status in ('yes', 'maybe', 'no')),
  guests   smallint not null default 0 check (guests between 0 and 20),
  primary key (event_id, user_id)
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
  proposal_id uuid references public.proposals on delete cascade,
  user_id     uuid default auth.uid() references public.profiles on delete cascade,
  value       smallint not null check (value in (-1, 1)),
  primary key (proposal_id, user_id)
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

-- Creates the profile of a new auth user, named after user_metadata.display_name.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Applies a proposal to its event and deletes it. Event creator or admin only.
create function public.adopt_proposal(pid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p public.proposals;
begin
  select * into p from public.proposals where id = pid;
  if not found
     or not public.can_manage_event(p.event_id)
     or not exists (select 1 from public.events where id = p.event_id and public.is_open(starts_at)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.events
     set starts_at = coalesce(p.starts_at, starts_at),
         location  = coalesce(p.location, location)
   where id = p.event_id;

  delete from public.proposals where id = pid;
end $$;

revoke execute on function public.adopt_proposal(uuid) from public, anon;
grant execute on function public.adopt_proposal(uuid) to authenticated;

-- ── Row Level Security ─────────────────────────────────────────────────────
-- Subqueries on events and proposals inherit their RLS, so child rows are
-- visible exactly when their event is.

alter table public.profiles  enable row level security;
alter table public.events    enable row level security;
alter table public.responses enable row level security;
alter table public.proposals enable row level security;
alter table public.votes     enable row level security;
alter table public.items     enable row level security;

-- Explicit grants, independent of the "Automatically expose new tables" setting.
revoke all on public.profiles, public.events, public.responses, public.proposals, public.votes, public.items from anon, authenticated;
grant all on public.profiles, public.events, public.responses, public.proposals, public.votes, public.items to service_role;
grant select on public.profiles, public.events, public.responses, public.proposals, public.votes, public.items to authenticated;
grant insert, delete on public.events, public.responses, public.proposals, public.votes, public.items to authenticated;
grant update on public.responses, public.votes to authenticated;
grant execute on function public.is_admin(), public.is_open(timestamptz), public.can_manage_event(uuid) to authenticated;

-- Columns the client may update; everything else goes through functions.
grant update (display_name) on public.profiles to authenticated;
grant update (title, description, location, starts_at) on public.events to authenticated;
grant update (claimed_by) on public.items to authenticated;

-- profiles
create policy "profiles: read" on public.profiles
  for select to authenticated using (true);
create policy "profiles: update self" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- events
create policy "events: read open" on public.events
  for select to authenticated using (public.is_open(starts_at));
create policy "events: create" on public.events
  for insert to authenticated with check (created_by = auth.uid() and starts_at > now());
create policy "events: update" on public.events
  for update to authenticated
  using (public.is_open(starts_at) and (created_by = auth.uid() or public.is_admin()))
  with check (public.is_open(starts_at));
create policy "events: delete" on public.events
  for delete to authenticated using (created_by = auth.uid() or public.is_admin());

-- responses
create policy "responses: read" on public.responses
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = responses.event_id));
create policy "responses: insert own" on public.responses
  for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.events e where e.id = responses.event_id));
create policy "responses: update own" on public.responses
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and exists (select 1 from public.events e where e.id = responses.event_id));
create policy "responses: delete own" on public.responses
  for delete to authenticated using (user_id = auth.uid());

-- proposals
create policy "proposals: read" on public.proposals
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = proposals.event_id));
create policy "proposals: create" on public.proposals
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (starts_at is null or starts_at > now())
    and exists (select 1 from public.events e where e.id = proposals.event_id)
  );
create policy "proposals: delete" on public.proposals
  for delete to authenticated
  using (created_by = auth.uid() or public.can_manage_event(event_id));

-- votes
create policy "votes: read" on public.votes
  for select to authenticated
  using (exists (select 1 from public.proposals p where p.id = votes.proposal_id));
create policy "votes: insert own" on public.votes
  for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.proposals p where p.id = votes.proposal_id));
create policy "votes: update own" on public.votes
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "votes: delete own" on public.votes
  for delete to authenticated using (user_id = auth.uid());

-- items: anyone can claim a free item or release their own
create policy "items: read" on public.items
  for select to authenticated
  using (exists (select 1 from public.events e where e.id = items.event_id));
create policy "items: create" on public.items
  for insert to authenticated
  with check (created_by = auth.uid() and exists (select 1 from public.events e where e.id = items.event_id));
create policy "items: claim" on public.items
  for update to authenticated
  using (
    (claimed_by is null or claimed_by = auth.uid())
    and exists (select 1 from public.events e where e.id = items.event_id)
  )
  with check (claimed_by is null or claimed_by = auth.uid());
create policy "items: delete" on public.items
  for delete to authenticated
  using (created_by = auth.uid() or public.can_manage_event(event_id));

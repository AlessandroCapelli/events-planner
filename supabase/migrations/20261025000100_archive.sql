-- Archivio: gli eventi conclusi (12 ore dopo l'inizio) restano visibili ma in sola lettura.
-- Prima la RLS li nascondeva; ora ogni scrittura verifica esplicitamente che l'evento sia aperto.
-- Un evento concluso può eliminarlo solo un admin.

create function public.event_is_open(eid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.events where id = eid and public.is_open(starts_at))
$$;

create function public.proposal_is_open(pid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.proposals p
    join public.events e on e.id = p.event_id
    where p.id = pid and public.is_open(e.starts_at)
  )
$$;

grant execute on function public.event_is_open(uuid), public.proposal_is_open(uuid) to authenticated;

-- events
drop policy "events: read open" on public.events;
create policy "events: read" on public.events
  for select to authenticated using (true);

drop policy "events: delete" on public.events;
create policy "events: delete" on public.events
  for delete to authenticated
  using (public.is_admin() or (created_by = auth.uid() and public.is_open(starts_at)));

-- responses
drop policy "responses: insert own" on public.responses;
create policy "responses: insert own" on public.responses
  for insert to authenticated
  with check (user_id = auth.uid() and public.event_is_open(event_id));

drop policy "responses: update own" on public.responses;
create policy "responses: update own" on public.responses
  for update to authenticated
  using (user_id = auth.uid() and public.event_is_open(event_id))
  with check (user_id = auth.uid() and public.event_is_open(event_id));

drop policy "responses: delete own" on public.responses;
create policy "responses: delete own" on public.responses
  for delete to authenticated
  using (user_id = auth.uid() and public.event_is_open(event_id));

-- proposals
drop policy "proposals: create" on public.proposals;
create policy "proposals: create" on public.proposals
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (starts_at is null or starts_at > now())
    and public.event_is_open(event_id)
  );

drop policy "proposals: delete" on public.proposals;
create policy "proposals: delete" on public.proposals
  for delete to authenticated
  using (public.event_is_open(event_id) and (created_by = auth.uid() or public.can_manage_event(event_id)));

-- votes
drop policy "votes: insert own" on public.votes;
create policy "votes: insert own" on public.votes
  for insert to authenticated
  with check (user_id = auth.uid() and public.proposal_is_open(proposal_id));

drop policy "votes: update own" on public.votes;
create policy "votes: update own" on public.votes
  for update to authenticated
  using (user_id = auth.uid() and public.proposal_is_open(proposal_id))
  with check (user_id = auth.uid() and public.proposal_is_open(proposal_id));

drop policy "votes: delete own" on public.votes;
create policy "votes: delete own" on public.votes
  for delete to authenticated
  using (user_id = auth.uid() and public.proposal_is_open(proposal_id));

-- items
drop policy "items: create" on public.items;
create policy "items: create" on public.items
  for insert to authenticated
  with check (created_by = auth.uid() and public.event_is_open(event_id));

drop policy "items: claim" on public.items;
create policy "items: claim" on public.items
  for update to authenticated
  using ((claimed_by is null or claimed_by = auth.uid()) and public.event_is_open(event_id))
  with check (claimed_by is null or claimed_by = auth.uid());

drop policy "items: delete" on public.items;
create policy "items: delete" on public.items
  for delete to authenticated
  using (public.event_is_open(event_id) and (created_by = auth.uid() or public.can_manage_event(event_id)));

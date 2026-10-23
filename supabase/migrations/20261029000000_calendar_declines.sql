-- Il calendario personale include gli eventi visibili, esclusi quelli rifiutati.
-- La stessa URL riflette nuovi eventi e cambi di risposta a ogni lettura.
create or replace function public.calendar_feed(p_token text)
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

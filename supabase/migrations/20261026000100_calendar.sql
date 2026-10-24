-- Calendar sync: each user can enable a secret personal feed URL for Google, Apple
-- or Outlook Calendar. The feed contains only the events that user can see.

create table public.calendar_tokens (
  user_id    uuid primary key references public.profiles on delete cascade,
  token      text not null unique,
  created_at timestamptz not null default now()
);

-- No policies and no client grants: access goes through the functions below.
alter table public.calendar_tokens enable row level security;
revoke all on public.calendar_tokens from anon, authenticated;
grant all on public.calendar_tokens to service_role;

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

-- Used only by the "calendar" Edge Function (service role).
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
    order by e.starts_at;
end $$;

revoke execute on function public.get_calendar_token(), public.rotate_calendar_token(), public.delete_calendar_token() from public, anon;
grant execute on function public.get_calendar_token(), public.rotate_calendar_token(), public.delete_calendar_token() to authenticated;
revoke execute on function public.calendar_feed(text) from public, anon, authenticated;
grant execute on function public.calendar_feed(text) to service_role;

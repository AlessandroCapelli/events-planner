\set ON_ERROR_STOP on
\ir bootstrap.sql
\ir ../supabase/migrations/20261023000000_init.sql
\ir ../supabase/migrations/20261030000000_groups.sql
\ir ../supabase/migrations/20261031000000_save_event_lock.sql
\ir ../supabase/migrations/20261101000000_polls.sql

begin;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-000000000001', 'admin@example.test', '{"display_name":"Admin"}', '{"initial_admin":true}'),
 ('00000000-0000-4000-8000-000000000002', 'owner@example.test', '{"display_name":"Owner"}', '{}'),
 ('00000000-0000-4000-8000-000000000003', 'member@example.test', '{"display_name":"Member", "initial_admin":true, "is_admin":true}', '{}'),
 ('00000000-0000-4000-8000-000000000004', 'outsider@example.test', '{"display_name":"Outsider"}', '{}');

do $$ begin
  if not (select is_admin from public.profiles where id = '00000000-0000-4000-8000-000000000001') then
    raise exception 'The initial admin role was not created';
  end if;
  if (select is_admin from public.profiles where id = '00000000-0000-4000-8000-000000000003') then
    raise exception 'user_metadata granted admin privileges';
  end if;
  begin
    insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
    values ('00000000-0000-4000-8000-000000000005', 'invalid@example.test', jsonb_build_object('display_name', repeat('x', 61)), '{"initial_admin":true}');
    raise exception 'The invalid profile should have failed';
  exception when check_violation then null;
  end;
  if exists (select 1 from auth.users where id = '00000000-0000-4000-8000-000000000005') then
    raise exception 'Account left behind after the profile failed';
  end if;
end $$;

insert into public.events (id, group_id, title, starts_at, created_by, invite_only) values
 ('10000000-0000-4000-8000-000000000001', (select id from public.groups where name = 'Default'), 'Group', now() + interval '1 day', '00000000-0000-4000-8000-000000000002', false),
 ('10000000-0000-4000-8000-000000000002', (select id from public.groups where name = 'Default'), 'Private', now() + interval '1 day', '00000000-0000-4000-8000-000000000002', true);
insert into public.invitations (event_id, user_id) values ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003');
insert into public.responses (event_id, user_id, status) values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'yes');
insert into public.proposals (id, event_id, starts_at, created_by) values
 ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', now() - interval '2 days', '00000000-0000-4000-8000-000000000003'),
 ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', now() + interval '2 days', '00000000-0000-4000-8000-000000000003');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
do $$ begin
  begin
    insert into public.items (event_id, label, claimed_by)
    values ('10000000-0000-4000-8000-000000000001', 'Forged claim', '00000000-0000-4000-8000-000000000004');
    raise exception 'Claimed an item on behalf of another user';
  exception when insufficient_privilege then null;
  end;
  insert into public.items (event_id, label, claimed_by) values
    ('10000000-0000-4000-8000-000000000001', 'My item', auth.uid()),
    ('10000000-0000-4000-8000-000000000001', 'Free item', null);
  if (select count(*) from public.events) <> 2 then raise exception 'Invitee cannot see the event'; end if;
  perform public.rotate_calendar_token();
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000004', true);
do $$ declare affected integer; begin
  if (select count(*) from public.events) <> 1 then raise exception 'Private event visible to outsiders'; end if;
  update public.items set claimed_by = auth.uid() where label = 'My item';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Overwrote someone else''s claim'; end if;
  begin
    insert into public.items (event_id, label) values ('10000000-0000-4000-8000-000000000002', 'Private');
    raise exception 'Wrote to an invisible event';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
do $$ begin
  begin
    perform public.adopt_proposal('20000000-0000-4000-8000-000000000001');
    raise exception 'Adopted an expired proposal';
  exception when sqlstate '22023' then null;
  end;
  if (select count(*) from public.responses where event_id = '10000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'Responses lost after a rejected adoption';
  end if;
  perform public.adopt_proposal('20000000-0000-4000-8000-000000000002');
  if exists (select 1 from public.responses where event_id = '10000000-0000-4000-8000-000000000001') then
    raise exception 'Responses not cleared after a valid adoption';
  end if;
  perform public.save_event(null, (select id from public.groups where name = 'Default'), 'Just started', now() - interval '1 hour', null, null, false, '{}');
  begin
    perform public.save_event(null, (select id from public.groups where name = 'Default'), 'Already over', now() - interval '13 hours', null, null, false, '{}');
    raise exception 'Created an event that has already ended';
  exception when sqlstate '22023' then null;
  end;
end $$;

reset role;
do $$ declare feed_token text; amount integer; begin
  select token into feed_token from public.calendar_tokens where user_id = '00000000-0000-4000-8000-000000000003';
  select count(*) into amount from public.calendar_feed(feed_token);
  if amount <> 3 then raise exception 'Wrong initial feed: %', amount; end if;
  delete from public.invitations where event_id = '10000000-0000-4000-8000-000000000002';
  select count(*) into amount from public.calendar_feed(feed_token);
  if amount <> 2 then raise exception 'Feed ignores a revoked invitation: %', amount; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', true);
insert into public.responses (event_id, user_id, status)
values ('10000000-0000-4000-8000-000000000001', auth.uid(), 'no');
reset role;
do $$ declare feed_token text; begin
  select token into feed_token from public.calendar_tokens where user_id = '00000000-0000-4000-8000-000000000003';
  if exists (select 1 from public.calendar_feed(feed_token) where id = '10000000-0000-4000-8000-000000000001') then
    raise exception 'Declined event still in the feed';
  end if;
  update public.responses set status = 'maybe' where event_id = '10000000-0000-4000-8000-000000000001';
  if not exists (select 1 from public.calendar_feed(feed_token) where id = '10000000-0000-4000-8000-000000000001' and my_status = 'maybe') then
    raise exception 'Event missing after the response changed';
  end if;
  insert into public.events (id, group_id, title, starts_at, created_by) values
    ('10000000-0000-4000-8000-000000000003', (select id from public.groups where name = 'Default'), 'New event after subscribing', now() + interval '3 days', '00000000-0000-4000-8000-000000000002');
  if not exists (select 1 from public.calendar_feed(feed_token) where id = '10000000-0000-4000-8000-000000000003' and my_status is null) then
    raise exception 'New event missing from the feed with the same token';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select set_config('test.climbing', public.save_group(null, 'Climbing')::text, true);
reset role;
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
 ('00000000-0000-4000-8000-000000000006', 'climber@example.test', '{"display_name":"Climber"}',
  jsonb_build_object('initial_groups', jsonb_build_array(current_setting('test.climbing'))));

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000006', true);
do $$ begin
  if exists (select 1 from public.events) then raise exception 'Events of another group are visible'; end if;
  if (select count(*) from public.profiles) <> 1 then raise exception 'Profiles of another group are visible'; end if;
  begin
    perform public.save_event(null, (select id from public.groups where name = 'Default'), 'Intrusion', now() + interval '1 day', null, null);
    raise exception 'Created an event in a group the user is not in';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_group(null, 'Mine');
    raise exception 'A member created a group';
  exception when insufficient_privilege then null;
  end;
  perform public.save_event(null, current_setting('test.climbing')::uuid, 'Climb', now() + interval '1 day', null, null, true, '{}');
end $$;

reset role;
insert into public.events (id, group_id, title, starts_at, created_by) values
 ('10000000-0000-4000-8000-000000000004', (select id from public.groups where name = 'Default'), 'Archived', now() - interval '2 days', '00000000-0000-4000-8000-000000000002');
insert into public.responses (event_id, user_id, status) values
 ('10000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'yes');
insert into public.votes (proposal_id, user_id, value) values
 ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', 1);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
do $$ begin
  if exists (select 1 from public.events where title = 'Climb') then raise exception 'Admins see events of groups they are not in'; end if;
  begin
    perform public.delete_group(current_setting('test.climbing')::uuid);
    raise exception 'Deleted the last group of a user';
  exception when check_violation then null;
  end;
  begin
    perform public.set_user_groups('00000000-0000-4000-8000-000000000003', '{}');
    raise exception 'Left a user without groups';
  exception when check_violation then null;
  end;
  perform public.set_user_groups('00000000-0000-4000-8000-000000000003', array[current_setting('test.climbing')::uuid]);
end $$;

reset role;
do $$ declare feed_token text; begin
  if exists (select 1 from public.responses r join public.events e on e.id = r.event_id
             where r.user_id = '00000000-0000-4000-8000-000000000003' and public.is_open(e.starts_at)) then
    raise exception 'Open responses kept after leaving the group';
  end if;
  if not exists (select 1 from public.responses where user_id = '00000000-0000-4000-8000-000000000003'
                 and event_id = '10000000-0000-4000-8000-000000000004') then
    raise exception 'Archived response lost after leaving the group';
  end if;
  if exists (select 1 from public.votes where user_id = '00000000-0000-4000-8000-000000000003') then
    raise exception 'Open votes kept after leaving the group';
  end if;
  if exists (select 1 from public.items where claimed_by = '00000000-0000-4000-8000-000000000003') then
    raise exception 'Open claims kept after leaving the group';
  end if;
  select token into feed_token from public.calendar_tokens where user_id = '00000000-0000-4000-8000-000000000003';
  if exists (select 1 from public.calendar_feed(feed_token)) then
    raise exception 'Feed includes events after leaving their group or without an invitation';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select public.set_user_groups('00000000-0000-4000-8000-000000000003', array[(select id from public.groups where name = 'Default')]);
select public.set_user_groups('00000000-0000-4000-8000-000000000006', array[(select id from public.groups where name = 'Default')]);
select public.delete_group(current_setting('test.climbing')::uuid);
reset role;
do $$ begin
  if exists (select 1 from public.events where group_id = current_setting('test.climbing')::uuid) then
    raise exception 'Group deletion left its events behind';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', true);
select set_config('test.poll', public.create_poll('10000000-0000-4000-8000-000000000001', 'Pizza or sushi?', false, array['Pizza', 'Sushi', ' Pizza '])::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000004', true);
do $$ declare options uuid[] := array(select id from public.poll_options where poll_id = current_setting('test.poll')::uuid order by position); begin
  if cardinality(options) <> 2 then raise exception 'Repeated poll options were kept'; end if;
  perform public.vote_poll(current_setting('test.poll')::uuid, options[1:1]);
  begin
    perform public.vote_poll(current_setting('test.poll')::uuid, options);
    raise exception 'Voted twice in a single-choice poll';
  exception when sqlstate '22023' then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000006', true);
do $$ begin
  if exists (select 1 from public.polls) then raise exception 'Polls of another group are visible'; end if;
end $$;
reset role;

set local role anon;
do $$ begin
  if has_function_privilege(current_user, 'public.is_member(uuid)', 'execute')
     or has_function_privilege(current_user, 'public.can_see_profile(uuid)', 'execute') then
    raise exception 'Group visibility helpers callable by anon';
  end if;
  begin
    perform public.calendar_feed(repeat('a', 64));
    raise exception 'Feed RPC callable by anon';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
\echo 'PASS: migrations, item and invitation RLS, groups, polls, proposal adoption, atomic user/admin creation, feed and anon privileges.'

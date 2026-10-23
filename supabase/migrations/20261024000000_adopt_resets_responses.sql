-- Adottare una proposta cambia data e/o luogo dell'evento:
-- le risposte date per la versione precedente non sono più valide e vengono azzerate.

create or replace function public.adopt_proposal(pid uuid) returns void
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

  delete from public.responses where event_id = p.event_id;
  delete from public.proposals where id = pid;
end $$;

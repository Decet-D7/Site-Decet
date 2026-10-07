-- O anfitrião também registra ticket (peer fixo "decet-dev-<sala>"), então o mesmo peer pode ter
-- vários tickets ao longo do tempo. Quem entra confere o anfitrião, e o anfitrião confere quem entra.
alter table public.room_tickets drop constraint room_tickets_pkey;
alter table public.room_tickets add column id bigint generated always as identity primary key;
create index room_tickets_peer_idx on public.room_tickets (peer_id, room_code, created_at desc);

create or replace function public.verify_room_ticket(p_peer_id text, p_room_code text)
returns table (name text, email text)
language sql stable security definer set search_path = '' as $$
  select tm.name, tm.email
  from public.room_tickets rt
  join public.team_members tm on tm.user_id = rt.user_id and tm.active
  where public.is_team_member() and rt.peer_id = p_peer_id and rt.room_code = p_room_code
    and rt.created_at > now() - interval '12 hours'
  order by rt.created_at desc
  limit 1;
$$;

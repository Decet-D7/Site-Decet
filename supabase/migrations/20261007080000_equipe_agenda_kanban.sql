-- Equipe DECET: cadastro do time (login por convite), agenda, kanban e entrada nas salas.
-- O site é estático; toda regra de acesso fica aqui, em RLS e funções security definer.

-- ============================================================ Utilidades
create or replace function public.random_code(len int) returns text
language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', (get_byte(b, i) % 31) + 1, 1), '' order by i)
  from extensions.gen_random_bytes(len) as b, generate_series(0, len - 1) as i;
$$;

create or replace function public.new_room_code() returns text
language sql volatile set search_path = '' as $$
  select lower(substr(c, 1, 4) || '-' || substr(c, 5, 4) || '-' || substr(c, 9, 4)) from (select public.random_code(12) as c) s;
$$;

create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ============================================================ Equipe
create table public.team_members (
  email text primary key check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  role text not null default 'member' check (role in ('admin', 'member')),
  active boolean not null default true,
  user_id uuid unique references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.team_members enable row level security;

-- Códigos de convite e de redefinição de senha (só hash). Sem políticas: só as funções abaixo acessam.
create table public.team_codes (
  email text primary key references public.team_members (email) on delete cascade,
  invite_hash text, invite_expires_at timestamptz,
  reset_hash text, reset_expires_at timestamptz,
  failed_attempts int not null default 0
);
alter table public.team_codes enable row level security;

create or replace function public.is_team_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members where user_id = (select auth.uid()) and active);
$$;
create or replace function public.is_team_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members where user_id = (select auth.uid()) and active and role = 'admin');
$$;

create policy "time vê a equipe" on public.team_members for select to authenticated using ((select public.is_team_member()));
create policy "admin cadastra" on public.team_members for insert to authenticated with check ((select public.is_team_admin()));
create policy "admin edita" on public.team_members for update to authenticated using ((select public.is_team_admin())) with check ((select public.is_team_admin()));
create policy "admin remove" on public.team_members for delete to authenticated using ((select public.is_team_admin()));
revoke all on public.team_members, public.team_codes from anon, authenticated;
grant select (email, name, role, active, user_id, created_at) on public.team_members to authenticated;
grant insert (email, name, role, active) on public.team_members to authenticated;
grant update (name, role, active) on public.team_members to authenticated;
grant delete on public.team_members to authenticated;

-- Sempre sobra pelo menos um administrador ativo.
create or replace function public.guard_last_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and old.active and (tg_op = 'DELETE' or new.role <> 'admin' or not new.active) then
    if not exists (select 1 from public.team_members where role = 'admin' and active and email <> old.email) then
      raise exception 'A equipe precisa de pelo menos um administrador ativo.';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger team_members_guard_last_admin before update or delete on public.team_members
  for each row execute function public.guard_last_admin();

-- Gera um código (mostrado uma vez) e guarda só o hash. kind: 'invite' (primeiro acesso) ou 'reset' (nova senha).
create or replace function public.issue_team_code(p_email text, p_kind text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_code text := public.random_code(8);
  v_hash text := extensions.crypt(v_code, extensions.gen_salt('bf'));
  m public.team_members;
begin
  select * into m from public.team_members where email = v_email;
  if not found then raise exception 'Pessoa não cadastrada na equipe.'; end if;
  if not m.active then raise exception 'Cadastro desativado. Reative antes de gerar um código.'; end if;
  if p_kind = 'invite' then
    if m.user_id is not null then raise exception 'Essa pessoa já criou a conta. Gere um código de nova senha.'; end if;
    insert into public.team_codes (email, invite_hash, invite_expires_at) values (v_email, v_hash, now() + interval '7 days')
      on conflict (email) do update set invite_hash = excluded.invite_hash, invite_expires_at = excluded.invite_expires_at;
  elsif p_kind = 'reset' then
    if m.user_id is null then raise exception 'Essa pessoa ainda não criou a conta. Gere um código de convite.'; end if;
    insert into public.team_codes (email, reset_hash, reset_expires_at, failed_attempts) values (v_email, v_hash, now() + interval '1 day', 0)
      on conflict (email) do update set reset_hash = excluded.reset_hash, reset_expires_at = excluded.reset_expires_at, failed_attempts = 0;
  else
    raise exception 'Tipo de código inválido.';
  end if;
  return v_code;
end $$;

create or replace function public.admin_issue_code(p_email text, p_kind text) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_team_admin() then raise exception 'Apenas administradores podem gerar códigos.'; end if;
  return public.issue_team_code(p_email, p_kind);
end $$;

-- Cadastro (signUp) só para quem foi cadastrado pelo admin e tem um convite válido.
create or replace function public.enforce_team_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(new.email);
  v_code text := upper(btrim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')));
  m public.team_members;
  c public.team_codes;
begin
  select * into m from public.team_members where email = v_email and active and user_id is null;
  select * into c from public.team_codes where email = v_email;
  if m.email is null or c.invite_hash is null or c.invite_expires_at < now()
     or extensions.crypt(v_code, c.invite_hash) <> c.invite_hash then
    raise exception 'convite_invalido';
  end if;
  new.raw_user_meta_data := (coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invite_code') || jsonb_build_object('name', m.name);
  return new;
end $$;
create trigger enforce_team_signup before insert on auth.users for each row execute function public.enforce_team_signup();

create or replace function public.link_team_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.team_members set user_id = new.id where email = lower(new.email) and user_id is null;
  update public.team_codes set invite_hash = null, invite_expires_at = null where email = lower(new.email);
  return new;
end $$;
create trigger link_team_member after insert on auth.users for each row execute function public.link_team_member();

-- Nova senha com o código gerado pelo admin (sem depender de e-mail). 5 tentativas erradas invalidam o código.
create or replace function public.redeem_password_reset(p_email text, p_code text, p_password text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  m public.team_members;
  c public.team_codes;
begin
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'A senha precisa ter pelo menos 8 caracteres.'; end if;
  select * into m from public.team_members where email = v_email and active and user_id is not null;
  select * into c from public.team_codes where email = v_email for update;
  if m.email is null or c.reset_hash is null or c.reset_expires_at < now() or c.failed_attempts >= 5 then return false; end if;
  if extensions.crypt(upper(btrim(coalesce(p_code, ''))), c.reset_hash) <> c.reset_hash then
    update public.team_codes set failed_attempts = failed_attempts + 1 where email = v_email;
    return false;
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now() where id = m.user_id;
  update public.team_codes set reset_hash = null, reset_expires_at = null, failed_attempts = 0 where email = v_email;
  return true;
end $$;

-- ============================================================ Entrada nas salas
-- Quem vai entrar registra o próprio peer; o anfitrião confere com verify_room_ticket.
create table public.room_tickets (
  peer_id text primary key check (peer_id ~ '^[A-Za-z0-9-]{8,64}$'),
  room_code text not null check (room_code ~ '^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$'),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.room_tickets enable row level security;
create policy "membro cria o próprio ticket" on public.room_tickets for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_team_member()));
revoke all on public.room_tickets from anon, authenticated;
grant insert (peer_id, room_code) on public.room_tickets to authenticated;

create or replace function public.verify_room_ticket(p_peer_id text, p_room_code text)
returns table (name text, email text)
language sql stable security definer set search_path = '' as $$
  select tm.name, tm.email
  from public.room_tickets rt
  join public.team_members tm on tm.user_id = rt.user_id and tm.active
  where public.is_team_member() and rt.peer_id = p_peer_id and rt.room_code = p_room_code
    and rt.created_at > now() - interval '10 minutes';
$$;

create or replace function public.prune_room_tickets() returns trigger
language plpgsql security definer set search_path = '' as $$
begin delete from public.room_tickets where created_at < now() - interval '1 day'; return null; end $$;
create trigger prune_room_tickets after insert on public.room_tickets for each statement execute function public.prune_room_tickets();

-- ============================================================ Agenda
create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  starts_at timestamptz not null,
  duration_min integer not null default 30 check (duration_min between 5 and 720),
  room_code text not null unique default public.new_room_code() check (room_code ~ '^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$'),
  created_by uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index meetings_starts_at_idx on public.meetings (starts_at);
create index meetings_created_by_idx on public.meetings (created_by);
create trigger meetings_updated_at before update on public.meetings for each row execute function public.set_updated_at();
alter table public.meetings enable row level security;
create policy "time vê a agenda" on public.meetings for select to authenticated using ((select public.is_team_member()));
create policy "time marca reuniões" on public.meetings for insert to authenticated
  with check ((select public.is_team_member()) and created_by = (select auth.uid()));
create policy "autor ou admin edita" on public.meetings for update to authenticated
  using ((select public.is_team_member()) and (created_by = (select auth.uid()) or (select public.is_team_admin())))
  with check ((select public.is_team_member()));
create policy "autor ou admin apaga" on public.meetings for delete to authenticated
  using ((select public.is_team_member()) and (created_by = (select auth.uid()) or (select public.is_team_admin())));
revoke all on public.meetings from anon, authenticated;
grant select, delete on public.meetings to authenticated;
grant insert (title, description, starts_at, duration_min) on public.meetings to authenticated;
grant update (title, description, starts_at, duration_min) on public.meetings to authenticated;

-- ============================================================ Kanban
create table public.kanban_columns (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 60),
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create table public.kanban_cards (
  id uuid primary key default gen_random_uuid(),
  column_id uuid not null references public.kanban_columns (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text not null default '' check (char_length(description) <= 5000),
  assignee uuid references auth.users (id) on delete set null,
  due_date date,
  labels text[] not null default '{}' check (cardinality(labels) <= 6),
  position double precision not null default 0,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kanban_cards_column_idx on public.kanban_cards (column_id, position);
create index kanban_cards_assignee_idx on public.kanban_cards (assignee);
create index kanban_cards_created_by_idx on public.kanban_cards (created_by);
create trigger kanban_cards_updated_at before update on public.kanban_cards for each row execute function public.set_updated_at();
alter table public.kanban_columns enable row level security;
alter table public.kanban_cards enable row level security;
create policy "time usa as colunas" on public.kanban_columns for all to authenticated
  using ((select public.is_team_member())) with check ((select public.is_team_member()));
create policy "time usa os cartões" on public.kanban_cards for all to authenticated
  using ((select public.is_team_member())) with check ((select public.is_team_member()));
revoke all on public.kanban_columns, public.kanban_cards from anon, authenticated;
grant select, delete on public.kanban_columns, public.kanban_cards to authenticated;
grant insert (title, position), update (title, position) on public.kanban_columns to authenticated;
grant insert (column_id, title, description, assignee, due_date, labels, position),
      update (column_id, title, description, assignee, due_date, labels, position) on public.kanban_cards to authenticated;

-- ============================================================ Funções: quem pode chamar
revoke execute on function public.random_code(int), public.new_room_code(), public.set_updated_at(),
  public.guard_last_admin(), public.issue_team_code(text, text), public.enforce_team_signup(),
  public.link_team_member(), public.prune_room_tickets() from public, anon, authenticated;
revoke execute on function public.is_team_member(), public.is_team_admin(), public.admin_issue_code(text, text),
  public.verify_room_ticket(text, text), public.redeem_password_reset(text, text, text) from public, anon;
grant execute on function public.is_team_member(), public.is_team_admin(), public.admin_issue_code(text, text),
  public.verify_room_ticket(text, text) to authenticated;
grant execute on function public.redeem_password_reset(text, text, text) to anon, authenticated;
-- new_room_code é usado como default de meetings.room_code
grant execute on function public.new_room_code(), public.random_code(int) to authenticated;

-- ============================================================ Tempo real
alter publication supabase_realtime add table public.meetings, public.kanban_columns, public.kanban_cards, public.team_members;

-- ============================================================ Dados iniciais
insert into public.team_members (email, name, role) values
  ('decet.com.br@gmail.com', 'DECET', 'admin'),
  ('joao.chagas@decet.com.br', 'João Chagas', 'admin'),
  ('lucas.noliveira@decet.com.br', 'lucas.noliveira', 'admin'),
  ('lucas.holiveira@decet.com.br', 'lucas.holiveira', 'admin');
insert into public.kanban_columns (title, position) values
  ('A fazer', 1), ('Em andamento', 2), ('Em revisão', 3), ('Concluído', 4);

-- Área do cliente: empresas clientes, logins dos clientes (convite por código, como o time), serviços e
-- prazos, reuniões com clientes, chamados (suporte e pedidos de reunião), arquivos (relatórios,
-- documentos, contratos) e financeiro. Regra geral: o time vê e edita tudo; o cliente só vê o que é da
-- empresa dele. Cadastro de empresas e de logins de clientes: só administradores.

-- ============================================================ Empresas e logins
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  notes text not null default '' check (char_length(notes) <= 4000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.client_users (
  email text primary key check (email = lower(btrim(email)) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  client_id uuid not null references public.clients (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  user_id uuid unique references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index client_users_client_idx on public.client_users (client_id);
-- Códigos de convite e de nova senha dos clientes (só hash; sem políticas: só as funções acessam).
create table public.client_codes (
  email text primary key references public.client_users (email) on delete cascade,
  invite_hash text, invite_expires_at timestamptz,
  reset_hash text, reset_expires_at timestamptz,
  failed_attempts int not null default 0
);
alter table public.clients enable row level security;
alter table public.client_users enable row level security;
alter table public.client_codes enable row level security;

-- Um mesmo e-mail não pode ser do time e de um cliente.
create or replace function public.guard_login_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'client_users' and exists (select 1 from public.team_members where email = new.email) then
    raise exception 'Esse e-mail já é do time DECET.';
  end if;
  if tg_table_name = 'team_members' and exists (select 1 from public.client_users where email = new.email) then
    raise exception 'Esse e-mail já é de um cliente.';
  end if;
  return new;
end $$;
create trigger client_users_guard_email before insert on public.client_users for each row execute function public.guard_login_email();
create trigger team_members_guard_email before insert on public.team_members for each row execute function public.guard_login_email();

-- Empresa do cliente logado (null para quem não é cliente ativo de uma empresa ativa).
create or replace function public.my_client_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select cu.client_id from public.client_users cu join public.clients c on c.id = cu.client_id and c.active
  where cu.user_id = (select auth.uid()) and cu.active limit 1;
$$;
create or replace function public.is_client_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.my_client_id() is not null;
$$;

create policy "time e o próprio cliente veem a empresa" on public.clients for select to authenticated
  using ((select public.is_team_member()) or id = (select public.my_client_id()));
create policy "admin cadastra empresa" on public.clients for insert to authenticated with check ((select public.is_team_admin()));
create policy "admin edita empresa" on public.clients for update to authenticated using ((select public.is_team_admin())) with check ((select public.is_team_admin()));
create policy "admin remove empresa" on public.clients for delete to authenticated using ((select public.is_team_admin()));
create policy "time vê logins; cliente vê o próprio" on public.client_users for select to authenticated
  using ((select public.is_team_member()) or user_id = (select auth.uid()));
create policy "admin cadastra login de cliente" on public.client_users for insert to authenticated with check ((select public.is_team_admin()));
create policy "admin edita login de cliente" on public.client_users for update to authenticated using ((select public.is_team_admin())) with check ((select public.is_team_admin()));
create policy "admin remove login de cliente" on public.client_users for delete to authenticated using ((select public.is_team_admin()));
revoke all on public.clients, public.client_users, public.client_codes from anon, authenticated;
grant select, delete on public.clients to authenticated;
grant insert (name, notes, active), update (name, notes, active) on public.clients to authenticated;
grant select (email, client_id, name, active, user_id, created_at) on public.client_users to authenticated;
grant delete on public.client_users to authenticated;
grant insert (email, client_id, name, active), update (name, active) on public.client_users to authenticated;

-- Códigos dos clientes (mesmas regras dos do time: convite 7 dias, nova senha 24 h).
create or replace function public.issue_client_code(p_email text, p_kind text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_code text := public.random_code(8);
  v_hash text := extensions.crypt(v_code, extensions.gen_salt('bf'));
  u public.client_users;
begin
  select * into u from public.client_users where email = v_email;
  if not found then raise exception 'Login de cliente não cadastrado.'; end if;
  if not u.active then raise exception 'Login desativado. Reative antes de gerar um código.'; end if;
  if p_kind = 'invite' then
    if u.user_id is not null then raise exception 'Essa pessoa já criou a conta. Gere um código de nova senha.'; end if;
    insert into public.client_codes (email, invite_hash, invite_expires_at) values (v_email, v_hash, now() + interval '7 days')
      on conflict (email) do update set invite_hash = excluded.invite_hash, invite_expires_at = excluded.invite_expires_at;
  elsif p_kind = 'reset' then
    if u.user_id is null then raise exception 'Essa pessoa ainda não criou a conta. Gere um código de convite.'; end if;
    insert into public.client_codes (email, reset_hash, reset_expires_at, failed_attempts) values (v_email, v_hash, now() + interval '1 day', 0)
      on conflict (email) do update set reset_hash = excluded.reset_hash, reset_expires_at = excluded.reset_expires_at, failed_attempts = 0;
  else
    raise exception 'Tipo de código inválido.';
  end if;
  return v_code;
end $$;
create or replace function public.admin_issue_client_code(p_email text, p_kind text) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not public.is_team_admin() then raise exception 'Apenas administradores podem gerar códigos.'; end if;
  return public.issue_client_code(p_email, p_kind);
end $$;

-- Cadastro (signUp): convite válido do time OU de um cliente.
create or replace function public.enforce_team_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(new.email);
  v_code text := upper(btrim(coalesce(new.raw_user_meta_data ->> 'invite_code', '')));
  v_name text;
  m public.team_members;
  c public.team_codes;
  u public.client_users;
  cc public.client_codes;
begin
  select * into m from public.team_members where email = v_email and active and user_id is null;
  if m.email is not null then
    select * into c from public.team_codes where email = v_email;
    if c.invite_hash is not null and c.invite_expires_at >= now() and extensions.crypt(v_code, c.invite_hash) = c.invite_hash then v_name := m.name; end if;
  else
    select cu.* into u from public.client_users cu join public.clients cl on cl.id = cu.client_id and cl.active
      where cu.email = v_email and cu.active and cu.user_id is null;
    if u.email is not null then
      select * into cc from public.client_codes where email = v_email;
      if cc.invite_hash is not null and cc.invite_expires_at >= now() and extensions.crypt(v_code, cc.invite_hash) = cc.invite_hash then v_name := u.name; end if;
    end if;
  end if;
  if v_name is null then raise exception 'convite_invalido'; end if;
  new.raw_user_meta_data := (coalesce(new.raw_user_meta_data, '{}'::jsonb) - 'invite_code') || jsonb_build_object('name', v_name);
  return new;
end $$;
create or replace function public.link_team_member() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.team_members set user_id = new.id where email = lower(new.email) and user_id is null;
  update public.team_codes set invite_hash = null, invite_expires_at = null where email = lower(new.email);
  update public.client_users set user_id = new.id where email = lower(new.email) and user_id is null;
  update public.client_codes set invite_hash = null, invite_expires_at = null where email = lower(new.email);
  return new;
end $$;

-- Nova senha com código (time ou cliente). 5 tentativas erradas invalidam o código.
create or replace function public.redeem_password_reset(p_email text, p_code text, p_password text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_uid uuid;
  c public.team_codes;
  cc public.client_codes;
begin
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'A senha precisa ter pelo menos 8 caracteres.'; end if;
  select user_id into v_uid from public.team_members where email = v_email and active and user_id is not null;
  if v_uid is not null then
    select * into c from public.team_codes where email = v_email for update;
    if c.reset_hash is null or c.reset_expires_at < now() or c.failed_attempts >= 5 then return false; end if;
    if extensions.crypt(v_code, c.reset_hash) <> c.reset_hash then
      update public.team_codes set failed_attempts = failed_attempts + 1 where email = v_email;
      return false;
    end if;
    update public.team_codes set reset_hash = null, reset_expires_at = null, failed_attempts = 0 where email = v_email;
  else
    select cu.user_id into v_uid from public.client_users cu join public.clients cl on cl.id = cu.client_id and cl.active
      where cu.email = v_email and cu.active and cu.user_id is not null;
    if v_uid is null then return false; end if;
    select * into cc from public.client_codes where email = v_email for update;
    if cc.reset_hash is null or cc.reset_expires_at < now() or cc.failed_attempts >= 5 then return false; end if;
    if extensions.crypt(v_code, cc.reset_hash) <> cc.reset_hash then
      update public.client_codes set failed_attempts = failed_attempts + 1 where email = v_email;
      return false;
    end if;
    update public.client_codes set reset_hash = null, reset_expires_at = null, failed_attempts = 0 where email = v_email;
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now() where id = v_uid;
  return true;
end $$;

-- ============================================================ Serviços e prazos
create table public.client_services (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 4000),
  status text not null default 'planejamento' check (status in ('planejamento', 'em_andamento', 'em_validacao', 'concluido', 'pausado')),
  progress integer not null default 0 check (progress between 0 and 100),
  start_date date,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index client_services_client_idx on public.client_services (client_id);
create table public.client_milestones (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references public.client_services (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  due_date date,
  done boolean not null default false,
  done_at timestamptz,
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
create index client_milestones_service_idx on public.client_milestones (service_id);
create index client_milestones_client_idx on public.client_milestones (client_id);
create or replace function public.prepare_milestone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select client_id into new.client_id from public.client_services where id = new.service_id;
  if new.done and (tg_op = 'INSERT' or not old.done) then new.done_at := now(); end if;
  if not new.done then new.done_at := null; end if;
  return new;
end $$;
create trigger client_milestones_prepare before insert or update on public.client_milestones for each row execute function public.prepare_milestone();
create trigger client_services_updated_at before update on public.client_services for each row execute function public.set_updated_at();

-- ============================================================ Chamados (suporte e pedidos de reunião)
create table public.client_tickets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null default public.my_client_id() references public.clients (id) on delete cascade,
  kind text not null default 'suporte' check (kind in ('suporte', 'reuniao')),
  subject text not null check (char_length(btrim(subject)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 5000),
  priority text not null default 'normal' check (priority in ('baixa', 'normal', 'alta', 'urgente')),
  status text not null default 'aberto' check (status in ('aberto', 'em_andamento', 'aguardando_cliente', 'resolvido', 'cancelado')),
  preferred_times text not null default '' check (char_length(preferred_times) <= 500),
  meeting_id uuid references public.meetings (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index client_tickets_client_idx on public.client_tickets (client_id, status);
create index client_tickets_meeting_idx on public.client_tickets (meeting_id);
create index client_tickets_created_by_idx on public.client_tickets (created_by);
create table public.client_ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.client_tickets (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  author uuid default auth.uid() references auth.users (id) on delete set null,
  author_name text,
  author_kind text check (author_kind in ('equipe', 'cliente')),
  created_at timestamptz not null default now()
);
create index client_ticket_messages_ticket_idx on public.client_ticket_messages (ticket_id, created_at);
create index client_ticket_messages_client_idx on public.client_ticket_messages (client_id);
create index client_ticket_messages_author_idx on public.client_ticket_messages (author);

create or replace function public.login_display_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select name from public.team_members where user_id = p_user), (select name from public.client_users where user_id = p_user));
$$;
-- Chamado aberto pelo cliente: sempre nasce "aberto", sem reunião ligada e com o autor certo.
create or replace function public.prepare_ticket() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_by_name := public.login_display_name(auth.uid());
    if not public.is_team_member() then
      new.status := 'aberto';
      new.meeting_id := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger client_tickets_prepare before insert or update on public.client_tickets for each row execute function public.prepare_ticket();
create or replace function public.prepare_ticket_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select client_id into new.client_id from public.client_tickets where id = new.ticket_id;
  new.author := auth.uid();
  new.author_name := public.login_display_name(auth.uid());
  new.author_kind := case when public.is_team_member() then 'equipe' else 'cliente' end;
  return new;
end $$;
create trigger client_ticket_messages_prepare before insert on public.client_ticket_messages for each row execute function public.prepare_ticket_message();
-- Resposta do cliente reabre o chamado que estava aguardando ele; toda mensagem atualiza o chamado.
create or replace function public.touch_ticket() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.client_tickets
    set updated_at = now(),
        status = case when new.author_kind = 'cliente' and status = 'aguardando_cliente' then 'aberto' else status end
    where id = new.ticket_id;
  return null;
end $$;
create trigger client_ticket_messages_touch after insert on public.client_ticket_messages for each row execute function public.touch_ticket();

-- ============================================================ Reuniões com clientes
alter table public.meetings add column client_id uuid references public.clients (id) on delete set null;
alter table public.meetings add column ticket_id uuid references public.client_tickets (id) on delete set null;
create index meetings_client_idx on public.meetings (client_id);
create index meetings_ticket_idx on public.meetings (ticket_id);
create policy "cliente vê as reuniões da empresa" on public.meetings for select to authenticated
  using (client_id is not null and client_id = (select public.my_client_id()));
grant insert (client_id, ticket_id), update (client_id, ticket_id) on public.meetings to authenticated;

-- ============================================================ Arquivos (relatórios, documentos, contratos)
create table public.client_files (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  category text not null check (category in ('relatorio', 'documento', 'contrato')),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text not null default '' check (char_length(description) <= 2000),
  link_url text check (link_url is null or link_url ~* '^https?://'),
  storage_path text,
  file_name text,
  size_bytes bigint,
  mime_type text,
  service_id uuid references public.client_services (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((link_url is null) <> (storage_path is null)),
  check (storage_path is null or storage_path like client_id::text || '/%')
);
create index client_files_client_idx on public.client_files (client_id, category);
create index client_files_service_idx on public.client_files (service_id);
create index client_files_created_by_idx on public.client_files (created_by);

-- ============================================================ Financeiro
create table public.client_invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  number text not null default '' check (char_length(number) <= 40),
  description text not null check (char_length(btrim(description)) between 1 and 300),
  amount numeric(12, 2) not null check (amount >= 0),
  due_date date not null,
  status text not null default 'aberta' check (status in ('aberta', 'paga', 'cancelada')),
  paid_at date,
  payment_url text check (payment_url is null or payment_url ~* '^https?://'),
  boleto_path text, boleto_name text,
  nota_path text, nota_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (boleto_path is null or boleto_path like client_id::text || '/%'),
  check (nota_path is null or nota_path like client_id::text || '/%')
);
create index client_invoices_client_idx on public.client_invoices (client_id, due_date);
create trigger client_invoices_updated_at before update on public.client_invoices for each row execute function public.set_updated_at();

-- ============================================================ Acesso às tabelas do cliente
do $$
declare t text;
begin
  foreach t in array array['client_services', 'client_milestones', 'client_tickets', 'client_ticket_messages', 'client_files', 'client_invoices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "time e o próprio cliente veem" on public.%I for select to authenticated using ((select public.is_team_member()) or client_id = (select public.my_client_id()))', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
  foreach t in array array['client_services', 'client_milestones', 'client_files', 'client_invoices'] loop
    execute format('create policy "time cria" on public.%I for insert to authenticated with check ((select public.is_team_member()))', t);
    execute format('create policy "time edita" on public.%I for update to authenticated using ((select public.is_team_member())) with check ((select public.is_team_member()))', t);
    execute format('create policy "time apaga" on public.%I for delete to authenticated using ((select public.is_team_member()))', t);
  end loop;
end $$;
create policy "time ou o cliente abre chamado" on public.client_tickets for insert to authenticated
  with check ((select public.is_team_member()) or client_id = (select public.my_client_id()));
create policy "time edita chamado" on public.client_tickets for update to authenticated
  using ((select public.is_team_member())) with check ((select public.is_team_member()));
create policy "time apaga chamado" on public.client_tickets for delete to authenticated using ((select public.is_team_member()));
create policy "time ou o cliente responde" on public.client_ticket_messages for insert to authenticated
  with check ((select public.is_team_member()) or client_id = (select public.my_client_id()));
create policy "time apaga mensagem" on public.client_ticket_messages for delete to authenticated using ((select public.is_team_member()));

-- ============================================================ Arquivos no Storage (bucket privado)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cliente-arquivos', 'cliente-arquivos', false, 26214400, array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/csv', 'text/plain', 'application/zip',
  'application/xml', 'text/xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'])
on conflict (id) do nothing;
-- Caminho: <id da empresa>/<arquivo>. O cliente só lê a pasta da própria empresa; o time faz tudo.
create policy "cliente-arquivos: time e o próprio cliente leem" on storage.objects for select to authenticated
  using (bucket_id = 'cliente-arquivos' and ((select public.is_team_member()) or (storage.foldername(name))[1] = (select public.my_client_id())::text));
create policy "cliente-arquivos: time envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'cliente-arquivos' and (select public.is_team_member()));
create policy "cliente-arquivos: time altera" on storage.objects for update to authenticated
  using (bucket_id = 'cliente-arquivos' and (select public.is_team_member())) with check (bucket_id = 'cliente-arquivos' and (select public.is_team_member()));
create policy "cliente-arquivos: time apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'cliente-arquivos' and (select public.is_team_member()));

-- ============================================================ Sala: cliente entra nas reuniões da empresa dele
-- Soma-se à regra do time ("membro cria o próprio ticket"): políticas de insert valem em "ou".
create policy "cliente da reunião cria o próprio ticket" on public.room_tickets for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.meetings m where m.room_code = room_tickets.room_code and m.client_id is not null and m.client_id = (select public.my_client_id())));
create or replace function public.verify_room_ticket(p_peer_id text, p_room_code text)
returns table (name text, email text)
language sql stable security definer set search_path = '' as $$
  select coalesce(tm.name, cu.name || ' (' || cl.name || ')'), coalesce(tm.email, cu.email)
  from public.room_tickets rt
  left join public.team_members tm on tm.user_id = rt.user_id and tm.active
  left join public.client_users cu on cu.user_id = rt.user_id and cu.active
  left join public.clients cl on cl.id = cu.client_id and cl.active
  where rt.peer_id = p_peer_id and rt.room_code = p_room_code
    and rt.created_at > now() - interval '12 hours'
    -- quem confere é do time ou é cliente da empresa dona da reunião
    and (public.is_team_member() or exists (select 1 from public.meetings m where m.room_code = p_room_code and m.client_id is not null and m.client_id = public.my_client_id()))
    -- quem entra é do time ou é cliente da empresa dona da reunião
    and (tm.email is not null or (cl.id is not null and exists (select 1 from public.meetings m where m.room_code = p_room_code and m.client_id = cl.id)))
  order by rt.created_at desc
  limit 1;
$$;

-- ============================================================ Funções: quem pode chamar
revoke execute on function public.guard_login_email(), public.issue_client_code(text, text), public.prepare_milestone(),
  public.prepare_ticket(), public.prepare_ticket_message(), public.touch_ticket(), public.login_display_name(uuid) from public, anon, authenticated;
revoke execute on function public.my_client_id(), public.is_client_user(), public.admin_issue_client_code(text, text) from public, anon;
grant execute on function public.my_client_id(), public.is_client_user(), public.admin_issue_client_code(text, text) to authenticated;

-- ============================================================ Tempo real
alter publication supabase_realtime add table public.clients, public.client_users, public.client_services, public.client_milestones,
  public.client_tickets, public.client_ticket_messages, public.client_files, public.client_invoices;

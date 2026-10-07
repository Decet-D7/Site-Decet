-- Índice para a chave estrangeira de room_tickets (apontado pelo advisor de desempenho).
create index room_tickets_user_id_idx on public.room_tickets (user_id);

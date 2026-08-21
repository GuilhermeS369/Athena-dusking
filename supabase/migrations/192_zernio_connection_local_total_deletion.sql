-- Exclusão total estritamente local de uma conexão Zernio.
-- Esta migration nunca consulta nem chama a Zernio: ela encerra somente o
-- estado persistido no Atena e revoga a credencial armazenada.

create table if not exists public.zernio_connection_total_deletion_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  zernio_connection_id uuid not null references public.zernio_connections(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null check (char_length(trim(idempotency_key)) between 16 and 240),
  status text not null default 'running' check (status in ('running', 'completed', 'blocked')),
  result jsonb not null default '{}'::jsonb check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  unique (organization_id, requested_by, idempotency_key)
);

alter table public.zernio_connection_total_deletion_operations enable row level security;
create policy zernio_connection_total_deletion_operations_select_admin
on public.zernio_connection_total_deletion_operations for select to authenticated
using (requested_by = auth.uid() and public.has_organization_role(organization_id, array['admin']::public.organization_role[]));
revoke all on public.zernio_connection_total_deletion_operations from public, anon;
grant select on public.zernio_connection_total_deletion_operations to authenticated;
grant all on public.zernio_connection_total_deletion_operations to service_role;

create or replace function public.begin_zernio_connection_total_deletion(
  p_connection_id uuid,
  p_idempotency_key text
)
returns public.zernio_connection_total_deletion_operations
language plpgsql security definer set search_path = public as $$
declare
  connection_row public.zernio_connections%rowtype;
  operation_row public.zernio_connection_total_deletion_operations%rowtype;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'Autenticação necessária.'; end if;
  if char_length(trim(coalesce(p_idempotency_key, ''))) not between 16 and 240 then raise exception using errcode = '22023', message = 'Chave de idempotência inválida.'; end if;

  select * into connection_row from public.zernio_connections
  where id = p_connection_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Conta Zernio não encontrada.'; end if;
  if not public.has_organization_role(connection_row.organization_id, array['admin']::public.organization_role[]) then raise exception using errcode = '42501', message = 'Somente administradores podem executar a exclusão total.'; end if;

  insert into public.zernio_connection_total_deletion_operations (
    organization_id, zernio_connection_id, requested_by, idempotency_key
  ) values (
    connection_row.organization_id, connection_row.id, auth.uid(), trim(p_idempotency_key)
  ) on conflict (organization_id, requested_by, idempotency_key) do nothing;

  select * into operation_row from public.zernio_connection_total_deletion_operations
  where organization_id = connection_row.organization_id and requested_by = auth.uid()
    and idempotency_key = trim(p_idempotency_key)
  for update;
  return operation_row;
end;
$$;

create or replace function public.execute_zernio_connection_total_deletion(
  p_operation_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  operation_row public.zernio_connection_total_deletion_operations%rowtype;
  connection_row public.zernio_connections%rowtype;
  profile_ids uuid[] := '{}'::uuid[];
  profile_id uuid;
  item_row public.publication_items%rowtype;
  cancellation jsonb;
  blocked_item_ids jsonb := '[]'::jsonb;
  deleted_profile_count integer := 0;
  released_reservation_count integer := 0;
  expired_turn_count integer := 0;
  result_value jsonb;
begin
  if auth.uid() is null then raise exception using errcode = '42501', message = 'Autenticação necessária.'; end if;
  select * into operation_row from public.zernio_connection_total_deletion_operations
  where id = p_operation_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Operação de exclusão total não encontrada.'; end if;
  if operation_row.requested_by <> auth.uid()
    or not public.has_organization_role(operation_row.organization_id, array['admin']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if operation_row.status <> 'running' then
    return operation_row.result || jsonb_build_object('operationId', operation_row.id, 'operationStatus', operation_row.status, 'idempotent', true);
  end if;

  select * into connection_row from public.zernio_connections
  where id = operation_row.zernio_connection_id and organization_id = operation_row.organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Conta Zernio não encontrada.'; end if;

  -- Nunca reativa uma conexão já removida; apenas finaliza a operação idempotente.
  if connection_row.deleted_at is not null then
    result_value := jsonb_build_object('completed', true, 'alreadyDeleted', true, 'profilesDeleted', 0, 'operationId', operation_row.id, 'localOnly', true);
    update public.zernio_connection_total_deletion_operations set status = 'completed', result = result_value, completed_at = timezone('utc', now()) where id = operation_row.id;
    return result_value;
  end if;

  for profile_id in
    select profile.id from public.instagram_profiles profile
    where profile.organization_id = operation_row.organization_id
      and profile.provider = 'zernio'
      and profile.zernio_connection_id = connection_row.id
      and profile.deleted_at is null
    order by profile.id
    for update
  loop
    profile_ids := array_append(profile_ids, profile_id);
  end loop;

  -- Faz o preflight completo antes de cancelar qualquer perfil. Assim uma
  -- publicação sob lease bloqueia toda a exclusão sem mutação parcial.
  for item_row in
    select item.* from public.publication_items item
    where item.organization_id = operation_row.organization_id
      and item.profile_id = any(profile_ids)
      and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
    order by item.created_at, item.id
    for update
  loop
    if item_row.status in ('preparing', 'publishing') then
      blocked_item_ids := blocked_item_ids || jsonb_build_array(item_row.id);
    end if;
  end loop;
  if jsonb_array_length(blocked_item_ids) > 0 then
    result_value := jsonb_build_object(
      'completed', false, 'blocked', true, 'operationId', operation_row.id,
      'blockedItemIds', blocked_item_ids,
      'message', 'Há publicação(ões) em processamento. Nenhuma alteração local foi aplicada.'
    );
    update public.zernio_connection_total_deletion_operations
    set status = 'blocked', result = result_value, completed_at = timezone('utc', now())
    where id = operation_row.id;
    return result_value;
  end if;

  -- A rotina de cancelamento é auditável e protege contra publicação sob lease.
  -- Ao levantar exceção abaixo, PostgreSQL desfaz integralmente qualquer perfil
  -- já processado nesta mesma transação.
  foreach profile_id in array profile_ids loop
    cancellation := public.cancel_publication_queue_scope('account', profile_id);
    if cancellation ->> 'state' = 'blocked' then
      raise exception using errcode = 'P0001', message = 'A fila mudou durante a exclusão total; nenhuma alteração foi aplicada.';
    end if;
  end loop;

  update public.zernio_connection_slot_reservations
  set released_at = coalesce(released_at, timezone('utc', now()))
  where organization_id = operation_row.organization_id and zernio_connection_id = connection_row.id
    and released_at is null;
  get diagnostics released_reservation_count = row_count;

  update public.zernio_oauth_turns
  set status = 'expired', finished_at = timezone('utc', now()), terminal_reason = 'connection_locally_deleted', lease_expires_at = null
  where organization_id = operation_row.organization_id and zernio_connection_id = connection_row.id
    and status in ('waiting', 'active');
  get diagnostics expired_turn_count = row_count;

  -- Impede que callbacks ou workers locais pendentes retomem um fluxo cuja
  -- conexão foi descartada. Não apagamos registros históricos de tentativas.
  update public.zernio_connection_attempts
  set status = 'failed', failed_at = coalesce(failed_at, timezone('utc', now())),
      last_error_message = 'Tentativa encerrada por exclusão total local da conta Zernio.'
  where organization_id = operation_row.organization_id and zernio_connection_id = connection_row.id
    and status in ('started', 'redirected', 'callback_received');

  update public.zernio_connection_intents
  set status = 'expired', expires_at = least(expires_at, timezone('utc', now())),
      diagnostic = diagnostic || jsonb_build_object('local_total_deletion_at', timezone('utc', now()))
  where organization_id = operation_row.organization_id
    and (requested_connection_id = connection_row.id or resolved_connection_id = connection_row.id)
    and status in ('started', 'reserved', 'redirected', 'callback_received');

  delete from public.profile_group_members member
  where member.organization_id = operation_row.organization_id and member.profile_id = any(profile_ids);

  foreach profile_id in array profile_ids loop
    perform public.soft_delete_profile_analytics(profile_id);
  end loop;

  update public.instagram_profiles
  set deleted_at = timezone('utc', now()), status = 'offline',
      last_error_code = 'zernio_connection_locally_discarded',
      last_error_message = 'Perfil removido por exclusão total local da conta Zernio; nenhuma chamada remota foi executada.'
  where id = any(profile_ids) and organization_id = operation_row.organization_id and deleted_at is null;
  get diagnostics deleted_profile_count = row_count;

  -- encrypted_api_key é NOT NULL. O tombstone invalida definitivamente o segredo
  -- local sem apagar histórico nem realizar qualquer ação na Zernio.
  update public.zernio_connections
  set deleted_at = timezone('utc', now()), status = 'offline',
      encrypted_api_key = 'revoked:' || gen_random_uuid()::text,
      last_error_code = 'zernio_connection_locally_discarded',
      last_error_message = 'Conta removida localmente por ação administrativa; nenhuma chamada remota foi executada.'
  where id = connection_row.id and organization_id = operation_row.organization_id and deleted_at is null;

  result_value := jsonb_build_object(
    'completed', true, 'operationId', operation_row.id, 'connectionId', connection_row.id,
    'profilesDeleted', deleted_profile_count, 'releasedReservations', released_reservation_count,
    'expiredOauthTurns', expired_turn_count, 'localOnly', true
  );
  update public.zernio_connection_total_deletion_operations
  set status = 'completed', result = result_value, completed_at = timezone('utc', now())
  where id = operation_row.id;
  return result_value;
end;
$$;

revoke all on function public.begin_zernio_connection_total_deletion(uuid, text) from public, anon;
revoke all on function public.execute_zernio_connection_total_deletion(uuid) from public, anon;
grant execute on function public.begin_zernio_connection_total_deletion(uuid, text) to authenticated;
grant execute on function public.execute_zernio_connection_total_deletion(uuid) to authenticated;
notify pgrst, 'reload schema';

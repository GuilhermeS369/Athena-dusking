-- Cada linha do bulk representa um aparelho distinto. A deduplicação deve usar
-- exclusivamente a intentKey daquela linha/aparelho, e não bloquear outra
-- solicitação legítima que escolheu a mesma chave Zernio.

create or replace function public.claim_zernio_connection_intent(
  p_organization_id uuid,
  p_created_by uuid,
  p_idempotency_key text,
  p_requested_connection_id uuid,
  p_requested_group_id uuid default null
)
returns table(intent_id uuid, intent_status text, reused boolean)
language plpgsql security definer set search_path = public as $$
declare existing public.zernio_connection_intents%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 160 then
    raise exception using errcode = '22023', message = 'Chave de idempotência inválida.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':zernio-intent:' || p_created_by::text || ':' || trim(p_idempotency_key), 0
  ));

  select * into existing
  from public.zernio_connection_intents intent
  where intent.organization_id = p_organization_id
    and intent.created_by = p_created_by
    and intent.idempotency_key = trim(p_idempotency_key)
  limit 1
  for update;

  if found then
    if existing.requested_connection_id <> p_requested_connection_id
       or existing.requested_group_id is distinct from p_requested_group_id then
      raise exception using errcode = '22023', message = 'A solicitação deste aparelho já existe com outro destino.';
    end if;
    intent_id := existing.id;
    intent_status := existing.status;
    reused := true;
    return next;
    return;
  end if;

  insert into public.zernio_connection_intents (
    organization_id, created_by, idempotency_key, requested_connection_id, requested_group_id
  ) values (
    p_organization_id, p_created_by, trim(p_idempotency_key), p_requested_connection_id, p_requested_group_id
  ) returning id, status into intent_id, intent_status;
  reused := false;
  return next;
end;
$$;

notify pgrst, 'reload schema';

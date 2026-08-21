-- Converge falsos negativos Zernio para a verdade externa sem gerar nova criação.
-- Também impede que a suspensão reutilize uma mensagem antiga incompatível com
-- o status que efetivamente disparou o trigger.

create or replace function public.reconcile_zernio_publication_item(
  p_item_id uuid,
  p_worker_id text,
  p_creation_id text,
  p_meta_media_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  resolved_creation_id text := nullif(trim(coalesce(p_creation_id, '')), '');
  resolved_worker_id text := trim(coalesce(p_worker_id, ''));
  resolved_now timestamptz := timezone('utc', now());
begin
  if char_length(resolved_worker_id) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if resolved_creation_id is null or char_length(resolved_creation_id) > 500 then
    raise exception using errcode = '22023', message = 'Identificador Zernio inválido.';
  end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
  for update;

  if item_row.id is null then
    raise exception using errcode = 'P0002', message = 'Item de publicação não encontrado.';
  end if;
  if item_row.status = 'published' then
    update public.publication_items item
    set creation_id = coalesce(item.creation_id, resolved_creation_id),
        meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), item.meta_media_id)
    where item.id = item_row.id;
    return jsonb_build_object('itemId', item_row.id, 'status', 'published', 'idempotent', true);
  end if;
  if item_row.status not in ('failed', 'suspended', 'preparing', 'publishing') then
    raise exception using errcode = '22023', message = 'Estado local incompatível com reconciliação Zernio.';
  end if;
  if item_row.status in ('preparing', 'publishing') and (
    item_row.claimed_by is distinct from resolved_worker_id
    or item_row.lease_until is null
    or item_row.lease_until <= resolved_now
  ) then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.';
  end if;

  update public.publication_items item
  set status = 'published',
      creation_id = resolved_creation_id,
      meta_media_id = coalesce(nullif(trim(p_meta_media_id), ''), item.meta_media_id),
      published_at = coalesce(item.published_at, resolved_now),
      claimed_by = null,
      lease_until = null,
      next_attempt_at = null,
      active_claim_consumed_attempt = false,
      suspended_at = null,
      suspension_reason = null,
      last_error_code = null,
      last_error_message = null
  where item.id = item_row.id;

  delete from public.publication_profile_daily_reservations where publication_item_id = item_row.id;
  delete from public.publication_dispatch_rate_reservations where publication_item_id = item_row.id;

  perform public.log_publication_item_event(
    item_row.id,
    'published',
    item_row.status,
    'published',
    null,
    resolved_worker_id,
    null,
    null,
    jsonb_build_object(
      'provider_confirmation_reconciled', true,
      'provider', 'zernio',
      'creation_id', resolved_creation_id,
      'previous_error_code', item_row.last_error_code,
      'historical_reconciliation', item_row.status in ('failed', 'suspended')
    )
  );
  perform public.mark_publication_item_media_as_published(item_row.id, item_row.organization_id);
  perform public.sync_publication_batch_status(item_row.batch_id);

  return jsonb_build_object(
    'itemId', item_row.id,
    'status', 'published',
    'idempotent', false,
    'previousStatus', item_row.status,
    'creationId', resolved_creation_id
  );
end;
$$;

create or replace function public.handle_profile_publication_suspension()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_reason text;
begin
  if (new.deleted_at is not null and old.deleted_at is null)
    or (new.status <> 'online' and old.status is distinct from new.status)
  then
    resolved_reason := case
      when new.deleted_at is not null then 'Perfil removido; retomada manual necessária.'
      else format('Perfil %s; retomada manual necessária.', new.status::text)
    end;
    perform public.suspend_offline_profile_publications(
      new.id,
      resolved_reason,
      'system: instagram-profile-status-trigger'
    );
  end if;
  return new;
end;
$$;

revoke all on function public.reconcile_zernio_publication_item(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.reconcile_zernio_publication_item(uuid, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

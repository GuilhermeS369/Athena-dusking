-- A migration 136 já foi aplicada antes da validação do constraint legado.
-- Substitui apenas a função, mantendo o token criptografado no registro
-- soft-deleted para respeitar o contrato histórico de credenciais Meta.

create or replace function public.finalize_meta_profile_disconnection(
  p_item_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_error_subcode integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_item public.publication_items%rowtype;
  profile_row public.instagram_profiles%rowtype;
  resolved_now timestamptz := timezone('utc', now());
  resolved_message text := left(coalesce(nullif(trim(p_error_message), ''),
    'Token Meta inválido; perfil removido automaticamente.'), 1200);
  ignored_count integer := 0;
  ignored_event_count integer := 0;
  cancelled_plan_count integer := 0;
  affected_batch uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if nullif(trim(p_worker_id), '') is null then
    raise exception using errcode = '22023', message = 'Worker obrigatório.';
  end if;

  select item.* into source_item
  from public.publication_items item
  where item.id = p_item_id
    and item.claimed_by = trim(p_worker_id)
    and item.lease_until > resolved_now
    and item.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.';
  end if;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = source_item.profile_id
    and profile.organization_id = source_item.organization_id
  for update;
  if not found or profile_row.provider <> 'meta_official' then
    raise exception using errcode = '22023', message = 'Perfil Meta oficial ativo não encontrado.';
  end if;
  if trim(coalesce(p_error_code, '')) <> '190' then
    raise exception using errcode = '22023', message = 'Somente erro terminal Meta 190 pode remover automaticamente o perfil.';
  end if;

  if profile_row.deleted_at is not null then
    return jsonb_build_object(
      'completed', true, 'idempotent', true, 'profileId', profile_row.id,
      'ignoredItemCount', 0, 'cancelledPlanCount', 0
    );
  end if;

  with targets as (
    select item.id, item.status as previous_status
    from public.publication_items item
    where item.organization_id = profile_row.organization_id
      and item.profile_id = profile_row.id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
      and item.meta_media_id is null
      and item.published_at is null
    for update
  ), ignored as (
    update public.publication_items item set
      status = 'ignored', claimed_by = null, lease_until = null,
      next_attempt_at = null,
      attempt_count = case
        when item.id = source_item.id and item.active_claim_consumed_attempt
          then greatest(item.attempt_count - 1, 0)
        else item.attempt_count
      end,
      active_claim_consumed_attempt = false,
      last_error_code = 'meta_profile_disconnected',
      last_error_message = 'Perfil Meta desconectado; publicação ignorada.'
    from targets
    where item.id = targets.id
    returning item.id, targets.previous_status
  ), events as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select profile_row.organization_id, ignored.id, 'ignored',
      ignored.previous_status, 'ignored', 'system: meta-profile-disconnection',
      'meta_profile_disconnected', 'Perfil Meta desconectado; publicação ignorada.',
      jsonb_build_object(
        'profile_id', profile_row.id,
        'source_item_id', source_item.id,
        'provider_error_code', left(trim(p_error_code), 120),
        'provider_error_subcode', p_error_subcode
      )
    from ignored
    returning publication_item_id
  )
  select
    (select count(*)::integer from ignored),
    (select count(*)::integer from events)
  into ignored_count, ignored_event_count;

  if ignored_count <> ignored_event_count then
    raise exception using errcode = 'P0001', message = 'Falha ao auditar publicações Meta ignoradas.';
  end if;

  delete from public.publication_profile_daily_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = profile_row.organization_id
    and item.profile_id = profile_row.id
    and item.status = 'ignored';

  delete from public.publication_dispatch_rate_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = profile_row.organization_id
    and item.profile_id = profile_row.id
    and item.status = 'ignored';

  update public.bulk_publication_generation_chunks chunk set
    status = 'cancelled', completed_at = coalesce(completed_at, resolved_now),
    claimed_by = null, lease_until = null,
    last_error_message = 'Perfil Meta desconectado; geração cancelada.'
  where chunk.organization_id = profile_row.organization_id
    and chunk.profile_id = profile_row.id
    and chunk.status in ('queued', 'processing', 'failed', 'paused');

  update public.bulk_publication_profile_horizons horizon set
    status = 'cancelled', released_at = coalesce(released_at, resolved_now)
  where horizon.organization_id = profile_row.organization_id
    and horizon.profile_id = profile_row.id
    and horizon.status = 'active';

  with cancelled_plans as (
    update public.bulk_publication_plan_profiles plan_profile set
      status = 'cancelled', suspended_at = coalesce(suspended_at, resolved_now),
      suspension_reason = 'Perfil Meta desconectado; removido automaticamente.'
    where plan_profile.organization_id = profile_row.organization_id
      and plan_profile.profile_id = profile_row.id
      and plan_profile.status in ('queued', 'generating', 'suspended')
    returning plan_profile.id
  ) select count(*)::integer into cancelled_plan_count from cancelled_plans;

  delete from public.profile_group_members
  where organization_id = profile_row.organization_id
    and profile_id = profile_row.id;

  update public.instagram_profiles set
    deleted_at = resolved_now,
    status = 'offline',
    last_error_code = 'meta_profile_disconnected',
    last_error_message = resolved_message
  where id = profile_row.id
    and organization_id = profile_row.organization_id
    and deleted_at is null;

  perform public.soft_delete_profile_analytics(profile_row.id);

  for affected_batch in
    select distinct item.batch_id
    from public.publication_items item
    where item.organization_id = profile_row.organization_id
      and item.profile_id = profile_row.id
  loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;

  return jsonb_build_object(
    'completed', true,
    'idempotent', false,
    'profileId', profile_row.id,
    'ignoredItemCount', ignored_count,
    'cancelledPlanCount', cancelled_plan_count,
    'errorCode', 'meta_profile_disconnected',
    'providerErrorCode', trim(p_error_code),
    'providerErrorSubcode', p_error_subcode
  );
end;
$$;

notify pgrst, 'reload schema';

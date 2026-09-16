-- Meta `25` "User access is restricted" (subcódigo 2207050) passa a derrubar o
-- perfil com o MESMO tratamento do `190` terminal (decisão do dono, 16/09/2026):
-- perfil `offline` + `deleted_at`, itens abertos `ignored/meta_profile_disconnected`,
-- planos cancelados, incidente `checkpoint_required` (conta como queda no XLSX),
-- eventos de saída de grupo, analytics congelado.
--
-- Por que: em 16/09 a Meta passou a recusar só a ESCRITA (POST /media) de ~100
-- perfis conectados entre 09 e 12/09 — leitura, token e cota intactos, conta
-- de pé no Instagram. Sem tratamento cada perfil perdia 1 reel por hora (337
-- reels até as 11:47 BRT) e os 5 `25` seguidos pausavam lotes inteiros (430).
--
-- O corpo do finalizador vira uma função por perfil
-- (`finalize_meta_profile_disconnection_for_profile`), para dois chamadores:
--   1. o worker, pela função de sempre (`finalize_meta_profile_disconnection`),
--      que continua exigindo o item sob lease e agora aceita `190` ou `25`;
--   2. a passada retroativa nos perfis que já deram `25` antes desta migration
--      (feita por fora, com `service_role`, item de origem = último reel com `25`).
-- Nada muda para o `190`: mesmas assinaturas, mesmo efeito.

create or replace function public.finalize_meta_profile_disconnection_for_profile(
  p_profile_id uuid,
  p_organization_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_error_subcode integer default null,
  p_source_item_id uuid default null
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
  incident_row public.meta_profile_disconnection_incidents%rowtype;
  app_label_snapshot text;
  views_snapshot bigint;
  views_synced_snapshot timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if nullif(trim(p_worker_id), '') is null then
    raise exception using errcode = '22023', message = 'Worker obrigatório.';
  end if;
  if trim(coalesce(p_error_code, '')) not in ('190', '25') then
    raise exception using errcode = '22023', message = 'Somente erro terminal Meta 190 ou 25 pode remover automaticamente o perfil.';
  end if;

  if p_source_item_id is not null then
    select item.* into source_item
    from public.publication_items item
    where item.id = p_source_item_id
      and item.organization_id = p_organization_id
      and item.profile_id = p_profile_id;
    -- Item de origem de outro perfil/organização é erro de chamada, não de dado.
    if not found then
      raise exception using errcode = '22023', message = 'Item de origem não pertence ao perfil.';
    end if;
  end if;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = p_profile_id
    and profile.organization_id = p_organization_id
  for update;
  if not found or profile_row.provider <> 'meta_official' then
    raise exception using errcode = '22023', message = 'Perfil Meta oficial ativo não encontrado.';
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
        when source_item.id is not null and item.id = source_item.id and item.active_claim_consumed_attempt
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

  -- Incidente e eventos de grupo ANTES do delete de `profile_group_members`
  -- (ver o comentário da 391: depois não há como saber de quais grupos saiu).
  select app.label into app_label_snapshot
  from public.meta_apps app
  where app.id = profile_row.meta_app_id
    and app.organization_id = profile_row.organization_id;

  select analytics.views, analytics.current_synced_at
  into views_snapshot, views_synced_snapshot
  from public.profile_analytics_current analytics
  where analytics.organization_id = profile_row.organization_id
    and analytics.profile_id = profile_row.id
    and analytics.deleted_at is null;

  -- `checkpoint_required` também para o 25: é o mesmo tratamento e conta como
  -- queda no XLSX; o `error_code` do incidente diz qual dos dois foi.
  insert into public.meta_profile_disconnection_incidents (
    organization_id, profile_id, meta_app_id, username_snapshot, meta_app_label_snapshot,
    source_item_id, source_batch_id, error_code, error_subcode, error_message,
    analytics_views_snapshot, analytics_synced_at_snapshot,
    ignored_item_count, cancelled_plan_count, finalized_at, signal
  ) values (
    profile_row.organization_id, profile_row.id, profile_row.meta_app_id,
    profile_row.username, app_label_snapshot,
    source_item.id, source_item.batch_id,
    left(trim(p_error_code), 120), p_error_subcode, resolved_message,
    views_snapshot, views_synced_snapshot,
    ignored_count, cancelled_plan_count, resolved_now, 'checkpoint_required'
  )
  on conflict (organization_id, profile_id) do update
    set updated_at = timezone('utc', now())
  returning * into incident_row;

  insert into public.meta_group_profile_removal_events (
    organization_id, group_id, profile_id, incident_id, removal_sequence, counted_at
  )
  select
    profile_row.organization_id, member.group_id, profile_row.id, incident_row.id,
    row_number() over (order by member.group_id), resolved_now
  from public.profile_group_members member
  where member.organization_id = profile_row.organization_id
    and member.profile_id = profile_row.id
  on conflict (incident_id, removal_sequence) do nothing;

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
    'incidentId', incident_row.id,
    'errorCode', 'meta_profile_disconnected',
    'providerErrorCode', trim(p_error_code),
    'providerErrorSubcode', p_error_subcode
  );
end;
$$;

-- A entrada do worker: mesma assinatura de sempre, mesmo lease obrigatório,
-- agora aceitando `190` ou `25`; delega o efeito à função por perfil.
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
  resolved_now timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if nullif(trim(p_worker_id), '') is null then
    raise exception using errcode = '22023', message = 'Worker obrigatório.';
  end if;
  if trim(coalesce(p_error_code, '')) not in ('190', '25') then
    raise exception using errcode = '22023', message = 'Somente erro terminal Meta 190 ou 25 pode remover automaticamente o perfil.';
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

  return public.finalize_meta_profile_disconnection_for_profile(
    source_item.profile_id, source_item.organization_id, p_worker_id,
    p_error_code, p_error_message, p_error_subcode, source_item.id
  );
end;
$$;

revoke all on function public.finalize_meta_profile_disconnection_for_profile(uuid, uuid, text, text, text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_meta_profile_disconnection_for_profile(uuid, uuid, text, text, text, integer, uuid)
  to service_role;
revoke all on function public.finalize_meta_profile_disconnection(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.finalize_meta_profile_disconnection(uuid, text, text, text, integer)
  to service_role;

notify pgrst, 'reload schema';

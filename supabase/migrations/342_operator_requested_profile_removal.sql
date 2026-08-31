-- Exclusão de perfis pedida pelo operador em /perfis, em massa.
--
-- O pipeline canônico de remoção já existe desde a migration 101
-- (zernio_profile_disconnection_incidents + zernio_profile_recycling_jobs) e já
-- é drenado a cada ciclo do worker de publicação. O que faltava era um caminho
-- de enfileiramento a pedido de uma pessoa: até aqui só workers enfileiravam,
-- sempre a partir de um sinal de queda vindo da Zernio.
--
-- Reaproveitar esse pipeline em vez de criar outro é o que garante, de graça, o
-- DELETE remoto com retry/dead-letter, a contenção da fila publicável, o
-- desvínculo de grupos e o soft-delete — tudo já implementado e testado em
-- complete_zernio_profile_recycling (migration 127).
--
-- Duas diferenças em relação à queda automática:
--
-- 1. O sinal é 'operator_requested'. Isso o mantém fora do contador de queda de
--    perfil (capture_zernio_group_profile_removal_event, migration 203, filtra
--    por 'account_disconnected'/'auth_expired'): exclusão pedida pelo operador
--    não é queda e não pode poluir essa métrica.
-- 2. A mensagem gravada nos itens cancelados precisa dizer o que de fato
--    aconteceu. Por isso a contenção vira uma função parametrizada e
--    contain_zernio_disconnected_profile passa a delegar para ela.
--
-- Perfis meta_official não têm conta remota na Zernio para apagar: são
-- finalizados localmente aqui mesmo, com a mesma contenção de fila e o mesmo
-- desvínculo de grupos, para não existirem dois significados de "excluído".

alter table public.zernio_profile_disconnection_incidents
  drop constraint if exists zernio_profile_disconnection_incidents_signal_check;

alter table public.zernio_profile_disconnection_incidents
  add constraint zernio_profile_disconnection_incidents_signal_check
  check (signal in ('account_disconnected', 'auth_expired', 'duplicate_identity_auto_removed', 'operator_requested'));

alter table public.zernio_profile_disconnection_incidents
  drop constraint if exists zernio_profile_disconnection_incidents_source_check;

alter table public.zernio_profile_disconnection_incidents
  add constraint zernio_profile_disconnection_incidents_source_check
  check (source in ('publication_worker', 'historical_backfill', 'zernio_sync_worker', 'operator_panel'));

-- Contenção parametrizada -----------------------------------------------------
-- Corpo idêntico ao de contain_zernio_disconnected_profile (migration 285), com
-- três mudanças: o motivo vem por parâmetro, o perfil não precisa ser Zernio, e
-- o soft-delete opcional permite finalizar num passo só quem não tem remoto.

create or replace function public.contain_instagram_profile_for_removal(
  p_organization_id uuid,
  p_profile_id uuid,
  p_incident_id uuid,
  p_reason_code text,
  p_reason_message text,
  p_actor_label text default 'system: instagram-profile-containment',
  p_finalize_local boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ignored_count integer := 0;
  plan_count integer := 0;
  affected_batch uuid;
  reason_code text := left(coalesce(nullif(trim(p_reason_code), ''), 'profile_removed'), 120);
  reason_message text := left(coalesce(nullif(trim(p_reason_message), ''), 'Perfil removido; publicação cancelada.'), 1200);
  actor_label text := left(coalesce(nullif(trim(p_actor_label), ''), 'system: instagram-profile-containment'), 180);
begin
  update public.instagram_profiles set
    status = 'offline',
    last_error_code = reason_code,
    last_error_message = reason_message
  where id = p_profile_id and organization_id = p_organization_id and deleted_at is null;

  with targets as (
    select item.id, item.status as previous_status
    from public.publication_items item
    where item.organization_id = p_organization_id and item.profile_id = p_profile_id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
    for update
  ), ignored as (
    update public.publication_items item set
      status = 'ignored', claimed_by = null, lease_until = null,
      next_attempt_at = null, attempt_count = 0,
      last_error_code = reason_code,
      last_error_message = reason_message
    from targets where item.id = targets.id
    returning item.id, targets.previous_status
  ), logged as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select p_organization_id, ignored.id, 'cancelled', ignored.previous_status,
      'ignored', actor_label, reason_code, reason_message,
      jsonb_build_object('incident_id', p_incident_id, 'containment', 'profile_removal')
    from ignored returning publication_item_id
  ) select count(*)::integer into ignored_count from logged;

  delete from public.publication_profile_daily_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = p_organization_id and item.profile_id = p_profile_id;
  delete from public.publication_dispatch_rate_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = p_organization_id and item.profile_id = p_profile_id;

  update public.bulk_publication_generation_chunks chunk set
    status = 'cancelled', completed_at = coalesce(completed_at, timezone('utc', now())),
    claimed_by = null, lease_until = null
  where chunk.organization_id = p_organization_id and chunk.profile_id = p_profile_id
    and chunk.status in ('queued', 'processing', 'failed', 'paused');
  update public.bulk_publication_profile_horizons horizon set
    status = 'cancelled', released_at = coalesce(released_at, timezone('utc', now()))
  where horizon.organization_id = p_organization_id and horizon.profile_id = p_profile_id
    and horizon.status = 'active';
  with updated_plans as (
    update public.bulk_publication_plan_profiles plan_profile set
      status = 'cancelled', suspended_at = coalesce(suspended_at, timezone('utc', now())),
      suspension_reason = reason_message
    where plan_profile.organization_id = p_organization_id and plan_profile.profile_id = p_profile_id
      and plan_profile.status in ('queued', 'generating', 'suspended')
    returning plan_profile.id
  ) select count(*)::integer into plan_count from updated_plans;

  -- Só para quem não tem contrapartida remota a apagar. Para perfis Zernio o
  -- soft-delete continua sendo responsabilidade de complete_zernio_profile_recycling,
  -- depois da confirmação do DELETE na Zernio: apagar antes esconderia da tela um
  -- perfil que ainda ocupa a vaga.
  if p_finalize_local then
    delete from public.profile_group_members
    where organization_id = p_organization_id and profile_id = p_profile_id;
    update public.instagram_profiles set deleted_at = timezone('utc', now())
    where id = p_profile_id and organization_id = p_organization_id and deleted_at is null;
  end if;

  for affected_batch in
    select distinct item.batch_id from public.publication_items item
    where item.organization_id = p_organization_id and item.profile_id = p_profile_id
  loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;

  return jsonb_build_object('contained', true, 'ignoredItemCount', ignored_count, 'interruptedPlanCount', plan_count);
end;
$$;

create or replace function public.contain_zernio_disconnected_profile(
  p_organization_id uuid,
  p_profile_id uuid,
  p_incident_id uuid,
  p_actor_label text default 'system: zernio-profile-containment'
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao service_role.';
  end if;
  return public.contain_instagram_profile_for_removal(
    p_organization_id, p_profile_id, p_incident_id,
    'zernio_account_disconnected',
    'Conta Zernio desconectada; publicação ignorada.',
    coalesce(nullif(trim(p_actor_label), ''), 'system: zernio-profile-containment'),
    false
  );
end;
$$;

-- Resumo do que a exclusão vai fazer ------------------------------------------
-- Alimenta o modal de confirmação. Sem mutação: é o dry-run.

create or replace function public.preview_instagram_profile_removal(
  p_organization_id uuid,
  p_profile_ids uuid[]
)
returns table (
  total integer,
  zernio_count integer,
  meta_count integer,
  already_queued integer,
  connection_labels text[],
  pending_item_count integer
)
language sql stable security definer set search_path = public as $$
  with allowed as (
    select coalesce(auth.role(), '') = 'service_role'
      or public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) as ok
  ), targets as (
    select profile.id, profile.provider::text as provider, profile.zernio_connection_id
    from public.instagram_profiles profile
    cross join allowed
    where allowed.ok
      and profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and profile.id = any (coalesce(p_profile_ids, array[]::uuid[]))
  )
  select
    (select count(*)::integer from targets),
    (select count(*)::integer from targets where provider = 'zernio'),
    (select count(*)::integer from targets where provider <> 'zernio'),
    (select count(*)::integer
       from public.zernio_profile_recycling_jobs job
       join public.zernio_profile_disconnection_incidents incident on incident.id = job.incident_id
      where incident.organization_id = p_organization_id
        and incident.profile_id in (select id from targets)
        and job.status <> 'completed'),
    (select coalesce(array_agg(distinct connection.label), array[]::text[])
       from public.zernio_connections connection
      where connection.organization_id = p_organization_id
        and connection.id in (select zernio_connection_id from targets where zernio_connection_id is not null)),
    (select count(*)::integer
       from public.publication_items item
      where item.organization_id = p_organization_id
        and item.profile_id in (select id from targets)
        and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'));
$$;

-- Enfileiramento --------------------------------------------------------------

-- A função é derrubada antes porque as colunas de saída mudaram de nome durante
-- o desenvolvimento e create or replace não altera o tipo de retorno.
drop function if exists public.enqueue_instagram_profile_removal(uuid, uuid[], text);

create or replace function public.enqueue_instagram_profile_removal(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_actor_label text default 'operator: /perfis'
)
-- As colunas de saída levam prefixo porque, em plpgsql, um OUT chamado
-- `profile_id` sequestra o `profile_id` do `on conflict (organization_id,
-- profile_id)` mais abaixo — alvo de conflito não aceita qualificação.
returns table (removed_profile_id uuid, removed_username text, removed_outcome text)
language plpgsql security definer set search_path = public as $$
declare
  profile_row public.instagram_profiles%rowtype;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  connection_label text;
  actor_label text := left(coalesce(nullif(trim(p_actor_label), ''), 'operator: /perfis'), 180);
  target_id uuid;
  had_open_job boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Somente administradores e operadores podem excluir perfis.';
  end if;

  foreach target_id in array coalesce(p_profile_ids, array[]::uuid[]) loop
    select profile.* into profile_row
    from public.instagram_profiles profile
    where profile.id = target_id
      and profile.organization_id = p_organization_id
      and profile.deleted_at is null
    for update;

    if not found then
      removed_profile_id := target_id; removed_username := null; removed_outcome := 'skipped_not_found';
      return next; continue;
    end if;

    if profile_row.provider::text = 'zernio'
      and nullif(trim(coalesce(profile_row.zernio_account_id, '')), '') is not null then
      select connection.label into connection_label
      from public.zernio_connections connection
      where connection.id = profile_row.zernio_connection_id
        and connection.organization_id = p_organization_id;

      select exists (
        select 1 from public.zernio_profile_recycling_jobs job
        join public.zernio_profile_disconnection_incidents incident on incident.id = job.incident_id
        where incident.organization_id = p_organization_id
          and incident.profile_id = profile_row.id
          and job.status <> 'completed'
      ) into had_open_job;

      insert into public.zernio_profile_disconnection_incidents (
        organization_id, profile_id, zernio_connection_id, zernio_account_id,
        username_snapshot, connection_label_snapshot, signal, source,
        error_code, error_message, detected_at, state
      ) values (
        p_organization_id, profile_row.id, profile_row.zernio_connection_id,
        profile_row.zernio_account_id, profile_row.username, connection_label,
        'operator_requested', 'operator_panel',
        'profile_removed_by_operator',
        'Perfil excluído pelo operador no painel; a conta será removida da Zernio.',
        timezone('utc', now()), 'remote_removal_pending'
      ) on conflict (organization_id, profile_id) do update set
        signal = excluded.signal, source = excluded.source,
        zernio_connection_id = excluded.zernio_connection_id,
        zernio_account_id = excluded.zernio_account_id,
        connection_label_snapshot = excluded.connection_label_snapshot,
        error_code = excluded.error_code, error_message = excluded.error_message,
        updated_at = timezone('utc', now()),
        last_observed_at = timezone('utc', now()),
        finalized_at = null, defer_reason = null,
        state = case when public.zernio_profile_disconnection_incidents.state = 'completed'
          then public.zernio_profile_disconnection_incidents.state
          else 'remote_removal_pending' end
      returning * into incident_row;

      insert into public.zernio_profile_recycling_jobs (organization_id, incident_id, status)
      values (p_organization_id, incident_row.id, 'pending')
      on conflict (incident_id) do update set
        status = case when public.zernio_profile_recycling_jobs.status = 'completed'
          then public.zernio_profile_recycling_jobs.status else 'pending' end,
        claimed_by = case when public.zernio_profile_recycling_jobs.status = 'completed'
          then public.zernio_profile_recycling_jobs.claimed_by else null end,
        lease_until = case when public.zernio_profile_recycling_jobs.status = 'completed'
          then public.zernio_profile_recycling_jobs.lease_until else null end,
        next_attempt_at = case when public.zernio_profile_recycling_jobs.status = 'completed'
          then public.zernio_profile_recycling_jobs.next_attempt_at
          else timezone('utc', now()) end;

      perform public.contain_instagram_profile_for_removal(
        p_organization_id, profile_row.id, incident_row.id,
        'profile_removed_by_operator',
        'Perfil excluído pelo operador; publicação cancelada.',
        actor_label, false
      );

      removed_profile_id := profile_row.id;
      removed_username := profile_row.username;
      removed_outcome := case when had_open_job then 'already_queued' else 'queued' end;
      return next;
    else
      perform public.contain_instagram_profile_for_removal(
        p_organization_id, profile_row.id, null,
        'profile_removed_by_operator',
        'Perfil excluído pelo operador; publicação cancelada.',
        actor_label, true
      );
      removed_profile_id := profile_row.id;
      removed_username := profile_row.username;
      removed_outcome := 'deleted_local';
      return next;
    end if;
  end loop;
end;
$$;

-- Ids do filtro corrente ------------------------------------------------------
-- O predicado é copiado de list_instagram_profiles_catalog_page (migration 317)
-- para que "todos deste filtro" signifique exatamente o que a tela mostra. O
-- distinct existe porque profile_group_members tem PK (group_id, profile_id):
-- sem filtro de grupo, um perfil em dois grupos apareceria duas vezes no join.

create or replace function public.list_instagram_profiles_catalog_ids(
  p_organization_id uuid,
  p_limit integer default 2000,
  p_query text default null,
  p_group_id uuid default null,
  p_status text default null,
  p_situation text default null,
  p_publication text default 'all'
)
returns table (id uuid)
language sql stable security definer set search_path = public, extensions as $$
  with allowed as (
    select coalesce(auth.role(), '') = 'service_role'
      or public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) as ok
  ), normalized as (
    select
      least(greatest(coalesce(p_limit, 2000), 1), 2000) as page_limit,
      nullif(lower(trim(coalesce(p_query, ''))), '') as search_query,
      nullif(lower(trim(coalesce(p_status, ''))), '') as status_filter,
      nullif(lower(trim(coalesce(p_situation, ''))), '') as situation_filter,
      coalesce(nullif(lower(trim(coalesce(p_publication, 'all'))), ''), 'all') as publication_filter
  ), candidates as (
    select distinct profile.id, profile.created_at
    from public.instagram_profiles profile
    cross join normalized filter
    cross join allowed
    left join public.profile_group_members membership
      on membership.organization_id = profile.organization_id
     and membership.profile_id = profile.id
    left join public.zernio_connections connection
      on connection.organization_id = profile.organization_id
     and connection.id = profile.zernio_connection_id
     and connection.deleted_at is null
    where allowed.ok
      and profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and (p_group_id is null or membership.group_id = p_group_id)
      and (filter.status_filter is null or profile.status::text = filter.status_filter)
      and (
        filter.situation_filter is null
        or (filter.situation_filter = 'online' and profile.status::text = 'online')
        or (filter.situation_filter = 'error' and (profile.status::text = 'reauthorization_required' or profile.last_error_message is not null))
        or (filter.situation_filter = 'paused' and profile.status::text in ('offline', 'no_data'))
      )
      and (
        filter.publication_filter = 'all'
        or (
          filter.publication_filter = 'posted'
          and exists (
            select 1
            from public.profile_publication_catalog_current catalog_filter
            where catalog_filter.organization_id = profile.organization_id
              and catalog_filter.profile_id = profile.id
              and catalog_filter.published_total > 0
          )
        )
      )
      and (
        filter.search_query is null
        or lower(profile.username) like '%' || trim(leading '@' from filter.search_query) || '%'
        or lower(coalesce(profile.display_name, '')) like '%' || filter.search_query || '%'
        or lower(coalesce(connection.label, '')) like '%' || filter.search_query || '%'
      )
  )
  select candidate.id
  from candidates candidate
  order by candidate.created_at desc, candidate.id desc
  limit (select page_limit from normalized);
$$;

revoke all on function public.contain_instagram_profile_for_removal(uuid, uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.contain_instagram_profile_for_removal(uuid, uuid, uuid, text, text, text, boolean) to service_role;

revoke all on function public.preview_instagram_profile_removal(uuid, uuid[]) from public, anon;
grant execute on function public.preview_instagram_profile_removal(uuid, uuid[]) to authenticated, service_role;

revoke all on function public.enqueue_instagram_profile_removal(uuid, uuid[], text) from public, anon;
grant execute on function public.enqueue_instagram_profile_removal(uuid, uuid[], text) to authenticated, service_role;

revoke all on function public.list_instagram_profiles_catalog_ids(uuid, integer, text, uuid, text, text, text) from public, anon;
grant execute on function public.list_instagram_profiles_catalog_ids(uuid, integer, text, uuid, text, text, text) to authenticated, service_role;

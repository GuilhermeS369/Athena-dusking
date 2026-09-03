-- Exclusao de perfis morria em statement timeout (57014) na primeira fatia.
--
-- SINTOMA. 12 perfis do GG LAURINHA, selecionados na tela de Recuperacao.
-- A rota fatiou em 11 + 1 (426 itens de fila abertos, 36 por perfil) e a
-- PRIMEIRA chamada de enqueue_instagram_profile_removal voltou 57014 — nada foi
-- enfileirado, e a tela mostrou "codigo 57014".
--
-- CAUSA. O laco final de contain_instagram_profile_for_removal (migration 342,
-- herdado da 285) sincronizava o status de TODO batch que o perfil ja tocou na
-- vida:
--
--   for affected_batch in
--     select distinct item.batch_id from publication_items item
--     where item.organization_id = ... and item.profile_id = ...
--
-- Medido em producao em 03/09/2026, para esses 12 perfis:
--
--   itens de fila por perfil ................ 473 (36 abertos)
--   batches distintos por perfil ............  12
--   batches com item ABERTO .................   2
--   batches JA TOTALMENTE TERMINAIS .........  10
--   tamanho dos 4 maiores ... 30.096 / 24.000 / 15.480 / 14.400 itens
--
-- Um batch totalmente terminal e o pior caso possivel para
-- sync_publication_batch_status: os tres `exists` dele so provam a ausencia
-- varrendo o batch inteiro. Custo de servidor medido do PRIMEIRO exists, por
-- perfil: ~374 ms somados nos 12 batches. Vezes 11 perfis da fatia: ~4,1 s — e
-- isso e um terco do trabalho, porque nos 10 batches terminais os outros dois
-- `exists` tambem varrem tudo. O orcamento de 8 s ia embora antes de os 396
-- itens serem sequer considerados.
--
-- E o laco fazia 12 x 11 = 132 sincronizacoes quando 2 bastavam.
--
-- O QUE MUDA. O status de um batch so pode mudar se o status de algum item dele
-- mudou. A contencao ja sabe exatamente quais itens virou 'ignored' — a CTE
-- `ignored`. O laco passa a ser dirigido por ela, e nao pela vida inteira do
-- perfil. Nos 10 batches terminais nenhum item mudou; sincroniza-los era
-- recalcular um valor que nao tinha como ser diferente.
--
-- Segunda mudanca, no mesmo espirito: quem exclui em massa nao precisa
-- sincronizar o mesmo batch uma vez por perfil. contain_...for_removal ganha
-- `p_defer_batch_sync`; com ele ligado, devolve os batches afetados em
-- `affectedBatchIds` em vez de sincronizar, e enqueue_instagram_profile_removal
-- junta tudo e sincroniza cada batch UMA vez, depois do laco. Dentro da mesma
-- transacao o resultado e identico — e mais correto, porque sincroniza sobre o
-- estado final em vez de sobre estados intermediarios.
--
-- Para os 12 perfis: de 132 sincronizacoes (10 delas varrendo batches de dezenas
-- de milhares de itens) para 2, ambas em batches com item aberto, onde o
-- primeiro `exists` acha na hora (14 ms e 10 ms medidos).
--
-- O padrao de p_defer_batch_sync e false, entao contain_zernio_disconnected_profile
-- — o caminho do worker, um perfil por vez — nao muda de comportamento.
--
-- PRECEDENTE. Isto nao inventa padrao nenhum: suspend_offline_profile_publications
-- (migration 088) ja coleta affected_batch_ids da propria CTE que suspendeu os
-- itens e sincroniza so esses. A contencao da 342 era a excecao que varria a vida
-- inteira do perfil. Depois desta migration as duas fazem a mesma coisa do mesmo
-- jeito — o que importa porque as duas rodam na MESMA transacao: a primeira linha
-- da contencao poe o perfil em 'offline', o que dispara
-- handle_profile_publication_suspension (migration 208) e roda a 088 antes.
--
-- CONSIDERADO E RECUSADO: indice parcial em publication_items (batch_id) where
-- status nao-terminal, para deixar o `exists` O(1). Resolveria o sintoma sem
-- resolver a causa, e poria um indice novo no caminho de escrita mais quente da
-- fila para acelerar chamadas que, depois desta migration, nao acontecem mais.
--
-- RESSALVA HONESTA: se algum batch estiver com `status` desatualizado por um bug
-- anterior, o laco antigo o consertava de raspao ao passar por ali. Isso era
-- acidente, nao contrato — reparo de status divergente e trabalho de script de
-- manutencao, nao de uma funcao de exclusao de perfil.

-- A assinatura ganha um parametro. create or replace com lista diferente criaria
-- uma sobrecarga em vez de substituir, e as chamadas posicionais de 7 argumentos
-- continuariam caindo na versao velha.
drop function if exists public.contain_instagram_profile_for_removal(uuid, uuid, uuid, text, text, text, boolean);

create or replace function public.contain_instagram_profile_for_removal(
  p_organization_id uuid,
  p_profile_id uuid,
  p_incident_id uuid,
  p_reason_code text,
  p_reason_message text,
  p_actor_label text default 'system: instagram-profile-containment',
  p_finalize_local boolean default false,
  p_defer_batch_sync boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ignored_count integer := 0;
  plan_count integer := 0;
  affected_batches uuid[] := array[]::uuid[];
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
    -- batch_id entra no returning: e daqui que sai a lista de batches a
    -- sincronizar, em vez de uma varredura pela vida inteira do perfil.
    returning item.id, item.batch_id, targets.previous_status
  ), logged as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select p_organization_id, ignored.id, 'cancelled', ignored.previous_status,
      'ignored', actor_label, reason_code, reason_message,
      jsonb_build_object('incident_id', p_incident_id, 'containment', 'profile_removal')
    from ignored returning publication_item_id
  )
  -- Com `ignored` vazia a consulta ainda devolve uma linha: agregado sem group by
  -- sobre conjunto vazio da (0, null), e o coalesce cuida do array.
  select (select count(*)::integer from logged),
         coalesce(array_agg(distinct ignored.batch_id), array[]::uuid[])
    into ignored_count, affected_batches
  from ignored;

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

  if not p_defer_batch_sync then
    foreach affected_batch in array affected_batches loop
      perform public.sync_publication_batch_status(affected_batch);
    end loop;
  end if;

  return jsonb_build_object(
    'contained', true,
    'ignoredItemCount', ignored_count,
    'interruptedPlanCount', plan_count,
    -- Sempre presente, mesmo sem defer: quem chama pode querer auditar o que foi
    -- tocado sem ter de deduzir.
    'affectedBatchIds', to_jsonb(affected_batches),
    'batchSyncDeferred', p_defer_batch_sync
  );
end;
$$;

-- Enfileiramento em massa: uma sincronizacao por batch, nao uma por (perfil, batch).

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
  containment jsonb;
  profile_batches uuid[] := array[]::uuid[];
  pending_batches uuid[] := array[]::uuid[];
  affected_batch uuid;
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

      containment := public.contain_instagram_profile_for_removal(
        p_organization_id, profile_row.id, incident_row.id,
        'profile_removed_by_operator',
        'Perfil excluído pelo operador; publicação cancelada.',
        actor_label, false, true
      );

      removed_profile_id := profile_row.id;
      removed_username := profile_row.username;
      removed_outcome := case when had_open_job then 'already_queued' else 'queued' end;
      return next;
    else
      containment := public.contain_instagram_profile_for_removal(
        p_organization_id, profile_row.id, null,
        'profile_removed_by_operator',
        'Perfil excluído pelo operador; publicação cancelada.',
        actor_label, true, true
      );
      removed_profile_id := profile_row.id;
      removed_username := profile_row.username;
      removed_outcome := 'deleted_local';
      return next;
    end if;

    select coalesce(array_agg(touched.batch_id::uuid), array[]::uuid[])
      into profile_batches
    from jsonb_array_elements_text(
      coalesce(containment -> 'affectedBatchIds', '[]'::jsonb)
    ) as touched(batch_id);
    pending_batches := pending_batches || profile_batches;
  end loop;

  -- Uma vez por batch, sobre o estado final da transacao.
  for affected_batch in
    select distinct listed.batch_id from unnest(pending_batches) as listed(batch_id)
  loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;
end;
$$;

revoke all on function public.contain_instagram_profile_for_removal(uuid, uuid, uuid, text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.contain_instagram_profile_for_removal(uuid, uuid, uuid, text, text, text, boolean, boolean) to service_role;

revoke all on function public.enqueue_instagram_profile_removal(uuid, uuid[], text) from public, anon;
grant execute on function public.enqueue_instagram_profile_removal(uuid, uuid[], text) to authenticated, service_role;

notify pgrst, 'reload schema';

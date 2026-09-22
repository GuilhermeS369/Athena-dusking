-- Reconectar pela API da Meta reativa o perfil que o operador excluiu.
--
-- O QUE ACONTECEU EM 22/09/2026. Na organizacao "Vini farmando cash" o perfil
-- `kamillagodinho604` foi conectado as 16:25:32 BRT e excluido pelo operador as
-- 16:26:52. Ao conectar de novo, o callback devolveu `profile_save_failed` com
-- diagnostico `23505`. Nao era o caso isolado: nenhum perfil Meta excluido
-- conseguia voltar para a mesma organizacao (4.431 linhas apagadas nesse
-- estado naquele dia).
--
-- POR QUE. A exclusao e logica: a linha fica com `deleted_at` e com o mesmo
-- `instagram_user_id`. `connect_meta_instagram_profile` (399) so procura
-- perfil vivo e, sem achar, faz INSERT -- que bate no
-- `unique (organization_id, instagram_user_id)` da migration 002, uma regra
-- que conta tambem as linhas apagadas.
--
-- O QUE MUDA (decisao do dono, 22/09/2026).
--   * Excluido pelo operador (`profile_removed_by_operator`): a reconexao
--     REATIVA a mesma linha -- mesmo id, historico e metricas diarias de volta,
--     token novo. Serve para exclusao acidental. Volta SEM grupos (os vinculos
--     foram apagados de verdade na exclusao e a remocao manual nao guarda de
--     quais grupos o perfil saiu) e sem as publicacoes que viraram `ignored`.
--   * Qualquer outro motivo (checkpoint 190/25, pedido de exclusao de dados da
--     Meta, ...): a reconexao cria um perfil NOVO e a linha antiga fica apagada,
--     como registro. Conta em checkpoint e descartavel por regra; se voltou,
--     comeca do zero.
--
-- A VAGA DO APP. A linha apagada costuma ter um incidente em
-- `meta_profile_disconnection_incidents` segurando a vaga do app de origem
-- (`slot_released_at` nulo: do lado da Meta a conexao continua la). Quando a
-- conta volta, esse incidente e marcado com `reconnected_at`. Se voltou pelo
-- MESMO app, a conexao esta em uso de novo e a vaga presa e liberada na hora --
-- a mesma regra de "volta para o app de origem" da 399; sem isso o app contaria
-- a conta duas vezes, como ativa e como vaga presa. Se voltou por OUTRO app, a
-- vaga do app antigo continua presa, porque la a conexao segue existindo. Por
-- isso a reativacao nao grava `meta_profile_app_transfers`: o incidente ja e o
-- rastro da vaga antiga, e gravar os dois contaria em dobro.
--
-- UM INCIDENTE POR QUEDA, NAO POR PERFIL. Um perfil reativado pode ser excluido
-- de novo. Com o `unique (organization_id, profile_id)` da 376, a segunda
-- remocao nao abriria incidente (o caminho do operador faz `do nothing`, o do
-- checkpoint so toca `updated_at`) e a vaga presa sumiria da tela /meta. O
-- unico passa a valer so para o incidente em aberto (`reconnected_at` nulo), e
-- as duas funcoes que o gravam sao reemitidas com o `on conflict` apontando
-- para esse indice -- unica mudanca nelas, copiadas dos arquivos 391 e 431,
-- conferidos iguais a producao em 22/09/2026.
--
-- ENSAIO. Rodada inteira em producao numa transacao desfeita em 22/09/2026
-- (~18:55 BRT, pool 18): migration em 51-160 ms; a kamilla voltou `restored`
-- pelo mesmo app com a vaga liberada e sem transferencia; excluida de novo
-- abriu um segundo incidente com vaga presa; voltou por outro app `restored`
-- com a vaga do app antigo ainda presa; o finalizador de checkpoint abriu o
-- terceiro incidente no perfil reativado; uma conta caida por checkpoint
-- voltou como perfil novo e liberou a vaga do mesmo app. Nada ficou gravado.

set lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. O id da Meta e unico so entre perfis vivos
-- ---------------------------------------------------------------------------
-- A condicao `zernio:%` mantem exatamente a regra antiga para os ids
-- sinteticos da Zernio, cuja reconexao por lapide (164) depende dela.
create unique index if not exists instagram_profiles_org_instagram_user_live_key
  on public.instagram_profiles (organization_id, instagram_user_id)
  where deleted_at is null or instagram_user_id like 'zernio:%';

alter table public.instagram_profiles
  drop constraint if exists instagram_profiles_organization_id_instagram_user_id_key;

-- ---------------------------------------------------------------------------
-- 2. Incidente de queda: um em aberto por perfil
-- ---------------------------------------------------------------------------
alter table public.meta_profile_disconnection_incidents
  add column if not exists reconnected_at timestamptz,
  add column if not exists reconnected_meta_app_id uuid references public.meta_apps(id) on delete set null;

comment on column public.meta_profile_disconnection_incidents.reconnected_at is
  'A conta voltou a ser conectada na organizacao (perfil reativado ou recriado). Incidente com isto preenchido esta encerrado; a vaga presa so e liberada junto quando a volta foi pelo mesmo app.';

create unique index if not exists meta_disconnection_incidents_open_profile_key
  on public.meta_profile_disconnection_incidents (organization_id, profile_id)
  where reconnected_at is null;

alter table public.meta_profile_disconnection_incidents
  drop constraint if exists meta_profile_disconnection_incid_organization_id_profile_id_key;

-- ---------------------------------------------------------------------------
-- 3. As duas funcoes que gravam o incidente apontam para o unico em aberto
-- ---------------------------------------------------------------------------
-- Copias integrais de 431 (finalize_meta_profile_disconnection_for_profile) e
-- 391 (enqueue_instagram_profile_removal), conferidas iguais a producao em
-- 22/09/2026. A UNICA linha trocada em cada uma e o `on conflict` do incidente
-- Meta, que ganha `where reconnected_at is null`: indice unico parcial so e
-- reconhecido pelo `on conflict` que repete a condicao dele, e sem isso as
-- duas remocoes falhariam com 42P10 assim que a constraint antiga sai.
-- O `on conflict` do incidente da Zernio, dentro da segunda, nao muda.

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
  on conflict (organization_id, profile_id) where reconnected_at is null do update
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
  meta_app_label text;
  meta_views_snapshot bigint;
  meta_views_synced timestamptz;
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
      -- Perfil META removido a pedido de uma pessoa: o bulk de /perfis, a
      -- exclusao de grupo com escopo media_profiles e o botao de /recuperacao
      -- passam todos por aqui. Ele sai do Athena na hora, mas a conexao continua
      -- ocupando a vaga do app no Meta Developers ate alguem apaga-la la --
      -- exatamente como numa queda por checkpoint. Sem o incidente, a vaga
      -- voltaria a ser oferecida no Bulk Meta sem existir de verdade, que e o
      -- bug que a migration 389 corrigiu para as quedas e deixou aberto aqui.
      --
      -- `signal = 'operator_requested'` e o que separa isto de uma queda. Mesma
      -- decisao que a Zernio tomou na migration 342: exclusao pedida nao e
      -- queda e nao pode poluir a metrica de queda. Na pratica sao dois efeitos:
      -- o painel diz "removido" em vez de um erro que nunca existiu, e a linha
      -- fica FORA do XLSX -- o ramo `fallen` do export le
      -- meta_group_profile_removal_events, e aqui nao gravamos evento de grupo
      -- nenhum, de proposito.
      --
      -- A gravacao vem DEPOIS da contencao para carregar as contagens reais do
      -- que foi cancelado. Ler analytics aqui ainda e seguro: a contencao mexe
      -- em fila, grupo e deleted_at, e nao em profile_analytics_current.
      if profile_row.provider::text = 'meta_official' then
        select app.label into meta_app_label
        from public.meta_apps app
        where app.id = profile_row.meta_app_id
          and app.organization_id = p_organization_id;

        -- Congelado agora: dali em diante o perfil para de sincronizar e o
        -- numero corrente deixa de ser o dele. Mesma razao da migration 376.
        select analytics.views, analytics.current_synced_at
        into meta_views_snapshot, meta_views_synced
        from public.profile_analytics_current analytics
        where analytics.organization_id = p_organization_id
          and analytics.profile_id = profile_row.id
          and analytics.deleted_at is null;

        insert into public.meta_profile_disconnection_incidents (
          organization_id, profile_id, meta_app_id, username_snapshot,
          meta_app_label_snapshot, error_code, error_message,
          analytics_views_snapshot, analytics_synced_at_snapshot,
          ignored_item_count, cancelled_plan_count, finalized_at, signal
        ) values (
          p_organization_id, profile_row.id, profile_row.meta_app_id,
          left(trim(profile_row.username), 80), meta_app_label,
          null, null,
          meta_views_snapshot, meta_views_synced,
          coalesce((containment ->> 'ignoredItemCount')::integer, 0),
          coalesce((containment ->> 'interruptedPlanCount')::integer, 0),
          timezone('utc', now()), 'operator_requested'
        )
        -- Um perfil ja incidentado nao ganha outro: a vaga e uma so. Isto
        -- tambem cobre a repeticao de fatia que enqueue-removal.ts faz de
        -- proposito quando o orcamento de parede da rota estoura.
        on conflict (organization_id, profile_id) where reconnected_at is null do nothing;

        meta_app_label := null;
        meta_views_snapshot := null;
        meta_views_synced := null;
      end if;

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

-- ---------------------------------------------------------------------------
-- 4. A conexao reativa o perfil excluido pelo operador
-- ---------------------------------------------------------------------------
-- Reescrita de `connect_meta_instagram_profile` (399) com tres adicoes: busca
-- da linha apagada quando nao ha alvo vivo, encerramento dos incidentes das
-- linhas apagadas da mesma conta, e a reativacao em si. Lock por (@),
-- resolucao explicita do alvo, recusa por conflito, takeover da Zernio e
-- rastro de troca de app seguem identicos.
--
-- Cuidado de plpgsql: `profile_id` e `outcome` sao colunas de saida desta
-- funcao, entao toda referencia a coluna de tabela com esses nomes vai
-- qualificada.
create or replace function public.connect_meta_instagram_profile(
  p_organization_id uuid,
  p_instagram_user_id text,
  p_username text,
  p_display_name text,
  p_profile_picture_url text,
  p_account_type text,
  p_encrypted_access_token text,
  p_token_expires_at timestamptz,
  p_meta_app_id uuid,
  p_created_by uuid
)
returns table (
  profile_id uuid,
  outcome text,
  previous_provider text,
  previous_username text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_username text;
  match_by_user_id public.instagram_profiles%rowtype;
  match_by_username public.instagram_profiles%rowtype;
  username_match_count integer;
  removed_row public.instagram_profiles%rowtype;
  target public.instagram_profiles%rowtype;
  resolved_outcome text;
  carried_metadata jsonb;
  from_app_label text;
  to_app_label text;
begin
  normalized_username := lower(nullif(trim(regexp_replace(p_username, '^@', '')), ''));

  if normalized_username is null then
    raise exception 'Username vazio devolvido pela Meta.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('meta_connect:' || p_organization_id::text || ':' || normalized_username, 0)
  );

  select * into match_by_user_id
  from public.instagram_profiles
  where organization_id = p_organization_id
    and instagram_user_id = p_instagram_user_id
    and deleted_at is null
  for update;

  select count(*) into username_match_count
  from public.instagram_profiles
  where organization_id = p_organization_id
    and deleted_at is null
    and lower(trim(regexp_replace(username, '^@', ''))) = normalized_username;

  if username_match_count > 1 then
    return query select null::uuid, 'conflict'::text, null::text, p_username;
    return;
  end if;

  if username_match_count = 1 then
    select * into match_by_username
    from public.instagram_profiles
    where organization_id = p_organization_id
      and deleted_at is null
      and lower(trim(regexp_replace(username, '^@', ''))) = normalized_username
    for update;
  end if;

  if match_by_user_id.id is not null
     and match_by_username.id is not null
     and match_by_user_id.id is distinct from match_by_username.id then
    return query select
      null::uuid,
      'conflict'::text,
      match_by_username.provider::text,
      match_by_username.username;
    return;
  end if;

  if match_by_user_id.id is not null then
    target := match_by_user_id;
  elsif match_by_username.id is not null then
    target := match_by_username;
  end if;

  -- SEM PERFIL VIVO: a conta pode ter uma linha apagada nesta organizacao. So
  -- o id da Meta decide -- o @ pode ter sido reaproveitado por outra conta. A
  -- mais recente vale; so ela diz como a conta saiu por ultimo.
  if target.id is null then
    select * into removed_row
    from public.instagram_profiles dead
    where dead.organization_id = p_organization_id
      and dead.instagram_user_id = p_instagram_user_id
      and dead.deleted_at is not null
    order by dead.deleted_at desc, dead.id desc
    limit 1
    for update;

    -- Reativa so o que o operador excluiu. Qualquer outro motivo cai no
    -- INSERT abaixo e vira perfil novo; a linha antiga fica como registro.
    if removed_row.id is not null
       and removed_row.provider = 'meta_official'
       and removed_row.last_error_code = 'profile_removed_by_operator' then
      target := removed_row;
    end if;
  end if;

  -- A CONTA VOLTOU: os incidentes em aberto das linhas apagadas dela se
  -- encerram, seja qual for o desfecho abaixo. Pelo mesmo app a vaga presa e
  -- liberada (a conexao esta em uso de novo); por outro app ela continua presa
  -- no de origem.
  update public.meta_profile_disconnection_incidents incident set
    reconnected_at = timezone('utc', now()),
    reconnected_meta_app_id = p_meta_app_id,
    slot_released_at = case
      when incident.slot_released_at is null
       and p_meta_app_id is not null
       and incident.meta_app_id = p_meta_app_id
        then timezone('utc', now())
      else incident.slot_released_at
    end
  where incident.organization_id = p_organization_id
    and incident.reconnected_at is null
    and incident.profile_id in (
      select dead.id
      from public.instagram_profiles dead
      where dead.organization_id = p_organization_id
        and dead.instagram_user_id = p_instagram_user_id
        and dead.deleted_at is not null
    );

  if target.id is null then
    insert into public.instagram_profiles (
      organization_id, instagram_user_id, username, display_name,
      profile_picture_url, account_type, provider, capabilities,
      encrypted_access_token, token_expires_at, token_refreshed_at,
      token_refresh_attempted_at, token_refresh_error, token_refresh_failure_count,
      meta_app_id, status, last_success_at, last_error_code, last_error_message,
      created_by
    ) values (
      p_organization_id, p_instagram_user_id, trim(p_username), p_display_name,
      p_profile_picture_url, p_account_type, 'meta_official',
      jsonb_build_object('instagram_business_basic', true, 'instagram_business_content_publish', true),
      p_encrypted_access_token, p_token_expires_at, timezone('utc', now()),
      null, null, 0,
      p_meta_app_id, 'online', timezone('utc', now()), null, null,
      p_created_by
    )
    returning id into target.id;

    return query select target.id, 'created'::text, null::text, null::text;
    return;
  end if;

  resolved_outcome := case
    when target.deleted_at is not null then 'restored'
    when target.provider = 'meta_official' then 'updated'
    else 'takeover'
  end;

  carried_metadata := coalesce(target.zernio_account_metadata, '{}'::jsonb);
  if resolved_outcome = 'takeover' then
    carried_metadata := carried_metadata || jsonb_build_object(
      'migrated_to_meta_at', timezone('utc', now()),
      'previous_provider', target.provider::text,
      'previous_instagram_user_id', target.instagram_user_id,
      'previous_zernio_account_id', target.zernio_account_id,
      'previous_zernio_profile_id', target.zernio_profile_id,
      'previous_zernio_connection_id', target.zernio_connection_id
    );
  end if;

  -- A TROCA DE APP. Registrada antes do update, enquanto `target.meta_app_id`
  -- ainda guarda a origem. Nao vale para a reativacao: ali o incidente
  -- encerrado acima ja e o rastro da vaga do app antigo.
  if resolved_outcome <> 'restored'
     and p_meta_app_id is not null
     and target.meta_app_id is not null
     and target.meta_app_id is distinct from p_meta_app_id then
    select label into from_app_label from public.meta_apps where id = target.meta_app_id;
    select label into to_app_label from public.meta_apps where id = p_meta_app_id;

    insert into public.meta_profile_app_transfers (
      organization_id, profile_id, from_app_id, to_app_id,
      from_app_label_snapshot, to_app_label_snapshot, username_snapshot
    ) values (
      p_organization_id, target.id, target.meta_app_id, p_meta_app_id,
      from_app_label, to_app_label, trim(p_username)
    );
  end if;

  -- Voltou para um app do qual havia saido: aquela conexao esta em uso de novo,
  -- entao ela deixa de ser vaga presa la.
  if p_meta_app_id is not null then
    update public.meta_profile_app_transfers transfer set
      slot_released_at = timezone('utc', now())
    where transfer.profile_id = target.id
      and transfer.from_app_id = p_meta_app_id
      and transfer.slot_released_at is null;
  end if;

  -- Metricas da reativacao. A exclusao marcou `deleted_at` nas series do
  -- perfil (`soft_delete_profile_analytics`, 385); volta so o que foi marcado
  -- na exclusao ou depois dela -- linha apagada antes por outro motivo (reparo
  -- de placeholder, 381) continua apagada. A linha compacta volta pelo
  -- `initialize_profile_analytics_state` que o callback chama; a metrica por
  -- post foi apagada de verdade e nao volta.
  if resolved_outcome = 'restored' then
    update public.profile_analytics_snapshots snapshot set
      deleted_at = null
    where snapshot.organization_id = p_organization_id
      and snapshot.profile_id = target.id
      and snapshot.deleted_at >= target.deleted_at;

    update public.profile_follower_daily_snapshots follower set
      deleted_at = null
    where follower.organization_id = p_organization_id
      and follower.profile_id = target.id
      and follower.deleted_at >= target.deleted_at;
  end if;

  update public.instagram_profiles set
    instagram_user_id = p_instagram_user_id,
    username = trim(p_username),
    display_name = coalesce(p_display_name, display_name),
    profile_picture_url = coalesce(p_profile_picture_url, profile_picture_url),
    account_type = coalesce(p_account_type, account_type),
    provider = 'meta_official',
    capabilities = jsonb_build_object(
      'instagram_business_basic', true,
      'instagram_business_content_publish', true
    ),
    encrypted_access_token = p_encrypted_access_token,
    token_expires_at = p_token_expires_at,
    token_refreshed_at = timezone('utc', now()),
    token_refresh_attempted_at = null,
    token_refresh_error = null,
    token_refresh_failure_count = 0,
    meta_app_id = p_meta_app_id,
    status = 'online',
    last_success_at = timezone('utc', now()),
    last_failure_at = null,
    last_error_code = null,
    last_error_message = null,
    zernio_account_id = null,
    zernio_profile_id = null,
    zernio_connection_id = null,
    zernio_account_metadata = carried_metadata,
    deleted_at = null
  where id = target.id;

  return query select
    target.id,
    resolved_outcome,
    target.provider::text,
    target.username;
end;
$$;

notify pgrst, 'reload schema';

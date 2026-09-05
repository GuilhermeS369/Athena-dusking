-- Toda saida de perfil Meta passa a sinalizar a vaga presa, e nao so a queda.
--
-- O QUE JA ESTAVA CERTO. A migration 389 fez a vaga do Meta Developers deixar
-- de ser liberada sozinha quando um perfil cai por checkpoint. E a contencao de
-- fila (`contain_instagram_profile_for_removal`, migrations 342/362) ja cancela
-- publicacoes, planos e horizontes em toda exclusao pedida por uma pessoa.
--
-- O QUE FALTAVA. A vaga no painel da Meta nao sabe POR QUE o perfil saiu do
-- Athena: ela fica ocupada do mesmo jeito. Mas so a queda automatica gravava
-- incidente. Excluir pelo bulk de /perfis, pelo botao de /recuperacao ou
-- apagando um grupo com escopo media_profiles devolvia a vaga em silencio --
-- o mesmo bug que a 389 corrigiu, intacto em todo caminho deliberado. Os tres
-- caem na mesma funcao (`enqueue_instagram_profile_removal`, ramo nao-Zernio),
-- entao uma mudanca cobre os tres.
--
-- O SINAL. `signal` separa a queda da remocao pedida, espelhando o que a Zernio
-- ja faz desde a 342 com `operator_requested`. Ele decide duas coisas:
--
--   * o painel diz "removido" em vez de `erro 190` -- codigo de um erro que,
--     numa exclusao pedida, nunca existiu;
--   * a remocao fica FORA do XLSX. O ramo `fallen` do export (migration 377) le
--     `meta_group_profile_removal_events`, e o caminho do operador nao grava
--     evento de grupo nenhum. Foi decisao explicita: exclusao pedida nao e
--     queda e nao pode poluir a metrica de queda da planilha.
--
-- POR QUE error_code E error_message VIRAM OPCIONAIS. Eram `not null` porque so
-- existia um jeito de o perfil sair: errando. Numa exclusao pedida nao ha erro,
-- e preencher com texto inventado ("removido pelo operador" no campo de codigo
-- de erro da Graph API) e o tipo de mentira que uma consulta futura acredita.
-- Os checks de tamanho continuam valendo para quando o valor existe.
--
-- POR QUE `finalize_meta_profile_disconnection` E REEMITIDA. A coluna nasce com
-- default para preencher as 599 linhas ja existentes, e o default e derrubado
-- em seguida: quem inserir daqui pra frente diz o sinal na mao. Sem isso, uma
-- insercao futura que esquecesse o campo herdaria "queda por checkpoint" em
-- silencio -- justamente a confusao que esta migration existe para acabar.

alter table public.meta_profile_disconnection_incidents
  add column if not exists signal text not null default 'checkpoint_required';

alter table public.meta_profile_disconnection_incidents
  drop constraint if exists meta_disconnection_incidents_signal_check;
alter table public.meta_profile_disconnection_incidents
  add constraint meta_disconnection_incidents_signal_check
  check (signal in ('checkpoint_required', 'operator_requested'));

-- O default cumpriu seu papel no backfill acima e sai de cena.
alter table public.meta_profile_disconnection_incidents
  alter column signal drop default;

alter table public.meta_profile_disconnection_incidents
  alter column error_code drop not null,
  alter column error_message drop not null;

comment on column public.meta_profile_disconnection_incidents.signal is
  'checkpoint_required = a Meta exigiu verificacao e o worker removeu; operator_requested = alguem pediu a exclusao. So o primeiro conta como queda no XLSX.';

-- Indice do painel: ele lista pendentes por app, sem filtrar por sinal.
-- Registrado aqui so para deixar claro que a coluna nova NAO entra nele --
-- os dois sinais aparecem juntos na mesma fila, porque a vaga presa e a mesma.

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

  -- O INCIDENTE E OS EVENTOS DE GRUPO SAO GRAVADOS ANTES DO DELETE, e a ordem
  -- nao e estilo: depois que `profile_group_members` some, nao existe mais como
  -- saber de quais grupos o perfil saiu. Foi por isso que a Zernio precisou de
  -- tabela de evento (migration 203) -- a linha de grupo e apagada de verdade,
  -- entao o rastro tem que ser tirado antes.
  select app.label into app_label_snapshot
  from public.meta_apps app
  where app.id = profile_row.meta_app_id
    and app.organization_id = profile_row.organization_id;

  -- Snapshot das views no instante da queda. Depois disso o perfil para de
  -- sincronizar, entao o numero corrente congela num valor que nao e mais o
  -- dele -- a mesma razao da migration 183 no lado da Zernio.
  select analytics.views, analytics.current_synced_at
  into views_snapshot, views_synced_snapshot
  from public.profile_analytics_current analytics
  where analytics.organization_id = profile_row.organization_id
    and analytics.profile_id = profile_row.id
    and analytics.deleted_at is null;

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

  -- `counted_at` ja entra preenchido: diferente da Zernio, aqui nao ha remocao
  -- remota para esperar -- a queda e terminal no instante em que e detectada.
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
        on conflict (organization_id, profile_id) do nothing;

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

revoke all on function public.enqueue_instagram_profile_removal(uuid, uuid[], text) from public, anon;
grant execute on function public.enqueue_instagram_profile_removal(uuid, uuid[], text) to authenticated, service_role;

revoke all on function public.finalize_meta_profile_disconnection(uuid, text, text, text, integer)
from public, anon, authenticated;
grant execute on function public.finalize_meta_profile_disconnection(uuid, text, text, text, integer)
to service_role;

notify pgrst, 'reload schema';

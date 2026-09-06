-- Athena Scheduler — 401: a janela de retenção vira parâmetro de verdade, e as
-- tabelas de log que ninguém poda entram na mesma esteira.
--
-- POR QUE AGORA. Medido em 05/09/2026: o banco saiu de ~600 MB (snapshot de
-- 21/08, em `.dashboard-db-table-stats.json`) para ~15 GB em duas semanas. A
-- operação explica metade — a frota foi de 1.140 para 5.474 perfis e a
-- publicação de 0 para ~68 mil posts/dia. A outra metade é log: cada post
-- publicado deixa ~6 linhas de histórico, e parte delas nunca foi podada.
--
-- O QUE ESTAVA QUEBRADO, E QUE NÃO SE VÊ LENDO O CHAMADOR: as duas funções de
-- retenção recebem `p_retention_days`, e o corpo faz
--
--     greatest(14, least(coalesce(p_retention_days, 14), 14))
--
-- que devolve 14 para qualquer entrada. O parâmetro existe na assinatura e não
-- existe no efeito — a rota manda 14 e mandaria 7 com o mesmo resultado. Agora
-- ele é real, entre 5 e 30 dias.
--
-- O PISO DE 5 DIAS É A REGRA DO OPERADOR, e mora aqui de propósito. "Cinco dias
-- de histórico, aconteça o que acontecer" escrito num comentário do chamador é
-- uma promessa; escrito no clamp, nenhum chamador futuro consegue furar.
--
-- QUANTO CADA FONTE NOVA CARREGAVA HOJE (linhas totais / com mais de 5 dias):
--
--   media_asset_delivery_attempts ............ 1.012.572 / 476.748
--   profile_analytics_refresh_step_events ....   882.968 / 455.773
--   instagram_observability_incident_entities    610.358 / —
--   publication_batch_terminal_outcomes ......   469.122 / 188.822
--   profile_analytics_refresh_item_events ....   139.918 / —
--
-- As duas de `profile_analytics_refresh_*` são telemetria de um pipeline que
-- parou em 03/09, quando a coleta migrou para a Meta: log de uma máquina que não
-- roda mais.
--
-- DUAS DECISÕES QUE VALE REGISTRAR:
--
-- 1. `batch_terminal_outcomes` só apaga linha JÁ RECONCILIADA. A linha não
--    reconciliada é fila de trabalho — é dela que a consolidação por lote de 272
--    tira o que consolidar. Podar por idade sem esse filtro deixaria um lote sem
--    consolidar, calado. O índice parcial abaixo existe para isso.
--
-- 2. `incident_entities` poda por `last_seen_at`, inclusive de incidente aberto.
--    Parece agressivo e não é: no mesmo corte os EVENTOS que sustentam aquela
--    entidade já foram embora. Manter a entidade sem evento mostra na tela um
--    perfil afetado que ninguém consegue mais abrir.
--
-- O QUE ESTA MIGRATION NÃO FAZ: não mexe em `maintain_instagram_observability`,
-- a função guarda-chuva de 293. Ela tem o mesmo clamp travado, mas nenhum
-- chamador — a rota chama as duas por fonte. Fica o registro: se um dia ela
-- voltar a ser usada, o clamp dela ainda é 14 fixo.

-- ---------------------------------------------------------------------------
-- Índices das fontes novas.
--
-- Sem eles a poda vira varredura sequencial a cada lote. São `create index`
-- comum, não `concurrently`: `supabase db push` roda a migration em transação e
-- `concurrently` não pode conviver com isso. A maior das tabelas tem ~1 M
-- linhas — segundos de escrita bloqueada, não minutos.
-- ---------------------------------------------------------------------------

create index if not exists media_asset_delivery_attempts_retention_time_idx
  on public.media_asset_delivery_attempts (created_at);
create index if not exists profile_analytics_refresh_step_events_retention_time_idx
  on public.profile_analytics_refresh_step_events (created_at);
create index if not exists profile_analytics_refresh_item_events_retention_time_idx
  on public.profile_analytics_refresh_item_events (created_at);
create index if not exists publication_batch_terminal_outcomes_reconciled_time_idx
  on public.publication_batch_terminal_outcomes (created_at)
  where reconciled_at is not null;
create index if not exists instagram_observability_incident_entities_retention_time_idx
  on public.instagram_observability_incident_entities (last_seen_at);

-- ---------------------------------------------------------------------------
-- Fontes quentes: janela real + entidades de incidente.
-- ---------------------------------------------------------------------------

create or replace function public.maintain_instagram_observability_hot_source(
  p_source text,
  p_retention_days integer default 14,
  p_batch_size integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  retention_days integer := greatest(5, least(coalesce(p_retention_days, 14), 30));
  cutoff timestamptz := timezone('utc', now()) - make_interval(days => retention_days);
  batch_size integer := greatest(50, least(coalesce(p_batch_size, 500), 5000));
  boundary_partition text := 'instagram_observability_events_' || to_char(cutoff::date, 'YYYY_MM_DD');
  partition_day date;
  partition_name text;
  partition_row record;
  affected bigint := 0;
  dropped integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role mantém a observabilidade.';
  end if;

  case p_source
    when 'partitions' then
      for day_offset in 0..7 loop
        partition_day := timezone('utc', now())::date + day_offset;
        partition_name := 'instagram_observability_events_' || to_char(partition_day, 'YYYY_MM_DD');
        if to_regclass('public.' || partition_name) is null then
          execute format(
            'create table public.%I partition of public.instagram_observability_events for values from (%L) to (%L)',
            partition_name, partition_day::timestamptz, (partition_day + 1)::timestamptz
          );
        end if;
      end loop;
      for partition_row in
        select child.relname as partition_name,
          to_date(substring(child.relname from '([0-9]{4}_[0-9]{2}_[0-9]{2})$'), 'YYYY_MM_DD') as partition_date
        from pg_inherits inheritance
        join pg_class parent on parent.oid = inheritance.inhparent
        join pg_class child on child.oid = inheritance.inhrelid
        join pg_namespace namespace on namespace.oid = child.relnamespace
        where parent.relname = 'instagram_observability_events'
          and namespace.nspname = 'public'
          and child.relname ~ '^instagram_observability_events_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
      loop
        if partition_row.partition_date < cutoff::date then
          execute format('drop table public.%I', partition_row.partition_name);
          dropped := dropped + 1;
        end if;
      end loop;
      return jsonb_build_object('source', p_source, 'cutoff', cutoff,
        'retentionDays', retention_days, 'affected', dropped, 'hasMore', false);

    when 'boundary_events' then
      if to_regclass('public.' || boundary_partition) is not null then
        execute format(
          'with expired as (select ctid from public.%I where occurred_at < $1 order by occurred_at limit $2) '
          || 'delete from public.%I target using expired where target.ctid = expired.ctid',
          boundary_partition, boundary_partition
        ) using cutoff, batch_size;
        get diagnostics affected = row_count;
      end if;

    when 'default_events' then
      with expired as (
        select ctid from public.instagram_observability_events_default
        where occurred_at < cutoff order by occurred_at limit batch_size
      )
      delete from public.instagram_observability_events_default target
      using expired where target.ctid = expired.ctid;
      get diagnostics affected = row_count;

    when 'event_rollups' then
      with expired as (
        select ctid from public.instagram_observability_rollups_5m
        where window_started_at < cutoff order by window_started_at limit batch_size
      )
      delete from public.instagram_observability_rollups_5m target
      using expired where target.ctid = expired.ctid;
      get diagnostics affected = row_count;

    when 'worker_rollups' then
      with expired as (
        select ctid from public.instagram_worker_rollups_5m
        where window_started_at < cutoff order by window_started_at limit batch_size
      )
      delete from public.instagram_worker_rollups_5m target
      using expired where target.ctid = expired.ctid;
      get diagnostics affected = row_count;

    when 'incident_actions' then
      with expired as (
        select ctid from public.instagram_observability_incident_actions
        where created_at < cutoff order by created_at limit batch_size
      )
      delete from public.instagram_observability_incident_actions target
      using expired where target.ctid = expired.ctid;
      get diagnostics affected = row_count;

    when 'incident_entities' then
      with expired as (
        select ctid from public.instagram_observability_incident_entities
        where last_seen_at < cutoff order by last_seen_at limit batch_size
      )
      delete from public.instagram_observability_incident_entities target
      using expired where target.ctid = expired.ctid;
      get diagnostics affected = row_count;

    when 'resolved_incidents' then
      with expired as (
        select id from public.instagram_observability_incidents
        where treatment_state = 'resolved'
          and greatest(last_seen_at, coalesce(resolved_at, last_seen_at)) < cutoff
        order by last_seen_at
        limit least(batch_size, 100)
        for update skip locked
      )
      delete from public.instagram_observability_incidents target
      using expired where target.id = expired.id;
      get diagnostics affected = row_count;

    else
      raise exception using errcode = '22023', message = 'Fonte quente inválida.';
  end case;

  return jsonb_build_object(
    'source', p_source,
    'cutoff', cutoff,
    'retentionDays', retention_days,
    'affected', affected,
    'hasMore', affected >= case when p_source = 'resolved_incidents' then least(batch_size, 100) else batch_size end
  );
end;
$$;

revoke all on function public.maintain_instagram_observability_hot_source(text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.maintain_instagram_observability_hot_source(text,integer,integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- Fontes legadas: janela real + as quatro tabelas que ninguém podava.
-- ---------------------------------------------------------------------------

create or replace function public.maintain_instagram_legacy_log_retention_source(
  p_source text,
  p_retention_days integer default 14,
  p_batch_size integer default 500
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  retention_days integer := greatest(5, least(coalesce(p_retention_days, 14), 30));
  cutoff timestamptz := timezone('utc', now()) - make_interval(days => retention_days);
  batch_size integer := greatest(100, least(coalesce(p_batch_size, 500), 5000));
  deleted_count bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role mantém os logs legados.';
  end if;
  case p_source
    when 'publication_events' then
      with expired as (select ctid from public.publication_item_events where created_at < cutoff order by created_at limit batch_size)
      delete from public.publication_item_events target using expired where target.ctid = expired.ctid;
    when 'worker_cycles' then
      with expired as (select ctid from public.publication_worker_cycle_events where created_at < cutoff order by created_at limit batch_size)
      delete from public.publication_worker_cycle_events target using expired where target.ctid = expired.ctid;
    when 'sync_logs' then
      with expired as (select ctid from public.zernio_sync_log_items where created_at < cutoff order by created_at limit batch_size)
      delete from public.zernio_sync_log_items target using expired where target.ctid = expired.ctid;
    when 'request_anomalies' then
      with expired as (select ctid from public.zernio_publication_request_anomalies where occurred_at < cutoff order by occurred_at limit batch_size)
      delete from public.zernio_publication_request_anomalies target using expired where target.ctid = expired.ctid;
    when 'request_rollups' then
      with expired as (select ctid from public.zernio_publication_request_rollups where window_started_at < cutoff order by window_started_at limit batch_size)
      delete from public.zernio_publication_request_rollups target using expired where target.ctid = expired.ctid;
    when 'media_delivery_attempts' then
      with expired as (select ctid from public.media_asset_delivery_attempts where created_at < cutoff order by created_at limit batch_size)
      delete from public.media_asset_delivery_attempts target using expired where target.ctid = expired.ctid;
    when 'analytics_step_events' then
      with expired as (select ctid from public.profile_analytics_refresh_step_events where created_at < cutoff order by created_at limit batch_size)
      delete from public.profile_analytics_refresh_step_events target using expired where target.ctid = expired.ctid;
    when 'analytics_item_events' then
      with expired as (select ctid from public.profile_analytics_refresh_item_events where created_at < cutoff order by created_at limit batch_size)
      delete from public.profile_analytics_refresh_item_events target using expired where target.ctid = expired.ctid;
    when 'batch_terminal_outcomes' then
      -- `reconciled_at is not null` não é detalhe: a linha pendente é fila de
      -- consolidação de lote. Apagar por idade sem o filtro perde o lote.
      with expired as (
        select ctid from public.publication_batch_terminal_outcomes
        where reconciled_at is not null and created_at < cutoff
        order by created_at limit batch_size
      )
      delete from public.publication_batch_terminal_outcomes target using expired where target.ctid = expired.ctid;
    else
      raise exception using errcode = '22023', message = 'Fonte legada inválida.';
  end case;
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('source', p_source, 'cutoff', cutoff,
    'retentionDays', retention_days, 'deleted', deleted_count,
    'hasMore', deleted_count >= batch_size);
end;
$$;

revoke all on function public.maintain_instagram_legacy_log_retention_source(text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.maintain_instagram_legacy_log_retention_source(text,integer,integer)
  to service_role;

notify pgrst, 'reload schema';

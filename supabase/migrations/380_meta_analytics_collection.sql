-- Athena Scheduler: a coleta de métricas passa a existir para a API da Meta.
--
-- O QUE ESTAVA ERRADO. Desde a migration 057 o banco afirma, em duas funções,
-- que perfil `meta_official` não tem analytics: `initialize_profile_analytics_state`
-- e `backfill_profile_analytics_current_placeholders` gravam
-- `sync_status = 'not_configured'` com a frase "Meta oficial ainda não tem
-- coleta de analytics configurada no Athena". Era verdade enquanto a frota
-- inteira publicava pela Zernio e 14 perfis usavam a Meta.
--
-- Em 04/09/2026 a Zernio suspendeu 2.004 conexões e a frota foi religada pela
-- API oficial. A tomada de perfil (migrations 373/374/375) preservou o
-- histórico com todo o cuidado — UPDATE na mesma linha, nunca INSERT — e aí
-- esta função, chamada logo depois da reconexão, gravava por cima um snapshot
-- ZERADO com período `hoje-29 .. hoje`. Como a dashboard lê o snapshot mais
-- recente de cada perfil, o histórico preservado sumia atrás de uma linha de
-- zeros. Medido em 05/09/2026: 944 perfis nesse estado, 0 linhas diárias
-- coletadas desde 03/09.
--
-- O histórico nunca foi perdido. Ele parou de ser CONTINUADO, e passou a ser
-- encoberto por um placeholder que dizia "não configurado" sobre uma conta que
-- estava publicando normalmente.
--
-- O QUE ESTA MIGRAÇÃO FAZ.
--   1. `select_meta_analytics_refresh_batch`: quem coletar a seguir, ordenado
--      por quem está parado há mais tempo. É o que permite ao worker pedir um
--      lote sem ler a frota inteira a cada ciclo.
--   2. `initialize_profile_analytics_state` deixa de mentir sobre a Meta e —
--      mais importante — deixa de criar placeholder para perfil que JÁ TEM
--      histórico. Reconectar uma conta não é conhecê-la pela primeira vez.
--   3. O mesmo para o backfill de placeholders.
--
-- O reparo das 944 linhas já gravadas vem na migration 381, separada de
-- propósito: esta muda comportamento, aquela mexe em dado existente.

-- ---------------------------------------------------------------------------
-- 1. Lote de coleta
-- ---------------------------------------------------------------------------

create or replace function public.select_meta_analytics_refresh_batch(
  p_organization_id uuid default null,
  p_profile_ids uuid[] default null,
  p_limit integer default 60,
  p_stale_minutes integer default 45
)
returns table (
  profile_id uuid,
  organization_id uuid,
  username text,
  instagram_user_id text,
  last_synced_at timestamptz,
  pending_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Só o servidor: a resposta orienta chamadas à Meta em nome da organização,
  -- e a seleção olha colunas que a sessão do navegador não enxerga.
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  if p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Lote de coleta deve estar entre 1 e 500.';
  end if;

  return query
  with candidates as (
    select
      profile.id,
      profile.organization_id,
      profile.username,
      profile.instagram_user_id,
      state.current_synced_at
    from public.instagram_profiles as profile
    left join public.profile_analytics_current as state
      on state.organization_id = profile.organization_id
     and state.profile_id = profile.id
     and state.deleted_at is null
    where profile.deleted_at is null
      and profile.provider = 'meta_official'
      -- Predicado, não projeção: o token nunca sai daqui. Sem ele não há
      -- chamada possível, então o perfil não entra no lote.
      and profile.encrypted_access_token is not null
      and (p_organization_id is null or profile.organization_id = p_organization_id)
      and (p_profile_ids is null or profile.id = any(p_profile_ids))
      -- Uma seleção explícita ignora o filtro de situação: quem pediu aquele
      -- perfil quer aquele perfil, mesmo que ele esteja marcado para reconexão.
      and (p_profile_ids is not null or profile.status = 'online')
      and (
        p_stale_minutes <= 0
        or state.current_synced_at is null
        or state.current_synced_at < timezone('utc', now()) - make_interval(mins => p_stale_minutes)
      )
  )
  select
    candidate.id,
    candidate.organization_id,
    candidate.username,
    candidate.instagram_user_id,
    candidate.current_synced_at,
    (select count(*)::integer from candidates)
  from candidates as candidate
  -- Quem está parado há mais tempo primeiro. `nulls first` coloca o perfil
  -- recém-conectado na frente, que é onde ele deve estar: é o único sem
  -- nenhuma métrica.
  order by candidate.current_synced_at asc nulls first, candidate.id
  limit p_limit;
end;
$$;

revoke all on function public.select_meta_analytics_refresh_batch(uuid, uuid[], integer, integer) from public, anon, authenticated;
grant execute on function public.select_meta_analytics_refresh_batch(uuid, uuid[], integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Inicialização de estado que respeita histórico
-- ---------------------------------------------------------------------------

create or replace function public.initialize_profile_analytics_state(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.instagram_profiles%rowtype;
  today date := (timezone('America/Sao_Paulo', now()))::date;
  has_history boolean;
begin
  select profile_source.* into profile_row
  from public.instagram_profiles as profile_source
  where profile_source.id = p_profile_id
    and profile_source.deleted_at is null;

  if not found then
    raise exception using errcode = 'P0002', message = 'Perfil não encontrado';
  end if;

  if auth.role() <> 'service_role'
    and not public.is_service_role_request()
    and not public.has_organization_role(profile_row.organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Ação não permitida';
  end if;

  -- O perfil já foi coletado alguma vez? Este é o caso da reconexão: a conta
  -- volta pela API da Meta com meses de métrica na mesma linha. Criar um
  -- placeholder com o período de hoje o colocaria à frente do histórico na
  -- leitura "snapshot mais recente" — que é a que a dashboard faz.
  select exists (
    select 1
    from public.profile_analytics_daily_metrics as metric
    where metric.organization_id = profile_row.organization_id
      and metric.profile_id = profile_row.id
    limit 1
  ) or exists (
    select 1
    from public.profile_analytics_snapshots as snapshot
    where snapshot.organization_id = profile_row.organization_id
      and snapshot.profile_id = profile_row.id
      and snapshot.deleted_at is null
      and snapshot.sync_status in ('synced', 'partial')
    limit 1
  ) into has_history;

  if not has_history then
    insert into public.profile_analytics_snapshots (
      organization_id, profile_id, provider, period_start, period_end,
      sync_status, unavailable_reason, synced_at
    ) values (
      profile_row.organization_id, profile_row.id, profile_row.provider,
      today - 29, today,
      'pending'::public.profile_analytics_sync_status,
      'Aguardando a primeira coleta de métricas.',
      timezone('utc', now())
    )
    on conflict (organization_id, profile_id, provider, period_start, period_end)
    do update set
      deleted_at = null,
      sync_status = excluded.sync_status,
      unavailable_reason = excluded.unavailable_reason,
      synced_at = coalesce(public.profile_analytics_snapshots.synced_at, excluded.synced_at);
  end if;

  -- A linha compacta é uma por perfil e nunca some, então ela é criada sempre.
  -- O que muda é que ela não sobrescreve um estado bom com um placeholder.
  insert into public.profile_analytics_current (
    organization_id, profile_id, provider, period_start, period_end,
    sync_status, unavailable_reason, deleted_at
  ) values (
    profile_row.organization_id, profile_row.id, profile_row.provider,
    today - 29, today,
    'pending'::public.profile_analytics_sync_status,
    'Aguardando a primeira coleta de métricas.',
    null
  )
  on conflict (organization_id, profile_id) do update set
    -- Reconexão troca o provedor da linha, não o que já se sabe dela. A guarda
    -- por `current_synced_at` é a da migration 221 e continua valendo: perfil
    -- que já foi coletado alguma vez mantém situação e motivo.
    provider = excluded.provider,
    sync_status = case
      when public.profile_analytics_current.current_synced_at is null
        then excluded.sync_status
      else public.profile_analytics_current.sync_status
    end,
    unavailable_reason = case
      when public.profile_analytics_current.current_synced_at is null
        then excluded.unavailable_reason
      else public.profile_analytics_current.unavailable_reason
    end,
    deleted_at = null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Backfill de placeholders sem a mentira sobre a Meta
-- ---------------------------------------------------------------------------

create or replace function public.backfill_profile_analytics_current_placeholders(
  p_organization_id uuid,
  p_limit integer default 500,
  p_after_profile_id uuid default null
)
returns table (
  processed_count integer,
  last_profile_id uuid,
  has_more boolean
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_limit not between 1 and 2000 then
    raise exception using errcode = '22023', message = 'Lote de placeholders deve estar entre 1 e 2000.';
  end if;

  return query
  with profiles as materialized (
    select profile.id, profile.organization_id, profile.provider
    from public.instagram_profiles profile
    left join public.profile_analytics_current current
      on current.organization_id = profile.organization_id
     and current.profile_id = profile.id
     and current.deleted_at is null
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and current.profile_id is null
      and (p_after_profile_id is null or profile.id > p_after_profile_id)
    order by profile.id
    limit p_limit
  ), upserted as (
    insert into public.profile_analytics_current (
      organization_id, profile_id, provider, sync_status, unavailable_reason, deleted_at
    )
    select
      profile.organization_id,
      profile.id,
      profile.provider,
      'pending'::public.profile_analytics_sync_status,
      'Aguardando a primeira coleta de métricas.',
      null
    from profiles profile
    on conflict (organization_id, profile_id) do update set
      provider = excluded.provider,
      sync_status = excluded.sync_status,
      unavailable_reason = excluded.unavailable_reason,
      deleted_at = null
    returning profile_id
  )
  select
    (select count(*)::integer from upserted),
    (select profile.id from profiles profile order by profile.id desc limit 1),
    exists (
      select 1
      from public.instagram_profiles profile
      left join public.profile_analytics_current current
        on current.organization_id = profile.organization_id
       and current.profile_id = profile.id
       and current.deleted_at is null
      where profile.organization_id = p_organization_id
        and profile.deleted_at is null
        and current.profile_id is null
        and profile.id > coalesce(
          (select profile_inner.id from profiles profile_inner order by profile_inner.id desc limit 1),
          '00000000-0000-0000-0000-000000000000'::uuid
        )
    );
end;
$$;

notify pgrst, 'reload schema';

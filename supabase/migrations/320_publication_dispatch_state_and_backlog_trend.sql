-- Fase 8 do plano de despacho Instagram (1000 perfis): expõe os cinco estados do
-- pré-carregamento/despacho por organização (pré-carregado, aguardando cota, enviado ao
-- provedor, perfil desconectado, stale) e um alerta de "backlog parou de avançar" — hoje todo
-- alerta em get_operational_alerts é limiar de leitura única; este é o primeiro que compara
-- duas leituras no tempo. Segue o mesmo padrão de snapshot pré-computado já usado em
-- publication_queue_operational_snapshots (303) e instagram_observability_summary_snapshots
-- (299): recomposição pesada uma vez por ciclo de manutenção, leitura barata pela API.
--
-- Aproximações documentadas (não são leitura exata de evento, para não pesar o refresh):
-- - "awaitingQuota" usa status=waiting com next_attempt_at futuro e sem creation_id, como
--   proxy de item recém-adiado por reserva de capacidade negada (reserve_publication_dispatch_capacity).
--   Não distingue esse motivo de outros adiamentos (ex.: recuperação de horário perdido).
-- - "profileDisconnected" conta perfis distintos da organização com status <> 'online' e não
--   removidos — sinal de perfis fora do ar, não só os que caíram nas últimas 24h.
-- - O tamanho do spool em disco da VPS não é reportado aqui (não existe no Postgres); fica
--   como limitação conhecida até o heartbeat do worker expor essa contagem.

create table if not exists public.publication_dispatch_state_snapshots (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  preloaded bigint not null default 0 check (preloaded >= 0),
  awaiting_quota bigint not null default 0 check (awaiting_quota >= 0),
  sent_to_provider bigint not null default 0 check (sent_to_provider >= 0),
  profile_disconnected bigint not null default 0 check (profile_disconnected >= 0),
  due bigint not null default 0 check (due >= 0),
  failures_1h bigint not null default 0 check (failures_1h >= 0),
  published_last_minute bigint not null default 0 check (published_last_minute >= 0),
  oldest_due_age_seconds integer not null default 0 check (oldest_due_age_seconds >= 0),
  active_total bigint not null default 0 check (active_total >= 0),
  generated_at timestamptz not null default timezone('utc', now())
);

alter table public.publication_dispatch_state_snapshots enable row level security;
revoke all on public.publication_dispatch_state_snapshots from public, anon, authenticated;
grant all on public.publication_dispatch_state_snapshots to service_role;

create table if not exists public.publication_dispatch_backlog_trend (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  last_active_total bigint not null default 0 check (last_active_total >= 0),
  last_progress_at timestamptz not null default timezone('utc', now()),
  checked_at timestamptz not null default timezone('utc', now())
);

alter table public.publication_dispatch_backlog_trend enable row level security;
revoke all on public.publication_dispatch_backlog_trend from public, anon, authenticated;
grant all on public.publication_dispatch_backlog_trend to service_role;

create or replace function public.refresh_publication_dispatch_state_snapshots()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  refreshed_count integer;
  checked_at_value timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode recompor o estado de despacho.';
  end if;

  with per_org as (
    select
      item.organization_id,
      count(*) filter (where item.dispatch_staged_by is not null) as preloaded,
      count(*) filter (
        where item.status = 'waiting' and item.creation_id is null
          and item.next_attempt_at is not null and item.next_attempt_at > checked_at_value
      ) as awaiting_quota,
      count(*) filter (
        where item.creation_id is not null and item.status in ('preparing', 'publishing')
      ) as sent_to_provider,
      count(*) filter (
        where item.status in ('waiting', 'ready') and item.execute_at is not null
          and item.execute_at <= checked_at_value
      ) as due,
      count(*) filter (where item.status = 'failed') as failures_1h,
      count(*) filter (
        where item.status = 'published' and item.published_at >= checked_at_value - interval '1 minute'
      ) as published_last_minute,
      coalesce(max(extract(epoch from checked_at_value - item.execute_at)) filter (
        where item.status in ('waiting', 'ready') and item.execute_at is not null
          and item.execute_at <= checked_at_value
      ), 0)::integer as oldest_due_age_seconds,
      count(*) filter (
        where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
      ) as active_total
    from public.publication_items item
    where item.archived_at is null
    group by item.organization_id
  ), per_org_disconnected as (
    select profile.organization_id, count(distinct profile.id) as profile_disconnected
    from public.instagram_profiles profile
    where profile.deleted_at is null and profile.status <> 'online'
    group by profile.organization_id
  )
  insert into public.publication_dispatch_state_snapshots (
    organization_id, preloaded, awaiting_quota, sent_to_provider, profile_disconnected,
    due, failures_1h, published_last_minute, oldest_due_age_seconds, active_total, generated_at
  )
  select
    per_org.organization_id, per_org.preloaded, per_org.awaiting_quota, per_org.sent_to_provider,
    coalesce(per_org_disconnected.profile_disconnected, 0), per_org.due, per_org.failures_1h,
    per_org.published_last_minute, per_org.oldest_due_age_seconds, per_org.active_total, checked_at_value
  from per_org
  left join per_org_disconnected on per_org_disconnected.organization_id = per_org.organization_id
  on conflict (organization_id) do update set
    preloaded = excluded.preloaded, awaiting_quota = excluded.awaiting_quota,
    sent_to_provider = excluded.sent_to_provider, profile_disconnected = excluded.profile_disconnected,
    due = excluded.due, failures_1h = excluded.failures_1h,
    published_last_minute = excluded.published_last_minute,
    oldest_due_age_seconds = excluded.oldest_due_age_seconds, active_total = excluded.active_total,
    generated_at = excluded.generated_at;

  get diagnostics refreshed_count = row_count;

  -- Tendência de backlog: só atualiza last_progress_at quando o total ativo realmente muda
  -- (encolheu ou cresceu). Se ficar parado, last_progress_at fica velho e vira o sinal de
  -- "backlog parou de avançar" em get_publication_dispatch_state_snapshot.
  insert into public.publication_dispatch_backlog_trend (
    organization_id, last_active_total, last_progress_at, checked_at
  )
  select snapshot.organization_id, snapshot.active_total, checked_at_value, checked_at_value
  from public.publication_dispatch_state_snapshots snapshot
  on conflict (organization_id) do update set
    last_active_total = excluded.last_active_total,
    last_progress_at = case
      when public.publication_dispatch_backlog_trend.last_active_total is distinct from excluded.last_active_total
        then excluded.checked_at
      else public.publication_dispatch_backlog_trend.last_progress_at
    end,
    checked_at = excluded.checked_at;

  return refreshed_count;
end;
$$;

revoke all on function public.refresh_publication_dispatch_state_snapshots()
  from public, anon, authenticated;
grant execute on function public.refresh_publication_dispatch_state_snapshots()
  to service_role;

-- p_stalled_after_seconds: quanto tempo sem o total ativo mudar até soar como estagnado.
-- Só sinaliza quando existe backlog de verdade (active_total > 0) — fila vazia não é estagnação.
create or replace function public.get_publication_dispatch_state_snapshot(
  p_organization_id uuid,
  p_stalled_after_seconds integer default 600
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  snapshot_row public.publication_dispatch_state_snapshots%rowtype;
  trend_row public.publication_dispatch_backlog_trend%rowtype;
  stalled boolean;
begin
  if auth.role() <> 'service_role' and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  if p_stalled_after_seconds not between 60 and 7200 then
    raise exception using errcode = '22023', message = 'Limite de estagnação inválido.';
  end if;

  select * into snapshot_row from public.publication_dispatch_state_snapshots
  where organization_id = p_organization_id;
  select * into trend_row from public.publication_dispatch_backlog_trend
  where organization_id = p_organization_id;

  stalled := coalesce(snapshot_row.active_total, 0) > 0
    and trend_row.last_progress_at is not null
    and trend_row.last_progress_at < timezone('utc', now()) - make_interval(secs => p_stalled_after_seconds);

  return jsonb_build_object(
    'preloaded', coalesce(snapshot_row.preloaded, 0),
    'awaitingQuota', coalesce(snapshot_row.awaiting_quota, 0),
    'sentToProvider', coalesce(snapshot_row.sent_to_provider, 0),
    'profileDisconnected', coalesce(snapshot_row.profile_disconnected, 0),
    'due', coalesce(snapshot_row.due, 0),
    'failuresLastHour', coalesce(snapshot_row.failures_1h, 0),
    'publishedLastMinute', coalesce(snapshot_row.published_last_minute, 0),
    'oldestDueAgeSeconds', coalesce(snapshot_row.oldest_due_age_seconds, 0),
    'activeTotal', coalesce(snapshot_row.active_total, 0),
    'backlogStalled', coalesce(stalled, false),
    'lastProgressAt', trend_row.last_progress_at,
    'generatedAt', snapshot_row.generated_at,
    'stale', snapshot_row.generated_at is null
      or snapshot_row.generated_at < timezone('utc', now()) - interval '10 minutes'
  );
end;
$$;

revoke all on function public.get_publication_dispatch_state_snapshot(uuid, integer)
  from public, anon;
grant execute on function public.get_publication_dispatch_state_snapshot(uuid, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';

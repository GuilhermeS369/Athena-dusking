-- Athena Scheduler: retenção da métrica por post, e faxina do que ficou de
-- perfil removido.
--
-- POR QUE AGORA. `profile_post_analytics_snapshots` é a única tabela de
-- analytics que cresce com posts × perfis, e ela nunca soltou nada. Medido em
-- 05/09/2026:
--
--   linhas hoje ......................... 444.180
--   crescimento (03/09) ................. 58.523/dia
--   dentro de 30 dias ................... 444.169 (99,99%)
--   dentro de 7 dias .................... 307.979 (69%)
--   já marcadas como deleted_at ......... 64.113 (14%, ocupando espaço à toa)
--
-- Não existe histórico antigo para proteger: a coleta sempre pediu "as 25
-- mídias mais recentes", então a tabela é uma janela rolante que só acumula.
-- Nesta escala, sem poda, são ~18 milhões de linhas por ano — e a frota ainda
-- vai crescer.
--
-- DUAS PODAS, POR MOTIVOS DIFERENTES:
--
-- 1. RETENÇÃO (90 dias) limita o futuro. Não libera quase nada hoje — são 4
--    linhas mais velhas que 180 dias — e é justamente por isso que vale fazer
--    antes de precisar.
--
-- 2. PERFIL REMOVIDO tem a métrica por post apagada de vez. Hoje ela é apenas
--    marcada com `deleted_at` e continua ocupando espaço; e métrica por post de
--    um perfil que não existe mais não serve para nada no sistema. O que
--    IMPORTA preservar do perfil caído é a métrica DIÁRIA — e ela não é tocada
--    nem aqui nem em `soft_delete_profile_analytics`.
--
-- POR QUE 90 DIAS, E O QUE MUDOU JUNTO. O maior recorte que a dashboard sabe
-- pedir é 90 dias. Mas a tela de Recuperação lia posts numa janela declarada
-- como `window_days between 3 and 180` — teto nunca usado (todas as execuções
-- registradas usam 30, uma usou 6), e que passaria a pedir dado que não existe
-- mais. Um teto maior que a retenção é uma promessa que o banco não cumpre, e
-- ela quebraria calada. Os dois passam a valer 90.
--
-- Para voltar a análises mais longas, suba os DOIS juntos: esta constraint e o
-- `p_retention_days` de `prune_profile_post_analytics`.

alter table public.recovery_analysis_runs
  drop constraint if exists recovery_analysis_runs_window_days_check;

alter table public.recovery_analysis_runs
  add constraint recovery_analysis_runs_window_days_check
  check (window_days between 3 and 90);

-- ---------------------------------------------------------------------------
-- 1. Retenção
-- ---------------------------------------------------------------------------

create or replace function public.prune_profile_post_analytics(
  p_retention_days integer default 90,
  p_limit integer default 5000
)
returns table (deleted_count integer, has_more boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz;
  removed integer;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  -- O piso de 90 não é decoração: abaixo dele a tela de Recuperação e o recorte
  -- de 90 dias da dashboard passam a pedir o que foi apagado.
  if p_retention_days < 90 then
    raise exception using errcode = '22023', message = 'Retenção mínima de 90 dias: é o maior recorte que as telas pedem.';
  end if;
  if p_limit not between 1 and 50000 then
    raise exception using errcode = '22023', message = 'Lote de poda deve estar entre 1 e 50000.';
  end if;

  cutoff := timezone('utc', now()) - make_interval(days => p_retention_days);

  -- Apaga em lote limitado: uma poda que trava a tabela por minutos é pior do
  -- que a linha que ela remove.
  with alvo as (
    select id
    from public.profile_post_analytics_snapshots
    where published_at is not null
      and published_at < cutoff
    order by published_at
    limit p_limit
  ), apagadas as (
    delete from public.profile_post_analytics_snapshots
    where id in (select id from alvo)
    returning 1
  )
  select count(*)::integer into removed from apagadas;

  deleted_count := removed;
  has_more := removed >= p_limit;
  return next;
end;
$$;

revoke all on function public.prune_profile_post_analytics(integer, integer) from public, anon, authenticated;
grant execute on function public.prune_profile_post_analytics(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Perfil removido não guarda métrica por post
-- ---------------------------------------------------------------------------

create or replace function public.purge_removed_profile_post_analytics(
  p_limit integer default 5000
)
returns table (deleted_count integer, has_more boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if p_limit not between 1 and 50000 then
    raise exception using errcode = '22023', message = 'Lote de faxina deve estar entre 1 e 50000.';
  end if;

  -- Alcança os dois casos: linha já marcada com `deleted_at` (o que o
  -- soft delete antigo deixou para trás) e linha viva de perfil apagado.
  -- A métrica DIÁRIA do perfil não entra aqui — ela é o que sobrevive à queda.
  with alvo as (
    select snapshot.id
    from public.profile_post_analytics_snapshots as snapshot
    where snapshot.deleted_at is not null
       or exists (
         select 1
         from public.instagram_profiles as profile
         where profile.id = snapshot.profile_id
           and profile.deleted_at is not null
       )
    limit p_limit
  ), apagadas as (
    delete from public.profile_post_analytics_snapshots
    where id in (select id from alvo)
    returning 1
  )
  select count(*)::integer into removed from apagadas;

  deleted_count := removed;
  has_more := removed >= p_limit;
  return next;
end;
$$;

revoke all on function public.purge_removed_profile_post_analytics(integer) from public, anon, authenticated;
grant execute on function public.purge_removed_profile_post_analytics(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. O limpador passa a apagar, não a marcar
-- ---------------------------------------------------------------------------

create or replace function public.soft_delete_profile_analytics(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.instagram_profiles%rowtype;
  deleted_at_value timestamptz := timezone('utc', now());
begin
  select profile_source.* into profile_row
  from public.instagram_profiles as profile_source
  where profile_source.id = p_profile_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'Perfil não encontrado';
  end if;

  if auth.role() <> 'service_role'
    and not public.is_service_role_request()
    and not public.has_organization_role(profile_row.organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Ação não permitida';
  end if;

  update public.profile_analytics_snapshots
  set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_follower_daily_snapshots
  set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  -- Métrica por post de perfil removido é apagada, não marcada.
  --
  -- Marcar guardava o pior dos dois mundos: a linha não aparece em lugar nenhum
  -- (a Recuperação e a dashboard filtram `deleted_at is null`) e continua
  -- ocupando espaço e índice. Eram 64.113 linhas nesse estado em 05/09/2026.
  --
  -- A métrica DIÁRIA continua intacta de propósito: é ela que permite ver o
  -- desempenho dos dias anteriores de um perfil que caiu.
  delete from public.profile_post_analytics_snapshots
  where profile_id = p_profile_id and organization_id = profile_row.organization_id;

  update public.profile_analytics_sync_runs
  set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;

  update public.profile_analytics_current
  set deleted_at = coalesce(deleted_at, deleted_at_value)
  where profile_id = p_profile_id and organization_id = profile_row.organization_id and deleted_at is null;
end;
$$;

notify pgrst, 'reload schema';

-- O sinal de pressao para de contar como atraso o trabalho que esta congelado
-- de proposito.
--
-- O QUE ACONTECEU EM 05/09/2026. A Meta bloqueou 4 apps, o disjuntor pausou 3
-- lotes, e os itens desses lotes ficaram vencidos para sempre -- lote pausado
-- nao e reivindicado desde a migration 095. A partir dai:
--
--   get_publication_generation_pressure_signal -> criticalDelay: true
--     -> /api/internal/instagram-observability-maintenance se auto-pausa
--        -> o snapshot da tela de operacao parou de ser gerado as 11:15,
--           e a tela passou a exibir "vencidos = 0" com 950 vencidos.
--
-- E nao e so a tela: `lib/integrations/analytics-pressure.ts` degrada ou para a
-- coleta no mesmo sinal, e o worker de geracao cede a ele. Ou seja, UM UNICO
-- item congelado -- o sinal dispara com um -- envenena observabilidade,
-- analytics e geracao ao mesmo tempo.
--
-- A CAUSA E A MESMA DA MIGRATION 379, em outro consumidor: contar trabalho
-- congelado como se fosse fila viva. La era a flag "backlog parado" da tela;
-- aqui e o portao que decide se a manutencao roda.
--
-- A CORRECAO. O comentario da migration 321 ja dizia a intencao certa -- que a
-- condicao de "atrasado" espelha "a condicao de elegibilidade ja usada por
-- claim_publication_items". So que o claim exclui duas coisas que este sinal
-- nao excluia:
--
--   1. item de lote pausado pelo disjuntor (migration 095, com a excecao da
--      325 para item ja aceito pelo provedor, que segue reconciliavel);
--   2. item de perfil cujo app da Meta esta com a API bloqueada (migration
--      394).
--
-- Nos dois casos o item nao esta atrasado: ele esta fora de disputa por decisao
-- do sistema. Se um dia voltar a ser reivindicavel e continuar parado, ai sim o
-- sinal deve gritar -- e vai.
create or replace function public.get_publication_generation_pressure_signal(
  p_critical_delay_seconds integer default 60
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  oldest_due_at timestamptz;
  checked_at timestamptz := timezone('utc', now());
  has_overdue_accepted boolean := false;
  has_overdue_unstarted boolean := false;
  blocked_profile_ids uuid[];
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode consultar pressão global.';
  end if;
  if p_critical_delay_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Limite de atraso crítico inválido.';
  end if;

  select coalesce(array_agg(profile.id), '{}'::uuid[]) into blocked_profile_ids
  from public.instagram_profiles profile
  join public.meta_apps app on app.id = profile.meta_app_id
  where profile.deleted_at is null
    and app.api_block_until is not null
    and app.api_block_until > checked_at;

  select item.execute_at into oldest_due_at
  from public.publication_items item
  where item.archived_at is null
    and item.pipeline_version = 2
    and item.status in ('waiting', 'ready')
    and item.execute_at is not null
    and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
    and (item.next_attempt_at is null or item.next_attempt_at <= checked_at)
    and (item.lease_until is null or item.lease_until <= checked_at)
    and not (item.profile_id = any(blocked_profile_ids))
    and (
      item.creation_id is not null
      or not exists (
        select 1 from public.publication_batch_circuit_breakers breaker
        where breaker.batch_id = item.batch_id and breaker.paused_at is not null
      )
    )
  order by item.execute_at, item.id
  limit 1;

  if oldest_due_at is not null then
    select
      exists (
        select 1 from public.publication_items item
        where item.archived_at is null
          and item.pipeline_version = 2
          and item.status in ('waiting', 'ready')
          and item.execute_at is not null
          and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
          and (item.next_attempt_at is null or item.next_attempt_at <= checked_at)
          and (item.lease_until is null or item.lease_until <= checked_at)
          and not (item.profile_id = any(blocked_profile_ids))
          and (
            item.creation_id is not null
            or not exists (
              select 1 from public.publication_batch_circuit_breakers breaker
              where breaker.batch_id = item.batch_id and breaker.paused_at is not null
            )
          )
          and item.creation_id is not null
      ),
      exists (
        select 1 from public.publication_items item
        where item.archived_at is null
          and item.pipeline_version = 2
          and item.status in ('waiting', 'ready')
          and item.execute_at is not null
          and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
          and (item.next_attempt_at is null or item.next_attempt_at <= checked_at)
          and (item.lease_until is null or item.lease_until <= checked_at)
          and not (item.profile_id = any(blocked_profile_ids))
          and not exists (
            select 1 from public.publication_batch_circuit_breakers breaker
            where breaker.batch_id = item.batch_id and breaker.paused_at is not null
          )
          and item.creation_id is null
      )
    into has_overdue_accepted, has_overdue_unstarted;
  end if;

  return jsonb_build_object(
    'criticalDelay', oldest_due_at is not null,
    'oldestDueAt', oldest_due_at,
    'overdueCurrent', case when oldest_due_at is null then 0 else 1 end,
    'overdueAccepted', has_overdue_accepted,
    'overdueUnstarted', has_overdue_unstarted,
    'checkedAt', checked_at
  );
end;
$$;

revoke all on function public.get_publication_generation_pressure_signal(integer)
  from public, anon, authenticated;
grant execute on function public.get_publication_generation_pressure_signal(integer) to service_role;

notify pgrst, 'reload schema';

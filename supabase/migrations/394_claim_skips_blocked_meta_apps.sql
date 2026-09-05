-- O claim para de entregar item de app da Meta com a API bloqueada.
--
-- Esta e a peca que faz o desenho de 05/09 funcionar: enquanto a janela de
-- bloqueio estiver aberta, nenhum item daquele app e reivindicado. Nada e
-- tentado, entao nada falha, entao NENHUM LOTE PAUSA -- que foi o dano de
-- hoje, quando o disjuntor pausou `Julio / 05/09 / Reels` e congelou junto
-- 6.120 itens do `Julio Lote 1`, um app saudavel que dividia o lote.
--
-- A EXCLUSAO E POR PERFIL, NAO POR LOTE, de proposito. Lote mistura apps; app
-- nao mistura. Filtrar pelo app atinge exatamente o que esta bloqueado e nada
-- alem disso.
--
-- POR QUE UM ARRAY E NAO UM `not exists` NA CONSULTA. O claim roda a cada
-- despacho e o CTE `source` varre todos os candidatos vencidos -- em onda de
-- agendamento em massa, milhares. Resolver os perfis bloqueados UMA vez, antes
-- da consulta, troca N subconsultas por uma varredura de array curto: no pior
-- caso real de hoje, 169 perfis. Quando nao ha bloqueio nenhum -- o estado
-- normal -- o array e vazio e o teste custa quase nada.
--
-- O RESTO DA FUNCAO E IDENTICO A MIGRATION 325, inclusive a excecao que deixa
-- item ja aceito pelo provedor (`creation_id` preenchido) ser reconciliado
-- mesmo com o lote pausado. Item de app bloqueado, porem, fica de fora ate com
-- `creation_id`: se a API esta fechada, o `media_publish` daquele container vai
-- falhar do mesmo jeito, e insistir so gera mais deteccao.
create or replace function public.claim_publication_items(
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 120
)
returns table (
  id uuid, organization_id uuid, batch_id uuid, profile_id uuid,
  format public.publication_format, status public.publication_item_status,
  execute_at timestamptz, caption text, idempotency_key text,
  attempt_count integer, creation_id text, lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  blocked_profile_ids uuid[];
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'Somente service_role pode reivindicar publicações.'; end if;
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120
    or p_limit not between 1 and 100 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Parâmetros de claim inválidos.';
  end if;

  select coalesce(array_agg(profile.id), '{}'::uuid[]) into blocked_profile_ids
  from public.instagram_profiles profile
  join public.meta_apps app on app.id = profile.meta_app_id
  where profile.deleted_at is null
    and app.api_block_until is not null
    and app.api_block_until > timezone('utc', now());

  return query
  with source as (
    select item.id, item.organization_id, item.profile_id, item.execute_at, item.created_at,
      case when item.creation_id is not null then 0 else 1 end priority_band
    from public.publication_items item
    where item.archived_at is null
      and item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
      and (item.execute_at is null or item.execute_at <= timezone('utc', now()))
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.dispatch_staged_until is null or item.dispatch_staged_until <= timezone('utc', now()))
      and (item.pipeline_version = 1 or item.creation_id is not null or item.preparation_status = 'ready')
      and not (coalesce(item.zernio_recovery_count, 0) > 0 and item.creation_id is null)
      and not (item.profile_id = any(blocked_profile_ids))
      and (
        item.creation_id is not null
        or not exists (
          select 1 from public.publication_batch_circuit_breakers breaker
          where breaker.batch_id = item.batch_id and breaker.paused_at is not null
        )
      )
      and not (
        item.pipeline_version = 1
        and item.creation_id is null
        and item.idempotency_key like 'bulk:%'
        and exists (
          select 1 from public.publication_slot_risk_incidents risk
          where risk.organization_id = item.organization_id
            and risk.batch_id = item.batch_id
            and risk.slot_execute_at = item.execute_at
            and risk.state = 'at_risk'
        )
      )
  ), fair as (
    select source.*,
      row_number() over (partition by source.organization_id order by source.priority_band, coalesce(source.execute_at, source.created_at), source.id) org_position,
      row_number() over (partition by source.profile_id order by source.priority_band, coalesce(source.execute_at, source.created_at), source.id) profile_position
    from source
  ), selected as (
    select fair.id from fair order by fair.priority_band, fair.profile_position, fair.org_position,
      coalesce(fair.execute_at, fair.created_at), fair.organization_id, fair.id limit p_limit
  ), locked as (
    select item.id from public.publication_items item join selected on selected.id = item.id
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item.attempt_count + case when item.creation_id is null or item.status = 'failed' then 1 else 0 end,
        active_claim_consumed_attempt = item.creation_id is null or item.status = 'failed',
        dispatch_staged_by = null, dispatch_staged_at = null, dispatch_staged_until = null
    from locked where item.id = locked.id returning item.*
  ), updated_batches as (
    update public.publication_batches batch set status = 'processing'
    where batch.id in (select distinct claimed.batch_id from claimed) and batch.status in ('queued', 'validating')
  )
  select claimed.id, claimed.organization_id, claimed.batch_id, claimed.profile_id,
    claimed.format, claimed.status, claimed.execute_at, claimed.caption, claimed.idempotency_key,
    claimed.attempt_count, claimed.creation_id, claimed.lease_until from claimed;
end;
$$;

revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;

notify pgrst, 'reload schema';

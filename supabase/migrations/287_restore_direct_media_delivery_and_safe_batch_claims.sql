-- Restaura a entrega direta de mídia no worker sem remover o pipeline v2.
-- A tabela zernio_prepared_media permanece apenas como legado inativo.

create or replace function public.is_publication_duplicate_content_failure(
  p_error_code text,
  p_error_message text
) returns boolean
language sql
immutable
parallel safe
as $$
  select lower(trim(coalesce(p_error_code, ''))) in (
    'duplicate_content', 'duplicate_content_detected', 'zernio_duplicate_content'
  ) or lower(trim(coalesce(p_error_message, ''))) like 'duplicate content detected.%';
$$;

create or replace function public.apply_publication_batch_failure_circuit_breaker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
begin
  if new.event_type not in ('published', 'failed') then return new; end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = new.publication_item_id;
  if item_row.id is null then return new; end if;

  -- Falhas transitórias, de infraestrutura e de conteúdo duplicado pertencem
  -- ao item. Elas não podem contribuir para pausar centenas de publicações.
  if new.event_type = 'failed' and (
    item_row.next_attempt_at is not null
    or public.is_publication_infrastructure_error(new.error_code, new.error_message)
    or public.is_publication_duplicate_content_failure(new.error_code, new.error_message)
  ) then
    return new;
  end if;

  insert into public.publication_batch_terminal_outcomes (
    publication_item_id, batch_id, organization_id, outcome, event_id, reconciled_at
  ) values (
    item_row.id, item_row.batch_id, item_row.organization_id,
    case when new.event_type = 'published' then 'published' else 'failed' end,
    new.id, null
  ) on conflict (publication_item_id) do nothing;

  return new;
end;
$$;

-- Itens já aceitos pelo provedor devem sempre avançar para polling. O circuit
-- breaker continua bloqueando somente novas criações do lote pausado.
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
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido';
  end if;
  if p_limit not between 1 and 100 or p_lease_seconds not between 30 and 900 then
    raise exception using errcode = '22023', message = 'Limite ou lease de claim inválido';
  end if;

  return query
  with eligible as (
    select item.id, item.organization_id, item.profile_id, item.execute_at, item.created_at,
      row_number() over (partition by item.organization_id order by coalesce(item.execute_at, item.created_at), item.created_at, item.id) as org_position,
      row_number() over (partition by item.profile_id order by coalesce(item.execute_at, item.created_at), item.created_at, item.id) as profile_position
    from public.publication_items item
    where item.status in ('ready', 'waiting', 'preparing', 'failed')
      and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
      and (item.execute_at is null or item.execute_at <= timezone('utc', now()))
      and (item.next_attempt_at is null or item.next_attempt_at <= timezone('utc', now()))
      and (item.lease_until is null or item.lease_until <= timezone('utc', now()))
      and (item.pipeline_version = 1 or item.creation_id is not null or item.preparation_status = 'ready')
      and not (coalesce(item.zernio_recovery_count, 0) > 0 and item.creation_id is null)
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
  ), selected as (
    select eligible.id from eligible
    order by eligible.profile_position, eligible.org_position,
      coalesce(eligible.execute_at, eligible.created_at), eligible.organization_id, eligible.id
    limit p_limit
  ), locked as (
    select item.id from public.publication_items item
    join selected on selected.id = item.id
    for update of item skip locked
  ), claimed as (
    update public.publication_items item
    set status = 'preparing', claimed_by = trim(p_worker_id),
        lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
        next_attempt_at = null,
        attempt_count = item.attempt_count + case when item.creation_id is null or item.status = 'failed' then 1 else 0 end
    from locked where item.id = locked.id
    returning item.id, item.organization_id, item.batch_id, item.profile_id,
      item.format, item.status, item.execute_at, item.caption, item.idempotency_key,
      item.attempt_count, item.creation_id, item.lease_until
  ), updated_batches as (
    update public.publication_batches batch
    set status = 'processing'
    where batch.id in (select distinct claimed.batch_id from claimed)
      and batch.status in ('queued', 'validating')
  )
  select * from claimed;
end;
$$;

revoke all on function public.is_publication_duplicate_content_failure(text, text) from public, anon, authenticated;
grant execute on function public.is_publication_duplicate_content_failure(text, text) to service_role;
revoke all on function public.claim_publication_items(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_publication_items(text, integer, integer) to service_role;

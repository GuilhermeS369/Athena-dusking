-- Pausa somente o despacho de um lote quando houver cinco falhas consecutivas.
-- Falhas isoladas continuam encerrando apenas o item e não bloqueiam os demais.

create table if not exists public.publication_batch_circuit_breakers (
  batch_id uuid primary key references public.publication_batches (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  paused_at timestamptz,
  paused_reason text,
  last_failure_item_id uuid references public.publication_items (id) on delete set null,
  resumed_at timestamptz,
  resumed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists publication_batch_circuit_breakers_org_paused_idx
  on public.publication_batch_circuit_breakers (organization_id, paused_at desc)
  where paused_at is not null;

alter table public.publication_batch_circuit_breakers enable row level security;
revoke all on table public.publication_batch_circuit_breakers from public, anon, authenticated;
grant select on table public.publication_batch_circuit_breakers to authenticated;
grant all on table public.publication_batch_circuit_breakers to service_role;

create or replace function public.apply_publication_batch_failure_circuit_breaker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  consecutive_count integer;
begin
  if new.event_type in ('published', 'cancelled') then
    select * into item_row
    from public.publication_items
    where id = new.publication_item_id;
    if item_row.id is not null then
      insert into public.publication_batch_circuit_breakers (
        batch_id, organization_id, consecutive_failures, updated_at
      ) values (
        item_row.batch_id, item_row.organization_id, 0, timezone('utc', now())
      )
      on conflict (batch_id) do update set
        consecutive_failures = case when publication_batch_circuit_breakers.paused_at is null then 0 else publication_batch_circuit_breakers.consecutive_failures end,
        updated_at = excluded.updated_at;
    end if;
    return new;
  end if;

  if new.event_type <> 'failed' then
    return new;
  end if;

  select * into item_row
  from public.publication_items
  where id = new.publication_item_id;
  if item_row.id is null then return new; end if;

  -- Retentativas do mesmo item não contam como cinco postagens com falha.
  -- O circuito só observa uma falha terminal: sem próximo retry agendado.
  if item_row.next_attempt_at is not null then
    return new;
  end if;

  -- Uma sequência considera os cinco resultados terminais mais recentes do lote.
  -- Publicação confirmada, remoção ou cancelamento zera a sequência.
  select coalesce(breaker.consecutive_failures, 0) + 1 into consecutive_count
  from public.publication_batch_circuit_breakers breaker
  where breaker.batch_id = item_row.batch_id
  for update;
  consecutive_count := coalesce(consecutive_count, 1);

  insert into public.publication_batch_circuit_breakers (
    batch_id, organization_id, consecutive_failures, last_failure_item_id, updated_at
  ) values (
    item_row.batch_id, item_row.organization_id, consecutive_count, item_row.id, timezone('utc', now())
  )
  on conflict (batch_id) do update set
    consecutive_failures = excluded.consecutive_failures,
    last_failure_item_id = excluded.last_failure_item_id,
    updated_at = excluded.updated_at;

  if consecutive_count >= 5 then
    update public.publication_batch_circuit_breakers
    set paused_at = coalesce(paused_at, timezone('utc', now())),
        paused_reason = 'O lote foi pausado após 5 falhas consecutivas. Corrija a causa e use Continuar lote.',
        updated_at = timezone('utc', now())
    where batch_id = item_row.batch_id;
  end if;
  return new;
end;
$$;

drop trigger if exists publication_batch_failure_circuit_breaker_event on public.publication_item_events;
create trigger publication_batch_failure_circuit_breaker_event
after insert on public.publication_item_events
for each row execute function public.apply_publication_batch_failure_circuit_breaker();

create or replace function public.resume_publication_batch_after_circuit_breaker(
  p_organization_id uuid,
  p_batch_id uuid,
  p_actor_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_at timestamptz := timezone('utc', now());
  actor_id uuid := auth.uid();
  ignored_count bigint := 0;
  continued_count bigint := 0;
begin
  if auth.role() <> 'service_role' and (
    actor_id is null or not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[])
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  perform 1 from public.publication_batches
  where id = p_batch_id and organization_id = p_organization_id
  for update;
  if not found then raise exception using errcode = 'P0002', message = 'Lote não encontrado.'; end if;

  perform 1 from public.publication_batch_circuit_breakers
  where batch_id = p_batch_id and organization_id = p_organization_id and paused_at is not null
  for update;
  if not found then raise exception using errcode = '22023', message = 'Este lote não está pausado por falhas consecutivas.'; end if;

  with expired as (
    update public.publication_items item
    set status = 'ignored', claimed_by = null, lease_until = null, next_attempt_at = null,
        last_error_code = 'batch_continued_schedule_expired',
        last_error_message = 'Horário anterior ignorado ao continuar o lote manualmente.'
    where item.organization_id = p_organization_id and item.batch_id = p_batch_id
      and item.status in ('waiting', 'ready', 'failed')
      and item.execute_at is not null and item.execute_at <= now_at
    returning item.id, item.status
  ), expired_events as (
    insert into public.publication_item_events (organization_id, publication_item_id, event_type, previous_status, status, actor_user_id, actor_label, error_code, error_message, metadata)
    select p_organization_id, id, 'cancelled', status, 'ignored', actor_id, p_actor_label,
      'batch_continued_schedule_expired', 'Horário anterior ignorado ao continuar o lote manualmente.',
      jsonb_build_object('action', 'continue_batch_skip_expired')
    from expired
    returning publication_item_id
  ) select count(*) into ignored_count from expired_events;

  update public.publication_items item
  set status = 'waiting', claimed_by = null, lease_until = null, next_attempt_at = null
  where item.organization_id = p_organization_id and item.batch_id = p_batch_id
    and item.status in ('waiting', 'ready')
    and (item.execute_at is null or item.execute_at > now_at);
  get diagnostics continued_count = row_count;

  update public.publication_batch_circuit_breakers
  set consecutive_failures = 0, paused_at = null, paused_reason = null,
      resumed_at = now_at, resumed_by = actor_id, updated_at = now_at
  where batch_id = p_batch_id;

  perform public.sync_publication_batch_status(p_batch_id);
  return jsonb_build_object('ignoredItems', ignored_count, 'continuedItems', continued_count);
end;
$$;

revoke all on function public.resume_publication_batch_after_circuit_breaker(uuid, uuid, text) from public, anon;
grant execute on function public.resume_publication_batch_after_circuit_breaker(uuid, uuid, text) to authenticated, service_role;

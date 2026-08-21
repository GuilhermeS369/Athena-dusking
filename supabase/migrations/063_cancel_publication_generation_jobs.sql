-- Cancelamento seguro de jobs grandes de geração.
-- A função cancela o job, libera claims/leases dos chunks ainda não terminais
-- e cancela apenas publicações geradas que continuam em estados canceláveis.

create or replace function public.cancel_publication_generation_job(
  p_job_id uuid,
  p_actor_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.publication_generation_jobs%rowtype;
  previous_status text;
  cancelled_chunks integer := 0;
  cancelled_items integer := 0;
  preserved_items integer := 0;
  batch_status public.publication_batch_status;
  item_row public.publication_items%rowtype;
  actor_id uuid := auth.uid();
  actor_label text := nullif(left(trim(coalesce(p_actor_label, auth.jwt() ->> 'email', '')), 160), '');
begin
  select * into job_row
  from public.publication_generation_jobs
  where id = p_job_id;

  if job_row.id is null then
    raise exception using errcode = 'P0002', message = 'Job de geração não encontrado.';
  end if;

  if auth.role() = 'authenticated'
    and not public.has_organization_role(job_row.organization_id, array['admin', 'operator']::public.organization_role[])
  then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  -- Mantém a ordem de lock compatível com process_publication_generation_chunk:
  -- chunks primeiro, job depois. Isso evita deadlock quando um worker estiver
  -- finalizando um chunk ao mesmo tempo em que o usuário cancela o job.
  perform 1
  from public.publication_generation_job_chunks
  where job_id = p_job_id
    and status in ('queued', 'processing', 'failed')
  order by chunk_index, id
  for update;

  select * into job_row
  from public.publication_generation_jobs
  where id = p_job_id
  for update;

  previous_status := job_row.status;

  if job_row.status = 'cancelled' then
    return jsonb_build_object(
      'job', to_jsonb(job_row),
      'cancelledChunks', 0,
      'cancelledItems', 0,
      'preservedItems', 0,
      'alreadyCancelled', true
    );
  end if;

  if job_row.status not in ('queued', 'processing', 'paused', 'failed') then
    raise exception using errcode = '23514', message = 'Este job não pode mais ser cancelado.';
  end if;

  update public.publication_generation_job_chunks
  set status = 'cancelled',
      claimed_by = null,
      lease_until = null,
      completed_at = coalesce(completed_at, timezone('utc', now())),
      last_error_message = null
  where job_id = p_job_id
    and status in ('queued', 'processing', 'failed');

  get diagnostics cancelled_chunks = row_count;

  update public.publication_generation_jobs
  set status = 'cancelled',
      claimed_by = null,
      lease_until = null,
      last_error_message = null,
      completed_at = timezone('utc', now()),
      metadata = metadata || jsonb_build_object(
        'cancelled_at', timezone('utc', now()),
        'cancelled_by', actor_label,
        'cancelled_by_user_id', actor_id
      )
  where id = p_job_id
  returning * into job_row;

  if job_row.batch_id is not null then
    select count(*)::integer into preserved_items
    from public.publication_items
    where batch_id = job_row.batch_id
      and status not in ('waiting', 'ready', 'preparing', 'publishing', 'failed');

    for item_row in
      select *
      from public.publication_items
      where batch_id = job_row.batch_id
        and status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
      order by created_at, id
      for update
    loop
      update public.publication_items
      set status = 'cancelled',
          cancelled_at = timezone('utc', now()),
          next_attempt_at = null,
          lease_until = null,
          claimed_by = null,
          creation_id = null
      where id = item_row.id;

      delete from public.publication_dispatch_rate_reservations
      where publication_item_id = item_row.id;

      perform public.log_publication_item_event(
        item_row.id,
        'cancelled',
        item_row.status,
        'cancelled',
        actor_id,
        actor_label,
        null,
        null,
        jsonb_build_object('action', 'cancelled_generation_job_by_user', 'generation_job_id', job_row.id, 'batch_id', job_row.batch_id)
      );

      cancelled_items := cancelled_items + 1;
    end loop;

    batch_status := public.sync_publication_batch_status(job_row.batch_id);
  end if;

  perform public.log_publication_generation_job_event(
    job_row.id,
    'cancelled',
    previous_status,
    'cancelled',
    null,
    actor_id,
    actor_label,
    'Job de geração cancelado pelo usuário.',
    jsonb_build_object(
      'batch_id', job_row.batch_id,
      'batch_status', batch_status,
      'cancelled_chunks', cancelled_chunks,
      'cancelled_items', cancelled_items,
      'preserved_items', preserved_items
    )
  );

  return jsonb_build_object(
    'job', to_jsonb(job_row),
    'batchStatus', batch_status,
    'cancelledChunks', cancelled_chunks,
    'cancelledItems', cancelled_items,
    'preservedItems', preserved_items,
    'alreadyCancelled', false
  );
end;
$$;

revoke all on function public.cancel_publication_generation_job(uuid, text) from public, anon;
grant execute on function public.cancel_publication_generation_job(uuid, text) to authenticated, service_role;

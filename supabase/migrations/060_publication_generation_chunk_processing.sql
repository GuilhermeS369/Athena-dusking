-- Expansão idempotente de jobs de geração em chunks.
-- Esta etapa cria o batch uma única vez por job, materializa chunks a partir de
-- payload.items e permite que o worker processe cada chunk sem depender da Vercel.

alter table public.publication_generation_jobs
  add column if not exists batch_id uuid references public.publication_batches (id) on delete set null;

create index if not exists publication_generation_jobs_batch_idx
  on public.publication_generation_jobs (organization_id, batch_id)
  where batch_id is not null;

create or replace function public.materialize_publication_generation_job(
  p_job_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.publication_generation_jobs%rowtype;
  items jsonb;
  total_items integer;
  chunk_size integer;
  chunk_index integer := 0;
  chunk_offset integer := 0;
  chunk_payload jsonb;
  chunk_expected integer;
  batch_row public.publication_batches%rowtype;
begin
  select * into job_row
  from public.publication_generation_jobs
  where id = p_job_id
    and claimed_by = p_worker_id
    and status = 'processing'
  for update;

  if job_row.id is null then
    raise exception using errcode = 'P0002', message = 'Job não encontrado ou pertence a outro worker.';
  end if;

  items := job_row.payload -> 'items';
  if jsonb_typeof(items) <> 'array' then
    raise exception using errcode = '22023', message = 'Payload do job precisa conter items como array.';
  end if;

  total_items := jsonb_array_length(items);
  if total_items = 0 then
    raise exception using errcode = '22023', message = 'Job sem itens para materializar.';
  end if;
  chunk_size := greatest(1, least(coalesce(job_row.chunk_size, 500), 1000));

  if job_row.batch_id is null then
    insert into public.publication_batches (
      organization_id, created_by, created_by_email, name, scheduled_for, status, review_confirmed_at
    ) values (
      job_row.organization_id, job_row.created_by, job_row.created_by_email,
      job_row.name, job_row.scheduled_for, 'queued', timezone('utc', now())
    ) returning * into batch_row;

    update public.publication_generation_jobs
    set batch_id = batch_row.id
    where id = job_row.id;
    job_row.batch_id := batch_row.id;
  end if;

  while chunk_offset < total_items loop
    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb), count(*)::integer
    into chunk_payload, chunk_expected
    from jsonb_array_elements(items) with ordinality
    where ordinality > chunk_offset
      and ordinality <= chunk_offset + chunk_size;

    insert into public.publication_generation_job_chunks (
      job_id, organization_id, chunk_index, payload, expected_items
    ) values (
      job_row.id, job_row.organization_id, chunk_index, chunk_payload, chunk_expected
    )
    on conflict (job_id, chunk_index) do update
      set payload = excluded.payload,
          expected_items = excluded.expected_items,
          updated_at = timezone('utc', now())
      where public.publication_generation_job_chunks.status in ('queued', 'failed');

    chunk_index := chunk_index + 1;
    chunk_offset := chunk_offset + chunk_size;
  end loop;

  update public.publication_generation_jobs
  set expected_items = coalesce(expected_items, total_items),
      chunk_count = chunk_index,
      metadata = metadata || jsonb_build_object('materialized_at', timezone('utc', now()), 'materialized_by', p_worker_id)
  where id = job_row.id;

  perform public.log_publication_generation_job_event(
    job_row.id, 'materialized', 'processing', 'processing', null, null, p_worker_id,
    'Job materializado em chunks.',
    jsonb_build_object('batch_id', job_row.batch_id, 'total_items', total_items, 'chunk_count', chunk_index, 'chunk_size', chunk_size)
  );

  return jsonb_build_object('jobId', job_row.id, 'batchId', job_row.batch_id, 'totalItems', total_items, 'chunkCount', chunk_index, 'chunkSize', chunk_size);
end;
$$;

create or replace function public.claim_publication_generation_job_chunks(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 300
)
returns table (
  id uuid,
  job_id uuid,
  organization_id uuid,
  chunk_index integer,
  status text,
  payload jsonb,
  expected_items integer,
  generated_items integer,
  failed_items integer,
  attempt_count integer,
  lease_until timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_limit not between 1 and 50 then
    raise exception using errcode = '22023', message = 'Limite de claim deve estar entre 1 e 50.';
  end if;
  if p_lease_seconds not between 60 and 3600 then
    raise exception using errcode = '22023', message = 'Lease deve estar entre 60 e 3600 segundos.';
  end if;

  return query
  with candidates as (
    select chunk_row.id
    from public.publication_generation_job_chunks as chunk_row
    join public.publication_generation_jobs as job_row on job_row.id = chunk_row.job_id
    where chunk_row.status in ('queued', 'processing', 'failed')
      and job_row.status = 'processing'
      and job_row.batch_id is not null
      and (chunk_row.status <> 'failed' or chunk_row.attempt_count < 3)
      and (chunk_row.lease_until is null or chunk_row.lease_until <= timezone('utc', now()))
    order by job_row.created_at, chunk_row.chunk_index, chunk_row.id
    for update of chunk_row skip locked
    limit p_limit
  ), claimed as (
    update public.publication_generation_job_chunks as chunk_row
    set
      status = 'processing',
      claimed_by = trim(p_worker_id),
      lease_until = timezone('utc', now()) + make_interval(secs => p_lease_seconds),
      attempt_count = chunk_row.attempt_count + 1,
      last_error_message = null
    from candidates
    where chunk_row.id = candidates.id
    returning chunk_row.id, chunk_row.job_id, chunk_row.organization_id, chunk_row.chunk_index,
      chunk_row.status, chunk_row.payload, chunk_row.expected_items, chunk_row.generated_items,
      chunk_row.failed_items, chunk_row.attempt_count, chunk_row.lease_until
  )
  select * from claimed;
end;
$$;

create or replace function public.process_publication_generation_chunk(
  p_chunk_id uuid,
  p_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  chunk_row public.publication_generation_job_chunks%rowtype;
  job_row public.publication_generation_jobs%rowtype;
  item_json jsonb;
  item_row public.publication_items%rowtype;
  existing_item_id uuid;
  media_id uuid;
  resolved_execute_at timestamptz;
  schedule_base_at timestamptz;
  candidate_window_start timestamptz;
  candidate_minute timestamptz;
  item_idempotency_key text;
  item_index integer := 0;
  generated_count integer := 0;
  failed_count integer := 0;
  skipped_count integer := 0;
  last_error text;
  remaining_chunks integer;
  has_failed_chunks boolean;
begin
  select * into chunk_row
  from public.publication_generation_job_chunks
  where id = p_chunk_id
    and claimed_by = p_worker_id
    and status = 'processing'
  for update;

  if chunk_row.id is null then
    raise exception using errcode = 'P0002', message = 'Chunk não encontrado ou pertence a outro worker.';
  end if;

  select * into job_row
  from public.publication_generation_jobs
  where id = chunk_row.job_id
    and status = 'processing'
  for update;

  if job_row.id is null or job_row.batch_id is null then
    raise exception using errcode = 'P0002', message = 'Job do chunk não está pronto para processamento.';
  end if;

  for item_json in select value from jsonb_array_elements(chunk_row.payload)
  loop
    item_index := item_index + 1;
    begin
      if nullif(item_json ->> 'profileId', '') is null then
        raise exception using errcode = '22023', message = 'Item sem profileId.';
      end if;
      if nullif(item_json ->> 'format', '') is null then
        raise exception using errcode = '22023', message = 'Item sem formato.';
      end if;
      if jsonb_typeof(item_json -> 'mediaIds') <> 'array' or jsonb_array_length(item_json -> 'mediaIds') = 0 then
        raise exception using errcode = '22023', message = 'Item sem mídias.';
      end if;

      item_idempotency_key := coalesce(nullif(item_json ->> 'idempotencyKey', ''), nullif(item_json ->> 'idempotency_key', ''), concat('generation:', job_row.id, ':', chunk_row.chunk_index, ':', item_index));

      select id into existing_item_id
      from public.publication_items
      where organization_id = job_row.organization_id
        and idempotency_key = item_idempotency_key;

      if existing_item_id is not null then
        skipped_count := skipped_count + 1;
        continue;
      end if;

      if not exists (
        select 1
        from public.instagram_profiles profile_row
        where profile_row.id = (item_json ->> 'profileId')::uuid
          and profile_row.organization_id = job_row.organization_id
          and profile_row.deleted_at is null
      ) then
        raise exception using errcode = '23514', message = 'Perfil inválido para a organização.';
      end if;

      if exists (
        select 1
        from jsonb_array_elements_text(item_json -> 'mediaIds') as media_value(id)
        left join public.media_assets asset on asset.id = media_value.id::uuid
          and asset.organization_id = job_row.organization_id
          and asset.deleted_at is null
          and asset.deletion_requested_at is null
          and asset.status = 'ready'
        where asset.id is null
      ) then
        raise exception using errcode = '23514', message = 'Uma ou mais mídias não pertencem à organização ou não estão prontas.';
      end if;

      perform pg_advisory_xact_lock(hashtextextended((item_json ->> 'profileId'), 0));
      resolved_execute_at := nullif(item_json ->> 'executeAt', '')::timestamptz;
      schedule_base_at := nullif(item_json ->> 'scheduleBaseAt', '')::timestamptz;

      if resolved_execute_at is null and nullif(item_json ->> 'scheduleTime', '') is not null then
        candidate_window_start := (
          coalesce(schedule_base_at at time zone 'America/Sao_Paulo', timezone('America/Sao_Paulo', now()))::date
          + (item_json ->> 'scheduleTime')::time
        ) at time zone 'America/Sao_Paulo';

        while candidate_window_start + interval '9 minutes 59 seconds' <= timezone('utc', now()) loop
          candidate_window_start := candidate_window_start + interval '1 day';
        end loop;

        loop
          if not exists (
            select 1
            from public.publication_items occupied
            where occupied.organization_id = job_row.organization_id
              and occupied.profile_id = (item_json ->> 'profileId')::uuid
              and occupied.execute_at >= candidate_window_start
              and occupied.execute_at < candidate_window_start + interval '10 minutes'
              and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
          ) then
            select candidate.minute_start into candidate_minute
            from (
              select candidate_window_start + make_interval(mins => minute_offset) as minute_start
              from generate_series(1, 9) as minute_offset
            ) as candidate
            where candidate.minute_start > timezone('utc', now())
            order by random()
            limit 1;

            if candidate_minute is not null then
              resolved_execute_at := candidate_minute + make_interval(secs => floor(random() * 60)::integer);
              exit;
            end if;
          end if;

          candidate_window_start := candidate_window_start + interval '1 day';
        end loop;
      end if;

      if resolved_execute_at is not null and exists (
        select 1
        from public.publication_items occupied
        where occupied.organization_id = job_row.organization_id
          and occupied.profile_id = (item_json ->> 'profileId')::uuid
          and date_trunc('minute', occupied.execute_at) = date_trunc('minute', resolved_execute_at)
          and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
      ) then
        raise exception using errcode = 'P0001', message = 'minute_slot_conflict';
      end if;

      insert into public.publication_items (
        organization_id, batch_id, profile_id, format, status, execute_at, caption, idempotency_key
      ) values (
        job_row.organization_id, job_row.batch_id, (item_json ->> 'profileId')::uuid,
        (item_json ->> 'format')::public.publication_format,
        case when resolved_execute_at is null then 'ready'::public.publication_item_status else 'waiting'::public.publication_item_status end,
        resolved_execute_at, nullif(item_json ->> 'caption', ''), item_idempotency_key
      ) returning * into item_row;

      for media_id in select value::uuid from jsonb_array_elements_text(item_json -> 'mediaIds')
      loop
        insert into public.publication_item_media (organization_id, publication_item_id, media_asset_id, position)
        values (job_row.organization_id, item_row.id, media_id, (select count(*) from public.publication_item_media where publication_item_id = item_row.id));
      end loop;

      perform public.log_publication_item_event(item_row.id, 'queued', null, item_row.status, job_row.created_by, job_row.created_by_email, null, null, jsonb_build_object('execute_at', item_row.execute_at, 'generation_job_id', job_row.id, 'generation_chunk_id', chunk_row.id));
      generated_count := generated_count + 1;
    exception when others then
      failed_count := failed_count + 1;
      last_error := SQLERRM;
    end;
  end loop;

  update public.publication_generation_job_chunks
  set status = case when failed_count > 0 then 'failed' else 'completed' end,
      generated_items = generated_count + skipped_count,
      failed_items = failed_count,
      claimed_by = null,
      lease_until = null,
      last_error_message = last_error,
      completed_at = timezone('utc', now())
  where id = chunk_row.id;

  update public.publication_generation_jobs job_update
  set generated_items = coalesce((select sum(generated_items) from public.publication_generation_job_chunks where job_id = job_update.id), 0),
      failed_items = coalesce((select sum(failed_items) from public.publication_generation_job_chunks where job_id = job_update.id), 0)
  where id = job_row.id;

  perform public.log_publication_generation_job_event(
    job_row.id,
    case when failed_count > 0 then 'chunk_failed' else 'chunk_completed' end,
    'processing', case when failed_count > 0 then 'failed' else 'completed' end,
    chunk_row.id, null, p_worker_id, last_error,
    jsonb_build_object('generated_items', generated_count, 'skipped_items', skipped_count, 'failed_items', failed_count)
  );

  select count(*)::integer into remaining_chunks
  from public.publication_generation_job_chunks
  where job_id = job_row.id
    and status in ('queued', 'processing');

  select exists (
    select 1 from public.publication_generation_job_chunks
    where job_id = job_row.id and status = 'failed'
  ) into has_failed_chunks;

  if remaining_chunks = 0 then
    update public.publication_generation_jobs
    set status = case when has_failed_chunks then 'failed' else 'completed' end,
        claimed_by = null,
        lease_until = null,
        completed_at = timezone('utc', now()),
        last_error_message = case when has_failed_chunks then 'Um ou mais chunks falharam.' else null end
    where id = job_row.id;

    perform public.log_publication_generation_job_event(
      job_row.id,
      case when has_failed_chunks then 'failed' else 'completed' end,
      'processing', case when has_failed_chunks then 'failed' else 'completed' end,
      null, null, p_worker_id,
      case when has_failed_chunks then 'Job concluído com falhas em chunks.' else 'Job concluído com sucesso.' end,
      '{}'::jsonb
    );
  end if;

  return jsonb_build_object('chunkId', chunk_row.id, 'jobId', job_row.id, 'generatedItems', generated_count, 'skippedItems', skipped_count, 'failedItems', failed_count, 'lastError', last_error);
end;
$$;

revoke all on function public.materialize_publication_generation_job(uuid, text) from public, anon, authenticated;
revoke all on function public.claim_publication_generation_job_chunks(text, integer, integer) from public, anon, authenticated;
revoke all on function public.process_publication_generation_chunk(uuid, text) from public, anon, authenticated;

grant execute on function public.materialize_publication_generation_job(uuid, text) to service_role;
grant execute on function public.claim_publication_generation_job_chunks(text, integer, integer) to service_role;
grant execute on function public.process_publication_generation_chunk(uuid, text) to service_role;

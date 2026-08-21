-- Corrige ambiguidade entre variável PL/pgSQL e coluna `chunk_index` na
-- materialização de jobs de geração.

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
  v_chunk_size integer;
  v_chunk_index integer := 0;
  v_chunk_offset integer := 0;
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
  v_chunk_size := greatest(1, least(coalesce(job_row.chunk_size, 500), 1000));

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

  while v_chunk_offset < total_items loop
    select coalesce(jsonb_agg(value order by ordinality), '[]'::jsonb), count(*)::integer
    into chunk_payload, chunk_expected
    from jsonb_array_elements(items) with ordinality
    where ordinality > v_chunk_offset
      and ordinality <= v_chunk_offset + v_chunk_size;

    insert into public.publication_generation_job_chunks (
      job_id, organization_id, chunk_index, payload, expected_items
    ) values (
      job_row.id, job_row.organization_id, v_chunk_index, chunk_payload, chunk_expected
    )
    on conflict (job_id, chunk_index) do update
      set payload = excluded.payload,
          expected_items = excluded.expected_items,
          updated_at = timezone('utc', now())
      where public.publication_generation_job_chunks.status in ('queued', 'failed');

    v_chunk_index := v_chunk_index + 1;
    v_chunk_offset := v_chunk_offset + v_chunk_size;
  end loop;

  update public.publication_generation_jobs
  set expected_items = coalesce(expected_items, total_items),
      chunk_count = v_chunk_index,
      metadata = metadata || jsonb_build_object('materialized_at', timezone('utc', now()), 'materialized_by', p_worker_id)
  where id = job_row.id;

  perform public.log_publication_generation_job_event(
    job_row.id, 'materialized', 'processing', 'processing', null, null, p_worker_id,
    'Job materializado em chunks.',
    jsonb_build_object('batch_id', job_row.batch_id, 'total_items', total_items, 'chunk_count', v_chunk_index, 'chunk_size', v_chunk_size)
  );

  return jsonb_build_object('jobId', job_row.id, 'batchId', job_row.batch_id, 'totalItems', total_items, 'chunkCount', v_chunk_index, 'chunkSize', v_chunk_size);
end;
$$;

revoke all on function public.materialize_publication_generation_job(uuid, text) from public, anon, authenticated;
grant execute on function public.materialize_publication_generation_job(uuid, text) to service_role;

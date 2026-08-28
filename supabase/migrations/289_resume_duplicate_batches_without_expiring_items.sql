-- Remove somente o ledger derivado de falhas explícitas de duplicidade. Os
-- eventos autoritativos permanecem intactos para auditoria.
delete from public.publication_batch_terminal_outcomes outcome
using public.publication_item_events event
where outcome.event_id = event.id
  and outcome.outcome = 'failed'
  and public.is_publication_duplicate_content_failure(event.error_code, event.error_message);

create or replace function public.resume_publication_batch_preserving_items(
  p_organization_id uuid,
  p_batch_id uuid,
  p_actor_label text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  now_at timestamptz := timezone('utc', now());
  status_counts jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Retomada operacional permitida somente ao worker.';
  end if;
  if char_length(trim(coalesce(p_actor_label, ''))) not between 3 and 160 then
    raise exception using errcode = '22023', message = 'Motivo da retomada é obrigatório.';
  end if;

  perform 1 from public.publication_batches batch
  where batch.id = p_batch_id and batch.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Lote não encontrado na organização.';
  end if;

  perform 1 from public.publication_batch_circuit_breakers breaker
  where breaker.batch_id = p_batch_id
    and breaker.organization_id = p_organization_id
    and breaker.paused_at is not null
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'Lote não está pausado.';
  end if;

  update public.publication_batch_circuit_breakers breaker
  set consecutive_failures = 0,
      last_failure_item_id = null,
      paused_at = null,
      paused_reason = null,
      resumed_at = now_at,
      resumed_by = auth.uid(),
      updated_at = now_at
  where breaker.batch_id = p_batch_id
    and breaker.organization_id = p_organization_id;

  perform public.sync_publication_batch_status(p_batch_id);

  select coalesce(jsonb_object_agg(counts.status, counts.total), '{}'::jsonb)
  into status_counts
  from (
    select item.status::text as status, count(*) as total
    from public.publication_items item
    where item.batch_id = p_batch_id and item.organization_id = p_organization_id
    group by item.status
  ) counts;

  return jsonb_build_object(
    'batchId', p_batch_id,
    'resumedAt', now_at,
    'actorLabel', trim(p_actor_label),
    'itemStatuses', status_counts
  );
end;
$$;

revoke all on function public.resume_publication_batch_preserving_items(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.resume_publication_batch_preserving_items(uuid, uuid, text)
  to service_role;

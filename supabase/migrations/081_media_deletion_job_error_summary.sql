-- Mantém um resumo útil de falhas no próprio job de exclusão.
-- Os detalhes completos continuam em media_deletion_job_items.error_message.

create or replace function public.refresh_media_deletion_job_status(p_job_id uuid)
returns public.media_deletion_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.media_deletion_jobs%rowtype;
begin
  update public.media_deletion_jobs job
  set processed_count = stats.processed_count,
      deleted_count = stats.deleted_count,
      failed_count = stats.failed_count,
      affected_item_count = stats.affected_item_count,
      status = case
        when stats.pending_count > 0 then job.status
        when stats.failed_count > 0 then 'completed_with_errors'
        else 'completed'
      end,
      last_error_message = case
        when stats.failed_count > 0 then stats.first_failure_message
        when stats.storage_warning_count > 0 then stats.first_storage_warning
        when stats.pending_count > 0 then job.last_error_message
        else null
      end,
      claimed_by = case when stats.pending_count > 0 then job.claimed_by else null end,
      lease_until = case when stats.pending_count > 0 then job.lease_until else null end,
      finished_at = case when stats.pending_count > 0 then job.finished_at else coalesce(job.finished_at, timezone('utc', now())) end
  from (
    select
      count(*) filter (where item.status in ('deleted', 'skipped', 'failed'))::integer as processed_count,
      count(*) filter (where item.status = 'deleted')::integer as deleted_count,
      count(*) filter (where item.status = 'failed')::integer as failed_count,
      count(*) filter (where item.status in ('pending', 'processing'))::integer as pending_count,
      count(*) filter (where item.status = 'deleted' and item.error_message is not null)::integer as storage_warning_count,
      coalesce(sum(cardinality(item.affected_item_ids)), 0)::integer as affected_item_count,
      min(item.error_message) filter (where item.status = 'failed' and item.error_message is not null) as first_failure_message,
      min(item.error_message) filter (where item.status = 'deleted' and item.error_message is not null) as first_storage_warning
    from public.media_deletion_job_items item
    where item.job_id = p_job_id
  ) stats
  where job.id = p_job_id
  returning job.* into job_row;

  return job_row;
end;
$$;

revoke all on function public.refresh_media_deletion_job_status(uuid) from public, anon, authenticated;
grant execute on function public.refresh_media_deletion_job_status(uuid) to service_role;

-- Corrige a ambiguidade PL/pgSQL entre a coluna job_id e a variável de saída
-- homônima quando uma reconciliação tenta anexar perfis a um job já ativo.

create or replace function public.enqueue_zernio_reconciliation_analytics(
  p_organization_id uuid,
  p_profile_ids uuid[]
)
returns table(job_id uuid, status text, total_count integer, reused boolean, reason text)
language plpgsql security definer set search_path = public as $$
declare
  normalized_profile_ids uuid[] := array(
    select distinct requested.profile_id
    from unnest(coalesce(p_profile_ids, '{}'::uuid[])) as requested(profile_id)
    where requested.profile_id is not null
  );
  active_job public.profile_analytics_refresh_jobs%rowtype;
  created_job record;
  inserted_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if cardinality(normalized_profile_ids) = 0 then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':zernio-reconciliation-analytics', 0));

  select job.* into active_job
  from public.profile_analytics_refresh_jobs job
  where job.organization_id = p_organization_id
    and job.status in ('pending', 'processing')
  order by job.created_at desc
  limit 1
  for update;

  if found then
    insert into public.profile_analytics_refresh_job_items (
      job_id, organization_id, profile_id, zernio_connection_id
    )
    select active_job.id, p_organization_id, profile.id, profile.zernio_connection_id
    from public.instagram_profiles profile
    where profile.organization_id = p_organization_id
      and profile.provider = 'zernio'
      and profile.deleted_at is null
      and profile.zernio_account_id is not null
      and profile.id = any(normalized_profile_ids)
    on conflict on constraint profile_analytics_refresh_job_items_pkey do nothing;

    get diagnostics inserted_count = row_count;

    update public.profile_analytics_refresh_jobs job set
      total_count = (
        select count(*)::integer
        from public.profile_analytics_refresh_job_items item
        where item.job_id = active_job.id
      ),
      metadata = job.metadata || jsonb_build_object(
        'lastZernioReconciliationAt', timezone('utc', now()),
        'lastZernioProfilesRequested', cardinality(normalized_profile_ids),
        'lastZernioProfilesAdded', inserted_count
      )
    where job.id = active_job.id
    returning job.* into active_job;

    return query select active_job.id, active_job.status,
      active_job.total_count, true,
      case when inserted_count > 0 then 'active_job_extended' else 'active_job_unchanged' end;
    return;
  end if;

  select * into created_job
  from public.create_profile_analytics_refresh_job(
    p_organization_id,
    'connection_sync',
    normalized_profile_ids,
    5,
    60,
    true
  )
  limit 1;

  if created_job.job_id is not null then
    return query select created_job.job_id, created_job.status,
      created_job.total_count, created_job.reused, created_job.reason;
  end if;
end;
$$;

revoke all on function public.enqueue_zernio_reconciliation_analytics(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.enqueue_zernio_reconciliation_analytics(uuid, uuid[]) to service_role;

notify pgrst, 'reload schema';

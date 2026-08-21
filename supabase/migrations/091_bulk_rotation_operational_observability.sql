-- Observabilidade operacional dos planos compactos. Leituras agregadas não
-- alteram planos e são restritas a administradores da organização/service_role.

create or replace function public.get_bulk_rotation_operational_summary(
  p_organization_id uuid default null,
  p_stalled_after_seconds integer default 900,
  p_growth_warning_publications bigint default 100000
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and (
    p_organization_id is null or not public.has_organization_role(
      p_organization_id, array['admin']::public.organization_role[]
    )
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  return (
  with limits as (
    select greatest(60, least(coalesce(p_stalled_after_seconds, 900), 86400)) as stalled_seconds,
      greatest(1000::bigint, least(coalesce(p_growth_warning_publications, 100000), 1000000000::bigint)) as growth_limit
  ), scoped_plans as (
    select plan.*
    from public.bulk_publication_plans plan
    where p_organization_id is null or plan.organization_id = p_organization_id
  ), scoped_chunks as (
    select chunk.*
    from public.bulk_publication_generation_chunks chunk
    join scoped_plans plan on plan.id = chunk.plan_id
  ), active as (
    select count(*)::bigint as active_plans,
      coalesce(sum(expected_publications), 0)::bigint as expected_publications,
      coalesce(sum(generated_publications), 0)::bigint as generated_publications,
      coalesce(sum(greatest(expected_publications - generated_publications - ignored_publications - failed_publications, 0)), 0)::bigint as remaining_publications,
      min(created_at) filter (where status in ('queued', 'generating', 'paused')) as oldest_active_plan_at,
      count(*) filter (
        where status in ('queued', 'generating')
          and updated_at < timezone('utc', now()) - make_interval(secs => (select stalled_seconds from limits))
      )::bigint as stalled_plans
    from scoped_plans
    where status in ('queued', 'generating', 'paused')
  ), chunks as (
    select count(*)::bigint as total_chunks,
      count(*) filter (where status = 'processing' and lease_until > timezone('utc', now()))::bigint as processing_chunks,
      count(*) filter (where status = 'processing' and lease_until <= timezone('utc', now()))::bigint as expired_leases,
      count(*) filter (where status = 'failed' and retry_exhausted_at is not null)::bigint as exhausted_chunks,
      count(*) filter (
        where status in ('queued', 'processing', 'failed') and retry_exhausted_at is null
          and coalesce(last_progress_at, created_at) < timezone('utc', now()) - make_interval(secs => (select stalled_seconds from limits))
      )::bigint as stalled_chunks
    from scoped_chunks
  ), storage_counts as (
    select (select count(*)::bigint from scoped_plans) as plan_rows,
      (select count(*)::bigint from public.bulk_publication_plan_profiles profile_plan join scoped_plans plan on plan.id = profile_plan.plan_id) as profile_rows,
      (select count(*)::bigint from public.bulk_publication_plan_media media join scoped_plans plan on plan.id = media.plan_id) as media_rows,
      (select count(*)::bigint from scoped_chunks) as chunk_rows,
      (select count(*)::bigint from public.publication_items item join scoped_plans plan on plan.batch_id = item.batch_id) as materialized_items
  )
  select jsonb_build_object(
    'checkedAt', timezone('utc', now()),
    'organizationId', p_organization_id,
    'activePlans', active.active_plans::text,
    'expectedPublications', active.expected_publications::text,
    'generatedPublications', active.generated_publications::text,
    'remainingPublications', active.remaining_publications::text,
    'oldestActivePlanAt', active.oldest_active_plan_at,
    'chunks', jsonb_build_object(
      'total', chunks.total_chunks::text,
      'processing', chunks.processing_chunks::text,
      'expiredLeases', chunks.expired_leases::text,
      'exhausted', chunks.exhausted_chunks::text,
      'stalled', chunks.stalled_chunks::text
    ),
    'storage', jsonb_build_object(
      'plans', storage_counts.plan_rows::text,
      'profiles', storage_counts.profile_rows::text,
      'mediaSnapshots', storage_counts.media_rows::text,
      'chunks', storage_counts.chunk_rows::text,
      'materializedItems', storage_counts.materialized_items::text
    ),
    'alerts', jsonb_build_array()
      || case when active.stalled_plans > 0 then jsonb_build_array(jsonb_build_object(
        'severity', 'critical', 'kind', 'stalled_plans', 'total', active.stalled_plans::text,
        'message', 'Há planos compactos sem atualização além do limite.'
      )) else '[]'::jsonb end
      || case when chunks.expired_leases > 0 then jsonb_build_array(jsonb_build_object(
        'severity', 'critical', 'kind', 'expired_chunk_leases', 'total', chunks.expired_leases::text,
        'message', 'Há chunks compactos com lease expirado.'
      )) else '[]'::jsonb end
      || case when chunks.stalled_chunks > 0 then jsonb_build_array(jsonb_build_object(
        'severity', 'warning', 'kind', 'stalled_chunks', 'total', chunks.stalled_chunks::text,
        'message', 'Há chunks compactos sem progresso recente.'
      )) else '[]'::jsonb end
      || case when active.remaining_publications > (select growth_limit from limits) then jsonb_build_array(jsonb_build_object(
        'severity', 'warning', 'kind', 'abnormal_backlog_growth', 'total', active.remaining_publications::text,
        'message', 'O backlog compacto ultrapassou o limite configurado.'
      )) else '[]'::jsonb end
  )
  from active cross join chunks cross join storage_counts
  );
end;
$$;

revoke all on function public.get_bulk_rotation_operational_summary(uuid, integer, bigint) from public, anon, authenticated;
grant execute on function public.get_bulk_rotation_operational_summary(uuid, integer, bigint) to service_role;
grant execute on function public.get_bulk_rotation_operational_summary(uuid, integer, bigint) to authenticated;

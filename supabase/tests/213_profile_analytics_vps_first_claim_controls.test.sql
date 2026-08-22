begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  test_organization_id uuid := '21300000-0000-4000-8000-000000000001';
begin
  if cardinality(public.active_profile_analytics_direct_worker_organization_ids(120, 'phase-e-missing-')) <> 0 then
    raise exception 'Prefixo inexistente não pode bloquear o fallback.';
  end if;

  begin
    perform * from public.claim_profile_analytics_refresh_job(
      'phase-e-test-worker',
      300,
      '{}'::uuid[],
      null
    );
    raise exception 'Escopo vazio deveria ser rejeitado.';
  exception
    when sqlstate '22023' then null;
  end;

  insert into public.publication_worker_heartbeats (
    worker_id, worker_kind, status, dry_run, last_seen_at, metadata
  ) values (
    'phase-e-active-direct',
    'profile_analytics',
    'idle',
    false,
    timezone('utc', now()),
    jsonb_build_object(
      'executionMode', 'direct',
      'organizationIds', jsonb_build_array(test_organization_id::text)
    )
  );

  if public.active_profile_analytics_direct_worker_organization_ids(120, 'phase-e-')
    <> array[test_organization_id]::uuid[]
  then
    raise exception 'Heartbeat direto ativo deveria excluir somente sua organização.';
  end if;
end;
$$;

select extensions.pass('controles VPS-first rejeitam escopo vazio e não detectam heartbeat inexistente');
select * from extensions.finish();

rollback;

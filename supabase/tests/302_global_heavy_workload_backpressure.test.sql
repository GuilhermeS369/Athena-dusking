begin;
select '1..5';

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

do $$ declare first_token uuid; second_token uuid; begin
  first_token := public.acquire_operational_heavy_workload_lease(
    'bulk_generation', 'test-generation', null, 30
  );
  second_token := public.acquire_operational_heavy_workload_lease(
    'zernio_sync', 'test-sync', null, 30
  );
  if first_token is null or second_token is not null then
    raise exception 'Lease global não garantiu exclusão mútua.';
  end if;
end $$;
select 'ok 1 - somente uma operação pesada adquire capacidade';

do $$ declare current_token uuid; begin
  select lease_token into current_token
  from public.operational_heavy_workload_lease where slot = 1;
  if not public.release_operational_heavy_workload_lease(current_token) then
    raise exception 'Lease válido não foi liberado.';
  end if;
end $$;
select 'ok 2 - titular libera o lease por token';

do $$ declare acquired uuid; begin
  acquired := public.acquire_operational_heavy_workload_lease(
    'zernio_sync', 'test-sync-after-release', null, 30
  );
  if acquired is null then raise exception 'Capacidade não voltou após release.'; end if;
  perform public.release_operational_heavy_workload_lease(acquired);
end $$;
select 'ok 3 - fila seguinte adquire capacidade depois da liberação';

do $$ begin
  perform public.acquire_operational_heavy_workload_lease(
    'categoria_invalida', 'test-invalid', null, 30
  );
  raise exception 'Categoria inválida foi aceita.';
exception when invalid_parameter_value then return;
end $$;
select 'ok 4 - categorias desconhecidas são rejeitadas';

do $$ begin
  if position('least(greatest(coalesce(p_limit, 250), 1), 250)' in
    pg_get_functiondef('public.clean_publication_queue_finished(uuid,integer)'::regprocedure)) = 0 then
    raise exception 'Limpeza não foi limitada a 250 itens.';
  end if;
end $$;
select 'ok 5 - limpeza usa transações pequenas e limitadas';

rollback;

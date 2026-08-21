-- Teste transacional das Fases 0 e 1. Executar em banco descartável com o
-- schema completo. Nenhum dado permanece porque a transação termina em rollback.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values (
  '19000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'zernio-phase1@example.com', '',
  timezone('utc', now()), timezone('utc', now()), timezone('utc', now())
);

insert into public.organizations (id, name, slug, created_by)
values
  ('29000000-0000-0000-0000-000000000001', 'Zernio sem conexões', 'zernio-sem-conexoes', '19000000-0000-0000-0000-000000000001'),
  ('29000000-0000-0000-0000-000000000002', 'Zernio com conexões', 'zernio-com-conexoes', '19000000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values
  ('29000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-000000000001', 'admin', '19000000-0000-0000-0000-000000000001'),
  ('29000000-0000-0000-0000-000000000002', '19000000-0000-0000-0000-000000000001', 'admin', '19000000-0000-0000-0000-000000000001');

insert into public.zernio_connections (
  id, organization_id, label, encrypted_api_key, status, created_by
) values (
  '39000000-0000-0000-0000-000000000001',
  '29000000-0000-0000-0000-000000000002',
  'Conexão teste',
  'encrypted-test-api-key-value',
  'online',
  '19000000-0000-0000-0000-000000000001'
);

set local role service_role;

do $$
declare
  empty_result record;
  populated_result record;
  reused_result record;
  claimed_result record;
  completed_result jsonb;
  freeze_result jsonb;
begin
  select * into empty_result
  from public.enqueue_zernio_organization_sync_batch(
    '29000000-0000-0000-0000-000000000001',
    '19000000-0000-0000-0000-000000000001',
    '49000000-0000-0000-0000-000000000001',
    '59000000-0000-0000-0000-000000000001'
  );

  if empty_result.total_connections <> 0 or empty_result.reused
     or empty_result.correlation_id <> '59000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'enqueue vazio não retornou o contrato esperado';
  end if;
  if (select status from public.zernio_sync_batches where id = empty_result.batch_id) <> 'completed' then
    raise exception 'lote vazio não foi concluído';
  end if;

  select * into populated_result
  from public.enqueue_zernio_organization_sync_batch(
    '29000000-0000-0000-0000-000000000002',
    '19000000-0000-0000-0000-000000000001',
    '49000000-0000-0000-0000-000000000002',
    '59000000-0000-0000-0000-000000000002'
  );

  if populated_result.total_connections <> 1 or populated_result.reused then
    raise exception 'enqueue com conexão não criou um item';
  end if;
  if (select count(*) from public.zernio_sync_batch_items where batch_id = populated_result.batch_id) <> 1 then
    raise exception 'item do lote não foi persistido';
  end if;

  select * into reused_result
  from public.enqueue_zernio_organization_sync_batch(
    '29000000-0000-0000-0000-000000000002',
    '19000000-0000-0000-0000-000000000001',
    '49000000-0000-0000-0000-000000000003',
    '59000000-0000-0000-0000-000000000003'
  );

  if not reused_result.reused
     or reused_result.batch_id <> populated_result.batch_id
     or reused_result.correlation_id <> populated_result.correlation_id then
    raise exception 'segundo enqueue não reutilizou lote e correlação ativos';
  end if;

  select * into claimed_result
  from public.claim_zernio_sync_batch_items('phase1-test-worker', 1, 180);
  if claimed_result.item_id is null or claimed_result.batch_id <> populated_result.batch_id then
    raise exception 'worker não reivindicou o item do lote criado';
  end if;

  completed_result := public.complete_zernio_sync_batch_item(
    claimed_result.item_id,
    'phase1-test-worker',
    1,
    0,
    null
  );
  if completed_result ->> 'completed' <> 'true'
     or (select status from public.zernio_sync_batch_items where id = claimed_result.item_id) <> 'completed'
     or (select status from public.zernio_sync_batches where id = populated_result.batch_id) <> 'completed' then
    raise exception 'conclusão do item ou lote não convergiu para completed';
  end if;

  freeze_result := public.set_zernio_automatic_duplicate_removal(
    '29000000-0000-0000-0000-000000000002',
    false,
    'Snapshot transacional da Fase 0',
    '59000000-0000-0000-0000-000000000004',
    '19000000-0000-0000-0000-000000000001'
  );

  if freeze_result ->> 'automaticDuplicateRemovalEnabled' <> 'false' then
    raise exception 'congelamento não foi persistido';
  end if;

  perform public.set_zernio_automatic_duplicate_removal(
    '29000000-0000-0000-0000-000000000002',
    true,
    null,
    null,
    '19000000-0000-0000-0000-000000000001'
  );

  if not (select automatic_duplicate_removal_enabled from public.zernio_sync_operational_controls where organization_id = '29000000-0000-0000-0000-000000000002') then
    raise exception 'descongelamento não foi persistido';
  end if;
end;
$$;

reset role;
rollback;

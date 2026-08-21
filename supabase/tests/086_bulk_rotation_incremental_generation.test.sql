-- Teste transacional da geração incremental compacta. Executar em banco
-- descartável com schema até a migration 086.

begin;

create or replace function public.media_asset_has_storage_object(p_storage_path text)
returns boolean language sql stable security definer set search_path = public
as $$ select p_storage_path is not null $$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values (
  '11000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'bulk-generation@example.com', '', timezone('utc', now()),
  timezone('utc', now()), timezone('utc', now())
);

insert into public.organizations (id, name, slug, created_by)
values ('21000000-0000-0000-0000-000000000001', 'Organização geração bulk', 'organizacao-geracao-bulk', '11000000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('21000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', 'admin', '11000000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
) values
  ('31000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', 'bulk-generation-1', 'bulk_generation_1', 'token', 'online', '11000000-0000-0000-0000-000000000001'),
  ('31000000-0000-0000-0000-000000000002', '21000000-0000-0000-0000-000000000001', 'bulk-generation-2', 'bulk_generation_2', 'token', 'online', '11000000-0000-0000-0000-000000000001');

insert into public.media_assets (
  id, organization_id, uploaded_by, storage_path, original_name, mime_type, kind,
  size_bytes, checksum_sha256, status
) values
  ('41000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001/rotation-a.jpg', 'rotation-a.jpg', 'image/jpeg', 'image', 1024, repeat('a', 64), 'ready'),
  ('41000000-0000-0000-0000-000000000002', '21000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001/rotation-b.jpg', 'rotation-b.jpg', 'image/jpeg', 'image', 1024, repeat('b', 64), 'ready');

set local role authenticated;
set local request.jwt.claim.sub = '11000000-0000-0000-0000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'bulk-generation@example.com';

do $$
declare
  result jsonb;
begin
  result := public.create_bulk_rotation_plan(
    '21000000-0000-0000-0000-000000000001', 'bulk-generation-request-0001', 'Geração incremental',
    array['31000000-0000-0000-0000-000000000001'::uuid], 'ungrouped', null,
    'image'::public.publication_format, 60, 1::bigint, E'Legenda\núnica', 'same_order',
    'seed-generation-1', 1::smallint, 500, '2026-08-13T10:00:00Z'::timestamptz
  );
  if result ->> 'expectedPublications' <> '24' then raise exception 'primeiro plano deveria conter 24 slots'; end if;

  result := public.create_bulk_rotation_plan(
    '21000000-0000-0000-0000-000000000001', 'bulk-generation-request-0002', 'Suspensão incremental',
    array['31000000-0000-0000-0000-000000000002'::uuid], 'ungrouped', null,
    'image'::public.publication_format, 60, 1::bigint, null, 'same_order',
    'seed-generation-2', 1::smallint, 500, '2026-08-13T10:00:00Z'::timestamptz
  );
end;
$$;

reset role;
set local role service_role;
set local request.jwt.claim.role = 'service_role';

do $$
declare
  first_plan_id uuid;
  second_plan_id uuid;
  first_chunk_id uuid;
  second_chunk_id uuid;
  claimed record;
  process_result jsonb;
  item_count bigint;
  protected boolean;
  attempt_before integer;
  rotation_ids uuid[];
begin
  select id into first_plan_id from public.bulk_publication_plans where request_key = 'bulk-generation-request-0001';
  select id into second_plan_id from public.bulk_publication_plans where request_key = 'bulk-generation-request-0002';
  update public.bulk_publication_plans
  set created_at = (select created_at from public.bulk_publication_plans where id = first_plan_id) + interval '1 second'
  where id = second_plan_id;
  select id into first_chunk_id from public.bulk_publication_generation_chunks where plan_id = first_plan_id;
  select id into second_chunk_id from public.bulk_publication_generation_chunks where plan_id = second_plan_id;

  protected := public.media_asset_is_in_active_generation_job(
    '21000000-0000-0000-0000-000000000001', '41000000-0000-0000-0000-000000000001'
  );
  if not protected then raise exception 'snapshot compacto ativo deveria proteger a mídia'; end if;

  insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
  values ('51000000-0000-0000-0000-000000000099', '21000000-0000-0000-0000-000000000001',
    '11000000-0000-0000-0000-000000000001', 'Conflito de horizonte', 'queued', timezone('utc', now()));
  begin
    insert into public.publication_items (
      organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key
    ) values (
      '21000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000099',
      '31000000-0000-0000-0000-000000000001', 'image', 'waiting', '2026-08-13T11:00:00Z',
      'bulk-generation-horizon-conflict'
    );
    raise exception 'reserva compacta deveria bloquear lote concorrente';
  exception when unique_violation then
    if SQLERRM <> 'bulk_publication_horizon_conflict' then raise; end if;
  end;
  if exists (select 1 from public.publication_items where batch_id = '51000000-0000-0000-0000-000000000099') then
    raise exception 'item bloqueado pelo horizonte não sofreu rollback';
  end if;

  select * into claimed from public.claim_bulk_rotation_generation_chunks('worker-a', 1, 60, 3);
  if claimed.id <> first_chunk_id then raise exception 'primeiro claim deveria escolher o primeiro plano'; end if;
  update public.bulk_publication_generation_chunks
  set lease_until = timezone('utc', now()) - interval '1 second'
  where id = first_chunk_id;
  select * into claimed from public.claim_bulk_rotation_generation_chunks('worker-b', 1, 60, 3);
  if claimed.id <> first_chunk_id or claimed.attempt_count <> 2 then raise exception 'lease expirado não foi recuperado'; end if;
  if (select count(distinct profile_plan.schedule_base_at + ((slot_index + 1) * interval '60 minutes'))
      from public.bulk_publication_plan_profiles profile_plan, generate_series(0, 4) slot_index
      where profile_plan.plan_id = first_plan_id) <> 5 then
    raise exception 'projeção de cinco slots não produziu cinco datas distintas';
  end if;
  if exists (
    select 1
    from public.bulk_publication_plan_profiles profile_plan
    join public.publication_items item on item.profile_id = profile_plan.profile_id
      and item.format = 'image'
      and item.execute_at in (select profile_plan.schedule_base_at + ((slot_index + 1) * interval '60 minutes') from generate_series(0, 4) slot_index)
      and item.status in ('waiting', 'ready', 'preparing', 'publishing')
    where profile_plan.plan_id = first_plan_id
  ) then raise exception 'fixture contém conflito ativo antes do processamento'; end if;

  process_result := public.process_bulk_rotation_generation_chunk(first_chunk_id, 'worker-b', 5);
  if process_result ->> 'processedItems' <> '5' or process_result ->> 'nextSlotIndex' <> '5' then
    raise exception 'primeiro passo não avançou cinco slots';
  end if;
  select count(*) into item_count from public.publication_items where batch_id = (select batch_id from public.bulk_publication_plans where id = first_plan_id);
  if item_count <> 5 then raise exception 'primeiro passo deveria inserir cinco itens'; end if;

  select array_agg(link.media_asset_id order by item.execute_at) into rotation_ids
  from public.publication_items item
  join public.publication_item_media link on link.publication_item_id = item.id
  where item.batch_id = (select batch_id from public.bulk_publication_plans where id = first_plan_id);
  if rotation_ids <> array[
    '41000000-0000-0000-0000-000000000001'::uuid,
    '41000000-0000-0000-0000-000000000002'::uuid,
    '41000000-0000-0000-0000-000000000001'::uuid,
    '41000000-0000-0000-0000-000000000002'::uuid,
    '41000000-0000-0000-0000-000000000001'::uuid
  ] then raise exception 'rotação das duas mídias ficou incorreta'; end if;

  select * into claimed from public.claim_bulk_rotation_generation_chunks('worker-c', 1, 60, 3);
  process_result := public.process_bulk_rotation_generation_chunk(claimed.id, 'worker-c', 1000);
  if process_result ->> 'processedItems' <> '19' or process_result ->> 'status' <> 'completed' then
    raise exception 'segundo passo deveria concluir os 19 slots restantes';
  end if;
  select count(*) into item_count from public.publication_items where batch_id = (select batch_id from public.bulk_publication_plans where id = first_plan_id);
  if item_count <> 24 then raise exception 'plano concluído deveria possuir 24 itens'; end if;
  if (select status from public.bulk_publication_plans where id = first_plan_id) <> 'completed' then raise exception 'plano deveria estar concluído'; end if;

  -- Simula replay integral depois de confirmação perdida: chaves determinísticas
  -- devem reutilizar os 24 itens sem duplicação.
  update public.bulk_publication_generation_chunks set status = 'queued', next_slot_index = 0,
    generated_items = 0, completed_at = null where id = first_chunk_id;
  update public.bulk_publication_plan_profiles set status = 'queued', next_slot_index = 0,
    generated_slot_count = 0 where plan_id = first_plan_id;
  update public.bulk_publication_plans set status = 'queued', generated_publications = 0,
    completed_at = null where id = first_plan_id;
  select * into claimed from public.claim_bulk_rotation_generation_chunks('worker-replay', 1, 60, 3);
  process_result := public.process_bulk_rotation_generation_chunk(claimed.id, 'worker-replay', 1000);
  if process_result ->> 'insertedItems' <> '0' or process_result ->> 'idempotentItems' <> '24' then
    raise exception 'replay não reutilizou todos os itens';
  end if;
  select count(*) into item_count from public.publication_items where batch_id = (select batch_id from public.bulk_publication_plans where id = first_plan_id);
  if item_count <> 24 then raise exception 'replay duplicou itens'; end if;

  select attempt_count into attempt_before from public.bulk_publication_generation_chunks where id = second_chunk_id;
  update public.instagram_profiles set status = 'offline' where id = '31000000-0000-0000-0000-000000000002';
  perform * from public.claim_bulk_rotation_generation_chunks('worker-offline', 10, 60, 3);
  if (select status from public.bulk_publication_generation_chunks where id = second_chunk_id) <> 'paused' then raise exception 'chunk offline deveria ser pausado'; end if;
  if (select attempt_count from public.bulk_publication_generation_chunks where id = second_chunk_id) <> attempt_before then raise exception 'suspensão offline consumiu retry'; end if;
  update public.instagram_profiles set status = 'online' where id = '31000000-0000-0000-0000-000000000002';
  if exists (select 1 from public.claim_bulk_rotation_generation_chunks('worker-no-auto-resume', 10, 60, 3) where id = second_chunk_id) then
    raise exception 'retorno online não deveria retomar automaticamente';
  end if;

  -- Simula uma retomada administrativa futura apenas para provar exaustão de falhas.
  update public.bulk_publication_generation_chunks set status = 'queued', retry_exhausted_at = null,
    consecutive_failure_count = 0, last_error_message = null where id = second_chunk_id;
  update public.bulk_publication_plan_profiles set status = 'queued' where plan_id = second_plan_id;
  update public.bulk_publication_plans set status = 'queued', suspended_publications = 0 where id = second_plan_id;
  select * into claimed from public.claim_bulk_rotation_generation_chunks('worker-fail-1', 1, 60, 2);
  perform public.fail_bulk_rotation_generation_chunk(claimed.id, 'worker-fail-1', 'falha um', 2);
  select * into claimed from public.claim_bulk_rotation_generation_chunks('worker-fail-2', 1, 60, 2);
  process_result := public.fail_bulk_rotation_generation_chunk(claimed.id, 'worker-fail-2', 'falha dois', 2);
  if (process_result ->> 'retryExhausted')::boolean is not true then raise exception 'segunda falha deveria esgotar retries'; end if;
  if (select retry_exhausted_at is null from public.bulk_publication_generation_chunks where id = second_chunk_id) then raise exception 'exaustão não foi persistida'; end if;
  if (select status from public.bulk_publication_plans where id = second_plan_id) <> 'completed_with_errors' then raise exception 'plano esgotado deveria concluir com erros'; end if;
end;
$$;

reset role;
rollback;

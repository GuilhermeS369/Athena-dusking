-- Teste transacional da observabilidade dos planos compactos. Executar em
-- banco descartável com schema até a migration 091.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('11910000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bulk-observability-admin@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now())),
  ('11910000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bulk-observability-viewer@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values
  ('21910000-0000-0000-0000-000000000001', 'Organização observabilidade bulk', 'organizacao-observabilidade-bulk', '11910000-0000-0000-0000-000000000001'),
  ('21910000-0000-0000-0000-000000000002', 'Organização isolada observabilidade', 'organizacao-isolada-observabilidade', '11910000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values
  ('21910000-0000-0000-0000-000000000001', '11910000-0000-0000-0000-000000000001', 'admin', '11910000-0000-0000-0000-000000000001'),
  ('21910000-0000-0000-0000-000000000001', '11910000-0000-0000-0000-000000000002', 'viewer', '11910000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
) values
  ('31910000-0000-0000-0000-000000000001', '21910000-0000-0000-0000-000000000001', 'bulk-observability-profile', 'bulk_observability_profile', 'token', 'online', '11910000-0000-0000-0000-000000000001');

insert into public.media_assets (
  id, organization_id, uploaded_by, storage_path, original_name, mime_type, kind,
  size_bytes, checksum_sha256, status
) values
  ('41910000-0000-0000-0000-000000000001', '21910000-0000-0000-0000-000000000001', '11910000-0000-0000-0000-000000000001', '21910000-0000-0000-0000-000000000001/observability.jpg', 'observability.jpg', 'image/jpeg', 'image', 1024, repeat('9', 64), 'ready');

insert into public.publication_batches (
  id, organization_id, created_by, name, status, review_confirmed_at
) values
  ('51910000-0000-0000-0000-000000000001', '21910000-0000-0000-0000-000000000001', '11910000-0000-0000-0000-000000000001', 'Observabilidade bulk', 'queued', timezone('utc', now()));

insert into public.bulk_publication_plans (
  id, organization_id, created_by, created_by_email, batch_id, request_key,
  request_hash, name, status, format, origin_type, caption, interval_minutes,
  duration_days, slots_per_profile, order_mode, algorithm_version, rotation_seed,
  profile_count, media_count, expected_publications, generated_publications,
  suspended_publications, ignored_publications, failed_publications, chunk_size,
  expected_chunks, created_at, updated_at
) values (
  '61910000-0000-0000-0000-000000000001', '21910000-0000-0000-0000-000000000001',
  '11910000-0000-0000-0000-000000000001', 'bulk-observability-admin@example.com',
  '51910000-0000-0000-0000-000000000001', 'bulk-observability-request-0001', repeat('a', 64),
  'Plano parado observável', 'generating', 'image', 'ungrouped', null, 60, 1, 24,
  'same_order', 1, 'bulk-observability-seed', 1, 1, 2400, 100, 0, 0, 0, 500, 1,
  timezone('utc', now()) - interval '2 hours', timezone('utc', now()) - interval '2 hours'
);

insert into public.bulk_publication_plan_profiles (
  id, plan_id, organization_id, profile_id, ordinal, status, schedule_base_at,
  first_execute_at, last_execute_at, total_slot_count, next_slot_index,
  generated_slot_count, rotation_offset
) values (
  '71910000-0000-0000-0000-000000000001', '61910000-0000-0000-0000-000000000001',
  '21910000-0000-0000-0000-000000000001', '31910000-0000-0000-0000-000000000001',
  0, 'generating', timezone('utc', now()), timezone('utc', now()) + interval '1 hour',
  timezone('utc', now()) + interval '24 hours', 24, 1, 1, 0
);

insert into public.bulk_publication_plan_media (
  plan_id, organization_id, media_asset_id, ordinal, kind, storage_path
) values (
  '61910000-0000-0000-0000-000000000001', '21910000-0000-0000-0000-000000000001',
  '41910000-0000-0000-0000-000000000001', 0, 'image',
  '21910000-0000-0000-0000-000000000001/observability.jpg'
);

insert into public.bulk_publication_generation_chunks (
  id, plan_id, plan_profile_id, organization_id, profile_id, chunk_ordinal,
  slot_start, slot_count, next_slot_index, status, generated_items, claimed_by,
  lease_until, last_progress_at, created_at, updated_at
) values (
  '81910000-0000-0000-0000-000000000001', '61910000-0000-0000-0000-000000000001',
  '71910000-0000-0000-0000-000000000001', '21910000-0000-0000-0000-000000000001',
  '31910000-0000-0000-0000-000000000001', 0, 0, 24, 1, 'processing', 1,
  'observability-worker', timezone('utc', now()) - interval '30 minutes',
  timezone('utc', now()) - interval '2 hours', timezone('utc', now()) - interval '2 hours',
  timezone('utc', now()) - interval '2 hours'
);

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key
) values (
  '91910000-0000-0000-0000-000000000001', '21910000-0000-0000-0000-000000000001',
  '51910000-0000-0000-0000-000000000001', '31910000-0000-0000-0000-000000000001',
  'image', 'waiting', timezone('utc', now()) + interval '1 hour', 'bulk-observability-item-0001'
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '11910000-0000-0000-0000-000000000002';

do $$
begin
  begin
    perform public.get_bulk_rotation_operational_summary('21910000-0000-0000-0000-000000000001', 60, 1000);
    raise exception 'viewer não deveria acessar observabilidade compacta';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

set local request.jwt.claim.sub = '11910000-0000-0000-0000-000000000001';

do $$
declare
  result jsonb;
  kinds text[];
begin
  result := public.get_bulk_rotation_operational_summary('21910000-0000-0000-0000-000000000001', 60, 1000);
  if result ->> 'activePlans' <> '1' then raise exception 'deveria contar um plano ativo'; end if;
  if result ->> 'expectedPublications' <> '2400' then raise exception 'volume esperado incorreto'; end if;
  if result ->> 'generatedPublications' <> '100' then raise exception 'volume gerado incorreto'; end if;
  if result ->> 'remainingPublications' <> '2300' then raise exception 'backlog restante incorreto'; end if;
  if result #>> '{chunks,total}' <> '1' or result #>> '{chunks,expiredLeases}' <> '1'
    or result #>> '{chunks,stalled}' <> '1' then raise exception 'métricas de chunks incorretas'; end if;
  if result #>> '{storage,plans}' <> '1' or result #>> '{storage,profiles}' <> '1'
    or result #>> '{storage,mediaSnapshots}' <> '1' or result #>> '{storage,chunks}' <> '1'
    or result #>> '{storage,materializedItems}' <> '1' then raise exception 'contagens de storage incorretas'; end if;

  select array_agg(alert ->> 'kind' order by alert ->> 'kind') into kinds
  from jsonb_array_elements(result -> 'alerts') alert;
  if kinds <> array['abnormal_backlog_growth', 'expired_chunk_leases', 'stalled_chunks', 'stalled_plans'] then
    raise exception 'alertas inesperados: %', kinds;
  end if;

  result := public.get_bulk_rotation_operational_summary('21910000-0000-0000-0000-000000000002', 60, 1000);
  raise exception 'admin não deveria observar outra organização';
exception when insufficient_privilege then
  null;
end;
$$;

reset role;
set local role service_role;
set local request.jwt.claim.role = 'service_role';

do $$
declare
  result jsonb;
begin
  result := public.get_bulk_rotation_operational_summary(null, 60, 1000);
  if result ->> 'activePlans' <> '1' then raise exception 'service role deveria acessar resumo global'; end if;
  result := public.get_bulk_rotation_operational_summary('21910000-0000-0000-0000-000000000002', 60, 1000);
  if result ->> 'activePlans' <> '0' or result #>> '{storage,plans}' <> '0' then
    raise exception 'o escopo service role não isolou a organização vazia';
  end if;
end;
$$;

reset role;
rollback;

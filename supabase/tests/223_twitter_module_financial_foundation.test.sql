begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(14);

select extensions.has_table('public', 'twitter_global_identities', 'identidade Zernio global existe');
select extensions.has_table('public', 'twitter_wallet_ledger', 'ledger imutável existe');
select extensions.has_table('public', 'twitter_wallet_reservations', 'reservas financeiras existem');
select extensions.has_function(
  'public', 'twitter_create_wallet_reservation',
  array['uuid', 'uuid', 'uuid', 'integer', 'twitter_price_category', 'twitter_financial_origin', 'uuid', 'bigint', 'bigint', 'text'],
  'reserva atômica versionada existe'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('12300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'twitter-admin-a@example.com', '', now(), now(), now()),
  ('12300000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'twitter-viewer-a@example.com', '', now(), now(), now()),
  ('12300000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'twitter-admin-b@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by) values
  ('22300000-0000-4000-8000-000000000001', 'Twitter Test A', 'twitter-test-a', '12300000-0000-4000-8000-000000000001'),
  ('22300000-0000-4000-8000-000000000002', 'Twitter Test B', 'twitter-test-b', '12300000-0000-4000-8000-000000000003');

insert into public.organization_members (organization_id, user_id, role, invited_by) values
  ('22300000-0000-4000-8000-000000000001', '12300000-0000-4000-8000-000000000001', 'admin', '12300000-0000-4000-8000-000000000001'),
  ('22300000-0000-4000-8000-000000000001', '12300000-0000-4000-8000-000000000002', 'viewer', '12300000-0000-4000-8000-000000000001'),
  ('22300000-0000-4000-8000-000000000002', '12300000-0000-4000-8000-000000000003', 'admin', '12300000-0000-4000-8000-000000000003');

set local role authenticated;
select set_config('request.jwt.claim.sub', '12300000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.email', 'twitter-admin-a@example.com', true);

create temporary table twitter_test_context (identity_id uuid, reservation_id uuid) on commit drop;

do $$
declare
  first_result jsonb;
  replay_result jsonb;
begin
  first_result := public.twitter_register_identity_and_grant(
    '22300000-0000-4000-8000-000000000001', 'zernio-user-financial-test'
  );
  replay_result := public.twitter_register_identity_and_grant(
    '22300000-0000-4000-8000-000000000001', 'zernio-user-financial-test'
  );
  if not (first_result ->> 'grantCreated')::boolean
    or (replay_result ->> 'grantCreated')::boolean
    or (replay_result ->> 'postedBalanceMicros')::bigint <> 12000000
  then
    raise exception 'Concessão global não foi idempotente: %, %', first_result, replay_result;
  end if;
  insert into twitter_test_context (identity_id)
  values ((first_result ->> 'identityId')::uuid);
end;
$$;

select extensions.is(
  (select count(*)::bigint from public.twitter_wallet_grants),
  1::bigint,
  'recadastro da mesma identidade cria uma única concessão'
);

select set_config('request.jwt.claim.sub', '12300000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claim.email', 'twitter-admin-b@example.com', true);
select extensions.throws_ok(
  $$select public.twitter_register_identity_and_grant(
    '22300000-0000-4000-8000-000000000002', 'zernio-user-financial-test'
  )$$,
  '23505',
  'Esta identidade Zernio não está disponível para cadastro.',
  'identidade global não pode ser concedida em outra organização'
);

select set_config('request.jwt.claim.sub', '12300000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claim.email', 'twitter-viewer-a@example.com', true);
select extensions.throws_ok(
  format(
    $$select public.twitter_create_wallet_reservation(
      '22300000-0000-4000-8000-000000000001', %L::uuid, null, 1,
      'post_dm_create', 'publication',
      '32300000-0000-4000-8000-000000000001', 15000, 1, 'viewer-reservation-test'
    )$$,
    (select identity_id::text from twitter_test_context)
  ),
  '42501',
  'Sem permissão para reservar saldo.',
  'viewer não pode reservar saldo'
);

select set_config('request.jwt.claim.sub', '12300000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.email', 'twitter-admin-a@example.com', true);

do $$
declare
  identity_value uuid := (select identity_id from twitter_test_context);
  first_result jsonb;
  replay_result jsonb;
begin
  first_result := public.twitter_create_wallet_reservation(
    '22300000-0000-4000-8000-000000000001', identity_value, null, 1,
    'post_dm_create', 'publication',
    '32300000-0000-4000-8000-000000000001', 30000, 1, 'reservation-idempotency-test'
  );
  replay_result := public.twitter_create_wallet_reservation(
    '22300000-0000-4000-8000-000000000001', identity_value, null, 1,
    'post_dm_create', 'publication',
    '32300000-0000-4000-8000-000000000001', 30000, 999, 'reservation-idempotency-test'
  );
  if (first_result ->> 'idempotentReplay')::boolean
    or not (replay_result ->> 'idempotentReplay')::boolean
  then
    raise exception 'Replay de reserva inválido: %, %', first_result, replay_result;
  end if;
  update twitter_test_context
  set reservation_id = (first_result ->> 'reservationId')::uuid;
end;
$$;

select extensions.is(
  (select reserved_micros from public.twitter_wallets where identity_id = (select identity_id from twitter_test_context)),
  30000::bigint,
  'replay não duplica reserva'
);

reset role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.email', 'worker@athena.local', true);

select public.twitter_settle_wallet_reservation(
  (select reservation_id from twitter_test_context),
  15000,
  'settlement-financial-test',
  '{"providerStatus":"published"}'::jsonb
);

select extensions.is(
  (select posted_balance_micros from public.twitter_wallets where identity_id = (select identity_id from twitter_test_context)),
  11985000::bigint,
  'liquidação debita exatamente US$ 0,015'
);

select public.twitter_mark_reservation_outcome_unknown(
  (select reservation_id from twitter_test_context),
  'unknown-financial-test',
  'timeout após envio externo',
  '{}'::jsonb
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '12300000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.email', 'twitter-admin-a@example.com', true);

select extensions.throws_ok(
  format(
    $$select public.twitter_release_wallet_reservation(%L::uuid, 'release-without-resolution', 'cancelamento', false)$$,
    (select reservation_id::text from twitter_test_context)
  ),
  '55000',
  'Resultado desconhecido exige resolução manual explícita.',
  'resultado desconhecido não é liberado por cancelamento comum'
);

select public.twitter_release_wallet_reservation(
  (select reservation_id from twitter_test_context),
  'manual-resolution-release',
  'falha confirmada sem cobrança após reconciliação',
  true
);

select extensions.is(
  (select reserved_micros from public.twitter_wallets where identity_id = (select identity_id from twitter_test_context)),
  0::bigint,
  'resolução manual devolve todo o hold restante'
);

select public.twitter_release_wallet_reservation(
  (select reservation_id from twitter_test_context),
  'manual-resolution-release',
  'falha confirmada sem cobrança após reconciliação',
  true
);

select extensions.is(
  (select count(*)::bigint from public.twitter_reservation_events where idempotency_key = 'manual-resolution-release'),
  1::bigint,
  'repetir resolução não duplica evento nem crédito'
);

reset role;
select extensions.throws_ok(
  $$update public.twitter_wallet_ledger set delta_micros = 1 where entry_kind = 'grant'$$,
  '55000',
  'Registro financeiro imutável.',
  'ledger não pode ser reescrito'
);

select extensions.is(
  (select remaining_micros + settled_micros + released_micros
   from public.twitter_wallet_reservations
   where id = (select reservation_id from twitter_test_context)),
  30000::bigint,
  'equação da reserva permanece íntegra'
);

select * from extensions.finish();
rollback;

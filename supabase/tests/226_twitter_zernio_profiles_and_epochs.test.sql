begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(23);

select extensions.has_table('public', 'twitter_profiles', 'perfis X isolados existem');
select extensions.has_table('public', 'twitter_profile_connection_epochs', 'épocas de conexão existem');
select extensions.has_table('public', 'twitter_connection_events', 'eventos de conexão imutáveis existem');
select extensions.has_function(
  'public', 'twitter_sync_profile_from_zernio',
  array['uuid','uuid','text','text','text','text','text','boolean','boolean','boolean','boolean','twitter_account_tier','jsonb'],
  'RPC de sincronização X existe'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.twitter_sync_profile_from_zernio(uuid,uuid,text,text,text,text,text,boolean,boolean,boolean,boolean,twitter_account_tier,jsonb)', 'EXECUTE'),
  'authenticated não consegue forjar inventário X'
);
select extensions.ok(
  has_function_privilege('service_role', 'public.twitter_sync_profile_from_zernio(uuid,uuid,text,text,text,text,text,boolean,boolean,boolean,boolean,twitter_account_tier,jsonb)', 'EXECUTE'),
  'service role sincroniza inventário X'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('12600000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'twitter-226-a@example.com', '', now(), now(), now()),
  ('12600000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'twitter-226-b@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by) values
  ('22600000-0000-4000-8000-000000000001', 'Twitter 226 A', 'twitter-226-a', '12600000-0000-4000-8000-000000000001'),
  ('22600000-0000-4000-8000-000000000002', 'Twitter 226 B', 'twitter-226-b', '12600000-0000-4000-8000-000000000002');

insert into public.organization_members (organization_id, user_id, role, invited_by) values
  ('22600000-0000-4000-8000-000000000001', '12600000-0000-4000-8000-000000000001', 'admin', '12600000-0000-4000-8000-000000000001'),
  ('22600000-0000-4000-8000-000000000002', '12600000-0000-4000-8000-000000000002', 'admin', '12600000-0000-4000-8000-000000000002');

create temporary table twitter_226_context (
  identity_a uuid,
  identity_b uuid,
  connection_a uuid,
  connection_b uuid,
  profile_id uuid,
  epoch_id uuid,
  releasable_reservation uuid,
  unknown_reservation uuid
) on commit drop;
grant select, insert, update on table twitter_226_context to service_role;
insert into twitter_226_context default values;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.email', 'twitter-test-worker@athena.local', true);

do $$
declare
  identity_result jsonb;
  connection_result jsonb;
begin
  identity_result := public.twitter_register_identity_and_grant(
    '22600000-0000-4000-8000-000000000001', 'zernio-226-identity-a'
  );
  connection_result := public.twitter_upsert_connection_credentials(
    '22600000-0000-4000-8000-000000000001',
    (identity_result ->> 'identityId')::uuid,
    'Conexão A', 'z-profile-a', repeat('encrypted-a', 4), repeat('a', 64),
    'api_key', 'read write', '12600000-0000-4000-8000-000000000001', 'twitter-226-a@example.com'
  );
  update twitter_226_context set
    identity_a = (identity_result ->> 'identityId')::uuid,
    connection_a = (connection_result ->> 'connectionId')::uuid;
end;
$$;

select extensions.is((select count(*)::bigint from public.twitter_wallet_grants), 1::bigint, 'cadastro cria uma concessão de US$ 12');
select extensions.is((select posted_balance_micros from public.twitter_wallets where identity_id = (select identity_a from twitter_226_context)), 12000000::bigint, 'carteira inicia com 12 milhões de micros');
select extensions.is((select analytics_enabled from public.twitter_connections where id = (select connection_a from twitter_226_context)), false, 'analytics começa desligado');
select extensions.is((select inbox_enabled from public.twitter_connections where id = (select connection_a from twitter_226_context)), false, 'inbox começa desligado');

do $$
declare replay jsonb;
begin
  replay := public.twitter_upsert_connection_credentials(
    '22600000-0000-4000-8000-000000000001', (select identity_a from twitter_226_context),
    'Conexão A rotacionada', 'z-profile-a', repeat('encrypted-b', 4), repeat('b', 64),
    'api_key', 'read write', '12600000-0000-4000-8000-000000000001', 'twitter-226-a@example.com'
  );
  if not (replay ->> 'reused')::boolean then raise exception 'Conexão não foi reutilizada: %', replay; end if;
end;
$$;
select extensions.is((select count(*)::bigint from public.twitter_connections), 1::bigint, 'rotação reutiliza a conexão');
select extensions.is((select count(*)::bigint from public.twitter_wallet_grants), 1::bigint, 'rotação não reinicia a concessão');

do $$
declare synced jsonb;
begin
  synced := public.twitter_sync_profile_from_zernio(
    '22600000-0000-4000-8000-000000000001', (select connection_a from twitter_226_context),
    'z-account-a', null, 'nome_original', 'Nome Original', null,
    true, false, true, false, 'unknown', '[]'::jsonb
  );
  update twitter_226_context set
    profile_id = (synced ->> 'profileId')::uuid,
    epoch_id = (synced ->> 'epochId')::uuid;
end;
$$;
select extensions.is((select identity_confidence::text from public.twitter_profiles where id = (select profile_id from twitter_226_context)), 'zernio_account_id', 'fallback usa ID de conta Zernio, nunca username');

select public.twitter_sync_profile_from_zernio(
  '22600000-0000-4000-8000-000000000001', (select connection_a from twitter_226_context),
  'z-account-a', 'x-user-immutable-a', 'nome_alterado', 'Nome Alterado', null,
  true, false, true, false, 'free', '[]'::jsonb
);
select extensions.is((select count(*)::bigint from public.twitter_profiles), 1::bigint, 'mudança de username não cria perfil novo');
select extensions.is((select twitter_user_id from public.twitter_profiles where id = (select profile_id from twitter_226_context)), 'x-user-immutable-a', 'perfil passa a usar ID imutável confirmado');
select extensions.is((select current_epoch_id from public.twitter_profiles where id = (select profile_id from twitter_226_context)), (select epoch_id from twitter_226_context), 'reauth na mesma conta preserva a época');

do $$
declare identity_result jsonb; connection_result jsonb; synced jsonb;
begin
  identity_result := public.twitter_register_identity_and_grant(
    '22600000-0000-4000-8000-000000000001', 'zernio-226-identity-b'
  );
  connection_result := public.twitter_upsert_connection_credentials(
    '22600000-0000-4000-8000-000000000001', (identity_result ->> 'identityId')::uuid,
    'Conexão B', 'z-profile-b', repeat('encrypted-c', 4), repeat('c', 64),
    'api_key', 'read write', '12600000-0000-4000-8000-000000000001', 'twitter-226-a@example.com'
  );
  synced := public.twitter_sync_profile_from_zernio(
    '22600000-0000-4000-8000-000000000001', (connection_result ->> 'connectionId')::uuid,
    'z-account-b', 'x-user-immutable-a', 'nome_nova_conexao', 'Nova conexão', null,
    true, false, true, false, 'free', '[]'::jsonb
  );
  if not (synced ->> 'epochChanged')::boolean then raise exception 'Troca real não abriu época: %', synced; end if;
  update twitter_226_context set identity_b = (identity_result ->> 'identityId')::uuid, connection_b = (connection_result ->> 'connectionId')::uuid;
end;
$$;
select extensions.is((select count(*)::bigint from public.twitter_profiles), 1::bigint, 'ID imutável mantém um perfil estável entre conexões');
select extensions.is((select count(*)::bigint from public.twitter_profile_connection_epochs where profile_id = (select profile_id from twitter_226_context)), 2::bigint, 'troca real cria nova época e encerra a anterior');

do $$
declare reservation jsonb;
begin
  reservation := public.twitter_create_wallet_reservation(
    '22600000-0000-4000-8000-000000000001', (select identity_b from twitter_226_context),
    (select connection_b from twitter_226_context), 1, 'post_dm_create', 'publication',
    '32600000-0000-4000-8000-000000000001', 15000, 1, 'delete-releasable-226'
  );
  update twitter_226_context set releasable_reservation = (reservation ->> 'reservationId')::uuid;
  reservation := public.twitter_create_wallet_reservation(
    '22600000-0000-4000-8000-000000000001', (select identity_b from twitter_226_context),
    (select connection_b from twitter_226_context), 1, 'post_dm_create', 'publication',
    '32600000-0000-4000-8000-000000000002', 15000, 2, 'delete-unknown-226'
  );
  update twitter_226_context set unknown_reservation = (reservation ->> 'reservationId')::uuid;
  perform public.twitter_mark_reservation_outcome_unknown(
    (reservation ->> 'reservationId')::uuid, 'mark-unknown-delete-226', 'resultado externo incerto', '{}'::jsonb
  );
end;
$$;

select public.twitter_soft_delete_connection(
  '22600000-0000-4000-8000-000000000001', (select connection_b from twitter_226_context),
  'remoção transacional de teste', '12600000-0000-4000-8000-000000000001', 'twitter-226-a@example.com'
);
select extensions.is((select status::text from public.twitter_wallet_reservations where id = (select releasable_reservation from twitter_226_context)), 'released', 'remoção libera reserva ainda utilizável');
select extensions.is((select status::text from public.twitter_wallet_reservations where id = (select unknown_reservation from twitter_226_context)), 'outcome_unknown', 'remoção mantém hold de resultado incerto');
select extensions.is((select status::text from public.twitter_profiles where id = (select profile_id from twitter_226_context)), 'deleted', 'remoção faz soft-delete do perfil corrente');

select public.twitter_soft_delete_connection(
  '22600000-0000-4000-8000-000000000001', (select connection_b from twitter_226_context),
  'repetição idempotente', '12600000-0000-4000-8000-000000000001', 'twitter-226-a@example.com'
);
select extensions.is((select count(*)::bigint from public.twitter_reservation_events where idempotency_key like 'connection-delete:%'), 1::bigint, 'repetir remoção não duplica devolução');

reset role;
select extensions.throws_ok(
  $$update public.twitter_connection_events set message = 'reescrito' where event_type = 'connection_deleted'$$,
  '55000', 'Registro financeiro imutável.', 'eventos de conexão não podem ser reescritos'
);

select * from extensions.finish();
rollback;

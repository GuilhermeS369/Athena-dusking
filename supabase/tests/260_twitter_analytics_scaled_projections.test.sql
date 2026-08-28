begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(29);

select extensions.has_table('public','twitter_profile_follower_daily_metrics','projeção diária tipada de followers existe');
select extensions.has_table('public','twitter_post_analytics_current','projeção atual tipada de posts existe');
select extensions.ok(position('currentFollowers' in pg_get_functiondef('public.twitter_project_analytics_snapshot()'::regprocedure)) > 0,'payload accounts/currentFollowers da Zernio é normalizado');
select extensions.has_column('public','twitter_analytics_items','collection_key','item possui collection_key');
select extensions.has_column('public','twitter_analytics_items','collection_stage','item possui collection_stage');
select extensions.has_column('public','twitter_analytics_items','requested_from','item possui requested_from');
select extensions.has_column('public','twitter_analytics_items','requested_to','item possui requested_to');
select extensions.has_column('public','twitter_analytics_items','force_refresh','item possui force_refresh');
select extensions.results_eq(
  $$select count(*)::bigint from pg_indexes where schemaname='public' and indexname='twitter_analytics_one_normal_collection_idx'$$,
  array[1::bigint], 'índice parcial anti-concorrência existe'
);
select extensions.results_eq(
  $$select count(*)::bigint from information_schema.parameters where specific_schema='public' and specific_name like 'twitter_claim_analytics_items_%' and parameter_name in ('collection_stage','requested_from','requested_to','force_refresh')$$,
  array[4::bigint], 'claim expõe metadados v2'
);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('16000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','twitter-260@example.com','',now(),now(),now());
insert into public.organizations(id,name,slug,created_by)
values('26000000-0000-4000-8000-000000000001','Twitter 260','twitter-260','16000000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role,invited_by)
values('26000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','viewer','16000000-0000-4000-8000-000000000001');

create temporary table t260(
  identity_id uuid, connection_id uuid, profile_id uuid, epoch_id uuid,
  publication_item_id uuid, wallet_version bigint
) on commit drop;
grant select,insert,update on t260 to service_role;
insert into t260 default values;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $$
declare identity jsonb; connection jsonb; profile jsonb; publication_id uuid:=gen_random_uuid();
  program_id uuid:=gen_random_uuid(); publication_reservation jsonb;
begin
  identity:=public.twitter_register_identity_and_grant('26000000-0000-4000-8000-000000000001','zernio-260');
  connection:=public.twitter_upsert_connection_credentials(
    '26000000-0000-4000-8000-000000000001',(identity->>'identityId')::uuid,'Zernio 260','zp-260',
    repeat('encrypted',5),repeat('e',64),'api','scope','16000000-0000-4000-8000-000000000001','twitter-260@example.com'
  );
  profile:=public.twitter_sync_profile_from_zernio(
    '26000000-0000-4000-8000-000000000001',(connection->>'connectionId')::uuid,
    'za-260','xu-260','perfil260','Perfil 260',null,true,true,true,false,'free','[]'
  );
  insert into public.twitter_programs(
    id,organization_id,schedule_kind,starts_at,ends_at,interval_minutes,total_requested,
    funded_count,unfunded_count,reserved_micros,rate_card_id,rate_card_version,review_digest,
    idempotency_key,created_by
  ) select program_id,'26000000-0000-4000-8000-000000000001','interval',now()-interval '8 days',now()-interval '8 days',1,1,1,0,15000,id,version,repeat('d',64),'program-260','16000000-0000-4000-8000-000000000001'
    from public.twitter_rate_cards where active;
  publication_reservation:=public.twitter_create_wallet_reservation(
    '26000000-0000-4000-8000-000000000001',(identity->>'identityId')::uuid,(connection->>'connectionId')::uuid,
    1,'post_dm_create','publication',program_id,15000,1,'publication-reservation-260'
  );
  insert into public.twitter_program_reservations values(program_id,(publication_reservation->>'reservationId')::uuid,(identity->>'identityId')::uuid,'post_dm_create');
  insert into public.twitter_publication_items(
    id,organization_id,program_id,profile_id,connection_epoch_id,connection_id,identity_id,
    slot_index,execute_at,content,weighted_characters,category,amount_micros,status,idempotency_key
  ) values(publication_id,'26000000-0000-4000-8000-000000000001',program_id,(profile->>'profileId')::uuid,(profile->>'epochId')::uuid,(connection->>'connectionId')::uuid,(identity->>'identityId')::uuid,0,now()-interval '8 days','publicado',9,'post_dm_create',15000,'published','publication-260');
  insert into public.twitter_publication_attempts(organization_id,item_id,attempt_number,worker_id,idempotency_key,status,post_id,finished_at)
  values('26000000-0000-4000-8000-000000000001',publication_id,1,'test','publication-attempt-260','published','zpost-260',now()-interval '8 days');
  update t260 set identity_id=(identity->>'identityId')::uuid,connection_id=(connection->>'connectionId')::uuid,
    profile_id=(profile->>'profileId')::uuid,epoch_id=(profile->>'epochId')::uuid,
    publication_item_id=publication_id,wallet_version=(select version from public.twitter_wallets where identity_id=(identity->>'identityId')::uuid);
end $$;

select extensions.throws_ok(
  (select format($q$select public.twitter_confirm_analytics_job('26000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','disabled-260','%s',1,'%s','%s')$q$,
    repeat('a',64),jsonb_build_array(jsonb_build_object('identityId',identity_id,'walletVersion',wallet_version))::text,
    jsonb_build_array(jsonb_build_object('type','profile','id',profile_id))::text) from t260),
  '22023','Recurso de analytics indisponível ou sem eligibility.','confirmação bloqueia conexão sem analytics'
);

update public.twitter_connections set analytics_enabled=true where id=(select connection_id from t260);
update public.twitter_profiles set can_fetch_analytics=false where id=(select profile_id from t260);
select extensions.throws_ok(
  (select format($q$select public.twitter_confirm_analytics_job('26000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','profile-disabled-260','%s',1,'%s','%s')$q$,
    repeat('1',64),jsonb_build_array(jsonb_build_object('identityId',identity_id,'walletVersion',wallet_version))::text,
    jsonb_build_array(jsonb_build_object('type','profile','id',profile_id))::text) from t260),
  '22023','Recurso de analytics indisponível ou sem eligibility.','confirmação bloqueia perfil sem capability de analytics'
);
update public.twitter_profiles set can_fetch_analytics=true where id=(select profile_id from t260);
update t260 set wallet_version=(select version from public.twitter_wallets where identity_id=t260.identity_id);
select public.twitter_confirm_analytics_job(
  '26000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','v2-job-260',repeat('b',64),1,
  (select jsonb_build_array(jsonb_build_object('identityId',identity_id,'walletVersion',wallet_version)) from t260),
  (select jsonb_build_array(
    jsonb_build_object('type','post','id',publication_item_id,'collectionStage','d7','requestedFrom','2026-08-17','requestedTo','2026-08-17','collectionKey','post:260:d7'),
    jsonb_build_object('type','profile','id',profile_id,'requestedFrom','2026-08-22','requestedTo','2026-08-23','collectionKey','profile:260:followers:2026-08-22:2026-08-23')
  ) from t260)
);
select extensions.is((select count(*)::bigint from public.twitter_analytics_items where organization_id='26000000-0000-4000-8000-000000000001'),2::bigint,'confirmação v2 materializa os alvos');
select extensions.is((select collection_stage::text from public.twitter_analytics_items where collection_key='post:260:d7'),'d7','estágio solicitado é persistido');
select extensions.is((select requested_from from public.twitter_analytics_items where collection_key='profile:260:followers:2026-08-22:2026-08-23'),'2026-08-22'::date,'janela de followers é persistida');

update t260 set wallet_version=(select version from public.twitter_wallets where identity_id=t260.identity_id);
select extensions.throws_ok(
  (select format($q$select public.twitter_confirm_analytics_job('26000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','duplicate-260','%s',1,'%s','%s')$q$,
    repeat('c',64),jsonb_build_array(jsonb_build_object('identityId',identity_id,'walletVersion',wallet_version))::text,
    jsonb_build_array(jsonb_build_object('type','post','id',publication_item_id,'stage','d7','collectionKey','post:260:d7'))::text) from t260),
  '23505','Esta coleta normal já está ativa ou concluída.','coleta normal concorrente é bloqueada'
);

update t260 set wallet_version=(select version from public.twitter_wallets where identity_id=t260.identity_id);
select public.twitter_confirm_analytics_job(
  '26000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','forced-260',repeat('f',64),1,
  (select jsonb_build_array(jsonb_build_object('identityId',identity_id,'walletVersion',wallet_version)) from t260),
  (select jsonb_build_array(jsonb_build_object('type','post','id',publication_item_id,'stage','d7','forceRefresh',true,'collectionKey','post:260:d7')) from t260)
);
select extensions.is((select count(*)::bigint from public.twitter_analytics_items where collection_key='post:260:d7' and force_refresh),1::bigint,'force refresh pode coexistir com coleta normal');

update public.twitter_analytics_items
set created_at=created_at-interval '1 second'
where collection_key='post:260:d7' and force_refresh=false;

create temporary table claim260a as select * from public.twitter_claim_analytics_items('worker-260',1);
grant select on claim260a to service_role;
select extensions.is((select collection_stage::text from claim260a),'d7','claim entrega collection_stage');
select extensions.is((select requested_from from claim260a),'2026-08-17'::date,'claim entrega requested_from');
select extensions.is((select requested_to from claim260a),'2026-08-17'::date,'claim entrega requested_to');
select extensions.is((select force_refresh from claim260a),false,'claim entrega force_refresh');
select public.twitter_complete_analytics_item(
  (select attempt_id from claim260a),'succeeded','result-post-260',
  '{"data":{"impressions":120,"views":150,"likes":12,"comments":3,"shares":4,"replies":2,"bookmarks":1,"quotes":1}}',
  '2026-08-24T12:00:00Z',200,'ok','req-post',null,'{}',3
);
select extensions.is((select impressions from public.twitter_post_analytics_current where organization_id='26000000-0000-4000-8000-000000000001'),120::bigint,'complete normaliza métricas atuais do post');

update t260 set wallet_version=(select version from public.twitter_wallets where identity_id=t260.identity_id);
select extensions.throws_ok(
  (select format($q$select public.twitter_confirm_analytics_job('26000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','completed-duplicate-260','%s',1,'%s','%s')$q$,
    repeat('9',64),jsonb_build_array(jsonb_build_object('identityId',identity_id,'walletVersion',wallet_version))::text,
    jsonb_build_array(jsonb_build_object('type','post','id',publication_item_id,'collectionStage','d7','collectionKey','post:260:d7'))::text) from t260),
  '23505','Esta coleta normal já está ativa ou concluída.','coleta normal concluída não pode ser cobrada novamente'
);

create temporary table claim260b as select * from public.twitter_claim_analytics_items('worker-260',1);
grant select on claim260b to service_role;
select public.twitter_complete_analytics_item(
  (select attempt_id from claim260b),'succeeded','result-profile-260',
  '{"data":[{"date":"2026-08-22","followers":100},{"date":"2026-08-23","followers_count":103}]}',
  '2026-08-24T12:00:00Z',200,'ok','req-profile',null,'{}',1
);
select extensions.is((select count(*)::bigint from public.twitter_profile_follower_daily_metrics where organization_id='26000000-0000-4000-8000-000000000001'),2::bigint,'complete expande série diária de followers');
select extensions.is((select followers_count from public.twitter_profile_follower_daily_metrics where metric_date='2026-08-23'),103::bigint,'followers diários são tipados');

update t260 set wallet_version=(select version from public.twitter_wallets where identity_id=t260.identity_id);
select public.twitter_confirm_analytics_job(
  '26000000-0000-4000-8000-000000000001','16000000-0000-4000-8000-000000000001','cancel-260',repeat('d',64),1,
  (select jsonb_build_array(jsonb_build_object('identityId',identity_id,'walletVersion',wallet_version)) from t260),
  (select jsonb_build_array(jsonb_build_object('type','profile','id',profile_id,'requestedFrom','2026-08-24','requestedTo','2026-08-24','collectionKey','profile:260:followers:2026-08-24')) from t260)
);
update public.twitter_connections set analytics_enabled=false where id=(select connection_id from t260);
select extensions.is((select status::text from public.twitter_analytics_items where collection_key='profile:260:followers:2026-08-24'),'cancelled','desabilitar analytics cancela item ainda reservado');
select extensions.is((select released_micros from public.twitter_analytics_items where collection_key='profile:260:followers:2026-08-24'),10000::bigint,'cancelamento seguro libera somente a reserva do item');
select extensions.is((select count(*)::bigint from public.twitter_analytics_items where organization_id='26000000-0000-4000-8000-000000000001' and status in('processing','outcome_unknown')),0::bigint,'teste termina sem resultado financeiro incerto');
update public.twitter_analytics_items set status='reserved' where collection_key='profile:260:followers:2026-08-24';
create temporary table claim260disabled as select * from public.twitter_claim_analytics_items('worker-disabled-260',10);
select extensions.is((select count(*)::bigint from claim260disabled),0::bigint,'claim não entrega item de conexão com analytics desabilitado');

select * from extensions.finish();
rollback;

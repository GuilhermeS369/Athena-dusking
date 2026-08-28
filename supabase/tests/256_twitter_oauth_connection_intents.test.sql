begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(20);

select extensions.has_table('public','twitter_connection_intents','fila OAuth X existe');
select extensions.has_column('public','twitter_connection_intents','profile_id','intent guarda perfil final');
select extensions.ok(not has_function_privilege('authenticated','public.twitter_claim_connection_intents(text,integer,integer)','EXECUTE'),'claim é exclusivo do service role');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('15600000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','twitter-256@example.com','',now(),now(),now());
insert into public.organizations(id,name,slug,created_by)
values('25600000-0000-4000-8000-000000000001','Twitter 256','twitter-256','15600000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role,invited_by)
values('25600000-0000-4000-8000-000000000001','15600000-0000-4000-8000-000000000001','admin','15600000-0000-4000-8000-000000000001');
create temporary table t256(connection_id uuid) on commit drop;
grant select,insert,update on t256 to service_role;
insert into t256 default values;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $$declare identity jsonb; connection jsonb; begin
  identity:=public.twitter_register_identity_and_grant('25600000-0000-4000-8000-000000000001','zernio-256');
  connection:=public.twitter_upsert_connection_credentials(
    '25600000-0000-4000-8000-000000000001',(identity->>'identityId')::uuid,
    'Conta X 256','profile-256',repeat('encrypted',5),repeat('f',64),
    'api','scope','15600000-0000-4000-8000-000000000001','twitter-256@example.com');
  update public.twitter_connections set twitter_slot_limit=3,remote_twitter_account_count=0,
    remote_inventory_checked_at=now(),last_error_code=null where id=(connection->>'connectionId')::uuid;
  update t256 set connection_id=(connection->>'connectionId')::uuid;
end$$;

select public.twitter_enqueue_connection_intent('25610000-0000-4000-8000-000000000001','25600000-0000-4000-8000-000000000001',(select connection_id from t256),null,'15600000-0000-4000-8000-000000000001','intent-256-1',repeat('a',64),repeat('b',64),repeat('encrypted',5),now()+interval '20 minutes');
select extensions.is((select status from public.twitter_connection_intents where id='25610000-0000-4000-8000-000000000001'),'queued','intent inicia na fila');
select public.twitter_enqueue_connection_intent('25610000-0000-4000-8000-000000000099','25600000-0000-4000-8000-000000000001',(select connection_id from t256),null,'15600000-0000-4000-8000-000000000001','intent-256-1',repeat('c',64),repeat('d',64),repeat('encrypted',5),now()+interval '20 minutes');
select extensions.is((select count(*)::bigint from public.twitter_connection_intents),1::bigint,'replay idempotente não cria reserva');
select public.twitter_enqueue_connection_intent('25610000-0000-4000-8000-000000000002','25600000-0000-4000-8000-000000000001',(select connection_id from t256),null,'15600000-0000-4000-8000-000000000001','intent-256-2',repeat('c',64),repeat('d',64),repeat('encrypted',5),now()+interval '20 minutes');
select public.twitter_enqueue_connection_intent('25610000-0000-4000-8000-000000000003','25600000-0000-4000-8000-000000000001',(select connection_id from t256),null,'15600000-0000-4000-8000-000000000001','intent-256-3',repeat('e',64),repeat('f',64),repeat('encrypted',5),now()+interval '20 minutes');
select extensions.is((select count(*)::bigint from public.twitter_connection_intents),3::bigint,'três vagas produzem três intents');
select extensions.throws_ok(
  $$select public.twitter_enqueue_connection_intent('25610000-0000-4000-8000-000000000004','25600000-0000-4000-8000-000000000001',(select connection_id from t256),null,'15600000-0000-4000-8000-000000000001','intent-256-4',repeat('1',64),repeat('2',64),repeat('encrypted',5),now()+interval '20 minutes')$$,
  '23514','Esta conexão Zernio X não possui vaga livre agora.','reserva atômica não ultrapassa capacidade');

create temporary table c256a as select * from public.twitter_claim_connection_intents('worker-a',50,300);
grant select on c256a to service_role;
select extensions.is((select count(*)::bigint from c256a),1::bigint,'somente um preparo é claimed por conexão');
select extensions.is((select attempt_count from c256a),1,'claim registra tentativa');
select public.twitter_mark_connection_intent_ready((select intent_id from c256a),(select claim_token from c256a),repeat('encrypted-url',4));
select extensions.is((select status from public.twitter_connection_intents where id=(select intent_id from c256a)),'ready','URL cifrada move intent para ready');
select public.twitter_record_connection_intent_callback((select intent_id from c256a),repeat('b',64),'profile-256','account-256','usuario256');
select extensions.is((select status from public.twitter_connection_intents where id=(select intent_id from c256a)),'callback_received','callback válida é monotônica');
select public.twitter_record_connection_intent_callback((select intent_id from c256a),repeat('b',64),'profile-256','account-256','usuario256');
select extensions.is((select returned_account_id from public.twitter_connection_intents where id=(select intent_id from c256a)),'account-256','callback repetida não troca accountId');

create temporary table c256b as select * from public.twitter_claim_connection_intents('worker-b',50,300);
grant select on c256b to service_role;
select extensions.is((select count(*)::bigint from c256b),2::bigint,'reconciliação e próximo preparo avançam em paralelo');
select extensions.is((select count(*)::bigint from c256b where phase='prepare'),1::bigint,'continua existindo um único preparo por conexão');
select public.twitter_retry_connection_intent((select intent_id from c256b where phase='reconcile'),(select claim_token from c256b where phase='reconcile'),'account_not_propagated','aguarde');
select extensions.is((select status from public.twitter_connection_intents where id=(select intent_id from c256b where phase='reconcile')),'callback_received','falha transitória preserva callback e reserva');
select extensions.ok((select retry_after>now() from public.twitter_connection_intents where id=(select intent_id from c256b where phase='reconcile')),'retry aplica backoff');
update public.twitter_connection_intents set lease_until=now()-interval '1 second' where id=(select intent_id from c256b where phase='prepare');
create temporary table c256c as select * from public.twitter_claim_connection_intents('worker-c',50,300);
grant select on c256c to service_role;
select extensions.is((select count(*)::bigint from c256c),1::bigint,'lease vencido é recuperado sem duplicar outro preparo');
select extensions.is((select attempt_count from c256c),2,'recuperação incrementa tentativa');
select public.twitter_complete_connection_intent((select intent_id from c256c),(select claim_token from c256c),false,null,'provider_error','falha terminal');
select extensions.is((select status from public.twitter_connection_intents where id=(select intent_id from c256c)),'failed','falha terminal libera a reserva');
select extensions.is((select count(*)::bigint from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_class f on f.oid=c.confrelid where t.relname='twitter_connection_intents' and f.relname like 'instagram%'),0::bigint,'fila X não referencia Instagram');

select jsonb_build_object('finish',(select jsonb_agg(value) from extensions.finish() value)) diagnostics;
rollback;

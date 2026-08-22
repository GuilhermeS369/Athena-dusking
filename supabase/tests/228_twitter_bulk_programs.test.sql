begin; create extension if not exists pgtap with schema extensions; select extensions.plan(16);
select extensions.has_table('public','twitter_programs','programas X existem');
select extensions.has_table('public','twitter_publication_items','fila X isolada existe');
select extensions.has_table('public','twitter_program_shortfalls','excedente compacto existe');
select extensions.has_function('public','twitter_confirm_bulk_program',array['uuid','uuid','text','text','integer','jsonb','jsonb','jsonb','jsonb','jsonb','jsonb'],'confirmação atômica existe');
select extensions.ok(not has_function_privilege('authenticated','public.twitter_confirm_bulk_program(uuid,uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)','EXECUTE'),'authenticated não confirma fora da API');
select extensions.ok(has_function_privilege('service_role','public.twitter_confirm_bulk_program(uuid,uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)','EXECUTE'),'service role confirma programa');
select extensions.is((select count(*)::bigint from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_class f on f.oid=c.confrelid where t.relname like 'twitter_%' and f.relname in ('instagram_profiles','publication_items')),0::bigint,'schema X não referencia tabelas operacionais Instagram');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at) values('12800000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','twitter-228@example.com','',now(),now(),now());
insert into public.organizations(id,name,slug,created_by) values('22800000-0000-4000-8000-000000000001','Twitter 228','twitter-228','12800000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role,invited_by) values('22800000-0000-4000-8000-000000000001','12800000-0000-4000-8000-000000000001','admin','12800000-0000-4000-8000-000000000001');
create temporary table twitter_228_context(identity_id uuid,connection_id uuid,profile_id uuid,epoch_id uuid,program_id uuid) on commit drop; grant select,insert,update on twitter_228_context to service_role; insert into twitter_228_context default values;
set local role service_role; select set_config('request.jwt.claim.role','service_role',true);
do $$ declare identity jsonb; connection jsonb; profile jsonb; begin
identity:=public.twitter_register_identity_and_grant('22800000-0000-4000-8000-000000000001','zernio-228');
connection:=public.twitter_upsert_connection_credentials('22800000-0000-4000-8000-000000000001',(identity->>'identityId')::uuid,'C','zp-228',repeat('encrypted',5),repeat('d',64),'api','scope','12800000-0000-4000-8000-000000000001','twitter-228@example.com');
profile:=public.twitter_sync_profile_from_zernio('22800000-0000-4000-8000-000000000001',(connection->>'connectionId')::uuid,'za-228','xu-228','perfil228','Perfil',null,true,false,true,false,'free','[]');
update twitter_228_context set identity_id=(identity->>'identityId')::uuid,connection_id=(connection->>'connectionId')::uuid,profile_id=(profile->>'profileId')::uuid,epoch_id=(profile->>'epochId')::uuid; end $$;
do $$ declare result jsonb; ctx twitter_228_context; begin select * into ctx from twitter_228_context; result:=public.twitter_confirm_bulk_program(
'22800000-0000-4000-8000-000000000001','12800000-0000-4000-8000-000000000001','confirm-228-first',repeat('a',64),1,
jsonb_build_array(jsonb_build_object('identityId',ctx.identity_id,'walletVersion',1,'availableMicros',12000000)),
jsonb_build_object('scheduleKind','interval','startsAt','2027-01-01T12:00:00Z','endsAt','2027-01-01T12:02:00Z','intervalMinutes',1,'totalRequested',3,'unfundedCount',1),
jsonb_build_array(jsonb_build_object('text_index',0,'content','sem url','weighted_characters',7,'contains_url',false),jsonb_build_object('text_index',1,'content','https://example.com','weighted_characters',23,'contains_url',true)),
'[]',
jsonb_build_array(
jsonb_build_object('profile_id',ctx.profile_id,'connection_epoch_id',ctx.epoch_id,'connection_id',ctx.connection_id,'identity_id',ctx.identity_id,'slot_index',0,'execute_at','2027-01-01T12:00:00Z','content','sem url','weighted_characters',7,'media_set_client_key',null,'category','post_dm_create','amount_micros',15000),
jsonb_build_object('profile_id',ctx.profile_id,'connection_epoch_id',ctx.epoch_id,'connection_id',ctx.connection_id,'identity_id',ctx.identity_id,'slot_index',1,'execute_at','2027-01-01T12:01:00Z','content','https://example.com','weighted_characters',23,'media_set_client_key',null,'category','post_create_url','amount_micros',200000)),
jsonb_build_array(jsonb_build_object('profile_id',ctx.profile_id,'requested_count',3,'funded_count',2,'unfunded_count',1,'first_unfunded_at','2027-01-01T12:02:00Z','last_unfunded_at','2027-01-01T12:02:00Z','interval_minutes',1)));
update twitter_228_context set program_id=(result->>'programId')::uuid; end $$;
select extensions.is((select count(*)::bigint from public.twitter_programs),1::bigint,'confirmação cria um programa');
select extensions.is((select count(*)::bigint from public.twitter_publication_items),2::bigint,'somente slots financiados são materializados');
select extensions.is((select unfunded_count from public.twitter_program_shortfalls),1::bigint,'excedente fica compacto');
select extensions.is((select reserved_micros from public.twitter_wallets where identity_id=(select identity_id from twitter_228_context)),215000::bigint,'reserva agrega custos de 0,015 e 0,200');
select extensions.is((select count(*)::bigint from public.twitter_wallet_reservations),2::bigint,'reservas são agregadas por categoria');

do $$ declare replay jsonb; ctx twitter_228_context; begin select * into ctx from twitter_228_context; replay:=public.twitter_confirm_bulk_program('22800000-0000-4000-8000-000000000001','12800000-0000-4000-8000-000000000001','confirm-228-first',repeat('a',64),1,'[]','{}','[]','[]','[]','[]'); if not (replay->>'idempotentReplay')::boolean then raise exception 'replay inválido'; end if; end $$;
select extensions.is((select count(*)::bigint from public.twitter_programs),1::bigint,'replay não duplica programa');
select extensions.is((select count(*)::bigint from public.twitter_publication_items),2::bigint,'replay não duplica itens');
select extensions.throws_ok(format($q$select public.twitter_confirm_bulk_program('22800000-0000-4000-8000-000000000001','12800000-0000-4000-8000-000000000001','confirm-228-stale',%L,1,%L::jsonb,%L::jsonb,'[]','[]','[]','[]')$q$,repeat('b',64),jsonb_build_array(jsonb_build_object('identityId',(select identity_id from twitter_228_context),'walletVersion',1,'availableMicros',12000000))::text,jsonb_build_object('scheduleKind','interval','startsAt','2027-01-01T12:00:00Z','endsAt','2027-01-01T12:00:00Z','intervalMinutes',1,'totalRequested',1,'unfundedCount',0)::text),'40001','Saldo ou reservas mudaram; revise novamente.','snapshot antigo recebe conflito');
select extensions.is((select posted_balance_micros from public.twitter_wallets where identity_id=(select identity_id from twitter_228_context)),12000000::bigint,'confirmar reserva não debita ledger');
select * from extensions.finish(); rollback;

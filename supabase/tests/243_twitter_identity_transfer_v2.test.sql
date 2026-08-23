begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(13);

select extensions.has_column('public','twitter_identity_transfer_events','idempotency_key','evento possui idempotência');
select extensions.has_column('public','twitter_identity_transfer_events','actor_user_id','evento registra autor estável');
select extensions.ok(not has_function_privilege('service_role','public.twitter_transfer_identity_organization(uuid,uuid,uuid,text,text)','EXECUTE'),'RPC antiga não pode mais transferir');
select extensions.ok(has_function_privilege('service_role','public.twitter_transfer_identity_organization_v2(uuid,uuid,uuid,text,uuid,text,text)','EXECUTE'),'service role usa somente RPC v2');
select extensions.ok(not has_function_privilege('authenticated','public.twitter_transfer_identity_organization_v2(uuid,uuid,uuid,text,uuid,text,text)','EXECUTE'),'cliente não chama RPC diretamente');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('14300000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','twitter-243@example.com','',now(),now(),now());
insert into public.organizations(id,name,slug,created_by) values
('24300000-0000-4000-8000-000000000001','Origem 243','origem-243','14300000-0000-4000-8000-000000000001'),
('24300000-0000-4000-8000-000000000002','Destino 243','destino-243','14300000-0000-4000-8000-000000000001'),
('24300000-0000-4000-8000-000000000003','Viewer 243','viewer-243','14300000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role,invited_by) values
('24300000-0000-4000-8000-000000000001','14300000-0000-4000-8000-000000000001','admin','14300000-0000-4000-8000-000000000001'),
('24300000-0000-4000-8000-000000000002','14300000-0000-4000-8000-000000000001','admin','14300000-0000-4000-8000-000000000001'),
('24300000-0000-4000-8000-000000000003','14300000-0000-4000-8000-000000000001','viewer','14300000-0000-4000-8000-000000000001');

create temporary table t243(identity_id uuid) on commit drop;
grant select,insert,update on t243 to service_role;
insert into t243 default values;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
update t243 set identity_id=(public.twitter_register_identity_and_grant('24300000-0000-4000-8000-000000000001','zernio-243')->>'identityId')::uuid;

select extensions.throws_ok(format(
  $q$select public.twitter_transfer_identity_organization_v2('%s','24300000-0000-4000-8000-000000000001','24300000-0000-4000-8000-000000000003','destino sem admin','14300000-0000-4000-8000-000000000001','twitter-243@example.com','transfer-243-viewer')$q$,
  (select identity_id from t243)
),'42501','Administração da origem e do destino é obrigatória.','viewer no destino é bloqueado');

select public.twitter_transfer_identity_organization_v2(
  (select identity_id from t243),'24300000-0000-4000-8000-000000000001','24300000-0000-4000-8000-000000000002',
  'transferência administrativa 243','14300000-0000-4000-8000-000000000001','TWITTER-243@EXAMPLE.COM','transfer-243-success'
);
select extensions.is((select current_organization_id from public.twitter_global_identities where id=(select identity_id from t243)),'24300000-0000-4000-8000-000000000002'::uuid,'identidade muda de tenant');
select extensions.is((select organization_id from public.twitter_wallets where identity_id=(select identity_id from t243)),'24300000-0000-4000-8000-000000000002'::uuid,'carteira acompanha identidade');
select extensions.is((select posted_balance_micros from public.twitter_wallets where identity_id=(select identity_id from t243)),12000000::bigint,'saldo é preservado');
select extensions.is((select count(*) from public.twitter_identity_transfer_events where identity_id=(select identity_id from t243)),1::bigint,'evento imutável único');
select extensions.is((select actor_email from public.twitter_identity_transfer_events where identity_id=(select identity_id from t243)),'twitter-243@example.com','email é normalizado');

select public.twitter_transfer_identity_organization_v2(
  (select identity_id from t243),'24300000-0000-4000-8000-000000000001','24300000-0000-4000-8000-000000000002',
  'transferência administrativa 243','14300000-0000-4000-8000-000000000001','twitter-243@example.com','transfer-243-success'
);
select extensions.is((select count(*) from public.twitter_identity_transfer_events where identity_id=(select identity_id from t243)),1::bigint,'replay não duplica evento');
select extensions.is((select version from public.twitter_wallets where identity_id=(select identity_id from t243)),2::bigint,'replay não incrementa versão novamente');

select jsonb_build_object('finish',(select jsonb_agg(value) from extensions.finish() value),'events',(select count(*) from public.twitter_identity_transfer_events where identity_id=(select identity_id from t243))) diagnostics;
rollback;

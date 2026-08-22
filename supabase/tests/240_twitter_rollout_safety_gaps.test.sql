begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(13);
select extensions.has_table('public','twitter_financial_rule_events','auditoria imutável de regras existe');
select extensions.has_function('public','twitter_recover_expired_analytics_claims',array['integer'],'recuperação conservadora de analytics existe');
select extensions.has_function('public','twitter_worker_circuit_breaker',array['text','text','text','integer','integer'],'circuit breaker persistente existe');
select extensions.ok(not has_function_privilege('authenticated','public.twitter_create_financial_rule(uuid,text,integer,text,twitter_financial_rule_action,text,uuid)','EXECUTE'),'authenticated não cria regra via RPC crítica');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('14000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','twitter-240@example.com','',now(),now(),now());
insert into public.organizations(id,name,slug,created_by)
values('24000000-0000-4000-8000-000000000001','Twitter 240','twitter-240','14000000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role,invited_by)
values('24000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000001','admin','14000000-0000-4000-8000-000000000001');
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

select public.twitter_create_financial_rule('24000000-0000-4000-8000-000000000001','publication',599,'future_code','hold','Primeira decisão administrativa','14000000-0000-4000-8000-000000000001');
select extensions.is((select count(*)::bigint from public.twitter_financial_rule_events),1::bigint,'criação gera evento');
select public.twitter_disable_financial_rule('24000000-0000-4000-8000-000000000001',(select id from public.twitter_financial_rules where active),'Regra substituída após revisão','14000000-0000-4000-8000-000000000001');
select public.twitter_create_financial_rule('24000000-0000-4000-8000-000000000001','publication',599,'future_code','release','Nova decisão administrativa','14000000-0000-4000-8000-000000000001');
select public.twitter_disable_financial_rule('24000000-0000-4000-8000-000000000001',(select id from public.twitter_financial_rules where active),'Segunda regra desativada com histórico','14000000-0000-4000-8000-000000000001');
select extensions.is((select count(*)::bigint from public.twitter_financial_rules where not active),2::bigint,'histórico aceita múltiplas regras desativadas');
select extensions.is((select count(*)::bigint from public.twitter_financial_rule_events),4::bigint,'criações e desativações são auditadas');
select extensions.throws_ok($$delete from public.twitter_financial_rule_events$$,'55000','Registro financeiro imutável.','eventos não podem ser apagados');

select public.twitter_worker_circuit_breaker('worker:test-240','failure','falha 1',5,300);
select public.twitter_worker_circuit_breaker('worker:test-240','failure','falha 2',5,300);
select public.twitter_worker_circuit_breaker('worker:test-240','failure','falha 3',5,300);
select public.twitter_worker_circuit_breaker('worker:test-240','failure','falha 4',5,300);
select public.twitter_worker_circuit_breaker('worker:test-240','failure','falha 5',5,300);
select extensions.is((public.twitter_worker_circuit_breaker('worker:test-240','check',null,5,300)->>'allowed')::boolean,false,'cinco falhas abrem o circuit breaker');
select public.twitter_worker_circuit_breaker('worker:test-240','success',null,5,300);
select extensions.is((public.twitter_worker_circuit_breaker('worker:test-240','check',null,5,300)->>'state'),'closed','sucesso fecha o circuit breaker');
select extensions.is(public.twitter_recover_expired_analytics_claims(300),0,'recovery vazio é idempotente');
select extensions.is((select count(*)::bigint from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_class f on f.oid=c.confrelid where t.relname like 'twitter_%' and f.relname in('instagram_profiles','publication_items')),0::bigint,'novos objetos não dependem do Instagram');
select extensions.is((select count(*)::bigint from public.twitter_financial_rules where active),0::bigint,'teste não deixa regra ativa');
select jsonb_build_object('finish',(select jsonb_agg(v)from extensions.finish()v)) diagnostics;
rollback;

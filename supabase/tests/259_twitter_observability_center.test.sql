begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(23);

select extensions.has_table('public','twitter_observability_events','eventos normalizados existem');
select extensions.has_table('public','twitter_observability_incidents','incidentes agrupados existem');
select extensions.has_table('public','twitter_observability_view_preferences','limpeza visual existe');
select extensions.has_table('public','twitter_observability_archives','manifestos de retenção existem');
select extensions.has_function('public','twitter_record_observability_event',array['uuid','twitter_observability_domain','twitter_observability_severity','text','text','text','text','text','text','timestamp with time zone','uuid','uuid','uuid','uuid','uuid','uuid','uuid','text','text','integer','text','text','text','text','jsonb'],'RPC de evento existe');
select extensions.ok(not has_function_privilege('authenticated','public.twitter_record_observability_event(uuid,twitter_observability_domain,twitter_observability_severity,text,text,text,text,text,text,timestamptz,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer,text,text,text,text,jsonb)','EXECUTE'),'membro não fabrica evento');
select extensions.ok(has_function_privilege('service_role','public.twitter_record_observability_event(uuid,twitter_observability_domain,twitter_observability_severity,text,text,text,text,text,text,timestamptz,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,integer,text,text,text,text,jsonb)','EXECUTE'),'service role registra evento');
select extensions.ok(exists(select 1 from pg_partitioned_table p join pg_class c on c.oid=p.partrelid where c.relname='twitter_observability_events'),'eventos são particionados');
select extensions.is(public.twitter_observability_sanitize_evidence('{"token":"segredo","nested":{"authorization":"Bearer abc","requestId":"req-1"}}'::jsonb),'{"nested":{"requestId":"req-1"}}'::jsonb,'sanitização SQL remove segredos aninhados');
select extensions.is(public.twitter_observability_sanitize_evidence('{"providerUrl":"https://signed.example/x","code":"429"}'::jsonb),'{"providerUrl":"[url removida]","code":"429"}'::jsonb,'sanitização SQL remove URLs e preserva evidência útil');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('25900000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','twitter-259@example.com','',now(),now(),now());
insert into public.organizations(id,name,slug,created_by) values('25900000-0000-4000-8000-000000000001','Twitter 259','twitter-259','25900000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role,invited_by) values('25900000-0000-4000-8000-000000000001','25900000-0000-4000-8000-000000000001','admin','25900000-0000-4000-8000-000000000001');

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.twitter_record_observability_event('25900000-0000-4000-8000-000000000001','publication','error','publication','failed','account_unavailable','Conta indisponível','test','event-1',now(),null,null,null,null,null,null,null,'worker-a','worker-id',401,'account_unavailable',null,null,null,'{}');
select public.twitter_record_observability_event('25900000-0000-4000-8000-000000000001','publication','error','publication','failed','account_unavailable','Outra conta indisponível','test','event-2',now()+interval '1 second',null,null,null,null,null,null,null,'worker-a','worker-id',403,'account_unavailable',null,null,null,'{}');
select extensions.is((select count(*)::bigint from public.twitter_observability_incidents),1::bigint,'mesma causa agrupa ocorrências');
select extensions.is((select occurrence_count from public.twitter_observability_incidents),2::bigint,'grupo contabiliza ocorrências');
select extensions.is((select status::text from public.twitter_observability_incidents),'open','incidente nasce aberto');
select extensions.throws_ok($$update public.twitter_observability_events set message='alterado'$$,'55000','Eventos de observabilidade X são imutáveis.','evento é imutável');

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','25900000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"role":"authenticated","sub":"25900000-0000-4000-8000-000000000001","email":"twitter-259@example.com"}',true);
select public.twitter_set_observability_incident_status((select id from public.twitter_observability_incidents),'resolved','Correção aplicada no worker','commit-259');
select extensions.is((select status::text from public.twitter_observability_incidents),'resolved','operador resolve incidente visual');
select extensions.is((select count(*)::bigint from public.twitter_observability_incident_actions),1::bigint,'tratamento possui auditoria');
select public.twitter_set_observability_view_preference('25900000-0000-4000-8000-000000000001','publication','clear');
select extensions.ok((select cleared_at is not null from public.twitter_observability_view_preferences),'limpeza cria marcador sem apagar');
select extensions.is((select count(*)::bigint from public.twitter_observability_events),2::bigint,'limpeza preserva eventos');

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select public.twitter_record_observability_event('25900000-0000-4000-8000-000000000001','publication','error','publication','failed','account_unavailable','Erro voltou','test','event-3',now()+interval '2 seconds',null,null,null,null,null,null,null,'worker-a','worker-id',401,'account_unavailable',null,null,null,'{}');
select extensions.is((select status::text from public.twitter_observability_incidents),'open','nova ocorrência reabre incidente');
select extensions.is((select reopen_count from public.twitter_observability_incidents),1,'reincidência é contabilizada');
select extensions.is((select count(*)::bigint from public.twitter_observability_events),3::bigint,'ocorrências individuais permanecem acessíveis');
select extensions.ok((select count(*) from public.twitter_observability_events where incident_id is not null)=3,'ocorrências apontam para o grupo');
select extensions.ok((select public.twitter_observability_fingerprint('publication','publication','account_unavailable',401,'account_unavailable','worker-a'))=(select public.twitter_observability_fingerprint('publication','publication','account_unavailable',403,'account_unavailable','worker-a')),'classe HTTP mantém agrupamento');

select * from extensions.finish();
rollback;

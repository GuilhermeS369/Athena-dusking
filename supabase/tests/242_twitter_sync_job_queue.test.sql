begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(17);

select extensions.has_table('public', 'twitter_sync_jobs', 'fila de sync X existe');
select extensions.ok(
  not has_function_privilege('authenticated', 'public.twitter_enqueue_sync_job(uuid,uuid,uuid,text)', 'EXECUTE'),
  'cliente não enfileira diretamente'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.twitter_claim_sync_jobs(text,integer,integer)', 'EXECUTE'),
  'cliente não executa claim'
);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at)
values('14200000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','twitter-242@example.com','',now(),now(),now());
insert into public.organizations(id,name,slug,created_by)
values('24200000-0000-4000-8000-000000000001','Twitter 242','twitter-242','14200000-0000-4000-8000-000000000001');
insert into public.organization_members(organization_id,user_id,role,invited_by)
values('24200000-0000-4000-8000-000000000001','14200000-0000-4000-8000-000000000001','admin','14200000-0000-4000-8000-000000000001');

create temporary table t242(identity_id uuid, connection_id uuid) on commit drop;
grant select,insert,update on t242 to service_role;
insert into t242 default values;
set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);

do $$
declare identity jsonb; connection jsonb;
begin
  identity := public.twitter_register_identity_and_grant('24200000-0000-4000-8000-000000000001','zernio-242');
  connection := public.twitter_upsert_connection_credentials(
    '24200000-0000-4000-8000-000000000001',
    (identity->>'identityId')::uuid,
    'Sync 242','profile-242',repeat('encrypted',5),repeat('f',64),
    'api','scope','14200000-0000-4000-8000-000000000001','twitter-242@example.com'
  );
  update t242 set identity_id=(identity->>'identityId')::uuid,
    connection_id=(connection->>'connectionId')::uuid;
end$$;

select public.twitter_enqueue_sync_job(
  '24200000-0000-4000-8000-000000000001',(select connection_id from t242),
  '14200000-0000-4000-8000-000000000001','sync-job-242-a'
);
select extensions.is((select status from public.twitter_sync_jobs),'pending','job inicia pendente');
select public.twitter_enqueue_sync_job(
  '24200000-0000-4000-8000-000000000001',(select connection_id from t242),
  '14200000-0000-4000-8000-000000000001','sync-job-242-a'
);
select extensions.is((select count(*)::bigint from public.twitter_sync_jobs),1::bigint,'replay não duplica job');
select public.twitter_enqueue_sync_job(
  '24200000-0000-4000-8000-000000000001',(select connection_id from t242),
  '14200000-0000-4000-8000-000000000001','sync-job-242-joined'
);
select extensions.is((select count(*)::bigint from public.twitter_sync_jobs),1::bigint,'nova solicitação adere ao job ativo');

create temporary table c242a as select * from public.twitter_claim_sync_jobs('sync-worker-242',1,300);
grant select on c242a to service_role;
select extensions.is((select count(*)::bigint from c242a),1::bigint,'claim obtém um job');
select extensions.is((select status from public.twitter_sync_jobs),'processing','claim move para processing');
select extensions.ok((select claim_token is not null from c242a),'claim token é obrigatório');
select extensions.is((select attempt_count from c242a),1,'primeiro claim registra tentativa');
select extensions.throws_ok(
  (select format(
    $q$select public.twitter_complete_sync_job('%s','00000000-0000-4000-8000-000000000099',true,'{}',null,null)$q$,
    job_id
  ) from c242a),
  '55000','Claim de sync X não é mais válido.','token obsoleto não conclui'
);
select public.twitter_complete_sync_job(
  (select job_id from c242a),(select claim_token from c242a),true,
  '{"seen":1,"synced":1,"markedOffline":0}',null,null
);
select extensions.is((select status from public.twitter_sync_jobs),'succeeded','sucesso fecha job');
select public.twitter_complete_sync_job(
  (select job_id from c242a),(select claim_token from c242a),true,'{}',null,null
);
select extensions.is((select status from public.twitter_sync_jobs),'succeeded','replay terminal é idempotente');

select public.twitter_enqueue_sync_job(
  '24200000-0000-4000-8000-000000000001',(select connection_id from t242),
  '14200000-0000-4000-8000-000000000001','sync-job-242-b'
);
select extensions.is((select count(*)::bigint from public.twitter_sync_jobs),2::bigint,'novo job nasce após terminal');
create temporary table c242b as select * from public.twitter_claim_sync_jobs('sync-worker-242',1,300);
grant select on c242b to service_role;
select public.twitter_complete_sync_job(
  (select job_id from c242b),(select claim_token from c242b),false,'{}','provider_error','falha confirmada'
);
select extensions.is((select status from public.twitter_sync_jobs where id=(select job_id from c242b)),'failed','falha fecha job e libera conexão');
select extensions.is((select last_error_code from public.twitter_connections where id=(select connection_id from t242)),'provider_error','falha atualiza diagnóstico da conexão');
select extensions.is(
  (select count(*)::bigint from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_class f on f.oid=c.confrelid where t.relname='twitter_sync_jobs' and f.relname in('instagram_profiles','publication_items')),
  0::bigint,'fila sync não referencia Instagram'
);

select jsonb_build_object('finish',(select jsonb_agg(value) from extensions.finish() value),'jobs',(select count(*) from public.twitter_sync_jobs)) diagnostics;
rollback;

begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(10);

select extensions.has_column('public', 'twitter_programs', 'name', 'programa X possui nome opcional');
select extensions.has_column('public', 'twitter_programs', 'schedule_version', 'programa X registra versão da agenda');
select extensions.has_function('public', 'twitter_bulk_profile_queue_summary', array['uuid'], 'agregado de fila por perfil existe');
select extensions.has_function('public', 'twitter_program_queue_overview', array['uuid'], 'estado efetivo dos programas existe');
select extensions.has_function(
  'public', 'twitter_confirm_bulk_program_v2',
  array['uuid','uuid','text','text','integer','jsonb','jsonb','jsonb','jsonb','jsonb','jsonb','jsonb'],
  'confirmação transacional V2 existe'
);
select extensions.ok(
  (select prosrc ilike '%order by 1%' and prosrc ilike '%for update%' from pg_proc where oid = 'public.twitter_confirm_bulk_program_v2(uuid,uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure),
  'confirmação bloqueia perfis em ordem determinística'
);
select extensions.ok(
  (select strpos(lower(prosrc), 'idempotency_key = p_idempotency_key') < strpos(lower(prosrc), 'for requested_profile') from pg_proc where oid = 'public.twitter_confirm_bulk_program_v2(uuid,uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)'::regprocedure),
  'replay idempotente é resolvido antes da validação da cauda'
);
select extensions.ok(
  (select prosrc ilike '%next_attempt_at%' and prosrc ilike '%outcome_unknown%' from pg_proc where oid = 'public.twitter_bulk_profile_queue_summary(uuid)'::regprocedure),
  'agregado considera retry futuro e resultado incerto'
);
select extensions.ok(
  (select prosrc ilike '%media_kind = ''images''%' and prosrc ilike '%media_kind = ''gif''%' and prosrc ilike '%media_kind = ''video''%' from pg_proc where oid = 'public.twitter_bulk_profile_queue_summary(uuid)'::regprocedure),
  'agregado separa imagens, GIF e vídeo'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.twitter_confirm_bulk_program_v2(uuid,uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE'),
  'confirmação V2 permanece restrita ao service role'
);

select * from extensions.finish();
rollback;

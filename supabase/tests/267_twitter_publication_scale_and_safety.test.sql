begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(18);

select extensions.has_column('public','twitter_publication_items','dispatch_deadline_at','item possui deadline');
select extensions.has_column('public','twitter_publication_items','preparation_status','item possui estado de preparação');
select extensions.has_column('public','twitter_publication_items','payload_snapshot','item possui snapshot');
select extensions.has_column('public','twitter_publication_items','media_manifest','item possui manifesto');
select extensions.has_column('public','twitter_publication_items','missed_at','item possui instante missed');
select extensions.has_column('public','twitter_publication_attempts','fencing_token','tentativa carrega fencing');
select extensions.has_table('public','twitter_dispatch_fences','fencing distribuído existe');
select extensions.has_table('public','twitter_connection_dispatch_limits','limite por conexão existe');
select extensions.has_table('public','twitter_profile_disconnection_incidents','incidente de retirada existe');
select extensions.has_function('public','twitter_claim_preparation_items',array['text','integer'],'claim de preparação existe');
select extensions.has_function('public','twitter_claim_publication_items_v2',array['text','integer','uuid'],'claim horizontal existe');
select extensions.has_function('public','twitter_backfill_publication_scale',array['integer'],'backfill explícito existe');
select extensions.has_function('public','twitter_publication_scale_audit',array[]::text[],'dry-run existe');
select extensions.ok(position('skip locked' in lower(pg_get_functiondef('public.twitter_claim_publication_items_v2(text,integer,uuid)'::regprocedure)))>0,'claim usa skip locked');
select extensions.ok(position('15 minutes' in pg_get_functiondef('public.twitter_set_publication_deadline()'::regprocedure))>0,'deadline é quinze minutos');
select extensions.ok(position('24 hours' in pg_get_functiondef('public.twitter_claim_preparation_items(text,integer)'::regprocedure))>0,'preparação usa janela de 24h');
select extensions.ok(not has_function_privilege('authenticated','public.twitter_backfill_publication_scale(integer)','EXECUTE'),'cliente não executa backfill');
select extensions.ok(not has_function_privilege('authenticated','public.twitter_claim_publication_items_v2(text,integer,uuid)','EXECUTE'),'cliente não executa claim');

select * from extensions.finish();
rollback;

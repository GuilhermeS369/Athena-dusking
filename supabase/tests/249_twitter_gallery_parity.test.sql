begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(12);

select extensions.has_column('public','twitter_media_assets','thumbnail_storage_path','X persiste miniaturas sem carregar vídeos na grade');
select extensions.has_column('public','twitter_media_assets','first_published_at','X registra reutilização publicada da mídia');
select extensions.has_column('public','twitter_media_assets','deletion_requested_at','X pode coordenar exclusões da galeria');
select extensions.has_function('public','twitter_gallery_media_page',array['uuid','integer','timestamp with time zone','uuid','text','text','uuid','boolean','text'],'consulta paginada da Galeria X existe');
select extensions.has_function('public','twitter_count_gallery_media',array['uuid','text','text','uuid','boolean','text'],'contagem dos filtros da Galeria X existe');
select extensions.has_function('public','twitter_update_media_group_assignments_bulk',array['uuid','uuid[]','uuid[]','text','uuid'],'organização em massa de grupos X existe');
select extensions.has_function('public','twitter_media_asset_has_storage_object',array['text'],'galeria X verifica o objeto físico antes de listar');
select extensions.has_trigger('public','twitter_publication_items','twitter_publication_items_mark_media_reused','publicação X marca o reaproveitamento da mídia');
select extensions.ok(
  (select indexdef ilike '%organization_id, sha256%' from pg_indexes where schemaname='public' and indexname='twitter_media_assets_org_sha256_idx'),
  'deduplicação X é isolada por organização e hash'
);
select extensions.ok(
  (select prosrc ilike '%thumbnail_storage_path%' and prosrc ilike '%scheduled_total%' and prosrc ilike '%published_at%' from pg_proc where oid='public.twitter_gallery_media_page(uuid,integer,timestamptz,uuid,text,text,uuid,boolean,text)'::regprocedure),
  'consulta inclui miniatura, fila e histórico de reutilização'
);
select extensions.ok(
  not has_function_privilege('authenticated','public.twitter_gallery_media_page(uuid,integer,timestamptz,uuid,text,text,uuid,boolean,text)','EXECUTE'),
  'consulta agregada não é exposta diretamente ao navegador'
);
select extensions.ok(
  not has_function_privilege('authenticated','public.twitter_update_media_group_assignments_bulk(uuid,uuid[],uuid[],text,uuid)','EXECUTE'),
  'mutação em massa permanece restrita ao servidor X'
);

select * from extensions.finish();
rollback;

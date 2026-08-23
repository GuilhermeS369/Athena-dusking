begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(9);

select extensions.has_table('public', 'twitter_media_groups', 'grupos de mídia X existem');
select extensions.has_table('public', 'twitter_media_group_members', 'associação de mídia X existe');
select extensions.has_function(
  'public', 'twitter_replace_media_group_members', array['uuid','uuid','uuid[]','uuid'],
  'substituição transacional dos itens do grupo existe'
);
select extensions.has_function(
  'public', 'twitter_bulk_profile_format_summary', array['uuid'],
  'resumo de progresso por formato existe'
);
select extensions.ok(
  (select prosrc ilike '%outcome_unknown%' and prosrc ilike '%next_attempt_at%'
   from pg_proc where oid = 'public.twitter_bulk_profile_format_summary(uuid)'::regprocedure),
  'resumo inclui bloqueios e cauda efetiva'
);
select extensions.ok(
  (select prosrc ilike '%published_text_count%' or proallargtypes is not null
   from pg_proc where oid = 'public.twitter_bulk_profile_format_summary(uuid)'::regprocedure),
  'resumo retorna progresso publicado por formato'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.twitter_replace_media_group_members(uuid,uuid,uuid[],uuid)', 'EXECUTE'),
  'mutação de grupos permanece restrita ao service role'
);
select extensions.ok(
  not has_function_privilege('authenticated', 'public.twitter_bulk_profile_format_summary(uuid)', 'EXECUTE'),
  'projeção agregada não é exposta diretamente ao navegador'
);
select extensions.ok(
  (select relrowsecurity from pg_class where oid = 'public.twitter_media_groups'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.twitter_media_group_members'::regclass),
  'tabelas de grupos de mídia possuem RLS'
);

select * from extensions.finish();
rollback;

begin;

select '1..5';

-- 1. Contrato: assinatura preservada.
select case when to_regprocedure('public.list_instagram_profiles_catalog_page(uuid,integer,timestamptz,uuid,text,uuid,text,text,text)') is not null
  then 'ok 1 - assinatura do catálogo preservada'
  else 'not ok 1 - assinatura do catálogo mudou' end;

-- 2. A varredura de publication_items não pode mais tocar o histórico publicado.
do $$ declare definition text; begin
  definition := pg_get_functiondef('public.list_instagram_profiles_catalog_page(uuid,integer,timestamptz,uuid,text,uuid,text,text,text)'::regprocedure);
  if position('''waiting'', ''ready'', ''preparing'', ''publishing'', ''published''' in definition) > 0 then
    raise exception 'O catálogo voltou a varrer o histórico publicado em publication_items.';
  end if;
  if position('item.status in (''waiting'', ''ready'', ''preparing'', ''publishing'')' in definition) = 0 then
    raise exception 'A varredura da fila ativa não foi encontrada.';
  end if;
end $$;
select 'ok 2 - varredura restrita à fila ativa';

-- 3. As contagens de publicado vêm do rollup mantido por trigger.
do $$ declare definition text; begin
  definition := pg_get_functiondef('public.list_instagram_profiles_catalog_page(uuid,integer,timestamptz,uuid,text,uuid,text,text,text)'::regprocedure);
  if position('profile_publication_catalog_current catalog' in definition) = 0
     or position('coalesce(catalog.published_total, 0)' in definition) = 0 then
    raise exception 'As contagens de publicado precisam vir do rollup.';
  end if;
  -- Perfil sem linha no rollup precisa aparecer com zero, nunca sumir da página.
  if position('left join public.profile_publication_catalog_current catalog' in definition) = 0 then
    raise exception 'O rollup precisa entrar por left join para não filtrar perfis sem publicação.';
  end if;
end $$;
select 'ok 3 - publicado vem do rollup, por left join';

-- 4. O filtro 'posted' usa o índice parcial da 292 em vez de varrer a fila.
do $$ declare definition text; begin
  definition := pg_get_functiondef('public.list_instagram_profiles_catalog_page(uuid,integer,timestamptz,uuid,text,uuid,text,text,text)'::regprocedure);
  if position('catalog_filter.published_total > 0' in definition) = 0 then
    raise exception 'O filtro posted deve consultar o rollup.';
  end if;
end $$;
select 'ok 4 - filtro posted usa o rollup';

-- 5. O índice parcial que sustenta o filtro continua existindo.
select case when exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'profile_publication_catalog_posted_idx'
  )
  then 'ok 5 - índice parcial do filtro posted presente'
  else 'not ok 5 - índice parcial ausente' end;

rollback;

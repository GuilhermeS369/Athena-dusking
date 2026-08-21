-- Garante que o alvo usado pelo worker em
-- ON CONFLICT (organization_id, zernio_post_id) seja inferível pelo PostgreSQL.
--
-- As migrations 184/185 corrigiram o índice parcial que causava 42P10. Esta
-- migration idempotente protege bancos que tenham histórico de migrations
-- marcado como aplicado, mas schema divergente, e falha de forma explícita se
-- existirem duplicatas que tornariam a correção insegura.

do $$
begin
  if exists (
    select 1
    from public.profile_post_analytics_snapshots
    where zernio_post_id is not null
    group by organization_id, zernio_post_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Existem posts analíticos duplicados por organização/zernio_post_id; deduplicate antes de recriar o índice de upsert.';
  end if;
end;
$$;

drop index if exists public.profile_post_analytics_snapshots_zernio_unique_idx;

create unique index profile_post_analytics_snapshots_zernio_unique_idx
  on public.profile_post_analytics_snapshots (organization_id, zernio_post_id);

do $$
declare
  inferable_index_exists boolean;
begin
  select exists (
    select 1
    from pg_catalog.pg_index index_row
    join pg_catalog.pg_class index_class
      on index_class.oid = index_row.indexrelid
    join pg_catalog.pg_class table_class
      on table_class.oid = index_row.indrelid
    join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = table_class.relnamespace
    where namespace_row.nspname = 'public'
      and table_class.relname = 'profile_post_analytics_snapshots'
      and index_class.relname = 'profile_post_analytics_snapshots_zernio_unique_idx'
      and index_row.indisunique
      and index_row.indisvalid
      and index_row.indpred is null
  ) into inferable_index_exists;

  if not inferable_index_exists then
    raise exception 'Índice UNIQUE não parcial de posts analíticos não foi criado corretamente.';
  end if;
end;
$$;

notify pgrst, 'reload schema';

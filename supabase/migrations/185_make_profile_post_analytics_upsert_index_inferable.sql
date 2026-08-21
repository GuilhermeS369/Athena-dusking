-- Um índice parcial ainda não é inferível por ON CONFLICT (organization_id,
-- zernio_post_id) sem predicado. Índices UNIQUE normais permitem múltiplos
-- NULLs no PostgreSQL, portanto preservam as linhas sem ID Zernio e tornam o
-- upsert do worker válido.

drop index if exists public.profile_post_analytics_snapshots_zernio_unique_idx;

create unique index if not exists profile_post_analytics_snapshots_zernio_unique_idx
  on public.profile_post_analytics_snapshots (organization_id, zernio_post_id);

notify pgrst, 'reload schema';

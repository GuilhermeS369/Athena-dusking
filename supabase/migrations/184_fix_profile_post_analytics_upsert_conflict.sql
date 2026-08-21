-- O worker usa ON CONFLICT (organization_id, zernio_post_id) para atualizar
-- métricas. O índice anterior era parcial por deleted_at, que não pode ser
-- inferido como alvo do ON CONFLICT sem repetir o predicado no cliente.
-- A unicidade total por organização/post preserva a identidade do post e faz
-- a sincronização reativar uma linha soft-deletada em vez de duplicá-la.

drop index if exists public.profile_post_analytics_snapshots_zernio_unique_idx;

create unique index if not exists profile_post_analytics_snapshots_zernio_unique_idx
  on public.profile_post_analytics_snapshots (organization_id, zernio_post_id)
  where zernio_post_id is not null;

notify pgrst, 'reload schema';

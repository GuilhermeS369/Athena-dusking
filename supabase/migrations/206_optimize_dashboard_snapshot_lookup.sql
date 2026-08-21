-- A dashboard carrega os snapshots recentes de analytics ordenados por period_end.
-- O índice anterior começava por period_start, que não participa deste filtro,
-- obrigando o PostgreSQL a varrer e ordenar muitos registros da organização.
-- Em organizações com histórico extenso isso ultrapassava o statement_timeout.
create index if not exists profile_analytics_snapshots_dashboard_period_idx
  on public.profile_analytics_snapshots (organization_id, period_end desc)
  where deleted_at is null;

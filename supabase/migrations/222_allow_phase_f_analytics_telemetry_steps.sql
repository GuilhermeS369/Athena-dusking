-- Dashboard escalável — Fase F.
-- Inclui as persistências aditivas de arquivo/current state na telemetria
-- agregada do executor legado e evita perda não bloqueante desses eventos.

alter table public.profile_analytics_refresh_step_events
  drop constraint if exists profile_analytics_refresh_step_events_step_check;

alter table public.profile_analytics_refresh_step_events
  add constraint profile_analytics_refresh_step_events_step_check check (step in (
    'worker_cycle',
    'connection_billing',
    'profile_lookup',
    'sync_run_create',
    'zernio_account_insights',
    'zernio_accounts',
    'zernio_follower_history',
    'zernio_post_analytics',
    'zernio_current_posts',
    'zernio_daily_metrics',
    'payload_archive_persist',
    'snapshot_persist',
    'current_state_persist',
    'daily_metrics_persist',
    'follower_history_persist',
    'post_analytics_persist',
    'item_complete'
  ));

notify pgrst, 'reload schema';

-- Athena Scheduler: distingue coleta parcial de sucesso integral e ausência total.

alter type public.profile_analytics_sync_status add value if not exists 'partial' after 'synced';

notify pgrst, 'reload schema';

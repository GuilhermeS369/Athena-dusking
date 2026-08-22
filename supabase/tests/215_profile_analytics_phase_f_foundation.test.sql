begin;
select plan(13);

select has_table('public', 'profile_analytics_current', 'current state compacto existe');
select has_table('public', 'profile_analytics_payload_archives', 'arquivo bruto separado existe');
select has_table('public', 'profile_analytics_v2_rollouts', 'rollout por organização existe');
select col_is_pk('public', 'profile_analytics_current', array['organization_id', 'profile_id'], 'current state tem uma linha por perfil');
select has_column('public', 'profile_analytics_snapshots', 'payload_archive_id', 'snapshot mantém referência ao arquivo');
select has_column('public', 'profile_analytics_snapshots', 'payload_sha256', 'snapshot mantém hash do arquivo');
select has_function('public', 'enqueue_profile_analytics_refresh_v2_live_canary', array['uuid', 'uuid[]', 'text', 'text'], 'enqueue live class-aware existe');
select has_function('public', 'claim_profile_analytics_refresh_v2_live_item', array['text', 'uuid[]', 'text[]', 'integer', 'integer'], 'claim live class-aware existe');
select has_function('public', 'backfill_profile_analytics_current', array['uuid', 'integer', 'uuid'], 'backfill idempotente existe');
select has_function('public', 'audit_profile_analytics_current_parity', array['uuid'], 'auditoria de paridade existe');
select has_function('public', 'get_profile_analytics_latest_payload_archive', array['uuid', 'uuid', 'text'], 'leitura protegida do arquivo existe');
select has_function('public', 'purge_expired_profile_analytics_payload_archives', array['integer'], 'retenção do arquivo existe');
select has_function('public', 'backfill_profile_analytics_current_archives', array['uuid', 'integer', 'uuid'], 'backfill do arquivo bruto existe');

select * from finish();
rollback;

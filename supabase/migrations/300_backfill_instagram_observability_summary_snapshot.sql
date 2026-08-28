-- Separado da criação da estrutura para que uma eventual recomposição lenta não
-- reverta a migration 299. Esta execução é idempotente.
select set_config('request.jwt.claim.role', 'service_role', true);
select public.refresh_instagram_observability_summary_snapshots(null);

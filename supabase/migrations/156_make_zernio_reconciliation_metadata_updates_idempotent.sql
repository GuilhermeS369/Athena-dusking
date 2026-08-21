-- Reconciliação idempotente: o INSERT continua protegido pelo trigger global,
-- mas UPDATE de uma linha já identificada/canônica não deve reexecutar a guarda
-- de INSERT. A RPC já mantém advisory locks e valida explicitamente accountId,
-- username, organização, conexão e profileId antes de atualizar.

drop trigger if exists instagram_profiles_prevent_zernio_identity_conflict_update
  on public.instagram_profiles;

-- Troca de identidade em caminhos externos à RPC continua bloqueada pela
-- trigger canônica de par conexão/profile e pelas unicidades de accountId.
-- O trigger global de INSERT permanece ativo contra duplicação nova.

notify pgrst, 'reload schema';

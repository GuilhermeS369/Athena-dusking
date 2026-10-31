import { decryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

import { META_APP_DEFAULT_SLOT_LIMIT } from './meta-apps';

export type MetaAppCredentials = {
  id: string;
  label: string;
  clientId: string;
  clientSecret: string;
  authMode: 'instagram_login' | 'unified_login';
  /** Só existe em app de Unified Login; o banco garante (migration 451). */
  unifiedConfigId: string | null;
};

export class MetaAppUnavailableError extends Error {
  constructor(
    readonly code:
      | 'meta_app_not_found'
      | 'meta_app_inactive'
      | 'meta_app_api_blocked'
      | 'meta_app_no_available_slot'
      | 'meta_app_secret_unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'MetaAppUnavailableError';
  }
}

/**
 * Carrega a credencial de um app cadastrado e confere, na mesma passada, se ele
 * ainda tem vaga.
 *
 * A leitura usa o cliente privilegiado porque encrypted_app_secret não é
 * legível pelo papel authenticated — quem chama já validou sessão e papel. A
 * checagem de vaga é feita aqui, e não na tela, porque duas pessoas podem colar
 * a mesma linha do Bulk Meta ao mesmo tempo: a contagem no momento do /start é
 * a única que enxerga a conexão que o outro aparelho acabou de fechar.
 */
export async function resolveMetaAppCredentials(
  organizationId: string,
  metaAppId: string,
  options: { requireFreeSlot?: boolean } = {},
): Promise<MetaAppCredentials> {
  const admin = createSupabaseAdminClient();
  const { data: app } = await admin
    .from('meta_apps')
    .select('id, label, app_id, encrypted_app_secret, instagram_slot_limit, active, api_block_until, auth_mode, unified_config_id')
    .eq('id', metaAppId)
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!app) {
    throw new MetaAppUnavailableError(
      'meta_app_not_found',
      'O app da Meta selecionado não existe mais nesta organização.',
    );
  }

  if (!app.active) {
    throw new MetaAppUnavailableError(
      'meta_app_inactive',
      `O app “${app.label}” está desativado e não recebe conexões novas.`,
    );
  }

  // Vem antes da vaga: um app bloqueado pela Meta pode estar vazio e ainda ser o
  // pior destino possível. A conta entraria, e nenhum item dela publicaria
  // enquanto o bloqueio durasse — inclusive no caminho de reautorização, que é
  // o mais perigoso, porque ele resolve o app sozinho a partir do perfil e
  // devolveria a conta para dentro do app que está fechado.
  const blockedUntil = app.api_block_until ? Date.parse(app.api_block_until) : Number.NaN;
  if (Number.isFinite(blockedUntil) && blockedUntil > Date.now()) {
    throw new MetaAppUnavailableError(
      'meta_app_api_blocked',
      `O app “${app.label}” está com o acesso à API bloqueado pela Meta e não publica. `
        + 'Conecte esta conta por outro app, pelo Bulk Meta.',
    );
  }

  if (options.requireFreeSlot !== false) {
    const slotLimit = app.instagram_slot_limit ?? META_APP_DEFAULT_SLOT_LIMIT;
    const { count } = await admin
      .from('instagram_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('provider', 'meta_official')
      .eq('meta_app_id', app.id)
      .is('deleted_at', null);

    if ((count ?? 0) >= slotLimit) {
      throw new MetaAppUnavailableError(
        'meta_app_no_available_slot',
        `O app “${app.label}” já ocupa as ${slotLimit} vagas. Cadastre outro app da Meta ou libere contas.`,
      );
    }
  }

  let clientSecret: string;
  try {
    clientSecret = decryptToken(app.encrypted_app_secret);
  } catch {
    throw new MetaAppUnavailableError(
      'meta_app_secret_unreadable',
      `Não foi possível ler a chave secreta do app “${app.label}”. Cadastre a chave novamente.`,
    );
  }

  return {
    id: app.id,
    label: app.label,
    clientId: app.app_id,
    clientSecret,
    authMode: app.auth_mode === 'unified_login' ? 'unified_login' : 'instagram_login',
    unifiedConfigId: app.unified_config_id ?? null,
  };
}

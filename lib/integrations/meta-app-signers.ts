import type { MetaWebhookSigner } from '@/lib/integrations/meta-webhook';
import { decryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

/**
 * Apps capazes de ter assinado uma chamada da Meta: o configurado por variável
 * de ambiente, quando existir, mais os apps ativos registrados em `meta_apps`.
 *
 * A leitura usa o cliente privilegiado porque `encrypted_app_secret` não é
 * legível pelo papel `authenticated`, e roda sem paginação de propósito:
 * `meta_apps` guarda uma linha por app registrado pela organização — dezenas no
 * limite, não milhares — e a verificação precisa de todos os candidatos de uma
 * vez. O segredo é decifrado em memória e nunca sai em log.
 */
export async function loadMetaAppSigners(): Promise<MetaWebhookSigner[]> {
  const signers: MetaWebhookSigner[] = [];
  const envSecret = process.env.META_WEBHOOK_APP_SECRET;

  if (envSecret) {
    signers.push({ appId: process.env.META_WEBHOOK_APP_ID ?? 'env', secret: envSecret });
  }

  const { data, error } = await createSupabaseAdminClient()
    .from('meta_apps')
    .select('app_id, encrypted_app_secret')
    .eq('active', true)
    .is('deleted_at', null);

  if (error) {
    console.error('[meta-callbacks] meta_apps_read_failed', { message: error.message });
    return signers;
  }

  for (const row of data ?? []) {
    try {
      signers.push({ appId: row.app_id, secret: decryptToken(row.encrypted_app_secret) });
    } catch {
      console.error('[meta-callbacks] app_secret_decrypt_failed', { appId: row.app_id });
    }
  }

  return signers;
}

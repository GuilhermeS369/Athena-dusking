import { NextResponse } from 'next/server';

import { META_APP_DEFAULT_SLOT_LIMIT, META_APP_SAFE_COLUMNS, metaAppCapacity } from '@/lib/integrations/meta-apps';
import { legacyMetaAppCredentials } from '@/lib/integrations/meta-oauth';
import { getOrganizationContext } from '@/lib/organizations/server';
import { encryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Cadastra o app da Meta que já está configurado no servidor e adota os perfis
 * que entraram por ele.
 *
 * Existe porque a credencial do ambiente não é um caso à parte: é um app da
 * Meta como qualquer outro, com as mesmas vagas e o mesmo nome. A única
 * diferença é que ela já estava aqui antes de existir cadastro. Sem esta rota o
 * operador teria de copiar o App Secret do painel da Meta para dentro do
 * navegador só para registrar algo que o servidor já conhece — o segredo é lido
 * de `process.env` e criptografado sem passar pela tela.
 *
 * Os perfis adotados são os desta organização que usam a API oficial e ainda
 * não têm app. Todos entraram por esta credencial, porque era a única que
 * existia, então o vínculo é reconstituição de um fato, não um palpite.
 */
export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') {
    return NextResponse.json({ error: 'Somente administradores podem cadastrar apps da Meta.' }, { status: 403 });
  }

  const credentials = legacyMetaAppCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: 'O servidor não tem INSTAGRAM_CLIENT_ID e INSTAGRAM_CLIENT_SECRET configurados. Cadastre o app pelo formulário.' },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => ({})) as { label?: unknown; instagramSlotLimit?: unknown };
  const label = typeof body.label === 'string' ? body.label.trim().replace(/\s+/g, ' ') : '';
  const instagramSlotLimit = typeof body.instagramSlotLimit === 'number'
    && Number.isInteger(body.instagramSlotLimit)
    && body.instagramSlotLimit >= 1
    && body.instagramSlotLimit <= 1000
    ? body.instagramSlotLimit
    : META_APP_DEFAULT_SLOT_LIMIT;

  if (label.length < 2 || label.length > 80) {
    return NextResponse.json({ error: 'Informe um nome entre 2 e 80 caracteres para este app.' }, { status: 400 });
  }
  if (!/^[0-9]{6,32}$/.test(credentials.clientId)) {
    return NextResponse.json({ error: 'O App ID configurado no servidor não parece válido.' }, { status: 400 });
  }

  const organizationId = context.activeOrganization.id;
  const admin = createSupabaseAdminClient();

  // Se este App ID já foi cadastrado, reaproveita a linha em vez de recusar: o
  // que o operador quer nesse caso é adotar os perfis órfãos, não criar cópia.
  const { data: existing } = await admin
    .from('meta_apps')
    .select('id, label')
    .eq('organization_id', organizationId)
    .eq('app_id', credentials.clientId)
    .is('deleted_at', null)
    .maybeSingle<{ id: string; label: string }>();

  let appId = existing?.id ?? null;

  if (!appId) {
    const { data: created, error } = await admin
      .from('meta_apps')
      .insert({
        organization_id: organizationId,
        label,
        app_id: credentials.clientId,
        encrypted_app_secret: encryptToken(credentials.clientSecret),
        instagram_slot_limit: instagramSlotLimit,
        created_by: context.user.id,
      })
      .select('id')
      .maybeSingle<{ id: string }>();

    if (error || !created) {
      if (error?.code === '23505') {
        return NextResponse.json({ error: 'Já existe um app ativo com esse nome nesta organização.' }, { status: 409 });
      }
      console.error('[meta-apps] adopt_env_failed', { organizationId, code: error?.code, message: error?.message });
      return NextResponse.json({ error: 'Não foi possível cadastrar o app do servidor.' }, { status: 500 });
    }

    appId = created.id;
  }

  const { data: claimedRows, error: claimError } = await admin
    .from('instagram_profiles')
    .update({ meta_app_id: appId })
    .eq('organization_id', organizationId)
    .eq('provider', 'meta_official')
    .is('meta_app_id', null)
    .is('deleted_at', null)
    .select('id');

  if (claimError) {
    return NextResponse.json(
      { error: `O app foi cadastrado, mas os perfis não puderam ser vinculados a ele: ${claimError.message}` },
      { status: 500 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: app } = await supabase
    .from('meta_apps_safe')
    .select(META_APP_SAFE_COLUMNS)
    .eq('id', appId)
    .maybeSingle();

  const claimed = claimedRows?.length ?? 0;
  const capacity = app
    ? metaAppCapacity(app as Parameters<typeof metaAppCapacity>[0])
    : null;

  return NextResponse.json({
    ok: true,
    app: app ?? null,
    reused: Boolean(existing),
    claimed,
    // Um app com mais contas do que vagas não quebra nada — a capacidade já é
    // limitada em zero —, mas o operador precisa saber que o número está
    // estourado antes de contar com vaga que não existe.
    overflow: capacity ? Math.max(0, capacity.usedSlots - capacity.slotLimit) : 0,
  });
}

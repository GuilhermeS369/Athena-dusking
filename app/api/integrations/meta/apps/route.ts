import { NextResponse } from 'next/server';

import { META_APP_DEFAULT_SLOT_LIMIT, META_APP_SAFE_COLUMNS } from '@/lib/integrations/meta-apps';
import { getOrganizationContext } from '@/lib/organizations/server';
import { encryptToken } from '@/lib/security/token-crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (!['admin', 'operator'].includes(context.activeOrganization.role)) return NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('meta_apps_safe')
    .select(META_APP_SAFE_COLUMNS)
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  if (error) {
    // O gêmeo do throw da página. Aqui a falha não derruba tela nenhuma, mas
    // sumia do mesmo jeito: 500 sem código nenhum no log.
    console.error('[meta] falha ao carregar meta_apps_safe', {
      code: error.code, message: error.message, details: error.details, hint: error.hint,
    });
    return NextResponse.json({ error: 'Não foi possível carregar os apps da Meta.' }, { status: 500 });
  }
  return NextResponse.json({ apps: data ?? [] });
}

export async function POST(request: Request) {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.json({ error: 'Não autenticado.' }, { status: 401 });
  if (context.activeOrganization.role !== 'admin') return NextResponse.json({ error: 'Somente administradores podem cadastrar apps da Meta.' }, { status: 403 });

  const body = await request.json().catch(() => ({})) as {
    label?: unknown;
    appId?: unknown;
    appSecret?: unknown;
    instagramSlotLimit?: unknown;
    authMode?: unknown;
    unifiedConfigId?: unknown;
  };
  const label = typeof body.label === 'string' ? body.label.trim().replace(/\s+/g, ' ') : '';
  const appId = typeof body.appId === 'string' ? body.appId.trim() : '';
  const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : '';
  const instagramSlotLimit = typeof body.instagramSlotLimit === 'number'
    && Number.isInteger(body.instagramSlotLimit)
    && body.instagramSlotLimit >= 1
    && body.instagramSlotLimit <= 1000
    ? body.instagramSlotLimit
    : META_APP_DEFAULT_SLOT_LIMIT;
  const isUnifiedLogin = body.authMode === 'unified_login';
  const unifiedConfigId = typeof body.unifiedConfigId === 'string' ? body.unifiedConfigId.trim() : '';

  if (isUnifiedLogin && !/^[0-9]{6,32}$/.test(unifiedConfigId)) {
    return NextResponse.json({ error: 'O app de Unified Login precisa do Configuration ID, só numérico, criado no painel da Meta.' }, { status: 400 });
  }
  if (label.length < 2 || label.length > 80) {
    return NextResponse.json({ error: 'Informe um nome entre 2 e 80 caracteres para este app.' }, { status: 400 });
  }
  if (!/^[0-9]{6,32}$/.test(appId)) {
    return NextResponse.json({ error: 'O App ID da Meta é só numérico. Copie o valor exato do painel da Meta.' }, { status: 400 });
  }
  // O secret da Meta tem 32 caracteres hexadecimais. Validar o formato aqui
  // evita cadastrar um valor truncado que só falharia no primeiro OAuth.
  if (!/^[a-fA-F0-9]{16,64}$/.test(appSecret)) {
    return NextResponse.json({ error: 'A chave secreta do app parece incompleta. Cole o App Secret inteiro do painel da Meta.' }, { status: 400 });
  }

  // A escrita usa o cliente privilegiado porque encrypted_app_secret não é
  // legível nem gravável pelo papel authenticated. O papel de admin já foi
  // conferido acima, contra a organização ativa desta sessão.
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('meta_apps')
    .insert({
      organization_id: context.activeOrganization.id,
      label,
      app_id: appId,
      encrypted_app_secret: encryptToken(appSecret),
      instagram_slot_limit: instagramSlotLimit,
      created_by: context.user.id,
      // Só na criação: o modo não muda depois (migration 451).
      ...(isUnifiedLogin ? { auth_mode: 'unified_login', unified_config_id: unifiedConfigId } : {}),
    })
    .select('id')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Já existe um app ativo com esse nome ou com esse App ID nesta organização.' },
        { status: 409 },
      );
    }
    console.error('[meta-apps] create_failed', {
      organizationId: context.activeOrganization.id,
      code: error.code,
      message: error.message,
    });
    return NextResponse.json({ error: 'Não foi possível cadastrar o app da Meta.' }, { status: 500 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: created } = await supabase
    .from('meta_apps_safe')
    .select(META_APP_SAFE_COLUMNS)
    .eq('id', data?.id ?? '')
    .maybeSingle();

  return NextResponse.json({ ok: true, app: created ?? null });
}

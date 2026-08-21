import { NextResponse } from 'next/server';
import { ACTIVE_ORGANIZATION_COOKIE } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { organizationId?: unknown };

    if (!isUuid(body.organizationId)) {
      return NextResponse.json({ error: 'Organização inválida.' }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();

    if (userError || !userData.user) {
      return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
    }

    const { data: membership, error: membershipError } = await supabase
      .from('organization_members')
      .select('organization_id, organizations!inner(id)')
      .eq('organization_id', body.organizationId)
      .eq('user_id', userData.user.id)
      .is('organizations.deleted_at', null)
      .maybeSingle();

    if (membershipError || !membership) {
      return NextResponse.json({ error: 'Você não pertence a esta organização.' }, { status: 403 });
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(ACTIVE_ORGANIZATION_COOKIE, body.organizationId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch {
    return NextResponse.json({ error: 'Requisição inválida ou Supabase não configurado.' }, { status: 400 });
  }
}

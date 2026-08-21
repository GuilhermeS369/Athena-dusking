import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function normalizeSlug(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();

    if (userError || !userData.user) {
      return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('organization_members')
      .select('role, joined_at, organizations!inner(id, name, slug, timezone)')
      .eq('user_id', userData.user.id)
      .is('organizations.deleted_at', null)
      .order('joined_at', { ascending: true });

    if (error) {
      return NextResponse.json({ error: 'Não foi possível carregar as organizações.' }, { status: 500 });
    }

    return NextResponse.json({ organizations: data ?? [] });
  } catch {
    return NextResponse.json({ error: 'Supabase ainda não está configurado.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { name?: unknown; slug?: unknown };
    const name = String(body.name ?? '').trim();
    const slug = normalizeSlug(body.slug || name);

    if (name.length < 2 || name.length > 120 || slug.length < 2) {
      return NextResponse.json({ error: 'Informe um nome válido para a organização.' }, { status: 400 });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc('create_organization', {
      organization_name: name,
      organization_slug: slug,
    });

    if (error) {
      const status = error.code === '42501' ? 401 : error.code === '23505' ? 409 : 400;
      return NextResponse.json({ error: 'Não foi possível criar a organização.' }, { status });
    }

    return NextResponse.json({ organization: data }, { status: 201 });
  } catch {
    return NextResponse.json({ error: 'Requisição inválida ou Supabase não configurado.' }, { status: 400 });
  }
}

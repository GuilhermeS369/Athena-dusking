import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { ACTIVE_ORGANIZATION_COOKIE } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  // O padrão do Supabase é `global`, que derruba TODAS as sessões do usuário.
  // Aqui isso seria um acidente: os aparelhos que entraram pelo link espelho
  // usam o mesmo usuário, e sair de um celular deslogaria a operação inteira.
  // Sair encerra só este aparelho; `global` só quando pedido com todas as letras.
  const body = await request.json().catch(() => null) as { scope?: unknown } | null;
  const scope = body?.scope === 'global' ? 'global' : 'local';

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signOut({ scope });

    if (error) {
      return NextResponse.json({ error: 'Não foi possível encerrar a sessão.' }, { status: 500 });
    }

    (await cookies()).delete(ACTIVE_ORGANIZATION_COOKIE);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Supabase ainda não está configurado.' }, { status: 503 });
  }
}

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { currentPassword?: unknown; newPassword?: unknown } | null;
  const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: 'Informe a senha atual e a nova senha.' }, { status: 400 });
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `A nova senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.` }, { status: 400 });
  }
  if (newPassword === currentPassword) {
    return NextResponse.json({ error: 'A nova senha precisa ser diferente da atual.' }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    return NextResponse.json({ error: 'Supabase ainda não está configurado.' }, { status: 503 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;

  if (userError || !user) return NextResponse.json({ error: 'Autenticação necessária.' }, { status: 401 });
  if (!user.email) return NextResponse.json({ error: 'Sua conta não tem e-mail para confirmar a senha atual.' }, { status: 400 });

  // A sessão sozinha não basta para trocar a senha: quem entra pelo link
  // espelho está logado como o dono do link, sem nunca ter sabido a senha dele.
  // A conferência usa um cliente descartável, sem cookies, para não mexer na
  // sessão de quem pediu; a sessão que o login de conferência abre é encerrada
  // em seguida.
  const verifier = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: verified, error: verifyError } = await verifier.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });

  if (verifyError || verified.user?.id !== user.id) {
    if (verifyError?.status === 429) {
      return NextResponse.json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }, { status: 429 });
    }
    return NextResponse.json({ error: 'A senha atual não confere.' }, { status: 400 });
  }
  await verifier.auth.signOut({ scope: 'local' });

  const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });

  if (updateError) {
    if (updateError.code === 'weak_password') {
      return NextResponse.json({ error: 'A nova senha é fraca demais. Use uma senha mais longa, com letras e números.' }, { status: 400 });
    }
    if (updateError.code === 'same_password') {
      return NextResponse.json({ error: 'A nova senha precisa ser diferente da atual.' }, { status: 400 });
    }
    console.error('[conta] falha ao trocar a senha', { code: updateError.code, status: updateError.status });
    return NextResponse.json({ error: `Não foi possível trocar a senha${updateError.code ? ` (${updateError.code})` : ''}.` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

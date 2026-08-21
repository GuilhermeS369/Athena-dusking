import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function requiredServerEnv(name: 'NEXT_PUBLIC_SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY') {
  const value = process.env[name];

  if (!value) {
    throw new Error(`A variável ${name} não está configurada no servidor.`);
  }

  return value;
}

/**
 * Cliente privilegiado para operações exclusivamente server-side.
 * Nunca importe este módulo em Client Components nem exponha o resultado ao
 * navegador. A service role ignora RLS; cada chamada deve validar sessão,
 * organização e autorização antes de tocar dados.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  return createClient(
    requiredServerEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requiredServerEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

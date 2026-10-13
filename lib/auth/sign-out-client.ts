export type SignOutScope = 'local' | 'global';

/**
 * Encerra a sessão e leva para o login. `local` sai só deste aparelho;
 * `global` derruba todas as sessões da conta, inclusive as do link espelho.
 * Navegação cheia de propósito: descarta o cache do router junto com a sessão.
 */
export async function signOutAndLeave(scope: SignOutScope = 'local') {
  const response = await fetch('/api/auth/signout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
  if (!response.ok) throw new Error('signout-failed');
  window.location.assign('/login');
}

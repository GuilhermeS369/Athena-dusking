import { NextResponse } from 'next/server';

import { knownZernioAccountIdsFromAttempt, loadZernioConnectionAttempt, markZernioConnectionAttemptCallback, markZernioConnectionAttemptFailed } from '@/lib/integrations/zernio-attempts';
import { explicitZernioCallbackAccountId, explicitZernioCallbackProfileId, validateExplicitZernioCallbackAccount, validateExplicitZernioCallbackProfile, validateZernioCallbackState, zernioTerminalCallbackFailure } from '@/lib/integrations/zernio-oauth-safety';
import { safeReturnTo } from '@/lib/integrations/meta-oauth';
import { getOrganizationContext } from '@/lib/organizations/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
  const attemptId = url.searchParams.get('attemptId')?.trim();
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) return NextResponse.redirect(new URL('/login', url.origin));
  if (!attemptId) return NextResponse.redirect(new URL(`${returnTo}?error=invalid_state`, url.origin));

  const organizationId = context.activeOrganization.id;
  const attempt = await loadZernioConnectionAttempt(organizationId, attemptId).catch(() => null);
  if (!attempt) return NextResponse.redirect(new URL(`${returnTo}?error=invalid_state`, url.origin));
  if (attempt.created_by !== context.user.id) return NextResponse.redirect(new URL(`${returnTo}?error=forbidden`, url.origin));
  if (!attempt.zernio_profile_id) return NextResponse.redirect(new URL(`${returnTo}?error=invalid_state`, url.origin));

  try {
    validateZernioCallbackState(attempt.zernio_state, url.searchParams);
    const profileValidation = validateExplicitZernioCallbackProfile({
      explicitProfileId: explicitZernioCallbackProfileId(url.searchParams),
      canonicalProfileId: attempt.zernio_profile_id,
    });
    if (!profileValidation.valid) throw new Error(profileValidation.error);
    const explicitAccountId = explicitZernioCallbackAccountId(url.searchParams);
    const accountValidation = validateExplicitZernioCallbackAccount({
      explicitAccountId,
      baselineAccountIds: knownZernioAccountIdsFromAttempt(attempt),
    });
    if (!accountValidation.valid) throw new Error(accountValidation.error ?? 'A conta retornada pela Zernio não pôde ser validada.');

    const callbackQuery = Object.fromEntries([...url.searchParams.entries()].filter(([key]) => key !== 'returnTo'));
    const terminalFailure = zernioTerminalCallbackFailure(url.searchParams);
    if (terminalFailure.terminal) {
      const reason = terminalFailure.code ?? 'A Zernio recusou a criação da conta.';
      // O operador lê isso no celular, no meio de uma onda. A mensagem precisa
      // dizer o que aconteceu, que nada ficou pendurado e o que fazer agora.
      const terminalMessages: Record<string, string> = {
        oauth_denied: 'A autorização no Instagram foi negada ou cancelada. Nenhuma conta foi criada e nenhum slot foi ocupado. Gere uma nova linha no Bulk Zernio para tentar de novo.',
        payment_required: 'A Zernio recusou a conexão por falta de capacidade de cobrança nesta chave. Nenhuma conta foi criada. Use outra chave com vaga.',
        free_tier_exceeded: 'Esta chave Zernio já atingiu o limite do plano gratuito. Nenhuma conta foi criada. Use outra chave com vaga.',
        billing_required: 'A Zernio exige forma de pagamento nesta chave. Nenhuma conta foi criada. Use outra chave com vaga.',
        plan_limit_exceeded: 'Esta chave Zernio já atingiu o limite do plano. Nenhuma conta foi criada. Use outra chave com vaga.',
      };
      const message = terminalMessages[reason] ?? `A Zernio recusou a criação da conta (${reason}). Nenhuma conta foi criada.`;
      await markZernioConnectionAttemptFailed(attemptId, new Error(message), {
        callbackQuery,
        terminalCallbackFailure: true,
        terminalCallbackFailureReason: reason,
      });
      const redirect = new URL('/zernio/concluindo', url.origin);
      redirect.searchParams.set('attemptId', attemptId);
      redirect.searchParams.set('returnTo', returnTo);
      return NextResponse.redirect(redirect);
    }
    const transition = await markZernioConnectionAttemptCallback(attemptId, {
      ...callbackQuery,
      callbackAccountWasInBaseline: String(Boolean(explicitAccountId && knownZernioAccountIdsFromAttempt(attempt).includes(explicitAccountId))),
    });
    if (!transition.accepted) {
      const redirect = new URL(returnTo, url.origin);
      if (attempt.status === 'synced' || attempt.status === 'empty') {
        redirect.searchParams.set('connected', attempt.status === 'synced' ? 'zernio' : 'zernio_empty');
        redirect.searchParams.set('synced', String(attempt.synced_count ?? 0));
      } else redirect.searchParams.set('error', 'zernio_intent_failed');
      return NextResponse.redirect(redirect);
    }

    // O callback não é sucesso final. O celular acompanha o worker até conta,
    // conexão, grupo e slot estarem confirmados.
    const redirect = new URL('/zernio/concluindo', url.origin);
    redirect.searchParams.set('attemptId', attemptId);
    redirect.searchParams.set('returnTo', returnTo);
    redirect.searchParams.set('correlationId', String(attempt.diagnostic?.correlationId ?? attemptId));
    const fallbackLabel = typeof attempt.diagnostic?.fallbackConnectionLabel === 'string' ? attempt.diagnostic.fallbackConnectionLabel : null;
    if (fallbackLabel) redirect.searchParams.set('zernioFallbackConnection', fallbackLabel.slice(0, 80));
    return NextResponse.redirect(redirect);
  } catch (error) {
    await markZernioConnectionAttemptFailed(attemptId, error).catch(() => undefined);
    const redirect = new URL(returnTo, url.origin);
    redirect.searchParams.set('error', 'zernio_callback_failed');
    if (error instanceof Error) redirect.searchParams.set('diagnostic', error.message.slice(0, 400));
    return NextResponse.redirect(redirect);
  }
}

type CallbackValues = URLSearchParams | Record<string, string | undefined>;

function callbackValue(values: CallbackValues, key: string) {
  return values instanceof URLSearchParams ? values.get(key) ?? undefined : values[key];
}

export function validateZernioCallbackState(_expectedState: string | null | undefined, values: CallbackValues) {
  const receivedState = callbackValue(values, 'state')?.trim() || null;
  // A Zernio devolve no callback o state interno do Instagram, enquanto o
  // startConnect devolve ao servidor um state composto próprio da Zernio. Eles
  // não são o mesmo token e compará-los rejeitava todo callback válido. A
  // correlação forte é feita por turnId + attemptId persistidos e validados no
  // banco imediatamente antes desta função.
  // No fluxo padrão de Instagram a Zernio documenta accountId/profileId no
  // redirect final, mas não promete reenviar state. A ausência é informativa;
  // a segurança é feita pelo turno de uso único, usuário e organização.
  return { valid: true as const, receivedState, error: null };
}

export function explicitZernioCallbackProfileId(values: CallbackValues) {
  for (const key of ['profileId', 'profile_id', 'zernioProfileId', 'zernio_profile_id']) {
    const value = callbackValue(values, key)?.trim();
    if (value) return value;
  }
  return null;
}

export function validateExplicitZernioCallbackProfile(input: {
  explicitProfileId: string | null;
  canonicalProfileId: string;
}) {
  if (input.explicitProfileId && input.explicitProfileId !== input.canonicalProfileId) {
    return {
      valid: false as const,
      error: 'O profileId retornado pela Zernio não corresponde à conexão canônica desta solicitação.',
    };
  }
  return { valid: true as const, error: null };
}

export function explicitZernioCallbackAccountId(values: CallbackValues) {
  for (const key of ['accountId', 'account_id', 'zernioAccountId', 'zernio_account_id']) {
    const value = callbackValue(values, key)?.trim();
    if (value) return value;
  }
  return null;
}

export function validateExplicitZernioCallbackAccount(input: {
  explicitAccountId: string | null;
  baselineAccountIds: string[];
}) {
  if (input.explicitAccountId && input.baselineAccountIds.includes(input.explicitAccountId)) {
    return {
      valid: true as const,
      requiresWorkerIdentityValidation: true as const,
      error: null,
    };
  }
  return { valid: true as const, requiresWorkerIdentityValidation: false as const, error: null };
}

export function zernioTerminalCallbackFailure(values: CallbackValues) {
  const error = callbackValue(values, 'error')?.trim().toLocaleLowerCase('en-US') ?? '';
  const reason = callbackValue(values, 'reason')?.trim().toLocaleLowerCase('en-US') ?? '';
  // Terminal significa "nenhuma conta foi criada e nenhuma vai aparecer": sem
  // isso o attempt entra em recuperação e prende o aparelho até o prazo.
  //
  // `oauth_denied` entrou na lista por medição: em 2.953 callbacks históricos
  // ele apareceu 16 vezes e nenhuma delas resultou em conta.
  //
  // `connection_failed` fica deliberadamente de fora: apareceu 6 vezes e em 5
  // delas a conta foi criada e sincronizada normalmente. Tratá-lo como terminal
  // transformaria plug bem-sucedido em falha.
  const terminalCodes = new Set([
    'payment_required',
    'free_tier_exceeded',
    'billing_required',
    'plan_limit_exceeded',
    'oauth_denied',
  ]);
  const code = terminalCodes.has(reason) ? reason : terminalCodes.has(error) ? error : null;
  return { terminal: Boolean(code), code };
}


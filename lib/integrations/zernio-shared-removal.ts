type RemoteAccountLike = {
  accountId?: string | null;
  _id?: string | null;
  id?: string | null;
  username?: string | null;
};

export type SharedAccountPresence = 'present_both' | 'absent_both';

export function normalizeZernioIdentity(value: unknown) {
  return String(value ?? '').replace(/^@/, '').trim().toLocaleLowerCase('en-US');
}

export function zernioRemoteAccountId(account: RemoteAccountLike) {
  return account.accountId ?? account._id ?? account.id ?? null;
}

export function zernioInstagramAccountCount(accounts: Array<RemoteAccountLike & { platform?: string | null }>) {
  return accounts.filter((account) => account.platform === 'instagram').length;
}

export function validateSharedZernioAccountPresence(input: {
  accountId: string;
  username: string;
  retainedAccounts: RemoteAccountLike[];
  removedAccounts: RemoteAccountLike[];
}): SharedAccountPresence {
  const accountId = input.accountId.trim();
  const identity = normalizeZernioIdentity(input.username);
  if (!accountId || !identity) throw new Error('Account ID ou identidade Zernio inválida.');

  const inspect = (accounts: RemoteAccountLike[], label: string) => {
    const account = accounts.find((item) => zernioRemoteAccountId(item) === accountId);
    if (!account) return false;
    if (normalizeZernioIdentity(account.username) !== identity) {
      throw new Error(`O account ID na chave ${label} pertence a outra identidade.`);
    }
    return true;
  };

  const retainedPresent = inspect(input.retainedAccounts, 'preservada');
  const removedPresent = inspect(input.removedAccounts, 'excedente');
  if (retainedPresent !== removedPresent) {
    throw new Error('O account ID global aparece em apenas uma das duas chaves; a remoção foi bloqueada por divergência remota.');
  }
  return retainedPresent ? 'present_both' : 'absent_both';
}

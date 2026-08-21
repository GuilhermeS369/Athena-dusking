export type ZernioSyncAccount = {
  accountId?: string;
  _id?: string;
  id?: string;
  platform?: string;
  username?: string;
  profileId?: string | { _id?: string };
  metadata?: Record<string, unknown> | null;
  profileData?: Record<string, unknown> | null;
  platformUserId?: string;
};

export type ZernioAccountIdentitySnapshot = {
  accountId: string;
  profileId: string | null;
  username: string | null;
  instagramIdentityId: string | null;
};

function profileId(account: ZernioSyncAccount) {
  if (typeof account.profileId === 'string') return account.profileId;
  return account.profileId?._id ?? null;
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function zernioInstagramIdentityId(account: ZernioSyncAccount) {
  const metadata = objectValue(account.metadata);
  const nestedProfileData = objectValue(metadata.profileData);
  const directProfileData = objectValue(account.profileData);
  return [
    account.platformUserId,
    metadata.platformUserId,
    metadata.instagramScopedId,
    nestedProfileData.instagramScopedId,
    nestedProfileData.id,
    directProfileData.instagramScopedId,
    directProfileData.id,
  ].map(stringValue).find(Boolean) ?? null;
}

export function zernioAccountIdentitySnapshot(account: ZernioSyncAccount): ZernioAccountIdentitySnapshot | null {
  const remoteAccountId = account.accountId ?? account._id ?? account.id;
  if (!remoteAccountId) return null;
  return {
    accountId: remoteAccountId,
    profileId: profileId(account),
    username: typeof account.username === 'string' && account.username.trim()
      ? account.username.replace(/^@/, '').trim().toLocaleLowerCase('en-US')
      : null,
    instagramIdentityId: zernioInstagramIdentityId(account),
  };
}

export function classifyZernioAccountAgainstBaseline(
  account: ZernioSyncAccount,
  baseline: ZernioAccountIdentitySnapshot[],
) {
  const current = zernioAccountIdentitySnapshot(account);
  if (!current) return { kind: 'invalid' as const, current: null, baseline: null };
  const previous = baseline.find((item) => item.accountId === current.accountId) ?? null;
  if (!previous) return { kind: 'new' as const, current, baseline: null };
  if (previous.instagramIdentityId && current.instagramIdentityId) {
    return previous.instagramIdentityId === current.instagramIdentityId
      ? { kind: 'existing' as const, current, baseline: previous }
      : { kind: 'reassociated' as const, current, baseline: previous };
  }
  // A Zernio reutiliza accountId. Sem um identificador Instagram imutável não
  // existe evidência suficiente para decidir que a troca é uma conta nova.
  return { kind: 'ambiguous_reuse' as const, current, baseline: previous };
}

/**
 * Uma API key pode expor contas de mais de um profile. Quando a conexão possui
 * profile canônico, somente contas inequivocamente associadas a ele podem ser
 * reconciliadas, tanto no callback quanto no sync administrativo/sync-all.
 */
export function selectZernioInstagramAccountsForSync<T extends ZernioSyncAccount>(accounts: T[], zernioProfileIds: string[], isolateAttempt: boolean) {
  const instagramAccounts = accounts.filter((account) => account.platform === 'instagram');
  const allowedProfileIds = new Set(zernioProfileIds.filter(Boolean));
  if (allowedProfileIds.size === 0) return isolateAttempt ? [] : instagramAccounts;
  return instagramAccounts.filter((account) => {
    const accountZernioProfileId = profileId(account);
    // Com profile canônico conhecido, conta sem profileId não é inequívoca e
    // não pode ser importada por recuperação/callback para a chave errada.
    return Boolean(accountZernioProfileId && allowedProfileIds.has(accountZernioProfileId));
  });
}

export function selectNewZernioAccountsForAttempt<T extends ZernioSyncAccount>(accounts: T[], baselineIds: string[]) {
  const baseline = new Set(baselineIds);
  return accounts.filter((account) => {
    const id = account.accountId ?? account._id ?? account.id;
    return Boolean(id && !baseline.has(id));
  });
}

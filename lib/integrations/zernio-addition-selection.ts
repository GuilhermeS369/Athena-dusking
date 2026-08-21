import {
  classifyZernioAccountAgainstBaseline,
  type ZernioAccountIdentitySnapshot,
  type ZernioSyncAccount,
} from './zernio-account-selection.ts';

export type ZernioAdditionSelection = {
  candidateAccounts: ZernioSyncAccount[];
  existingAccount: ZernioSyncAccount | null;
  ambiguousReuse: ZernioSyncAccount | null;
  explicitAccountMissing: boolean;
};

export function selectZernioAdditionCandidates(input: {
  accounts: ZernioSyncAccount[];
  baseline: ZernioAccountIdentitySnapshot[];
  explicitAccountId?: string | null;
}): ZernioAdditionSelection {
  const explicitAccountId = input.explicitAccountId?.trim() ?? '';
  const observed = explicitAccountId
    ? input.accounts.filter((account) => (account.accountId ?? account._id ?? account.id) === explicitAccountId)
    : input.accounts;
  const classified = observed.map((account) => ({
    account,
    classification: classifyZernioAccountAgainstBaseline(account, input.baseline),
  }));

  return {
    candidateAccounts: classified
      .filter(({ classification }) => ['new', 'reassociated'].includes(classification.kind))
      .map(({ account }) => account),
    existingAccount: classified.find(({ classification }) => classification.kind === 'existing')?.account ?? null,
    ambiguousReuse: classified.find(({ classification }) => classification.kind === 'ambiguous_reuse')?.account ?? null,
    explicitAccountMissing: Boolean(explicitAccountId && !observed.length),
  };
}

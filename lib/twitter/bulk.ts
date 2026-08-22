import { assertMicros } from './pricing.ts';

export type TwitterCombination = {
  textIndex: number;
  mediaSetIndex: number | null;
};

export type TwitterFundingCandidate = {
  id: string;
  profileId: string;
  scheduledAt: string;
  amountMicros: number;
};

export function buildTwitterCombinations(textCount: number, mediaSetCount: number) {
  if (!Number.isInteger(textCount) || textCount < 1) {
    throw new TypeError('É necessário pelo menos um texto.');
  }
  if (!Number.isInteger(mediaSetCount) || mediaSetCount < 0) {
    throw new TypeError('Quantidade de conjuntos de mídia inválida.');
  }

  const combinations: TwitterCombination[] = [];
  const normalizedMediaCount = Math.max(1, mediaSetCount);
  for (let textIndex = 0; textIndex < textCount; textIndex += 1) {
    for (let mediaIndex = 0; mediaIndex < normalizedMediaCount; mediaIndex += 1) {
      combinations.push({
        textIndex,
        mediaSetIndex: mediaSetCount === 0 ? null : mediaIndex,
      });
    }
  }
  return combinations;
}

export function getTwitterCombinationForSlot(
  combinations: TwitterCombination[],
  profileIndex: number,
  slotIndex: number,
) {
  if (combinations.length === 0) throw new TypeError('Combinações vazias.');
  if (!Number.isInteger(profileIndex) || profileIndex < 0 || !Number.isInteger(slotIndex) || slotIndex < 0) {
    throw new TypeError('Índices de rotação inválidos.');
  }
  return combinations[(profileIndex + slotIndex) % combinations.length];
}

export function allocateTwitterFundingRoundRobin(
  candidates: TwitterFundingCandidate[],
  availableMicros: number,
) {
  assertMicros(availableMicros, 'availableMicros');
  for (const candidate of candidates) assertMicros(candidate.amountMicros, `candidate:${candidate.id}`);

  const byProfile = new Map<string, TwitterFundingCandidate[]>();
  for (const candidate of candidates) {
    const profileCandidates = byProfile.get(candidate.profileId) ?? [];
    profileCandidates.push(candidate);
    byProfile.set(candidate.profileId, profileCandidates);
  }
  for (const profileCandidates of byProfile.values()) {
    profileCandidates.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id));
  }

  const profileIds = [...byProfile.keys()].sort();
  const remaining = new Map(profileIds.map((profileId) => [profileId, [...(byProfile.get(profileId) ?? [])]]));
  const funded: TwitterFundingCandidate[] = [];
  let balance = availableMicros;

  while (true) {
    let fundedInRound = false;
    for (const profileId of profileIds) {
      const queue = remaining.get(profileId) ?? [];
      const affordableIndex = queue.findIndex((candidate) => candidate.amountMicros <= balance);
      if (affordableIndex < 0) continue;
      const [candidate] = queue.splice(affordableIndex, 1);
      funded.push(candidate);
      balance -= candidate.amountMicros;
      fundedInRound = true;
    }
    if (!fundedInRound) break;
  }

  const fundedIds = new Set(funded.map((candidate) => candidate.id));
  return {
    funded,
    unfunded: candidates.filter((candidate) => !fundedIds.has(candidate.id)),
    reservedMicros: availableMicros - balance,
    remainingMicros: balance,
  };
}

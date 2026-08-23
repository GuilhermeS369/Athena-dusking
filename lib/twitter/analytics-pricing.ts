export const TWITTER_ANALYTICS_POST_READ_RESERVE_UNITS = 9;
export const TWITTER_ANALYTICS_PROFILE_READ_RESERVE_UNITS = 1;

export function twitterAnalyticsReservedAmountMicros(
  resourceType: "post" | "profile",
  unitCostMicros: number,
) {
  const reservedUnits =
    resourceType === "post"
      ? TWITTER_ANALYTICS_POST_READ_RESERVE_UNITS
      : TWITTER_ANALYTICS_PROFILE_READ_RESERVE_UNITS;
  return { reservedUnits, amountMicros: unitCostMicros * reservedUnits };
}

export function twitterAnalyticsWalletProjection(input: {
  postedBalanceMicros: number;
  reservedMicros: number;
  analyticsCostMicros: number;
}) {
  const availableMicros = input.postedBalanceMicros - input.reservedMicros;
  const projectedAvailableMicros =
    availableMicros - input.analyticsCostMicros;
  return {
    availableMicros,
    projectedAvailableMicros,
    protectedFloorMicros: 5_000_000,
    canFund: projectedAvailableMicros >= 5_000_000,
  };
}

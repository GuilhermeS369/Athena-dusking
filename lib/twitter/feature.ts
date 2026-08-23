function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === 'true';
}

function parseOrganizationIds(value: string | undefined) {
  return new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean));
}

type TwitterFeatureEnvironment = {
  TWITTER_MODULE_ENABLED?: string;
  TWITTER_CANARY_ORGANIZATION_IDS?: string;
  TWITTER_ANALYTICS_ENABLED?: string;
  TWITTER_ZERNIO_ANALYTICS_SYNC_ENABLED?: string;
  TWITTER_BULK_SCHEDULE_V2_ENABLED?: string;
};

export function isTwitterModuleEnabled(
  organizationId: string,
  environment: TwitterFeatureEnvironment = process.env as TwitterFeatureEnvironment,
) {
  return enabled(environment.TWITTER_MODULE_ENABLED)
    || parseOrganizationIds(environment.TWITTER_CANARY_ORGANIZATION_IDS).has(organizationId);
}

export function isTwitterBulkScheduleV2Enabled(environment: TwitterFeatureEnvironment = process.env as TwitterFeatureEnvironment) {
  return enabled(environment.TWITTER_BULK_SCHEDULE_V2_ENABLED);
}

export function isTwitterRolloutActive(
  environment: TwitterFeatureEnvironment = process.env as TwitterFeatureEnvironment,
) {
  return enabled(environment.TWITTER_MODULE_ENABLED)
    || parseOrganizationIds(environment.TWITTER_CANARY_ORGANIZATION_IDS).size > 0;
}

export function isTwitterAnalyticsEnabled(
  organizationId: string,
  environment: TwitterFeatureEnvironment = process.env as TwitterFeatureEnvironment,
) {
  return enabled(environment.TWITTER_ANALYTICS_ENABLED)
    && (enabled(environment.TWITTER_MODULE_ENABLED)
      || parseOrganizationIds(environment.TWITTER_CANARY_ORGANIZATION_IDS).has(organizationId));
}

export function isTwitterZernioAnalyticsSyncEnabled(
  organizationId: string,
  environment: TwitterFeatureEnvironment = process.env as TwitterFeatureEnvironment,
) {
  return enabled(environment.TWITTER_ZERNIO_ANALYTICS_SYNC_ENABLED)
    && isTwitterAnalyticsEnabled(organizationId, environment);
}

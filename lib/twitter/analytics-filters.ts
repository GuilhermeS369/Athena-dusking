export type TwitterAnalyticsMetricType = 'all' | 'post' | 'profile';

export type TwitterAnalyticsFilter = {
  profileId: string;
  groupId: string;
  fromDate: string;
  toDate: string;
  metricType: TwitterAnalyticsMetricType;
};

export type TwitterAnalyticsFilterResource = {
  id: string;
  profileId: string;
  resourceType: Exclude<TwitterAnalyticsMetricType, 'all'>;
  occurredAt?: string;
};

export type TwitterAnalyticsFilterGroup = {
  id: string;
  profileIds: string[];
};

function saoPauloDateKey(value: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function filterTwitterAnalyticsResources(
  resources: TwitterAnalyticsFilterResource[],
  groups: TwitterAnalyticsFilterGroup[],
  filter: TwitterAnalyticsFilter,
) {
  const groupProfiles = filter.groupId
    ? new Set(
        groups.find((group) => group.id === filter.groupId)?.profileIds ?? [],
      )
    : null;

  return resources.filter((resource) => {
    if (
      filter.metricType !== 'all' &&
      resource.resourceType !== filter.metricType
    ) {
      return false;
    }
    if (filter.profileId && resource.profileId !== filter.profileId) {
      return false;
    }
    if (groupProfiles && !groupProfiles.has(resource.profileId)) {
      return false;
    }
    if (resource.resourceType === 'post' && resource.occurredAt) {
      const date = saoPauloDateKey(resource.occurredAt);
      if (filter.fromDate && date < filter.fromDate) return false;
      if (filter.toDate && date > filter.toDate) return false;
    }
    return true;
  });
}

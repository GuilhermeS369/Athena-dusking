type DashboardRolloutEnvironment = {
  DASHBOARD_V2_ENABLED?: string;
  DASHBOARD_V2_KILL_SWITCH?: string;
  DASHBOARD_V2_ORGANIZATION_IDS?: string;
};

const dashboardRolloutEnvironment = (): DashboardRolloutEnvironment => ({
  DASHBOARD_V2_ENABLED: process.env.DASHBOARD_V2_ENABLED,
  DASHBOARD_V2_KILL_SWITCH: process.env.DASHBOARD_V2_KILL_SWITCH,
  DASHBOARD_V2_ORGANIZATION_IDS: process.env.DASHBOARD_V2_ORGANIZATION_IDS,
});

export function isDashboardV2Enabled(
  organizationId: string,
  environment: DashboardRolloutEnvironment = dashboardRolloutEnvironment(),
) {
  if (environment.DASHBOARD_V2_KILL_SWITCH?.trim().toLowerCase() === 'true') return false;
  if (environment.DASHBOARD_V2_ENABLED?.trim().toLowerCase() === 'true') return true;

  return (environment.DASHBOARD_V2_ORGANIZATION_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(organizationId);
}

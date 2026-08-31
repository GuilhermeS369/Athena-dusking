import type { SupabaseClient } from '@supabase/supabase-js';

import type { RecoveryGroupStatus, RecoveryReason } from './ruler.ts';
import type { RecoveryVerdict } from './verdict.ts';

/**
 * Leitura do snapshot da análise de recuperação.
 *
 * Tudo passa por RPC, nunca por `.select()` direto: além de a leitura precisar
 * juntar nome de perfil e de grupo, o teto de linhas do PostgREST vale até para
 * RPC `returns table`, e o corte tem de ser explícito (`hasMore`) em vez de
 * silencioso.
 *
 * **Não há cursor nos candidatos, e isso é deliberado.** O ajuste 25%/40% é
 * filtro de cliente sobre o conjunto já carregado — é o que permite girar o
 * botão e comparar os dois cenários sem requisição nova. Para isso a resposta
 * precisa trazer o superconjunto (40%) de uma vez. Quando `hasMore` vem
 * verdadeiro, a tela recusa a ação em massa sobre "todos" e pede para refinar,
 * em vez de agir sobre um conjunto que não mostrou — mesma postura de
 * `MAX_FILTER_PROFILE_DELETE` em app/api/profiles/bulk-delete/route.ts.
 */

export const RECOVERY_CANDIDATES_MAX = 500;
export const RECOVERY_COHORT_MAX = 200;

export type RecoveryRun = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';
  triggerSource: 'cron' | 'manual' | 'backfill';
  latestMetricDate: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  groupsTotal: number;
  groupsProcessed: number;
  groupsFailed: number;
  candidatesTotal: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Os parâmetros com que ESTE snapshot foi produzido. */
  neverStartedRatio: number;
  neverStartedRatioAlt: number;
  collapsedRatio: number;
  healthGateRatio: number;
  minPostsJudgeable: number;
  recentWindowPosts: number;
  windowDays: number;
  medianIncludesRecovery: boolean;
  peakFromLastMilestone: boolean;
};

export type RecoveryMilestone = {
  id: string;
  happenedOn: string;
  mediaCount: number;
  batchKind: 'common' | 'reprocessed';
  note: string | null;
};

export type RecoverySeriesPoint = { d: string; m: number; n: number };

export type RecoveryGroupCard = {
  groupId: string;
  groupName: string;
  status: RecoveryGroupStatus;
  profilesTotal: number;
  profilesWithMetrics: number;
  profilesIdle: number;
  judgeableProfiles: number;
  medianVs: number | null;
  medianRecentVs: number | null;
  peakDailyMedian: number | null;
  peakFromDate: string | null;
  healthRatio: number | null;
  /** Derivado do pico na leitura. Nunca gravado como se fosse o pico. */
  healthGateThreshold: number | null;
  healthGatePassed: boolean;
  neverStartedCut: number | null;
  neverStartedCutAlt: number | null;
  collapsedCut: number | null;
  neverStarted25: number;
  neverStarted40: number;
  collapsed: number;
  lastMetricDate: string | null;
  errorMessage: string | null;
  recoveryGroupId: string | null;
  recoveryGroupName: string | null;
  cohortActive: number;
  series: RecoverySeriesPoint[];
  milestones: RecoveryMilestone[];
};

export type RecoveryOverview = {
  run: RecoveryRun | null;
  activeRun: { id: string; status: string; groupsProcessed: number; groupsTotal: number } | null;
  staleness: { latestMetricDate: string | null; days: number | null; warn: boolean };
  totals: {
    neverStarted25: number;
    neverStarted40: number;
    collapsed: number;
    eligible25: number;
    eligible40: number;
    newSincePrevious: number;
  };
  groups: RecoveryGroupCard[];
};

export type RecoveryCandidate = {
  profileId: string;
  username: string;
  displayName: string | null;
  profilePictureUrl: string | null;
  groupId: string;
  groupName: string;
  reason: RecoveryReason;
  severity: 'severe' | 'moderate';
  postsTotal: number;
  viewsTotal: number;
  vs: number;
  bestDayVs: number;
  bestDayDate: string | null;
  recentPosts: number | null;
  recentVs: number | null;
  vsIndex: number | null;
  bestDayIndex: number | null;
  recentIndex: number | null;
  /**
   * A razão que a barra "% da mediana" deve mostrar. Cada nível é julgado por
   * uma métrica diferente: usar sempre `vsIndex` colocaria o perfil que
   * DESABOU acima do tique dos 40%, parecendo que não deveria estar na lista —
   * quando o motivo da entrada é justamente que ele era bom e afundou.
   */
  judgedIndex: number | null;
  lastActiveDate: string | null;
  staleDays: number | null;
  alreadyInRecovery: boolean;
  newSincePrevious: boolean;
};

export type RecoveryCohortItem = {
  cohortMemberId: string;
  profileId: string;
  username: string;
  sourceGroupId: string;
  sourceGroupName: string | null;
  recoveryGroupId: string | null;
  recoveryGroupName: string | null;
  enteredOn: string;
  measurementStartOn: string;
  entryReason: 'never_started' | 'collapsed' | 'manual' | 'direct_delete';
  baselineVs: number | null;
  baselineRatio: number | null;
  status: 'active' | 'returned' | 'removed';
  exitAt: string | null;
  exitDecision: string | null;
  exitIndex: number | null;
  exitNote: string | null;
  observedOn: string | null;
  postsSince: number | null;
  vsSince: number | null;
  originMedianVs: number | null;
  originProfiles: number | null;
  recoveryIndex: number | null;
  verdict: RecoveryVerdict | null;
  measuredPosts: number | null;
  zeroViewPosts: number | null;
  zeroViewRate: number | null;
  staleDays: number | null;
};

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number {
  return Math.trunc(num(value) ?? 0);
}

type OverviewPayload = Record<string, unknown> | null;

export function normalizeRecoveryOverview(payload: OverviewPayload): RecoveryOverview {
  const source = (payload ?? {}) as Record<string, any>;
  const run = source.run as Record<string, any> | null | undefined;
  const staleness = (source.staleness ?? {}) as Record<string, any>;
  const totals = (source.totals ?? {}) as Record<string, any>;
  const groups = Array.isArray(source.groups) ? (source.groups as Record<string, any>[]) : [];

  return {
    run: run
      ? {
          id: String(run.id),
          status: run.status,
          triggerSource: run.trigger_source,
          latestMetricDate: run.latest_metric_date ?? null,
          windowStart: run.window_start ?? null,
          windowEnd: run.window_end ?? null,
          groupsTotal: int(run.groups_total),
          groupsProcessed: int(run.groups_processed),
          groupsFailed: int(run.groups_failed),
          candidatesTotal: int(run.candidates_total),
          startedAt: run.started_at ?? null,
          finishedAt: run.finished_at ?? null,
          createdAt: run.created_at,
          neverStartedRatio: num(run.never_started_ratio) ?? 0.25,
          neverStartedRatioAlt: num(run.never_started_ratio_alt) ?? 0.4,
          collapsedRatio: num(run.collapsed_ratio) ?? 0.25,
          healthGateRatio: num(run.health_gate_ratio) ?? 0.6,
          minPostsJudgeable: int(run.min_posts_judgeable),
          recentWindowPosts: int(run.recent_window_posts),
          windowDays: int(run.window_days),
          medianIncludesRecovery: run.median_includes_recovery !== false,
          peakFromLastMilestone: run.peak_from_last_milestone !== false,
        }
      : null,
    activeRun: source.activeRun
      ? {
          id: String((source.activeRun as any).id),
          status: String((source.activeRun as any).status),
          groupsProcessed: int((source.activeRun as any).groups_processed),
          groupsTotal: int((source.activeRun as any).groups_total),
        }
      : null,
    staleness: {
      latestMetricDate: staleness.latestMetricDate ?? null,
      days: num(staleness.days),
      warn: staleness.warn === true,
    },
    totals: {
      neverStarted25: int(totals.neverStarted25),
      neverStarted40: int(totals.neverStarted40),
      collapsed: int(totals.collapsed),
      eligible25: int(totals.eligible25),
      eligible40: int(totals.eligible40),
      newSincePrevious: int(totals.newSincePrevious),
    },
    groups: groups.map((group) => ({
      groupId: String(group.group_id),
      groupName: String(group.group_name ?? ''),
      status: group.status,
      profilesTotal: int(group.profiles_total),
      profilesWithMetrics: int(group.profiles_with_metrics),
      profilesIdle: int(group.profiles_idle),
      judgeableProfiles: int(group.judgeable_profiles),
      medianVs: num(group.median_vs),
      medianRecentVs: num(group.median_recent_vs),
      peakDailyMedian: num(group.peak_daily_median),
      peakFromDate: group.peak_from_date ?? null,
      healthRatio: num(group.health_ratio),
      healthGateThreshold: num(group.health_gate_threshold),
      healthGatePassed: group.health_gate_passed === true,
      neverStartedCut: num(group.never_started_cut),
      neverStartedCutAlt: num(group.never_started_cut_alt),
      collapsedCut: num(group.collapsed_cut),
      neverStarted25: int(group.never_started_25),
      neverStarted40: int(group.never_started_40),
      collapsed: int(group.collapsed),
      lastMetricDate: group.last_metric_date ?? null,
      errorMessage: group.error_message ?? null,
      recoveryGroupId: group.recovery_group_id ?? null,
      recoveryGroupName: group.recovery_group_name ?? null,
      cohortActive: int(group.cohort_active),
      series: Array.isArray(group.daily_median_series)
        ? (group.daily_median_series as RecoverySeriesPoint[])
        : [],
      milestones: Array.isArray(group.milestones)
        ? (group.milestones as RecoveryMilestone[])
        : [],
    })),
  };
}

export function normalizeRecoveryCandidates(rows: Record<string, any>[] | null) {
  const list = rows ?? [];
  return {
    candidates: list.map<RecoveryCandidate>((row) => ({
      profileId: String(row.profile_id),
      username: String(row.username ?? ''),
      displayName: row.display_name ?? null,
      profilePictureUrl: row.profile_picture_url ?? null,
      groupId: String(row.group_id),
      groupName: String(row.group_name ?? ''),
      reason: row.reason,
      severity: row.severity,
      postsTotal: int(row.posts_total),
      viewsTotal: int(row.views_total),
      vs: num(row.vs) ?? 0,
      bestDayVs: num(row.best_day_vs) ?? 0,
      bestDayDate: row.best_day_date ?? null,
      recentPosts: num(row.recent_posts),
      recentVs: num(row.recent_vs),
      vsIndex: num(row.vs_index),
      bestDayIndex: num(row.best_day_index),
      recentIndex: num(row.recent_index),
      judgedIndex: num(row.judged_index),
      lastActiveDate: row.last_active_date ?? null,
      staleDays: num(row.stale_days),
      alreadyInRecovery: row.already_in_recovery === true,
      newSincePrevious: row.new_since_previous === true,
    })),
    hasMore: list.some((row) => row.has_more === true),
  };
}

export function normalizeRecoveryCohort(rows: Record<string, any>[] | null) {
  const list = rows ?? [];
  return {
    members: list.map<RecoveryCohortItem>((row) => ({
      cohortMemberId: String(row.cohort_member_id),
      profileId: String(row.profile_id),
      username: String(row.username ?? ''),
      sourceGroupId: String(row.source_group_id),
      sourceGroupName: row.source_group_name ?? null,
      recoveryGroupId: row.recovery_group_id ?? null,
      recoveryGroupName: row.recovery_group_name ?? null,
      enteredOn: row.entered_on,
      measurementStartOn: row.measurement_start_on,
      entryReason: row.entry_reason,
      baselineVs: num(row.baseline_vs),
      baselineRatio: num(row.baseline_ratio),
      status: row.status,
      exitAt: row.exit_at ?? null,
      exitDecision: row.exit_decision ?? null,
      exitIndex: num(row.exit_index),
      exitNote: row.exit_note ?? null,
      observedOn: row.observed_on ?? null,
      postsSince: num(row.posts_since),
      vsSince: num(row.vs_since),
      originMedianVs: num(row.origin_median_vs),
      originProfiles: num(row.origin_profiles),
      recoveryIndex: num(row.recovery_index),
      verdict: row.verdict ?? null,
      measuredPosts: num(row.measured_posts),
      zeroViewPosts: num(row.zero_view_posts),
      zeroViewRate: num(row.zero_view_rate),
      staleDays: num(row.stale_days),
    })),
    hasMore: list.some((row) => row.has_more === true),
  };
}

export async function getRecoveryOverview(
  supabase: SupabaseClient,
  organizationId: string,
  runId?: string | null,
) {
  const { data, error } = await supabase.rpc('get_recovery_overview', {
    p_organization_id: organizationId,
    p_run_id: runId ?? null,
  });
  if (error) throw new Error(`recovery_overview:${error.message}`);
  return normalizeRecoveryOverview(data as OverviewPayload);
}

export async function listRecoveryCandidates(
  supabase: SupabaseClient,
  runId: string,
  groupId?: string | null,
  limit = RECOVERY_CANDIDATES_MAX,
) {
  const { data, error } = await supabase.rpc('list_recovery_candidates', {
    p_run_id: runId,
    p_group_id: groupId ?? null,
    p_limit: Math.min(Math.max(limit, 1), RECOVERY_CANDIDATES_MAX),
  });
  if (error) throw new Error(`recovery_candidates:${error.message}`);
  return normalizeRecoveryCandidates(data as Record<string, any>[] | null);
}

export async function getRecoveryCohortPage(
  supabase: SupabaseClient,
  organizationId: string,
  options: { recoveryGroupId?: string | null; status?: string; limit?: number } = {},
) {
  const { data, error } = await supabase.rpc('get_recovery_cohort_page', {
    p_organization_id: organizationId,
    p_recovery_group_id: options.recoveryGroupId ?? null,
    p_status: options.status ?? 'active',
    p_limit: Math.min(Math.max(options.limit ?? RECOVERY_COHORT_MAX, 1), RECOVERY_COHORT_MAX),
  });
  if (error) throw new Error(`recovery_cohort:${error.message}`);
  return normalizeRecoveryCohort(data as Record<string, any>[] | null);
}

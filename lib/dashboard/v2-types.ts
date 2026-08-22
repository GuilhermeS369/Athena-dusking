import type { DashboardMetric } from '@/lib/dashboard/analytics-period';

export type DashboardV2Profile = {
  id: string;
  username: string;
  display_name: string | null;
  provider: 'meta_official' | 'zernio';
  status: string;
};

export type DashboardV2Group = {
  id: string;
  name: string;
  profile_ids: string[];
};

export type DashboardV2Bootstrap = {
  generated_at: string;
  profiles: DashboardV2Profile[];
  groups: DashboardV2Group[];
  analytics_state: Array<{
    profile_id: string;
    sync_status: string;
    synced_at: string | null;
    period_end: string;
    last_error_code: string | null;
  }>;
  summary: {
    connections_total: number;
    connections_healthy: number;
    connections_attention: number;
    operational_profiles: number;
    scheduled_total: number;
    next_scheduled_at: string | null;
    failed_publications: number;
    profiles_needing_reauth: number;
    total_posts: number;
    published_total: number;
    analytics_available_profiles: number;
    analytics_unavailable_profiles: number;
    ready_assets: number;
    groups_total: number;
  };
};

export type DashboardV2Analytics = {
  generated_at: string;
  filters: {
    start_date: string;
    end_date: string;
    metric: DashboardMetric;
    bucket: 'day' | 'week' | 'month';
    provider: string | null;
    group_id: string | null;
  };
  kpis: {
    posts: number;
    impressions: number;
    reach: number;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    saves: number;
    interactions: number;
    engagement_rate: number;
    followers_total: number;
    followers_delta: number;
    followers_baseline_profiles: number;
  };
  metric_series: Array<{ date: string; value: number }>;
  post_series: Array<{ date: string; value: number }>;
  follower_series: Array<{ date: string; value: number }>;
  metric_per_source: Array<{ label: string; value: number }>;
  metric_per_group: Array<{ id: string; label: string; value: number }>;
  ranking: Array<{ profile_id: string; username: string; display_name: string | null; value: number }>;
  publication_status: Array<{ label: string; value: number }>;
  publication_format: Array<{ label: string; value: number }>;
  coverage: {
    selected_profiles: number;
    profiles_with_metrics: number;
    partial_profiles: number;
    first_metric_date: string | null;
    last_metric_date: string | null;
  };
};

export type DashboardV2TopPost = {
  id: string;
  profile_id: string;
  username: string;
  platform_post_url: string | null;
  content: string | null;
  media_type: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  views: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  total_interactions: number;
  engagement_rate: number;
  sync_status: string;
  metric_value: number;
};

export type DashboardV2Section<T> = {
  status: 'ok' | 'unavailable';
  data: T;
  error?: string;
};

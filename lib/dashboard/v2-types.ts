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
  /**
   * Só os perfis que PRECISAM de atenção, no máximo 60 (migration 383). Antes
   * vinha a frota inteira — 2.024 linhas para alimentar um cartão que mostra
   * oito. Perfil ausente daqui está sincronizado; quem responde por ele é
   * `analytics_state_counts`.
   */
  analytics_state: Array<{
    profile_id: string;
    sync_status: string;
    synced_at: string | null;
    period_end: string;
    last_error_code: string | null;
  }>;
  /** Contagem por situação de coleta. Opcional enquanto a 383 não é aplicada. */
  analytics_state_counts?: Record<string, number>;
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
    /**
     * Saiu para `DashboardV2Operations.posts` na migration 382: contar
     * publicações custava 226 mil linhas na mesma chamada que agrega 12 mil de
     * métrica. Fica opcional aqui para clientes e respostas antigas.
     */
    posts?: number;
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
  /**
   * A série de TODAS as métricas na mesma resposta (migration 382). Sai da
   * mesma CTE já materializada, então custa quase nada — e é o que deixa a
   * troca de métrica na tela ser instantânea, sem nova ida ao servidor.
   */
  series_by_metric?: Record<DashboardMetric, Array<{ date: string; value: number }>>;
  /** Ver `posts` acima: agora vem de `get_dashboard_operations_v2`. */
  post_series?: Array<{ date: string; value: number }>;
  follower_series: Array<{ date: string; value: number }>;
  metric_per_source: Array<{ label: string; value: number }>;
  metric_per_group: Array<{ id: string; label: string; value: number }>;
  /**
   * `removed` marca perfil já excluído que continua no histórico (migration
   * 386). A tela precisa dele: mostrar um @ que não abre é pior do que não
   * mostrar.
   */
  ranking: Array<{ profile_id: string; username: string; display_name: string | null; value: number; removed?: boolean }>;
  publication_status?: Array<{ label: string; value: number }>;
  publication_format?: Array<{ label: string; value: number }>;
  coverage: {
    selected_profiles: number;
    profiles_with_metrics: number;
    partial_profiles: number;
    first_metric_date: string | null;
    last_metric_date: string | null;
    // Opcionais até a migração 339 ser aplicada remotamente; ver
    // lib/dashboard/coverage-notes.ts.
    profiles_with_publications?: number;
    profiles_pending_collection?: number;
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

/**
 * A metade operacional da dashboard, servida por `get_dashboard_operations_v2`.
 *
 * Ela existe separada porque lê `publication_items`, que cresce com a operação
 * (550 mil linhas na Pomodoro em 05/09/2026) enquanto a metade de métrica lê
 * dezenas de milhares. A tela pede as duas em paralelo e desenha cada uma
 * quando chega. Ver a migration 382.
 */
export type DashboardV2Operations = {
  generated_at: string;
  posts: number;
  post_series: Array<{ date: string; value: number }>;
  publication_status: Array<{ label: string; value: number }>;
  publication_format: Array<{ label: string; value: number }>;
  profiles_with_publications: number;
  profiles_pending_collection: number;
};

/**
 * Contas plugadas x caídas por dia, servido por `get_dashboard_account_flow`
 * (migration 449). Organização inteira, dia de Brasília.
 *
 * `by_reason` e `reasons[].key` usam a mesma chave
 * (`fonte:sinal:código:subcódigo`), para o tooltip de um dia nomear os motivos
 * com o rótulo da lista.
 */
export type DashboardAccountFlowReason = {
  key: string;
  source: 'meta' | 'zernio';
  signal: string;
  code: string | null;
  subcode: string | null;
  /** Falso só para remoção pedida pelo operador, que não conta como queda. */
  is_fall: boolean;
  total: number;
  sample_message: string | null;
  last_at: string;
};

export type DashboardAccountFlow = {
  start_date: string;
  end_date: string;
  days: Array<{
    date: string;
    connected: number;
    connected_meta: number;
    connected_zernio: number;
    fallen: number;
    removed: number;
    by_reason: Record<string, number>;
  }>;
  reasons: DashboardAccountFlowReason[];
  totals: { connected: number; fallen: number; removed: number };
  online_now: number;
};

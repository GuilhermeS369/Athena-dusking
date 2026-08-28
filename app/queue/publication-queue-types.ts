export type Organization = {
  id: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
};

export type IntegrationProvider = 'meta_official' | 'zernio';

export type QueueProfile = {
  id: string;
  username: string;
  display_name: string | null;
  status?: string;
  profile_picture_url?: string | null;
  provider: IntegrationProvider;
  zernio_account_id: string | null;
  zernio_connection_id: string | null;
  zernio_connection_label?: string | null;
};

export type QueueResumption = {
  resumptionId: string;
  organizationId: string;
  batchId: string;
  profileId: string;
  planId: string | null;
  resumedItems: string;
  ignoredItems: string;
  resumedCompactSlots: string;
  ignoredCompactSlots: string;
  safeBaseAt: string | null;
  firstExecuteAt: string | null;
  lastExecuteAt: string | null;
};

export type QueueGroup = {
  id: string;
  name: string;
  description: string | null;
  profile_group_members: Array<{ profile_id: string }> | null;
};

export type QueueAsset = {
  id: string;
  original_name: string;
  mime_type: string;
  kind: 'image' | 'video';
  size_bytes: number;
  storage_path: string;
  thumbnail_storage_path?: string | null;
  signed_url?: string | null;
  thumbnail_url?: string | null;
  status?: string;
  deleted_at?: string | null;
};

export type QueueMedia = {
  position: number;
  media_assets: QueueAsset | null;
};

export type PublicationEvent = {
  id: string;
  event_type: string;
  previous_status: string | null;
  status: string;
  actor_label: string | null;
  error_code: string | null;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type QueueItem = {
  id: string;
  profile_id: string;
  format: 'image' | 'reel' | 'story' | 'carousel';
  status: string;
  execute_at: string | null;
  caption: string | null;
  last_error_message: string | null;
  published_at: string | null;
  attempt_count?: number;
  next_attempt_at?: string | null;
  last_error_code?: string | null;
  suspended_at?: string | null;
  suspension_reason?: string | null;
  created_at?: string;
  updated_at?: string;
  cancelled_at?: string | null;
  archived_at?: string | null;
  publication_failure_acknowledgements?: Array<{
    publication_item_id?: string;
    acknowledged_at: string;
    acknowledged_by: string | null;
  }> | null;
  profile?: QueueProfile | null;
  publication_item_events?: PublicationEvent[] | null;
  publication_item_media?: QueueMedia[] | null;
};

export type Batch = {
  id: string;
  name: string | null;
  status: string;
  scheduled_for: string | null;
  timezone: string;
  created_at: string;
  created_by: string;
  created_by_name?: string | null;
  created_by_email?: string | null;
  updated_at?: string;
  publication_batch_circuit_breakers?: Array<{
    consecutive_failures: number;
    paused_at: string | null;
    paused_reason: string | null;
  }> | null;
  publication_items: QueueItem[] | null;
};

export type QueueCursor = {
  createdAt: string;
  id: string;
};

export type QueueStatusFilter = 'all' | 'scheduled' | 'processing' | 'failed' | 'acknowledged_failed' | 'suspended' | 'published';
export type QueueFormatFilter = 'all' | QueueItem['format'];
export type QueueTimingFilter = 'all' | 'immediate' | 'scheduled';
export type QueueViewMode = 'lumora' | 'classic';
export type QueueAggregateTab = 'account' | 'batch' | 'group';

export type QueueSummaryRow = {
  id: string;
  title?: string;
  username?: string;
  display_name?: string | null;
  profile_picture_url?: string | null;
  profile_count?: number;
  created_at?: string;
  total: number;
  historical_total?: number;
  completed: number;
  errors: number;
  suspended: number;
  pending: number;
  processing: number;
  active?: number;
  closed?: number;
  next_at: string | null;
  tone: 'posting' | 'error' | 'suspended' | 'done' | 'idle';
};

export type QueueSummary = {
  snapshotAt: string | null;
  totals: {
    total: number;
    historicalTotal?: number;
    ok: number;
    pending: number;
    processing: number;
    errors: number;
    acknowledgedErrors?: number;
    suspended: number;
    active?: number;
    closed: number;
    archived: number;
    expiredLeases: number;
    activeAccounts: number;
    suspendedAccounts: number;
    totalAccounts: number;
    progress: number;
  };
  accounts: QueueSummaryRow[];
  batches: QueueSummaryRow[];
  groups: QueueSummaryRow[];
};

export type QueueSummaryPage = {
  scope: QueueAggregateTab;
  offset: number;
  limit: number;
  totalCount: number;
  hasMore: boolean;
};

export type PausedPublicationBatch = {
  batchId: string;
  name: string | null;
  consecutiveFailures: number;
  pausedAt: string;
  reason: string | null;
  lastFailureItemId: string | null;
  blockedItems: number;
  blockedProfiles: number;
  nextExecuteAt: string | null;
};

export type PausedPublicationBatchSummary = {
  snapshotAt: string | null;
  total: number;
  blockedItems: number;
  batches: PausedPublicationBatch[];
};

export type QueueCancellationOperation = {
  id: string;
  scope: 'account' | 'batch' | 'group';
  targetId: string;
  targetLabel: string;
  idempotencyKey: string;
  status: 'running' | 'completed' | 'blocked' | 'failed';
  progress: number;
  result?: Record<string, unknown>;
  error?: string | null;
  createdAt?: string | null;
};

export type PublicationGenerationJob = {
  id: string;
  name: string | null;
  status: string;
  scheduled_for: string | null;
  expected_items: number | null;
  generated_items: number;
  failed_items: number;
  chunk_size: number;
  chunk_count: number;
  attempt_count: number;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  metadata?: Record<string, unknown> | null;
};

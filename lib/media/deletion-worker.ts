import { randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { removeMediaObjectsEverywhere } from '@/lib/storage/media-storage';

type ClaimedDeletionJob = {
  job_id: string;
  organization_id: string;
  total_count: number;
  processed_count: number;
};

type DeletionJobRow = {
  id: string;
  status: string;
  total_count: number;
  processed_count: number;
  deleted_count: number;
  failed_count: number;
  affected_item_count: number;
};

type DeletedMediaResult = {
  media_asset_id: string;
  storage_path: string;
  thumbnail_storage_path: string | null;
  affected_item_ids: string[] | null;
  affected_batch_ids: string[] | null;
};

export type MediaDeletionDispatchOptions = {
  workerId?: string;
  limit?: number;
  chunkSize?: number;
  leaseSeconds?: number;
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Falha desconhecida no worker de exclusão de mídia.';
}

async function refreshJob(jobId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('refresh_media_deletion_job_status', { p_job_id: jobId });
  if (error) throw error;
  return data as DeletionJobRow | null;
}

async function releaseJobIfStillProcessing(job: DeletionJobRow | null) {
  if (!job || job.status !== 'processing' || job.processed_count >= job.total_count) return;
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('media_deletion_jobs')
    .update({ status: 'pending', claimed_by: null, lease_until: null })
    .eq('id', job.id)
    .eq('status', 'processing');
  if (error) throw error;
}

async function failChunk(job: ClaimedDeletionJob, mediaAssetIds: string[], message: string) {
  const supabase = createSupabaseAdminClient();
  await Promise.all([
    supabase
      .from('media_deletion_job_items')
      .update({ status: 'failed', error_message: message.slice(0, 1200), processed_at: new Date().toISOString() })
      .eq('job_id', job.job_id)
      .in('media_asset_id', mediaAssetIds),
    supabase
      .from('media_assets')
      .update({ deletion_requested_at: null, deletion_requested_by: null })
      .eq('organization_id', job.organization_id)
      .is('deleted_at', null)
      .in('id', mediaAssetIds),
  ]);
  const refreshed = await refreshJob(job.job_id);
  await releaseJobIfStillProcessing(refreshed);
}

async function processDeletionChunk(job: ClaimedDeletionJob, chunkSize: number) {
  const supabase = createSupabaseAdminClient();
  const { data: items, error: itemsError } = await supabase
    .from('media_deletion_job_items')
    .select('media_asset_id')
    .eq('job_id', job.job_id)
    .in('status', ['pending', 'processing'])
    .order('created_at', { ascending: true })
    .limit(chunkSize);

  if (itemsError) throw itemsError;

  const mediaAssetIds = [...new Set((items ?? []).map((item) => item.media_asset_id as string))];
  if (!mediaAssetIds.length) {
    await refreshJob(job.job_id);
    return { jobId: job.job_id, processed: 0, deleted: 0, failed: 0, affectedItems: 0 };
  }

  const { error: processingError } = await supabase
    .from('media_deletion_job_items')
    .update({ status: 'processing', error_message: null })
    .eq('job_id', job.job_id)
    .in('media_asset_id', mediaAssetIds);
  if (processingError) throw processingError;

  const { data, error: deleteError } = await supabase.rpc('delete_media_assets_and_remove_publication_items', {
    p_organization_id: job.organization_id,
    p_media_asset_ids: mediaAssetIds,
  });

  if (deleteError) {
    const message = deleteError.message || 'Não foi possível excluir este chunk de mídias.';
    await failChunk(job, mediaAssetIds, message);
    return { jobId: job.job_id, processed: mediaAssetIds.length, deleted: 0, failed: mediaAssetIds.length, affectedItems: 0 };
  }

  const deletedAssets = (data ?? []) as DeletedMediaResult[];
  const deletedById = new Map(deletedAssets.map((asset) => [asset.media_asset_id, asset]));
  const storagePaths = [...new Set(deletedAssets.flatMap((asset) => [
    asset.storage_path,
    ...(asset.thumbnail_storage_path ? [asset.thumbnail_storage_path] : []),
  ]))];

  const storageResult = await removeMediaObjectsEverywhere(supabase, storagePaths);
  const storageWarning = storageResult.error
    ? 'Mídia apagada da galeria, mas o arquivo físico pode ter permanecido no Storage.'
    : null;

  const updates = mediaAssetIds.map((mediaAssetId) => {
    const deleted = deletedById.get(mediaAssetId);
    if (!deleted) {
      return supabase
        .from('media_deletion_job_items')
        .update({ status: 'skipped', error_message: 'A mídia já havia sido removida ou não estava mais disponível.', processed_at: new Date().toISOString() })
        .eq('job_id', job.job_id)
        .eq('media_asset_id', mediaAssetId);
    }
    return supabase
      .from('media_deletion_job_items')
      .update({
        status: 'deleted',
        affected_item_ids: deleted.affected_item_ids ?? [],
        affected_batch_ids: deleted.affected_batch_ids ?? [],
        error_message: storageWarning,
        processed_at: new Date().toISOString(),
      })
      .eq('job_id', job.job_id)
      .eq('media_asset_id', mediaAssetId);
  });
  const updateResults = await Promise.all(updates);
  const firstUpdateError = updateResults.find((result) => result.error)?.error;
  if (firstUpdateError) throw firstUpdateError;

  const refreshed = await refreshJob(job.job_id);
  await releaseJobIfStillProcessing(refreshed);

  return {
    jobId: job.job_id,
    processed: mediaAssetIds.length,
    deleted: deletedAssets.length,
    failed: 0,
    affectedItems: deletedAssets.reduce((total, asset) => total + (asset.affected_item_ids?.length ?? 0), 0),
  };
}

export async function dispatchMediaDeletionJobs(options: MediaDeletionDispatchOptions = {}) {
  const workerId = options.workerId?.trim().slice(0, 120) || `media-delete-${randomUUID()}`;
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit!, 1), 10) : 3;
  const chunkSize = Number.isInteger(options.chunkSize) ? Math.min(Math.max(options.chunkSize!, 1), 100) : 50;
  const leaseSeconds = Number.isInteger(options.leaseSeconds) ? Math.min(Math.max(options.leaseSeconds!, 30), 900) : 180;
  const supabase = createSupabaseAdminClient();
  const processed = [];

  for (let index = 0; index < limit; index += 1) {
    const { data: claimed, error: claimError } = await supabase.rpc('claim_media_deletion_job', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (claimError) throw claimError;

    const job = ((claimed ?? []) as ClaimedDeletionJob[])[0];
    if (!job) break;

    try {
      processed.push(await processDeletionChunk(job, chunkSize));
    } catch (error) {
      console.error('Falha isolada no worker de exclusão de mídia.', { jobId: job.job_id, error: errorMessage(error), details: error });
      const refreshed = await refreshJob(job.job_id);
      await releaseJobIfStillProcessing(refreshed);
      processed.push({ jobId: job.job_id, processed: 0, deleted: 0, failed: 0, affectedItems: 0, error: errorMessage(error) });
    }
  }

  console.info('Dispatcher de exclusão de mídia concluído.', { workerId, chunks: processed.length, processed });
  return { workerId, chunks: processed.length, processed };
}


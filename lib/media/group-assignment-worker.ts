import { randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';

type ClaimedGroupAssignmentJob = {
  job_id: string;
  organization_id: string;
  total_count: number;
  processed_count: number;
};

type GroupAssignmentJobRow = {
  id: string;
  status: string;
  total_count: number;
  processed_count: number;
  applied_count: number;
  skipped_count: number;
  failed_count: number;
};

type ProcessedGroupAssignmentChunk = {
  job_id: string;
  processed: number;
  applied: number;
  skipped: number;
  failed: number;
};

export type MediaGroupAssignmentDispatchOptions = {
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
  return 'Falha desconhecida no worker de organização de grupos.';
}

async function refreshJob(jobId: string) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('refresh_media_group_assignment_job_status', { p_job_id: jobId });
  if (error) throw error;
  return data as GroupAssignmentJobRow | null;
}

async function releaseJobIfStillProcessing(job: GroupAssignmentJobRow | null) {
  if (!job || job.status !== 'processing' || job.processed_count >= job.total_count) return;
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from('media_group_assignment_jobs')
    .update({ status: 'pending', claimed_by: null, lease_until: null })
    .eq('id', job.id)
    .eq('status', 'processing');
  if (error) throw error;
}

async function failJob(job: ClaimedGroupAssignmentJob, message: string) {
  const supabase = createSupabaseAdminClient();
  await Promise.all([
    supabase
      .from('media_group_assignment_job_items')
      .update({ status: 'failed', error_message: message.slice(0, 1200), processed_at: new Date().toISOString() })
      .eq('job_id', job.job_id)
      .in('status', ['pending', 'processing']),
    supabase
      .from('media_group_assignment_jobs')
      .update({ status: 'failed', claimed_by: null, lease_until: null, last_error_message: message.slice(0, 1200), finished_at: new Date().toISOString() })
      .eq('id', job.job_id)
      .eq('status', 'processing'),
  ]);
}

async function processGroupAssignmentChunk(job: ClaimedGroupAssignmentJob, chunkSize: number) {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.rpc('process_media_group_assignment_job_chunk', {
    p_job_id: job.job_id,
    p_chunk_size: chunkSize,
  });

  if (error) {
    const message = error.message || 'Não foi possível organizar este chunk de mídias.';
    await failJob(job, message);
    return { jobId: job.job_id, processed: 0, applied: 0, skipped: 0, failed: job.total_count - job.processed_count, error: message };
  }

  const chunk = ((data ?? []) as ProcessedGroupAssignmentChunk[])[0];
  const refreshed = await refreshJob(job.job_id);
  await releaseJobIfStillProcessing(refreshed);

  return {
    jobId: job.job_id,
    processed: chunk?.processed ?? 0,
    applied: chunk?.applied ?? 0,
    skipped: chunk?.skipped ?? 0,
    failed: chunk?.failed ?? 0,
  };
}

export async function dispatchMediaGroupAssignmentJobs(options: MediaGroupAssignmentDispatchOptions = {}) {
  const workerId = options.workerId?.trim().slice(0, 120) || `media-group-${randomUUID()}`;
  const limit = Number.isInteger(options.limit) ? Math.min(Math.max(options.limit!, 1), 10) : 3;
  const chunkSize = Number.isInteger(options.chunkSize) ? Math.min(Math.max(options.chunkSize!, 1), 1000) : 500;
  const leaseSeconds = Number.isInteger(options.leaseSeconds) ? Math.min(Math.max(options.leaseSeconds!, 30), 900) : 180;
  const supabase = createSupabaseAdminClient();
  const processed = [];

  for (let index = 0; index < limit; index += 1) {
    const { data: claimed, error: claimError } = await supabase.rpc('claim_media_group_assignment_job', {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });
    if (claimError) throw claimError;

    const job = ((claimed ?? []) as ClaimedGroupAssignmentJob[])[0];
    if (!job) break;

    try {
      processed.push(await processGroupAssignmentChunk(job, chunkSize));
    } catch (error) {
      console.error('Falha isolada no worker de organização de grupos.', { jobId: job.job_id, error: errorMessage(error), details: error });
      const refreshed = await refreshJob(job.job_id);
      await releaseJobIfStillProcessing(refreshed);
      processed.push({ jobId: job.job_id, processed: 0, applied: 0, skipped: 0, failed: 0, error: errorMessage(error) });
    }
  }

  console.info('Dispatcher de organização de grupos concluído.', { workerId, chunks: processed.length, processed });
  return { workerId, chunks: processed.length, processed };
}

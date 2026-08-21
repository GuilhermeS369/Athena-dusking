import { randomUUID } from 'crypto';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';

type LeaseOptions = {
  leaseSeconds?: number;
  retries?: number;
  delayMs?: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireZernioConnectionOperationLease(
  organizationId: string,
  connectionId: string,
  options: LeaseOptions = {},
) {
  const supabase = createSupabaseAdminClient();
  const holderId = randomUUID();
  const retries = Math.max(1, options.retries ?? 12);
  const delayMs = Math.max(50, options.delayMs ?? 250);
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const { data, error } = await supabase.rpc('acquire_zernio_connection_operation_lock', {
      p_organization_id: organizationId,
      p_zernio_connection_id: connectionId,
      p_locked_by: holderId,
      p_lease_seconds: options.leaseSeconds ?? 30,
    });
    if (error) throw error;
    if (data === true) return holderId;
    if (attempt < retries) await sleep(delayMs);
  }
  return null;
}

export async function releaseZernioConnectionOperationLease(organizationId: string, connectionId: string, holderId: string | null) {
  if (!holderId) return;
  const supabase = createSupabaseAdminClient();
  await supabase.rpc('release_zernio_connection_operation_lock', {
    p_organization_id: organizationId,
    p_zernio_connection_id: connectionId,
    p_locked_by: holderId,
  });
}

export async function withZernioConnectionOperationLease<T>(
  organizationId: string,
  connectionId: string,
  callback: (locked: boolean) => Promise<T>,
  options: LeaseOptions = {},
) {
  const holderId = await acquireZernioConnectionOperationLease(organizationId, connectionId, options);
  try {
    return await callback(Boolean(holderId));
  } finally {
    await releaseZernioConnectionOperationLease(organizationId, connectionId, holderId);
  }
}

export async function acquireZernioOrganizationSyncLease(organizationId: string, requestedBy: string, options: LeaseOptions = {}) {
  const supabase = createSupabaseAdminClient();
  const holderId = randomUUID();
  const { data, error } = await supabase.rpc('acquire_zernio_organization_sync_lock', {
    p_organization_id: organizationId,
    p_locked_by: holderId,
    p_requested_by: requestedBy,
    p_lease_seconds: options.leaseSeconds ?? 300,
  });
  if (error) throw error;
  return data === true ? holderId : null;
}

export async function releaseZernioOrganizationSyncLease(organizationId: string, holderId: string | null) {
  if (!holderId) return;
  const { error } = await createSupabaseAdminClient().rpc('release_zernio_organization_sync_lock', {
    p_organization_id: organizationId,
    p_locked_by: holderId,
  });
  if (error) throw error;
}

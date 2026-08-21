#!/usr/bin/env node

import fs from 'node:fs';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker.deploy']) {
  if (!fs.existsSync(filePath)) continue;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (!line || line.startsWith('#') || separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const organizationId = '58785306-4dfb-432f-8de0-f0b33f91f3de';
const attemptIds = [
  'f8dde97d-e5c2-438a-af65-2c80208979e4',
  '4e0b5984-e7ba-429e-bc44-f279444d3d7a',
  '6d4c88aa-bae1-4bf2-a549-9c3e7818861b',
  '70d42995-8072-4136-8eab-25bb9ff88edd',
  'fbc53701-c0b7-4b5e-b0de-38e7be5b78e2',
];
const accountIds = [
  '6a82380b77555aae0169f932',
  '6a82380b77555aae0169f936',
];

async function query(builder) {
  const { data, error } = await builder;
  if (error) throw error;
  return data ?? [];
}

const [activeTurns, attempts, profiles] = await Promise.all([
  query(
    supabase
      .from('zernio_oauth_turns')
      .select('id, status, attempt_id, lease_expires_at, terminal_reason')
      .eq('organization_id', organizationId)
      .eq('status', 'active'),
  ),
  query(
    supabase
      .from('zernio_connection_attempts')
      .select('id, status, worker_status, synced_count, zernio_account_ids, requested_group_id, group_assignment_status, group_assigned_profile_ids, diagnostic')
      .eq('organization_id', organizationId)
      .in('id', attemptIds),
  ),
  query(
    supabase
      .from('instagram_profiles')
      .select('id, username, zernio_account_id, zernio_profile_id, zernio_connection_id')
      .eq('organization_id', organizationId)
      .in('zernio_account_id', accountIds)
      .is('deleted_at', null),
  ),
]);

const activeAttemptIds = activeTurns
  .map((turn) => turn.attempt_id)
  .filter(Boolean);
const activeTurnAttempts = activeAttemptIds.length
  ? await query(
    supabase
      .from('zernio_connection_attempts')
      .select('id, status, worker_status, synced_count, last_error_message, created_at, updated_at')
      .in('id', activeAttemptIds),
  )
  : [];

const memberships = await query(
  supabase
    .from('profile_group_members')
    .select('profile_id, group_id, profile_groups(name)')
    .eq('organization_id', organizationId)
    .in('profile_id', profiles.map((profile) => profile.id)),
);

for (const turn of activeTurns) {
  if (new Date(turn.lease_expires_at) >= new Date()) continue;
  const { error } = await supabase.rpc('maintain_zernio_oauth_turn_queue', {
    p_organization_id: organizationId,
    p_zernio_profile_id: '',
    p_lease_seconds: 900,
  });
  if (error) throw error;
  break;
}

const activeTurnsAfterMaintenance = await query(
  supabase
    .from('zernio_oauth_turns')
    .select('id, status, attempt_id, lease_expires_at, terminal_reason')
    .eq('organization_id', organizationId)
    .eq('status', 'active'),
);

const recovered = attempts.filter(
  (attempt) => attempt.diagnostic?.recoveredFromFivePhoneIncident === true,
);
const retryable = attempts.filter(
  (attempt) => attempt.diagnostic?.retryable === true,
);

const assertions = {
  exactlyTwoRecoveredAttempts:
    recovered.length === 2 &&
    recovered.every((attempt) =>
      attempt.status === 'synced' &&
      attempt.worker_status === 'completed' &&
      attempt.synced_count === 1 &&
      attempt.group_assignment_status === 'assigned'),
  exactlyThreeRetryableAttempts:
    retryable.length === 3 &&
    retryable.every((attempt) =>
      attempt.status === 'failed' &&
      attempt.worker_status === 'failed' &&
      attempt.synced_count === 0),
  exactlyTwoCanonicalProfiles: profiles.length === 2,
  bothProfilesInDani:
    memberships.length === 2 &&
    memberships.every((membership) => membership.profile_groups?.name === 'dani'),
  noOrphanActiveTurn: activeTurnsAfterMaintenance.length === 0,
};

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  assertions,
  activeTurns,
  activeTurnAttempts,
  activeTurnsAfterMaintenance,
  recovered,
  retryable,
  profiles,
  memberships,
}, null, 2));

if (Object.values(assertions).some((value) => !value)) process.exitCode = 1;

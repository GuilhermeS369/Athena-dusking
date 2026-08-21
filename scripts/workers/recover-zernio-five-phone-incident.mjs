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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase service role ausente.');

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});

const organizationId = '58785306-4dfb-432f-8de0-f0b33f91f3de';
const incidentAttemptIds = [
  'f8dde97d-e5c2-438a-af65-2c80208979e4',
  '4e0b5984-e7ba-429e-bc44-f279444d3d7a',
  '6d4c88aa-bae1-4bf2-a549-9c3e7818861b',
  '70d42995-8072-4136-8eab-25bb9ff88edd',
  'fbc53701-c0b7-4b5e-b0de-38e7be5b78e2',
];

// Os dois callbacks Aidan tinham baseline vazio. O primeiro callback processado
// (menor failed_at) representa deterministicamente a única conta criada; o
// segundo permanece recuperável. Boysie representa a outra conta remota.
const recoveredTargets = [
  {
    attemptId: '6d4c88aa-bae1-4bf2-a549-9c3e7818861b',
    connectionId: 'f5e0bc7d-a47d-4cfd-b16f-d6404a8741c4',
    zernioProfileId: '6a82344456025122388c6303',
    accountId: '6a82380b77555aae0169f932',
    username: 'velvetzen4285',
  },
  {
    attemptId: 'fbc53701-c0b7-4b5e-b0de-38e7be5b78e2',
    connectionId: 'cfff9246-8d6c-4671-9535-ee4ca1d70fc3',
    zernioProfileId: '6a8225be57dd9fefe1ea8e9b',
    accountId: '6a82380b77555aae0169f936',
    username: 'cyberzen3517',
  },
];

const retryableAttemptIds = [
  'f8dde97d-e5c2-438a-af65-2c80208979e4',
  '4e0b5984-e7ba-429e-bc44-f279444d3d7a',
  '70d42995-8072-4136-8eab-25bb9ff88edd',
];

async function requireData(query, message) {
  const { data, error } = await query;
  if (error) throw error;
  if (!data) throw new Error(message);
  return data;
}

async function releaseReservation(attempt, reason) {
  if (!attempt.zernio_slot_reservation_id) return;
  const { error } = await supabase.rpc(
    'release_zernio_connection_slot_reservation',
    {
      p_reservation_id: attempt.zernio_slot_reservation_id,
      p_organization_id: organizationId,
      p_reason: reason,
    },
  );
  if (error) throw error;
}

async function closeRelatedHistory(attempt, status, reason, now) {
  if (attempt.zernio_connection_intent_id) {
    const { error: intentError } = await supabase
      .from('zernio_connection_intents')
      .update({
        status: status === 'completed' ? 'synced' : 'failed',
        diagnostic: {
          ...(attempt.intent_diagnostic ?? {}),
          incidentRecovery: true,
          incidentRecoveryReason: reason,
          incidentRecoveryAt: now,
        },
      })
      .eq('id', attempt.zernio_connection_intent_id)
      .eq('organization_id', organizationId);
    if (intentError) throw intentError;
  }

  const { error: turnError } = await supabase
    .from('zernio_oauth_turns')
    .update({
      status,
      lease_expires_at: null,
      finished_at: now,
      terminal_reason: reason,
    })
    .eq('attempt_id', attempt.id)
    .eq('organization_id', organizationId);
  if (turnError) throw turnError;

  await releaseReservation(attempt, reason);
}

const group = await requireData(
  supabase
    .from('profile_groups')
    .select('id, name')
    .eq('organization_id', organizationId)
    .ilike('name', 'dani')
    .is('deleted_at', null)
    .maybeSingle(),
  'Grupo dani não encontrado.',
);

const incidentAttempts = await requireData(
  supabase
    .from('zernio_connection_attempts')
    .select('id, created_by, zernio_connection_id, zernio_profile_id, zernio_connection_intent_id, zernio_slot_reservation_id, requested_group_id, requested_group_name, callback_received_at, failed_at, diagnostic, created_at')
    .eq('organization_id', organizationId)
    .in('id', incidentAttemptIds),
  'Attempts do incidente não encontrados.',
);

if (incidentAttempts.length !== incidentAttemptIds.length) {
  throw new Error(`Esperados ${incidentAttemptIds.length} attempts; encontrados ${incidentAttempts.length}.`);
}

const intentIds = incidentAttempts
  .map((attempt) => attempt.zernio_connection_intent_id)
  .filter(Boolean);
const intents = intentIds.length
  ? await requireData(
    supabase
      .from('zernio_connection_intents')
      .select('id, diagnostic')
      .in('id', intentIds),
    'Intents do incidente não encontradas.',
  )
  : [];
const intentById = new Map(intents.map((intent) => [intent.id, intent]));
const attemptById = new Map(
  incidentAttempts.map((attempt) => [
    attempt.id,
    {
      ...attempt,
      intent_diagnostic:
        intentById.get(attempt.zernio_connection_intent_id)?.diagnostic ?? {},
    },
  ]),
);

const aidanRecovered = attemptById.get(recoveredTargets[0].attemptId);
const aidanRetryable = attemptById.get(retryableAttemptIds[2]);
if (!aidanRecovered?.failed_at || !aidanRetryable?.failed_at) {
  throw new Error('Attempts Aidan não possuem timestamps terminais para correlação.');
}
if (new Date(aidanRecovered.failed_at) >= new Date(aidanRetryable.failed_at)) {
  throw new Error('A seleção do attempt Aidan recuperado não corresponde ao primeiro callback processado.');
}

const recovered = [];
for (const target of recoveredTargets) {
  const now = new Date().toISOString();
  const attempt = attemptById.get(target.attemptId);
  if (!attempt) throw new Error(`Attempt ${target.attemptId} não encontrado.`);
  if (attempt.zernio_connection_id !== target.connectionId) {
    throw new Error(`Conexão divergente no attempt de @${target.username}.`);
  }
  if (attempt.zernio_profile_id !== target.zernioProfileId) {
    throw new Error(`Profile canônico divergente no attempt de @${target.username}.`);
  }
  if (attempt.requested_group_id !== group.id) {
    throw new Error(`Grupo solicitado divergente no attempt de @${target.username}.`);
  }

  const connection = await requireData(
    supabase
      .from('zernio_connections')
      .select('id, zernio_profile_id')
      .eq('id', target.connectionId)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .single(),
    `Conexão de @${target.username} não encontrada.`,
  );
  if (connection.zernio_profile_id !== target.zernioProfileId) {
    throw new Error(`Profile canônico divergente para @${target.username}.`);
  }

  const row = {
    organization_id: organizationId,
    instagram_user_id: `zernio:${target.accountId}`,
    username: target.username,
    display_name: target.username,
    account_type: 'Zernio Instagram',
    capabilities: {
      zernio_content_publish: true,
      zernio_instagram_feed: true,
      zernio_instagram_reels: true,
      zernio_instagram_stories: true,
      zernio_instagram_carousel: true,
    },
    status: 'online',
    created_by: attempt.created_by,
    provider: 'zernio',
    zernio_profile_id: target.zernioProfileId,
    zernio_account_id: target.accountId,
    zernio_connection_id: target.connectionId,
    zernio_account_metadata: {
      recoveredFromIncident: true,
      recoveredAt: now,
      recoveredAttemptId: target.attemptId,
    },
  };

  const existingProfile = await requireData(
    supabase
      .from('instagram_profiles')
      .select('id, organization_id, zernio_connection_id, zernio_profile_id, zernio_account_id, username')
      .eq('organization_id', organizationId)
      .eq('zernio_account_id', target.accountId)
      .is('deleted_at', null)
      .maybeSingle(),
    `Consulta do perfil existente de @${target.username} falhou.`,
  );

  let result;
  if (existingProfile) {
    if (
      existingProfile.zernio_connection_id !== target.connectionId ||
      existingProfile.zernio_profile_id !== target.zernioProfileId
    ) {
      throw new Error(`Perfil existente de @${target.username} está em escopo canônico divergente.`);
    }
    result = {
      profile_id: existingProfile.id,
      result_status: 'already_recovered',
      conflict_reason: null,
    };
  } else {
    const reconciliation = await requireData(
      supabase.rpc('reconcile_zernio_connection_accounts', {
        p_organization_id: organizationId,
        p_zernio_connection_id: target.connectionId,
        p_rows: [row],
      }),
      `Reconciliação sem retorno para @${target.username}.`,
    );
    result = reconciliation[0];
    if (!result?.profile_id || result.result_status === 'conflict') {
      throw new Error(
        `Reconciliação falhou para @${target.username}: ${result?.conflict_reason ?? 'sem perfil'}`,
      );
    }
  }

  const assignment = await requireData(
    supabase.rpc('assign_zernio_attempt_profiles_to_group', {
      p_organization_id: organizationId,
      p_attempt_id: attempt.id,
      p_profile_ids: [result.profile_id],
      p_added_by: attempt.created_by,
    }),
    `Associação ao grupo sem retorno para @${target.username}.`,
  );
  if (assignment[0]?.assignment_status !== 'assigned') {
    throw new Error(
      `Associação ao grupo falhou para @${target.username}: ${assignment[0]?.error_message ?? 'status inesperado'}`,
    );
  }

  const { error: attemptError } = await supabase
    .from('zernio_connection_attempts')
    .update({
      status: 'synced',
      worker_status: 'completed',
      worker_id: 'incident-recovery-2026-08-16',
      worker_lease_expires_at: null,
      worker_error_code: null,
      worker_error_stage: null,
      worker_completed_at: now,
      synced_count: 1,
      zernio_account_ids: [target.accountId],
      new_zernio_account_ids: [target.accountId],
      synced_at: now,
      failed_at: null,
      last_error_message: null,
      diagnostic: {
        ...(attempt.diagnostic ?? {}),
        retryable: false,
        retryReason: null,
        recoveredFromFivePhoneIncident: true,
        recoveredAt: now,
        recoveredAccountId: target.accountId,
        recoveredUsername: target.username,
        recoveredLocalProfileId: result.profile_id,
        recoveryCorrelation: target.username === 'velvetzen4285'
          ? 'first_aidan_callback_by_failed_at'
          : 'single_boysie_attempt',
      },
    })
    .eq('id', attempt.id)
    .eq('organization_id', organizationId);
  if (attemptError) throw attemptError;

  await closeRelatedHistory(
    attempt,
    'completed',
    'five_phone_incident_recovered',
    now,
  );

  recovered.push({
    attemptId: attempt.id,
    username: target.username,
    accountId: target.accountId,
    profileId: result.profile_id,
    result: result.result_status,
    group: group.name,
  });
}

const retryable = [];
for (const attemptId of retryableAttemptIds) {
  const now = new Date().toISOString();
  const attempt = attemptById.get(attemptId);
  if (!attempt) throw new Error(`Attempt recuperável ${attemptId} não encontrado.`);

  const { error: attemptError } = await supabase
    .from('zernio_connection_attempts')
    .update({
      status: 'failed',
      worker_status: 'failed',
      worker_lease_expires_at: null,
      worker_error_code: 'remote_account_absent_after_callback',
      worker_error_stage: 'incident_recovery',
      worker_completed_at: now,
      synced_count: 0,
      zernio_account_ids: [],
      new_zernio_account_ids: [],
      synced_at: null,
      failed_at: attempt.failed_at ?? now,
      last_error_message: 'A autorização não produziu uma conta remota. Uma nova linha Bulk pode ser usada com segurança.',
      group_assignment_status: 'pending',
      group_assigned_profile_ids: [],
      group_assignment_error: null,
      group_assignment_completed_at: null,
      diagnostic: {
        ...(attempt.diagnostic ?? {}),
        retryable: true,
        retryReason: 'remote_account_absent_after_callback',
        classifiedAt: now,
        classifiedBy: 'five_phone_incident_recovery',
      },
    })
    .eq('id', attempt.id)
    .eq('organization_id', organizationId);
  if (attemptError) throw attemptError;

  await closeRelatedHistory(
    attempt,
    'failed',
    'remote_account_absent_after_callback',
    now,
  );
  retryable.push(attempt.id);
}

const finalAttempts = await requireData(
  supabase
    .from('zernio_connection_attempts')
    .select('id, status, worker_status, synced_count, zernio_account_ids, last_error_message, requested_group_id, group_assignment_status, group_assigned_profile_ids, diagnostic')
    .eq('organization_id', organizationId)
    .in('id', incidentAttemptIds),
  'Auditoria final dos attempts falhou.',
);

const recoveredAudit = finalAttempts.filter(
  (attempt) => attempt.diagnostic?.recoveredFromFivePhoneIncident === true,
);
const retryableAudit = finalAttempts.filter(
  (attempt) => attempt.diagnostic?.retryable === true,
);
if (recoveredAudit.length !== 2 || retryableAudit.length !== 3) {
  throw new Error(
    `Classificação final inválida: ${recoveredAudit.length} recuperados e ${retryableAudit.length} recuperáveis.`,
  );
}

const recoveredProfileIds = recovered.map((row) => row.profileId);
const memberships = await requireData(
  supabase
    .from('profile_group_members')
    .select('profile_id, group_id')
    .eq('organization_id', organizationId)
    .eq('group_id', group.id)
    .in('profile_id', recoveredProfileIds),
  'Auditoria das associações ao grupo falhou.',
);
if (memberships.length !== recoveredProfileIds.length) {
  throw new Error('Nem todos os perfis recuperados pertencem ao grupo dani.');
}

console.log(JSON.stringify({
  recovered,
  retryableAttempts: retryable,
  audit: {
    recoveredCount: recoveredAudit.length,
    retryableCount: retryableAudit.length,
    groupMembershipCount: memberships.length,
    attempts: finalAttempts,
  },
}, null, 2));

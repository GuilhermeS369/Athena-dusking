import { randomBytes, randomUUID } from 'node:crypto';

import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { confirmTwitterBulkReview, prepareTwitterBulkReview, type TwitterBulkRequest } from '../../lib/twitter/bulk-service';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  if (required('TWITTER_CANARY_CONFIRM') !== 'prepare-one-text-no-url') {
    throw new Error('Confirmação operacional inválida.');
  }
  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const delayMinutes = Number(process.env.TWITTER_CANARY_DELAY_MINUTES ?? '20');
  if (!Number.isInteger(delayMinutes) || delayMinutes < 10 || delayMinutes > 60) {
    throw new Error('Delay deve ficar entre 10 e 60 minutos.');
  }
  const admin = createSupabaseAdminClient();
  const [{ data: organization }, { data: membership }, { data: profiles, error: profileError }, programCount, itemCount] = await Promise.all([
    admin.from('organizations').select('id, name, created_by').eq('id', organizationId).is('deleted_at', null).single(),
    admin.from('organization_members').select('user_id, role').eq('organization_id', organizationId).eq('role', 'admin').order('joined_at').limit(1).single(),
    admin.from('twitter_profiles').select('id, status, can_post').eq('organization_id', organizationId).is('deleted_at', null).eq('status', 'active').eq('can_post', true),
    admin.from('twitter_programs').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    admin.from('twitter_publication_items').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
  ]);
  if (!organization || !membership || membership.role !== 'admin') throw new Error('Organização/admin canário inválido.');
  if (profileError || profiles?.length !== 1) throw new Error('É necessário exatamente um perfil X ativo para este canário.');
  if ((programCount.count ?? 0) !== 0 || (itemCount.count ?? 0) !== 0) {
    throw new Error('Já existem programas ou itens X; não criar outro canário automaticamente.');
  }

  process.env.TWITTER_REVIEW_TOKEN_SECRET ??= randomBytes(32).toString('base64url');
  const executeAt = new Date(Date.now() + delayMinutes * 60_000);
  executeAt.setUTCSeconds(0, 0);
  const uniqueStamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const content = `Canário técnico Athena X — teste de publicação isolada ${uniqueStamp}`;
  const request: TwitterBulkRequest = {
    profileIds: [profiles[0].id],
    texts: [content],
    mediaSets: [],
    schedule: { kind: 'interval', startsAt: executeAt.toISOString(), intervalMinutes: 1, durationMinutes: 0 },
  };

  const review = await prepareTwitterBulkReview(organizationId, request);
  if (review.totalRequested !== 1 || review.fundedCount !== 1 || review.unfundedCount !== 0 || review.reservedMicros !== 15_000) {
    throw new Error('Revisão do canário não produziu exatamente um slot financiado de 15.000 micros.');
  }
  const confirmed = await confirmTwitterBulkReview({
    organizationId,
    actorUserId: membership.user_id,
    request,
    reviewToken: review.reviewToken,
    idempotencyKey: `twitter-canary-text-${randomUUID()}`,
  }) as Record<string, unknown>;
  const programId = String(confirmed.programId ?? '');
  if (!programId) throw new Error('Confirmação não retornou program ID.');

  const [{ data: program }, { data: items }, { data: wallet }, { data: reservations }] = await Promise.all([
    admin.from('twitter_programs').select('status, funded_count, unfunded_count, reserved_micros').eq('id', programId).eq('organization_id', organizationId).single(),
    admin.from('twitter_publication_items').select('id, status, execute_at, category, amount_micros, attempt_count').eq('program_id', programId),
    admin.from('twitter_wallets').select('posted_balance_micros, reserved_micros, version').eq('organization_id', organizationId).single(),
    admin.from('twitter_wallet_reservations').select('initial_micros, remaining_micros, settled_micros, released_micros, status').eq('organization_id', organizationId).eq('source_id', programId),
  ]);
  const item = items?.[0];
  const reservation = reservations?.[0];
  const safe = {
    programId,
    itemId: item?.id,
    content,
    program,
    item,
    wallet,
    reservation,
  };
  const valid = program?.status === 'confirmed'
    && Number(program.funded_count) === 1
    && Number(program.unfunded_count) === 0
    && Number(program.reserved_micros) === 15_000
    && items?.length === 1
    && item?.status === 'ready'
    && item?.category === 'post_dm_create'
    && Number(item?.amount_micros) === 15_000
    && Number(item?.attempt_count) === 0
    && Number(wallet?.posted_balance_micros) === 12_000_000
    && Number(wallet?.reserved_micros) === 15_000
    && reservations?.length === 1
    && Number(reservation?.remaining_micros) === 15_000
    && Number(reservation?.settled_micros) === 0
    && Number(reservation?.released_micros) === 0
    && reservation?.status === 'open';
  if (!valid) throw new Error(`Invariantes pós-confirmação não atendidas: ${JSON.stringify(safe)}`);
  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});

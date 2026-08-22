import { createSupabaseAdminClient } from '../../lib/supabase/admin';
import { provisionTwitterZernioConnection } from '../../lib/twitter/zernio-connections';
import { syncTwitterProfiles } from '../../lib/twitter/zernio-profiles';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

async function main() {
  if (required('TWITTER_CANARY_CONFIRM') !== 'provision-pomodoro-x') {
    throw new Error('Confirmação operacional inválida.');
  }

  const organizationId = required('TWITTER_CANARY_ORGANIZATION_ID');
  const apiKey = required('TWITTER_CANARY_ZERNIO_API_KEY');
  const label = required('TWITTER_CANARY_CONNECTION_LABEL');
  const admin = createSupabaseAdminClient();

  const { data: organization, error: organizationError } = await admin
    .from('organizations')
    .select('id, name, created_by')
    .eq('id', organizationId)
    .is('deleted_at', null)
    .single();
  if (organizationError || !organization) throw new Error('Organização canário não encontrada.');

  const { data: membership, error: membershipError } = await admin
    .from('organization_members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', organization.created_by)
    .single();
  if (membershipError || membership?.role !== 'admin') {
    throw new Error('O criador da organização não possui papel admin válido.');
  }

  const provisioned = await provisionTwitterZernioConnection({
    organizationId,
    organizationName: organization.name,
    actorUserId: organization.created_by,
    label,
    apiKey,
  });
  const connectionId = String(provisioned.connection.id ?? '');
  if (!connectionId) throw new Error('Provisionamento não retornou connection ID.');

  const sync = await syncTwitterProfiles(organizationId, connectionId);
  const identityId = String(provisioned.connection.identity_id ?? provisioned.wallet.identityId ?? '');
  if (!identityId) throw new Error('Provisionamento não retornou identity ID.');

  const [walletResult, grantResult, ledgerResult, reservationResult, connectionResult, profilesResult] = await Promise.all([
    admin.from('twitter_wallets')
      .select('posted_balance_micros, reserved_micros, version')
      .eq('identity_id', identityId)
      .eq('organization_id', organizationId)
      .single(),
    admin.from('twitter_wallet_grants')
      .select('amount_micros', { count: 'exact' })
      .eq('identity_id', identityId),
    admin.from('twitter_wallet_ledger')
      .select('entry_kind, delta_micros')
      .eq('identity_id', identityId),
    admin.from('twitter_wallet_reservations')
      .select('id', { count: 'exact', head: true })
      .eq('identity_id', identityId),
    admin.from('twitter_connections')
      .select('status, analytics_enabled, inbox_enabled, last_sync_at')
      .eq('id', connectionId)
      .eq('organization_id', organizationId)
      .single(),
    admin.from('twitter_profiles')
      .select('status, account_tier, can_post, token_valid, needs_reconnect, twitter_user_id')
      .eq('organization_id', organizationId)
      .eq('current_connection_id', connectionId)
      .is('deleted_at', null),
  ]);

  const firstError = [walletResult, grantResult, ledgerResult, reservationResult, connectionResult, profilesResult]
    .find((result) => result.error)?.error;
  if (firstError) throw new Error(`Preflight pós-provisionamento falhou: ${firstError.message}`);

  const ledger = ledgerResult.data ?? [];
  const profiles = profilesResult.data ?? [];
  const wallet = walletResult.data;
  const grant = grantResult.data ?? [];
  const connection = connectionResult.data;
  const safe = {
    organization: organization.name,
    adoptedExistingProfile: provisioned.adoptedExistingProfile,
    sync: { seen: sync.seen, synced: sync.synced, markedOffline: sync.markedOffline },
    wallet: {
      postedBalanceMicros: Number(wallet?.posted_balance_micros ?? -1),
      reservedMicros: Number(wallet?.reserved_micros ?? -1),
      version: Number(wallet?.version ?? -1),
      grantCount: grantResult.count ?? grant.length,
      grantAmountMicros: Number(grant[0]?.amount_micros ?? -1),
      ledgerEntries: ledger.length,
      ledgerGrantMicros: ledger
        .filter((entry) => entry.entry_kind === 'grant')
        .reduce((total, entry) => total + Number(entry.delta_micros), 0),
      debitEntries: ledger.filter((entry) => entry.entry_kind === 'debit').length,
      openReservations: reservationResult.count ?? 0,
    },
    connection: {
      status: connection?.status,
      analyticsEnabled: connection?.analytics_enabled,
      inboxEnabled: connection?.inbox_enabled,
      synchronized: Boolean(connection?.last_sync_at),
    },
    profiles: profiles.map((profile) => ({
      status: profile.status,
      accountTier: profile.account_tier,
      effectiveCharacterLimit: profile.account_tier === 'premium' ? 25_000 : 280,
      canPost: profile.can_post,
      tokenValid: profile.token_valid,
      needsReconnect: profile.needs_reconnect,
      hasImmutableTwitterUserId: Boolean(profile.twitter_user_id),
    })),
  };

  const valid = safe.adoptedExistingProfile
    && safe.sync.seen === 1
    && safe.sync.synced === 1
    && safe.wallet.postedBalanceMicros === 12_000_000
    && safe.wallet.reservedMicros === 0
    && safe.wallet.grantCount === 1
    && safe.wallet.grantAmountMicros === 12_000_000
    && safe.wallet.debitEntries === 0
    && safe.wallet.openReservations === 0
    && safe.connection.analyticsEnabled === false
    && safe.connection.inboxEnabled === false
    && safe.profiles.length === 1
    && safe.profiles[0]?.effectiveCharacterLimit === 280;
  if (!valid) throw new Error(`Invariantes do canário não atendidas: ${JSON.stringify(safe)}`);

  process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha desconhecida.'}\n`);
  process.exitCode = 1;
});

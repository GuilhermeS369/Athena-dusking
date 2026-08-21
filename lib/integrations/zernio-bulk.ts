export type NamedZernioConnection = {
  id: string;
  label: string;
  instagram_profile_count: number | null;
  instagram_slot_limit: number | null;
  remote_instagram_account_count: number | null;
  remote_inventory_checked_at: string | null;
  remote_inventory_error_code: string | null;
  active_slot_reservation_count: number | null;
};

export type ZernioConnectionCapacity = {
  snapshotValid: boolean;
  reliableOccupancy: number;
  activeReservations: number;
  slotLimit: number;
  freeSlots: number;
};

export type NamedProfileGroup = {
  id: string;
  name: string;
};

export type ParsedZernioBulkTarget =
  | { kind: 'empty'; accountName: ''; groupName: null }
  | { kind: 'invalid_format'; accountName: string; groupName: string | null }
  | { kind: 'valid'; accountName: string; groupName: string | null };

export type ResolvedZernioBulkTarget = {
  parsed: ParsedZernioBulkTarget;
  connection: NamedZernioConnection | null;
  group: NamedProfileGroup | null;
  connectionStatus: 'empty' | 'found' | 'missing' | 'duplicate';
  groupStatus: 'not_requested' | 'found' | 'missing' | 'duplicate' | 'invalid';
  valid: boolean;
};

/**
 * Interpreta exatamente `conta` ou `conta;grupo`.
 * Os nomes não são normalizados: caixa, acentos e espaços fazem parte do valor.
 */
export function parseZernioBulkTarget(value: string): ParsedZernioBulkTarget {
  if (value.length === 0) return { kind: 'empty', accountName: '', groupName: null };

  const parts = value.split(';');
  const accountName = parts[0] ?? '';
  const groupName = parts.length >= 2 ? parts[1] : null;

  if (parts.length > 2 || accountName.length === 0 || groupName === '') {
    return { kind: 'invalid_format', accountName, groupName };
  }

  return { kind: 'valid', accountName, groupName };
}

export function resolveZernioBulkTarget(
  connections: NamedZernioConnection[],
  groups: NamedProfileGroup[],
  value: string,
): ResolvedZernioBulkTarget {
  const parsed = parseZernioBulkTarget(value);
  if (parsed.kind === 'empty') {
    return {
      parsed,
      connection: null,
      group: null,
      connectionStatus: 'empty',
      groupStatus: 'not_requested',
      valid: false,
    };
  }

  const connectionMatches = connections.filter((connection) => connection.label === parsed.accountName);
  const groupMatches = parsed.groupName === null
    ? []
    : groups.filter((group) => group.name === parsed.groupName);
  const connectionStatus = connectionMatches.length === 1
    ? 'found'
    : connectionMatches.length > 1
      ? 'duplicate'
      : 'missing';
  const groupStatus = parsed.kind === 'invalid_format'
    ? 'invalid'
    : parsed.groupName === null
      ? 'not_requested'
      : groupMatches.length === 1
        ? 'found'
        : groupMatches.length > 1
          ? 'duplicate'
          : 'missing';

  return {
    parsed,
    connection: connectionStatus === 'found' ? connectionMatches[0] : null,
    group: groupStatus === 'found' ? groupMatches[0] : null,
    connectionStatus,
    groupStatus,
    valid: parsed.kind === 'valid'
      && connectionStatus === 'found'
      && (groupStatus === 'not_requested' || groupStatus === 'found'),
  };
}

export function sortZernioConnectionsByProfileCount<T extends NamedZernioConnection>(connections: T[]) {
  return [...connections].sort((first, second) => {
    const countDifference = (first.instagram_profile_count ?? 0) - (second.instagram_profile_count ?? 0);
    if (countDifference !== 0) return countDifference;
    return first.label.localeCompare(second.label, 'pt-BR', { sensitivity: 'variant' });
  });
}

export function zernioConnectionCapacity(
  connection: NamedZernioConnection,
  _now = Date.now(),
): ZernioConnectionCapacity {
  const checkedAt = connection.remote_inventory_checked_at
    ? Date.parse(connection.remote_inventory_checked_at)
    : Number.NaN;
  const snapshotValid = connection.remote_instagram_account_count !== null
    && Number.isInteger(connection.remote_instagram_account_count)
    && connection.remote_instagram_account_count >= 0
    && !connection.remote_inventory_error_code
    && Number.isFinite(checkedAt);
  const localOccupancy = Math.max(0, connection.instagram_profile_count ?? 0);
  const remoteOccupancy = snapshotValid
    ? Math.max(0, connection.remote_instagram_account_count ?? 0)
    : 0;
  const reliableOccupancy = Math.max(localOccupancy, remoteOccupancy);
  const activeReservations = Math.max(0, connection.active_slot_reservation_count ?? 0);
  const slotLimit = Math.max(0, connection.instagram_slot_limit ?? 0);

  return {
    snapshotValid,
    reliableOccupancy,
    activeReservations,
    slotLimit,
    freeSlots: snapshotValid
      ? Math.max(0, slotLimit - reliableOccupancy - activeReservations)
      : 0,
  };
}

export function buildBulkZernioRows<T extends NamedZernioConnection>(
  connections: T[],
  requestedQuantity: number,
  groupName: string | null = null,
  now = Date.now(),
) {
  const requested = Math.max(0, Math.floor(Number.isFinite(requestedQuantity) ? requestedQuantity : 0));
  const rows: string[] = [];
  let availableSlots = 0;
  let fullConnections = 0;
  let availableConnections = 0;
  let unavailableSnapshotConnections = 0;

  sortZernioConnectionsByProfileCount(connections).forEach((connection) => {
    const capacity = zernioConnectionCapacity(connection, now);

    if (!capacity.snapshotValid) {
      unavailableSnapshotConnections += 1;
      return;
    }

    if (capacity.freeSlots === 0) {
      fullConnections += 1;
      return;
    }

    availableConnections += 1;
    availableSlots += capacity.freeSlots;

    for (let slot = 0; slot < capacity.freeSlots && rows.length < requested; slot += 1) {
      rows.push(groupName === null ? connection.label : `${connection.label};${groupName}`);
    }
  });

  return {
    rows,
    requested,
    availableSlots,
    availableConnections,
    fullConnections,
    unavailableSnapshotConnections,
    text: rows.join('\n'),
  };
}

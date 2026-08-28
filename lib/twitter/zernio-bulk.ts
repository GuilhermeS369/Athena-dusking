export type TwitterBulkConnection = {
  id: string;
  label: string;
  twitter_profile_count: number | null;
  twitter_slot_limit: number | null;
  remote_twitter_account_count: number | null;
  remote_inventory_checked_at: string | null;
  remote_inventory_error_code?: string | null;
  active_slot_reservation_count: number | null;
};

export type TwitterBulkGroup = { id: string; name: string };

export function parseTwitterZernioTarget(value: string) {
  if (!value.length) return { kind: 'empty' as const, connectionName: '', groupName: null };
  const parts = value.split(';');
  const connectionName = parts[0] ?? '';
  const groupName = parts.length === 2 ? parts[1] : null;
  if (parts.length > 2 || !connectionName || groupName === '') {
    return { kind: 'invalid' as const, connectionName, groupName };
  }
  return { kind: 'valid' as const, connectionName, groupName };
}

export function resolveTwitterZernioTarget(
  connections: TwitterBulkConnection[],
  groups: TwitterBulkGroup[],
  value: string,
) {
  const parsed = parseTwitterZernioTarget(value);
  const connectionMatches = connections.filter((connection) => connection.label === parsed.connectionName);
  const groupMatches = parsed.groupName === null ? [] : groups.filter((group) => group.name === parsed.groupName);
  const connection = connectionMatches.length === 1 ? connectionMatches[0] : null;
  const group = groupMatches.length === 1 ? groupMatches[0] : null;
  return {
    parsed,
    connection,
    group,
    connectionStatus: parsed.kind === 'empty' ? 'empty' as const : connectionMatches.length === 1 ? 'found' as const : connectionMatches.length > 1 ? 'duplicate' as const : 'missing' as const,
    groupStatus: parsed.groupName === null ? 'not_requested' as const : groupMatches.length === 1 ? 'found' as const : groupMatches.length > 1 ? 'duplicate' as const : 'missing' as const,
    valid: parsed.kind === 'valid' && connectionMatches.length === 1 && (parsed.groupName === null || groupMatches.length === 1),
  };
}

export function twitterZernioCapacity(connection: TwitterBulkConnection) {
  const checkedAt = connection.remote_inventory_checked_at ? Date.parse(connection.remote_inventory_checked_at) : Number.NaN;
  const snapshotValid = Number.isInteger(connection.remote_twitter_account_count)
    && Number(connection.remote_twitter_account_count) >= 0
    && Number.isFinite(checkedAt)
    && !connection.remote_inventory_error_code;
  const local = Math.max(0, Number(connection.twitter_profile_count ?? 0));
  const remote = snapshotValid ? Math.max(0, Number(connection.remote_twitter_account_count)) : 0;
  const occupied = Math.max(local, remote);
  const reservations = Math.max(0, Number(connection.active_slot_reservation_count ?? 0));
  const limit = Math.max(0, Number(connection.twitter_slot_limit ?? 0));
  return { snapshotValid, occupied, reservations, limit, freeSlots: snapshotValid ? Math.max(0, limit - occupied - reservations) : 0 };
}

export function sortTwitterZernioConnections<T extends TwitterBulkConnection>(connections: T[]) {
  return [...connections].sort((left, right) => {
    const occupancy = twitterZernioCapacity(left).occupied - twitterZernioCapacity(right).occupied;
    return occupancy || left.label.localeCompare(right.label, 'pt-BR', { sensitivity: 'variant' });
  });
}

export function buildTwitterZernioBulkRows(
  connections: TwitterBulkConnection[],
  requestedQuantity: number,
  groupName: string | null,
) {
  const requested = Math.max(0, Math.floor(Number.isFinite(requestedQuantity) ? requestedQuantity : 0));
  const rows: string[] = [];
  let availableSlots = 0;
  let availableConnections = 0;
  let fullConnections = 0;
  let unavailableConnections = 0;
  for (const connection of sortTwitterZernioConnections(connections)) {
    const capacity = twitterZernioCapacity(connection);
    if (!capacity.snapshotValid) { unavailableConnections += 1; continue; }
    if (!capacity.freeSlots) { fullConnections += 1; continue; }
    availableConnections += 1;
    availableSlots += capacity.freeSlots;
    for (let slot = 0; slot < capacity.freeSlots && rows.length < requested; slot += 1) {
      rows.push(groupName ? `${connection.label};${groupName}` : connection.label);
    }
  }
  return { requested, rows, text: rows.join('\n'), availableSlots, availableConnections, fullConnections, unavailableConnections };
}

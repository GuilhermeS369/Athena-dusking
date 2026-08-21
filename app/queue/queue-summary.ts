type QueueStatusEntry = { status: string };

const closedStatuses = new Set(['cancelled', 'removed', 'ignored']);
const activeStatuses = new Set(['waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended']);

export function operationalQueueMetric(items: QueueStatusEntry[]) {
  const operational = items.filter((item) => !closedStatuses.has(item.status));
  const completed = operational.filter((item) => item.status === 'published').length;
  const active = operational.filter((item) => activeStatuses.has(item.status)).length;
  const closed = items.length - operational.length;
  return {
    total: operational.length,
    completed,
    active,
    closed,
    progress: operational.length ? Math.round((completed / operational.length) * 100) : 0,
  };
}

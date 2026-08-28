export type TwitterHeartbeatPrevious = {
  worker_id?: string | null;
  mode?: string | null;
  last_seen_at?: string | null;
} | null;

export type TwitterHeartbeatDecision = {
  /** O `mode` é o único estado observável do worker; troca de PID não é transição. */
  modeChanged: boolean;
  /** Se falso, a linha do heartbeat é preservada e nenhuma tupla morta é gerada. */
  heartbeatDue: boolean;
};

/**
 * Decide se o heartbeat X precisa ser regravado e se houve transição de estado.
 *
 * O heartbeat é chaveado por `worker_name`, então as instâncias do cluster de
 * publicação compartilham a mesma linha e a regravam a cada ciclo. Como o
 * consumidor (failover da Vercel e rollout health) tolera
 * `TWITTER_FALLBACK_STALE_SECONDS`, escrever a cada ciclo só produz WAL e
 * disputa de linha.
 *
 * A decisão é conservadora em favor de escrever: qualquer dúvida sobre o
 * carimbo anterior — ausente, ilegível ou no futuro por desvio de relógio —
 * regrava, para nunca deixar o gate de failover cego.
 */
export function resolveTwitterHeartbeatWrite(input: {
  previous: TwitterHeartbeatPrevious;
  mode: string;
  nowMs: number;
  minWriteIntervalMs: number;
}): TwitterHeartbeatDecision {
  const { previous, mode, nowMs, minWriteIntervalMs } = input;
  const modeChanged = !previous || previous.mode !== mode;
  if (modeChanged) return { modeChanged: true, heartbeatDue: true };

  const lastSeenMs = previous?.last_seen_at ? Date.parse(previous.last_seen_at) : Number.NaN;
  if (!Number.isFinite(lastSeenMs)) return { modeChanged: false, heartbeatDue: true };

  const elapsedMs = nowMs - lastSeenMs;
  // Carimbo no futuro indica desvio de relógio: regrava em vez de silenciar.
  if (elapsedMs < 0) return { modeChanged: false, heartbeatDue: true };

  return { modeChanged: false, heartbeatDue: elapsedMs >= Math.max(0, minWriteIntervalMs) };
}

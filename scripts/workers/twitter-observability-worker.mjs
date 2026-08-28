import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

for (const envPath of [path.resolve(process.cwd(), '.env.worker'), path.resolve(process.cwd(), '.env.local')]) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

const baseUrl = process.env.TWITTER_WORKER_APP_BASE_URL;
const secret = process.env.TWITTER_OBSERVABILITY_WORKER_SECRET;
if (!baseUrl || !secret) throw new Error('TWITTER_WORKER_APP_BASE_URL e TWITTER_OBSERVABILITY_WORKER_SECRET são obrigatórios.');
const workerName = 'athena-twitter-observability-worker';
const workerId = `${workerName}-${os.hostname()}-${process.pid}`;
const intervalMs = Math.min(Math.max(Number.parseInt(process.env.TWITTER_OBSERVABILITY_POLL_INTERVAL_MS ?? '60000', 10), 30000), 3600000);
const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGTERM', () => { stopping = true; }); process.on('SIGINT', () => { stopping = true; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function post(path, body) { const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-twitter-worker-secret': secret }, body: JSON.stringify(body) }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`); return payload; }
async function cycle() { const heartbeat = await post('/api/internal/twitter-heartbeat', { workerName, workerId, metadata: { role: 'observability', pid: process.pid, hostname: os.hostname() } }); if (heartbeat.mode === 'stopped' || heartbeat.allowed === false) return { skipped: true, reason: heartbeat.mode === 'stopped' ? 'stopped' : 'breaker_open' }; return post('/api/internal/twitter-observability-maintenance', { workerId }); }
do { try { const result = await cycle(); console.info('[twitter:observability]', result); await post('/api/internal/twitter-circuit-breaker', { workerName, operation: 'success' }); } catch (error) { const message = error instanceof Error ? error.message : String(error); console.error('[twitter:observability]', message); try { await post('/api/internal/twitter-circuit-breaker', { workerName, operation: 'failure', reason: message }); } catch {} process.exitCode = 1; } if (once || stopping) break; await sleep(intervalMs); } while (!stopping);

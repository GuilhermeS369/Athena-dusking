import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const attemptId = process.argv[2];
if (!attemptId) {
  throw new Error('Informe o ID da tentativa que deve ser encerrada.');
}

function localWorkerEnvironment() {
  try {
    return Object.fromEntries(readFileSync('.env.worker.deploy', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')];
      }));
  } catch {
    return {};
  }
}

const env = { ...localWorkerEnvironment(), ...process.env };
const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceRoleKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios.');
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: attempt, error: readError } = await supabase
  .from('zernio_connection_attempts')
  .select('id, status, diagnostic, zernio_connection_intent_id')
  .eq('id', attemptId)
  .maybeSingle();

if (readError) throw readError;
if (!attempt) throw new Error('Tentativa Zernio não encontrada.');

if (['synced', 'empty', 'failed'].includes(attempt.status)) {
  console.info(JSON.stringify({ attemptId, status: attempt.status, changed: false }, null, 2));
  process.exit(0);
}

const diagnostic = attempt.diagnostic && typeof attempt.diagnostic === 'object' && !Array.isArray(attempt.diagnostic)
  ? attempt.diagnostic
  : {};
const now = new Date().toISOString();
const reason = 'restoration_oauth_abandoned_by_owner';

const { data: updated, error: updateError } = await supabase
  .from('zernio_connection_attempts')
  .update({
    status: 'failed',
    failed_at: now,
    last_error_message: 'Restauração OAuth cancelada administrativamente por decisão do proprietário; slot mantido vazio.',
    diagnostic: {
      ...diagnostic,
      administrativeClosure: {
        reason,
        closedAt: now,
        remoteRequestSent: false,
        userLoginRequired: false,
      },
    },
  })
  .eq('id', attemptId)
  .in('status', ['started', 'redirected', 'callback_received'])
  .select('id, status, failed_at')
  .maybeSingle();

if (updateError) throw updateError;
if (!updated) throw new Error('A tentativa mudou de estado durante o encerramento; nenhuma alteração foi aplicada.');

if (attempt.zernio_connection_intent_id) {
  const { error: intentError } = await supabase
    .from('zernio_connection_intents')
    .update({ status: 'failed' })
    .eq('id', attempt.zernio_connection_intent_id)
    .in('status', ['started', 'reserved', 'redirected', 'callback_received']);
  if (intentError) throw intentError;
}

console.info(JSON.stringify({
  attemptId: updated.id,
  status: updated.status,
  failedAt: updated.failed_at,
  changed: true,
  reason,
}, null, 2));

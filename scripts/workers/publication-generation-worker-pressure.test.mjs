// Fase 2 de plans/plano-correcao-deadlock-staging-criticaldelay-2026-08-28.md aplicada ao
// publication-generation-worker.mjs: antes desta correção, qualquer criticalDelay=true vetava
// incondicionalmente a aquisição de capacidade pesada (acquire_operational_heavy_workload_lease)
// — mesmo quando o atraso era só de itens que a própria geração em massa resolveria. Este teste
// prova, no nível de integração de tick(), que a geração agora só cede quando o atraso é de
// itens já aceitos pelo provedor.
//
// mode/dryRun são lidos de env no topo do módulo, então este arquivo configura o ambiente antes
// do import — por isso fica isolado de publication-generation-worker.test.mjs (modo padrão
// observe/dry-run). Cada teste importa o módulo com uma query string diferente para forçar uma
// instância nova (adaptiveBulkController é um singleton de módulo com cooldown próprio — sem
// isso, o cooldown de um teste vazaria para o próximo).

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PUBLICATION_GENERATION_WORKER_MODE = 'plan';
process.env.PUBLICATION_GENERATION_WORKER_DRY_RUN = 'false';
process.env.PUBLICATION_GENERATION_WORKER_ONCE = 'true';

function fakeSupabase(pressureSignal, { leaseToken = 'lease-token-1' } = {}) {
  const calls = [];
  return {
    calls,
    from() {
      return {
        select() { return this; },
        in() { return this; },
        order() { return this; },
        limit: async () => ({ data: [], error: null }),
      };
    },
    async rpc(name, parameters) {
      calls.push({ name, parameters });
      switch (name) {
        case 'get_bulk_rotation_worker_summary':
          return { data: { activePlans: 0, remainingPublications: 0 }, error: null };
        case 'claim_publication_generation_jobs':
          return { data: [], error: null };
        case 'claim_publication_generation_job_chunks':
          return { data: [], error: null };
        case 'get_publication_generation_pressure_signal':
          return { data: pressureSignal, error: null };
        case 'acquire_operational_heavy_workload_lease':
          return { data: leaseToken, error: null };
        case 'release_operational_heavy_workload_lease':
          return { data: null, error: null };
        case 'claim_bulk_rotation_generation_chunks':
          return { data: [], error: null };
        default:
          throw new Error(`RPC inesperada no fake de pressão: ${name}`);
      }
    },
  };
}

function leaseCalls(supabase) {
  return supabase.calls.filter((call) => call.name === 'acquire_operational_heavy_workload_lease');
}

test('geração cede quando o atraso crítico é de itens já aceitos, competindo por despacho', async () => {
  const { tick } = await import('./publication-generation-worker.mjs?pressure-case=accepted');
  const supabase = fakeSupabase({
    criticalDelay: true, overdueAccepted: true, overdueUnstarted: false,
    oldestDueAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
  });
  await tick(supabase);
  assert.equal(leaseCalls(supabase).length, 0, 'não deveria adquirir capacidade pesada com atraso de itens já aceitos');
});

test('geração NÃO cede quando o atraso crítico é só de itens não iniciados (regressão do deadlock)', async () => {
  const { tick } = await import('./publication-generation-worker.mjs?pressure-case=unstarted');
  const supabase = fakeSupabase({
    criticalDelay: true, overdueAccepted: false, overdueUnstarted: true,
    oldestDueAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
  });
  await tick(supabase);
  assert.equal(leaseCalls(supabase).length, 1, 'deveria seguir adquirindo capacidade pesada — só a geração resolve esse atraso');
});

test('sinal antigo sem a distinção (overdueAccepted ausente) mantém o comportamento anterior e cede', async () => {
  const { tick } = await import('./publication-generation-worker.mjs?pressure-case=legacy-signal');
  const supabase = fakeSupabase({ criticalDelay: true, oldestDueAt: new Date().toISOString() });
  await tick(supabase);
  assert.equal(leaseCalls(supabase).length, 0, 'sinal ambíguo deveria manter o comportamento conservador de ceder');
});

test('teto de segurança força a geração mesmo cedendo, depois do tempo limite', async () => {
  process.env.PUBLICATION_GENERATION_WORKER_CRITICAL_DELAY_FORCE_AFTER_MS = '60000';
  const { tick } = await import('./publication-generation-worker.mjs?pressure-case=force-through');
  delete process.env.PUBLICATION_GENERATION_WORKER_CRITICAL_DELAY_FORCE_AFTER_MS;

  const pressure = {
    criticalDelay: true, overdueAccepted: true, overdueUnstarted: false,
    oldestDueAt: new Date().toISOString(), checkedAt: new Date().toISOString(),
  };
  const firstSupabase = fakeSupabase(pressure);
  await tick(firstSupabase);
  assert.equal(leaseCalls(firstSupabase).length, 0, 'primeira observação deveria só começar a série de cessão');

  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 61_000;
    const forcedSupabase = fakeSupabase(pressure);
    await tick(forcedSupabase);
    assert.equal(leaseCalls(forcedSupabase).length, 1, 'depois do teto de tempo, deveria forçar uma tentativa mesmo com atraso crítico ativo');
  } finally {
    Date.now = originalNow;
  }
});

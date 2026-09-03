#!/usr/bin/env node

// Leitor ao vivo da saúde da fila de publicação.
//
// Nasceu do incidente de 02/09/2026, em que o painel parou de carregar e não
// havia como olhar a fila justamente porque a API de dados era o que estava
// quebrado. Por isso o sinal nº 1 aqui é a LATÊNCIA do PostgREST, e não uma
// métrica de negócio: foi o pool de conexões que estourou primeiro, e todo o
// resto foi consequência. Ver a seção 3-B de
// docs/fila-de-publicacao-mapa-de-controles.md.
//
// A chave de serviço fica no servidor. O navegador recebe só números agregados,
// nunca credencial — é por isso que isto é um servidor local e não uma página
// estática batendo direto no Supabase.
//
// Todas as consultas são `head: true` com `count: 'exact'`: contam no banco e
// não devolvem linha nenhuma, então o teto de linhas do PostgREST não se aplica
// e o custo por ciclo é baixo o bastante para rodar de 10 em 10 segundos.

import fs from 'node:fs';
import http from 'node:http';
import { createClient } from '@supabase/supabase-js';

for (const filePath of ['.env.local', '.env.worker']) {
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0 || line.trim().startsWith('#')) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key]) continue;
    process.env[key] = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

const supabase = createClient(
  requiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
  requiredEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const PORT = Number(process.env.QUEUE_MONITOR_PORT ?? 4599);

/** Teto do pool do PostgREST medido no incidente de 02/09. */
const POOL_CEILING = 41;

async function count(build) {
  const { count: total, error } = await build(
    supabase.from('publication_items').select('*', { count: 'exact', head: true }),
  );
  if (error) throw error;
  return total ?? 0;
}

async function collect() {
  const startedAt = Date.now();
  const now = new Date();
  const iso = (date) => date.toISOString();
  const minutesFromNow = (minutes) => new Date(now.getTime() + minutes * 60_000);

  // Sonda de latência: a consulta mais barata possível. Durante o incidente esta
  // chamada passou de milissegundos para "sem resposta em 3 minutos", muito
  // antes de qualquer número de negócio denunciar alguma coisa.
  const probeStartedAt = Date.now();
  const { error: probeError } = await supabase
    .from('organizations')
    .select('id', { count: 'exact', head: true });
  const probeMs = Date.now() - probeStartedAt;

  const active = ['waiting', 'ready', 'preparing', 'publishing'];

  const [
    backlog,
    inFlight,
    publishedLastHour,
    failedLastHour,
    dispatcherErrors,
    dueNextHour,
  ] = await Promise.all([
    // Vencido e ainda não publicado: o número que define se a fila está atrasada.
    count((q) => q.in('status', ['waiting', 'ready']).lte('execute_at', iso(now))),
    count((q) => q.in('status', ['preparing', 'publishing'])),
    count((q) => q.eq('status', 'published').gte('published_at', iso(minutesFromNow(-60)))),
    count((q) => q.eq('status', 'failed').gte('updated_at', iso(minutesFromNow(-60)))),
    // A assinatura do incidente de 31/08. Qualquer ocorrência é alarme.
    count((q) => q
      .eq('last_error_code', 'dispatcher_unexpected_error')
      .gte('updated_at', iso(minutesFromNow(-60)))),
    count((q) => q
      .in('status', active)
      .gt('execute_at', iso(now))
      .lte('execute_at', iso(minutesFromNow(60)))),
  ]);

  return {
    checkedAt: now.toISOString(),
    collectMs: Date.now() - startedAt,
    probeMs,
    probeError: probeError?.message ?? null,
    poolCeiling: POOL_CEILING,
    backlog,
    inFlight,
    publishedLastHour,
    failedLastHour,
    dispatcherErrors,
    dueNextHour,
  };
}

/**
 * O veredito é deliberadamente conservador com a latência: foi o sinal que
 * chegou primeiro no incidente e o único que, sozinho, já significa queda.
 */
function verdict(snapshot) {
  if (snapshot.probeError) return { level: 'critico', label: 'API DE DADOS FORA' };
  if (snapshot.dispatcherErrors > 0) return { level: 'critico', label: 'ERRO DE DESPACHANTE' };
  if (snapshot.probeMs > 3000) return { level: 'critico', label: 'BANCO SEM RESPOSTA' };
  if (snapshot.probeMs > 800) return { level: 'atencao', label: 'BANCO LENTO' };
  if (snapshot.backlog > 1500) return { level: 'atencao', label: 'BACKLOG ALTO' };
  if (snapshot.failedLastHour > 50) return { level: 'atencao', label: 'FALHAS ACIMA DO NORMAL' };
  return { level: 'ok', label: 'SAUDAVEL' };
}

const PAGE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fila de publicação — ao vivo</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --card:#161b22; --line:#30363d;
          --fg:#e6edf3; --dim:#8b949e; --ok:#3fb950; --warn:#d29922; --crit:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-monospace, "Cascadia Code", Menlo, monospace; }
  header { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:18px; }
  h1 { font-size:15px; margin:0; font-weight:600; letter-spacing:.02em; }
  #verdict { padding:5px 14px; border-radius:999px; font-weight:700; font-size:13px; letter-spacing:.04em; }
  .ok{background:rgba(63,185,80,.15);color:var(--ok);border:1px solid rgba(63,185,80,.4)}
  .atencao{background:rgba(210,153,34,.15);color:var(--warn);border:1px solid rgba(210,153,34,.4)}
  .critico{background:rgba(248,81,73,.15);color:var(--crit);border:1px solid rgba(248,81,73,.5)}
  .meta { color:var(--dim); font-size:12px; margin-left:auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
  .card h2 { margin:0 0 8px; font-size:11px; font-weight:600; color:var(--dim);
             text-transform:uppercase; letter-spacing:.07em; }
  .value { font-size:30px; font-weight:700; font-variant-numeric:tabular-nums; line-height:1.1; }
  .hint { color:var(--dim); font-size:11px; margin-top:6px; }
  .v-ok{color:var(--ok)} .v-warn{color:var(--warn)} .v-crit{color:var(--crit)}
  #spark { margin-top:16px; background:var(--card); border:1px solid var(--line);
           border-radius:8px; padding:14px 16px; }
  #spark h2 { margin:0 0 10px; font-size:11px; color:var(--dim);
              text-transform:uppercase; letter-spacing:.07em; font-weight:600; }
  svg { width:100%; height:70px; display:block; }
  footer { color:var(--dim); font-size:11px; margin-top:16px; line-height:1.7; }
</style></head><body>
<header>
  <h1>Fila de publicação</h1>
  <span id="verdict" class="ok">…</span>
  <span class="meta" id="meta">conectando…</span>
</header>
<div class="grid">
  <div class="card"><h2>Latência do banco</h2><div class="value" id="probe">–</div>
    <div class="hint">sonda trivial no PostgREST — o sinal que caiu primeiro em 02/09</div></div>
  <div class="card"><h2>Vencidos na fila</h2><div class="value" id="backlog">–</div>
    <div class="hint">passaram do horário e ainda não saíram</div></div>
  <div class="card"><h2>Em voo</h2><div class="value" id="inflight">–</div>
    <div class="hint">preparando ou publicando agora</div></div>
  <div class="card"><h2>Publicados / 1h</h2><div class="value" id="published">–</div>
    <div class="hint">normal: 2.500–3.500 por hora</div></div>
  <div class="card"><h2>Falhas / 1h</h2><div class="value" id="failed">–</div>
    <div class="hint" id="dispatcherHint">erro de despachante: 0</div></div>
  <div class="card"><h2>Próxima hora</h2><div class="value" id="due">–</div>
    <div class="hint">agendados para os próximos 60 min</div></div>
</div>
<div id="spark"><h2>Vencidos na fila — últimos ciclos</h2><svg id="chart" viewBox="0 0 600 70" preserveAspectRatio="none"></svg></div>
<footer id="foot"></footer>
<script>
const history = [];
function paint(id, value) { document.getElementById(id).textContent = value; }
function tone(id, level) {
  const el = document.getElementById(id);
  el.classList.remove('v-ok','v-warn','v-crit');
  if (level) el.classList.add(level);
}
function chart() {
  const svg = document.getElementById('chart');
  if (history.length < 2) { svg.innerHTML = ''; return; }
  const max = Math.max(...history, 10);
  const step = 600 / (history.length - 1);
  const points = history.map((v, i) => (i * step).toFixed(1) + ',' + (68 - (v / max) * 62).toFixed(1)).join(' ');
  // O rótulo vai embaixo: no ciclo em que o backlog é o próprio pico, a linha
  // encosta no topo e passaria por cima dele.
  svg.innerHTML =
    '<polyline points="' + points + '" fill="none" stroke="#58a6ff" stroke-width="2" vector-effect="non-scaling-stroke"/>' +
    '<text x="4" y="66" fill="#8b949e" font-size="10">pico ' + max + '  ·  agora ' + history[history.length - 1] + '</text>';
}
async function tick() {
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' });
    const d = await res.json();
    if (d.error) { document.getElementById('meta').textContent = 'erro: ' + d.error; return; }

    const v = document.getElementById('verdict');
    v.textContent = d.verdict.label;
    v.className = d.verdict.level;

    paint('probe', d.probeError ? 'FORA' : d.probeMs + ' ms');
    tone('probe', d.probeError || d.probeMs > 3000 ? 'v-crit' : d.probeMs > 800 ? 'v-warn' : 'v-ok');

    paint('backlog', d.backlog.toLocaleString('pt-BR'));
    tone('backlog', d.backlog > 1500 ? 'v-warn' : d.backlog > 4000 ? 'v-crit' : null);

    paint('inflight', d.inFlight.toLocaleString('pt-BR'));
    paint('published', d.publishedLastHour.toLocaleString('pt-BR'));

    paint('failed', d.failedLastHour.toLocaleString('pt-BR'));
    tone('failed', d.dispatcherErrors > 0 ? 'v-crit' : d.failedLastHour > 50 ? 'v-warn' : null);
    document.getElementById('dispatcherHint').textContent =
      'erro de despachante: ' + d.dispatcherErrors + (d.dispatcherErrors > 0 ? '  ← ALARME' : '');

    paint('due', d.dueNextHour.toLocaleString('pt-BR'));

    history.push(d.backlog);
    if (history.length > 120) history.shift();
    chart();

    document.getElementById('meta').textContent =
      new Date(d.checkedAt).toLocaleTimeString('pt-BR') + '  ·  coleta ' + d.collectMs + ' ms';
    document.getElementById('foot').textContent =
      'Atualiza a cada 10 s. Erro de despachante é a assinatura do incidente de 31/08 (3.315 publicações perdidas). ' +
      'Latência acima de 3 s é a assinatura do de 02/09 (pool de ' + d.poolCeiling + ' conexões esgotado).';
  } catch (err) {
    document.getElementById('meta').textContent = 'sem resposta do monitor: ' + err.message;
  }
}
tick(); setInterval(tick, 10000);
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  if (request.url?.startsWith('/api/snapshot')) {
    try {
      const snapshot = await collect();
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ ...snapshot, verdict: verdict(snapshot) }));
    } catch (error) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(PAGE);
});

server.listen(PORT, () => {
  console.log(`[queue-health-monitor] http://localhost:${PORT}`);
});

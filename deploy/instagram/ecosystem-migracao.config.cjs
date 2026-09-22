// Processos PM2 da VPS NOVA de publicacao (srv2000866, 76.13.238.104), criada em
// 22/09/2026 porque a Meta passou a descartar toda legenda vinda do IP da VPS antiga
// (erro 4/2207051 na foto; no reel publica sem a legenda e sem erro).
//
// Durante a migracao as duas maquinas publicam ao mesmo tempo, entao os ids aqui sao
// 6 a 9 -- nunca repetir um id que ainda esteja vivo na outra VPS: ao subir, o worker
// libera o staging do PROPRIO id, e isso soltaria itens que o processo vivo ainda tem
// no spool. O prefixo `athena-vps-` fica: a Vercel decide se assume o despacho olhando
// heartbeat com esse prefixo.
//
// O publicador 1 (preparacao + staging + direto) NAO esta aqui: ele sobe por ultimo,
// pelo ecosystem.config.cjs de sempre, com o id `athena-vps-publication-1`, e so
// depois que o processo da VPS antiga com esse id estiver parado.
//
// Unica diferenca de conteudo para o arquivo de sempre: log com carimbo de hora
// (pendencia da secao 12 do mestre -- na VPS antiga o log do PM2 nao tem hora).
const cwd = '/opt/athena-worker';

function npmWorker(name, script, env = {}) {
  return {
    name,
    cwd,
    script: 'npm',
    args: `run ${script}`,
    interpreter: 'none',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 20,
    restart_delay: 5000,
    kill_timeout: 15000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    env: { NODE_ENV: 'production', ...env },
  };
}

function publicadorDireto(numero) {
  return npmWorker(`athena-publication-worker-${numero}`, 'worker:publication', {
    PUBLICATION_WORKER_ID: `athena-vps-publication-${numero}`,
    PUBLICATION_WORKER_MODE: 'direct',
    PUBLICATION_WORKER_PREPARATION_ENABLED: 'false',
    PUBLICATION_WORKER_STAGING_ENABLED: 'false',
    PUBLICATION_WORKER_SLIDING_WINDOW: 'true',
    PUBLICATION_WORKER_VIDEO_VARIANTS: 'true',
  });
}

module.exports = {
  apps: [
    publicadorDireto(6),
    publicadorDireto(7),
    publicadorDireto(8),
    publicadorDireto(9),
  ],
};

// Processos PM2 do Instagram na VPS (/opt/athena-worker), versionados em 07/09/2026.
//
// Ate esta data os processos so existiam na VPS (criados a mao com `pm2 start`), e o
// `pm2 save` era a unica memoria deles. Este arquivo e a receita para recriar a VPS
// ou um processo, e a fonte da verdade dos envs por processo -- o PM2 guarda o env de
// cada processo e ignora o `.env.worker` para chaves que ja tem, entao mudar um teto
// dos publicadores 2/3 e mudar AQUI e dar `pm2 restart <nome> --update-env`.
//
// Uso na VPS:
//   pm2 start deploy/instagram/ecosystem.config.cjs            (todos)
//   pm2 start deploy/instagram/ecosystem.config.cjs --only athena-publication-worker-2
//   pm2 save
//
// Os valores de teto vivem em /opt/athena-worker/.env.worker (secao 4 do documento
// mestre); aqui so entram os overrides POR PROCESSO. Nada do Twitter/X: modulo
// desligado por decisao do dono em 07/09/2026.
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
    env: { NODE_ENV: 'production', ...env },
  };
}

module.exports = {
  apps: [
    // Publicador 1: preparacao, staging (spool) e despacho direto.
    npmWorker('athena-publication-worker', 'worker:publication', {
      PUBLICATION_WORKER_ID: 'athena-vps-publication-1',
    }),
    // Publicadores 2 a 5: so caminho direto. Ligam pela conta da secao 8.3 do mestre.
    npmWorker('athena-publication-worker-2', 'worker:publication', {
      PUBLICATION_WORKER_ID: 'athena-vps-publication-2',
      PUBLICATION_WORKER_MODE: 'direct',
      PUBLICATION_WORKER_PREPARATION_ENABLED: 'false',
      PUBLICATION_WORKER_STAGING_ENABLED: 'false',
      // Janela deslizante ligada em 17/09/2026 (2o e 3o processos, decisao do dono
      // depois do veredito do canario). Ver docs/fila-de-publicacao-MASTER.md, secao 4.
      PUBLICATION_WORKER_SLIDING_WINDOW: 'true',
    }),
    npmWorker('athena-publication-worker-3', 'worker:publication', {
      PUBLICATION_WORKER_ID: 'athena-vps-publication-3',
      PUBLICATION_WORKER_MODE: 'direct',
      PUBLICATION_WORKER_PREPARATION_ENABLED: 'false',
      PUBLICATION_WORKER_STAGING_ENABLED: 'false',
      PUBLICATION_WORKER_SLIDING_WINDOW: 'true',
    }),
    // Publicador 4: so caminho direto, ligado em 12/09/2026. O bloco das 07:00 BRT
    // (500-680 posts num intervalo de 5 min) passava da conta de 3 publicadores:
    // p90 de 296 s e reels encerrados por atraso em 11 e 12/09. Secao 8.3 do mestre.
    npmWorker('athena-publication-worker-4', 'worker:publication', {
      PUBLICATION_WORKER_ID: 'athena-vps-publication-4',
      PUBLICATION_WORKER_MODE: 'direct',
      PUBLICATION_WORKER_PREPARATION_ENABLED: 'false',
      PUBLICATION_WORKER_STAGING_ENABLED: 'false',
    }),
    // Publicador 5: so caminho direto, ligado em 15/09/2026 02:3xZ. Motivo: o bloco das
    // 07:00 BRT de 15/09 traz reels em quatro intervalos seguidos (298/488/549/313 em
    // 5 min cada); com 4 processos a capacidade sustentada e ~545 por 5 min e o reel
    // encosta no corte de 300 s quando um bloco pesado chega em cima do anterior.
    npmWorker('athena-publication-worker-5', 'worker:publication', {
      PUBLICATION_WORKER_ID: 'athena-vps-publication-5',
      PUBLICATION_WORKER_MODE: 'direct',
      PUBLICATION_WORKER_PREPARATION_ENABLED: 'false',
      PUBLICATION_WORKER_STAGING_ENABLED: 'false',
      // Canario da janela deslizante (16/09/2026): so este processo. Ver
      // docs/fila-de-publicacao-MASTER.md, secao 4 (freios) e 12 (o que medir).
      PUBLICATION_WORKER_SLIDING_WINDOW: 'true',
    }),
    npmWorker('athena-generation-worker', 'worker:publication-generation'),
    npmWorker('athena-queue-summary-worker', 'worker:queue-summary'),
    // Fila de cancelamento (migration 428): drena as operacoes de cancelamento em
    // massa, uma etapa por vez, e invalida o resumo ao concluir. Ligado em 14/09/2026.
    npmWorker('athena-cancellation-worker', 'worker:publication-cancellation'),
    npmWorker('athena-profile-analytics-worker', 'worker:profile-analytics'),
    npmWorker('athena-media-maintenance-worker', 'worker:media-maintenance'),
    // Roda e sai; o PM2 o mostra como "stopped" entre passadas. Sem autorestart.
    { ...npmWorker('athena-meta-token-renewal', 'worker:meta-token-renewal:apply'), autorestart: false },
  ],
};

// Processos PM2 da VPS DE VARIANTES (`ssh athena-variantes`, 187.127.253.65,
// Hostinger KVM 4), criada em 20/09/2026. Maquina separada de proposito: nada
// aqui disputa nucleo, rede ou memoria com os cinco publicadores do Instagram,
// que continuam em deploy/instagram/ecosystem.config.cjs.
//
// So roda o worker de variantes de video (migration 436). Nenhum processo daqui
// publica, le token de perfil ou chama o claim da fila.
//
// Uso na VPS de variantes:
//   pm2 start deploy/variants/ecosystem.config.cjs
//   pm2 save
//
// Segredos e enderecos moram em /opt/athena-variants/.env.worker (nunca no git):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY  (token PROPRIO desta VPS:
//     leitura no bucket de midia; leitura/escrita/exclusao no de variantes),
//   R2_BUCKET_INSTAGRAM_MEDIA, R2_BUCKET_INSTAGRAM_VARIANTS.
const cwd = '/opt/athena-variants';

module.exports = {
  apps: [
    {
      name: 'athena-video-variant-worker',
      cwd,
      script: 'npm',
      args: 'run worker:video-variants',
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      // O ffmpeg de uma `light` leva ~8 s; 30 s deixa o lote em curso terminar.
      kill_timeout: 30000,
      // Os logs do PM2 da VPS dos publicadores nao tem carimbo de hora (pendencia
      // do mestre, secao 12). Aqui ja nasce com.
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      env: {
        NODE_ENV: 'production',
        VIDEO_VARIANT_WORKER_ID: 'athena-variants-1',
        // Maior que a janela de 24 h da preparacao (ver o cabecalho do worker).
        VIDEO_VARIANT_WORKER_LEAD_HOURS: '30',
        // Teto de conexoes do pool do Supabase que este processo pode ocupar.
        VIDEO_VARIANT_WORKER_DB_CONCURRENCY: '2',
        VIDEO_VARIANT_WORKER_CACHE_DIR: '/var/cache/athena-variants',
        VIDEO_VARIANT_WORKER_CACHE_MAX_GB: '60',
        // Franquia da KVM 4: 16 TB/mes. Avisa no heartbeat em 60% e 80%.
        VIDEO_VARIANT_WORKER_BANDWIDTH_QUOTA_TB: '16',
      },
    },
  ],
};

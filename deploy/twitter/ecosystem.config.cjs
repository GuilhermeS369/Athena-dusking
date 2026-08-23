const path = require('node:path');

const cwd = path.resolve(__dirname, '..', '..');
const script = path.join(cwd, 'scripts', 'workers', 'twitter-worker.mjs');

function worker(name, role) {
  return {
    name,
    cwd,
    script,
    args: `--role=${role}`,
    interpreter: 'node',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 5,
    restart_delay: 5000,
    kill_timeout: 10000,
    time: true,
    env: { NODE_ENV: 'production' },
  };
}

module.exports = {
  apps: [
    worker('athena-twitter-publication-worker', 'publication'),
    worker('athena-twitter-zernio-sync-worker', 'sync'),
    worker('athena-twitter-analytics-worker', 'analytics'),
    worker('athena-twitter-webhook-reconcile-worker', 'reconcile'),
  ],
};

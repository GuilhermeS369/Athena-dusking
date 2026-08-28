#!/usr/bin/env bash
set -euo pipefail

runtime_dir=/opt/athena-worker
worker_dir="$runtime_dir/scripts/workers"
backup_suffix="before-fase5-$(date -u +%Y%m%dT%H%M%SZ)"

pm2 stop athena-publication-worker
pm2 save

if [ -f "$worker_dir/publication-worker.mjs" ]; then
  cp -a "$worker_dir/publication-worker.mjs" "$worker_dir/publication-worker.mjs.$backup_suffix"
fi
if [ -f "$worker_dir/publication-direct-dispatch.mjs" ]; then
  cp -a "$worker_dir/publication-direct-dispatch.mjs" "$worker_dir/publication-direct-dispatch.mjs.$backup_suffix"
fi

install -m 644 /tmp/publication-worker.mjs "$worker_dir/publication-worker.mjs"
install -m 644 /tmp/publication-direct-dispatch.mjs "$worker_dir/publication-direct-dispatch.mjs"
install -m 644 /tmp/adaptive-bulk-controller.mjs "$worker_dir/adaptive-bulk-controller.mjs"

node --check "$worker_dir/publication-worker.mjs"
node --check "$worker_dir/publication-direct-dispatch.mjs"
node --check "$worker_dir/adaptive-bulk-controller.mjs"
node --check "$worker_dir/publication-dispatch-spool.mjs"

pm2 restart athena-publication-worker --update-env
pm2 save

printf 'BACKUP_SUFFIX=%s\n' "$backup_suffix"
sha256sum "$worker_dir/publication-worker.mjs" \
  "$worker_dir/publication-direct-dispatch.mjs" \
  "$worker_dir/adaptive-bulk-controller.mjs"
pm2 pid athena-publication-worker

#!/usr/bin/env bash
set -euo pipefail

runtime_dir=/opt/athena-worker
worker_dir="$runtime_dir/scripts/workers"
backup_suffix="before-pressure-fix-$(date -u +%Y%m%dT%H%M%SZ)"

pm2 stop athena-generation-worker
pm2 save

if [ -f "$worker_dir/publication-generation-worker.mjs" ]; then
  cp -a "$worker_dir/publication-generation-worker.mjs" "$worker_dir/publication-generation-worker.mjs.$backup_suffix"
fi

install -m 644 /tmp/publication-generation-worker.mjs "$worker_dir/publication-generation-worker.mjs"
install -m 644 /tmp/publication-pressure-signal.mjs "$worker_dir/publication-pressure-signal.mjs"

node --check "$worker_dir/publication-generation-worker.mjs"
node --check "$worker_dir/publication-pressure-signal.mjs"
node --check "$worker_dir/adaptive-bulk-controller.mjs"

# node --check só valida sintaxe; confirma resolução real dos imports antes de reiniciar
# o processo real (a lição do incidente do @aws-sdk/client-s3 mais cedo hoje).
(cd "$runtime_dir" && node --input-type=module -e "await import('$worker_dir/publication-generation-worker.mjs')") \
  || { echo 'FALHA: publication-generation-worker.mjs não conseguiu resolver seus imports.'; exit 1; }

pm2 restart athena-generation-worker --update-env
pm2 save

printf 'BACKUP_SUFFIX=%s\n' "$backup_suffix"
sha256sum "$worker_dir/publication-generation-worker.mjs" "$worker_dir/publication-pressure-signal.mjs"
pm2 pid athena-generation-worker

#!/usr/bin/env bash
set -euo pipefail

# Deploy final da Fase 5: publication-direct-dispatch.mjs já está correto e estável na
# VPS (deploy da outra sessão, import dinâmico de R2 + shouldStop preservado) — este
# script toca só nos dois arquivos que faltam, sem mexer no que já está funcionando.

runtime_dir=/opt/athena-worker
worker_dir="$runtime_dir/scripts/workers"
backup_suffix="before-fase5b-$(date -u +%Y%m%dT%H%M%SZ)"

pm2 stop athena-publication-worker
pm2 save

if [ -f "$worker_dir/publication-worker.mjs" ]; then
  cp -a "$worker_dir/publication-worker.mjs" "$worker_dir/publication-worker.mjs.$backup_suffix"
fi

install -m 644 /tmp/publication-worker.mjs "$worker_dir/publication-worker.mjs"
install -m 644 /tmp/adaptive-bulk-controller.mjs "$worker_dir/adaptive-bulk-controller.mjs"

node --check "$worker_dir/publication-worker.mjs"
node --check "$worker_dir/publication-direct-dispatch.mjs"
node --check "$worker_dir/adaptive-bulk-controller.mjs"
node --check "$worker_dir/publication-dispatch-spool.mjs"

# Confirma resolução real dos módulos (não só sintaxe) antes de reiniciar o processo real.
# node --check só valida sintaxe; isso teria pego o incidente anterior (pacote aws-sdk ausente).
(cd "$runtime_dir" && node --input-type=module -e "await import('$worker_dir/publication-worker.mjs')") \
  || { echo 'FALHA: publication-worker.mjs não conseguiu resolver seus imports.'; exit 1; }

pm2 restart athena-publication-worker --update-env
pm2 save

printf 'BACKUP_SUFFIX=%s\n' "$backup_suffix"
sha256sum "$worker_dir/publication-worker.mjs" \
  "$worker_dir/publication-direct-dispatch.mjs" \
  "$worker_dir/adaptive-bulk-controller.mjs"
pm2 pid athena-publication-worker

#!/usr/bin/env bash
# Publica a liberacao automatica de vaga Zernio no worker de publicacao.
# Muda um unico arquivo e nenhuma variavel de ambiente.
set -euo pipefail

runtime_dir=/opt/athena-worker
worker_dir="$runtime_dir/scripts/workers"
backup_suffix="before-liberacao-vaga-$(date -u +%Y%m%dT%H%M%SZ)"

test -f /tmp/publication-direct-dispatch.mjs

# Valida o candidato antes de parar qualquer coisa.
node --check /tmp/publication-direct-dispatch.mjs

pm2 stop athena-publication-worker
cp -a "$worker_dir/publication-direct-dispatch.mjs" "$worker_dir/publication-direct-dispatch.mjs.$backup_suffix"
install -m 644 /tmp/publication-direct-dispatch.mjs "$worker_dir/publication-direct-dispatch.mjs"

node --check "$worker_dir/publication-direct-dispatch.mjs"
node --check "$worker_dir/publication-worker.mjs"

pm2 restart athena-publication-worker --update-env
pm2 save

printf 'BACKUP_SUFFIX=%s\n' "$backup_suffix"
sha256sum "$worker_dir/publication-direct-dispatch.mjs"
pm2 pid athena-publication-worker

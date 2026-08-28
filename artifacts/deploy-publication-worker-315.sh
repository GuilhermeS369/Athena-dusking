#!/usr/bin/env bash
set -euo pipefail

runtime_dir=/opt/athena-worker
worker_dir="$runtime_dir/scripts/workers"
env_file="$runtime_dir/.env.worker"
spool_dir=/var/lib/athena-publication-spool
backup_suffix="before-315-$(date -u +%Y%m%dT%H%M%SZ)"

pm2 stop athena-publication-worker
pm2 save

install -d -m 700 "$spool_dir"
cp -a "$worker_dir/publication-worker.mjs" "$worker_dir/publication-worker.mjs.$backup_suffix"
cp -a "$worker_dir/publication-direct-dispatch.mjs" "$worker_dir/publication-direct-dispatch.mjs.$backup_suffix"
cp -a "$env_file" "$env_file.$backup_suffix"

install -m 644 /tmp/publication-worker.mjs "$worker_dir/publication-worker.mjs"
install -m 644 /tmp/publication-direct-dispatch.mjs "$worker_dir/publication-direct-dispatch.mjs"
install -m 644 /tmp/publication-dispatch-spool.mjs "$worker_dir/publication-dispatch-spool.mjs"

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$env_file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
  else
    printf '\n%s=%s' "$key" "$value" >> "$env_file"
  fi
}

set_env PUBLICATION_WORKER_STAGING_ENABLED true
set_env PUBLICATION_WORKER_STAGING_WINDOW_SECONDS 600
set_env PUBLICATION_WORKER_STAGING_LIMIT 100
set_env PUBLICATION_WORKER_STAGING_CONCURRENCY 4
set_env PUBLICATION_WORKER_STAGING_LEASE_SECONDS 1200
set_env PUBLICATION_WORKER_STAGING_DUE_GUARD_MS 60000
set_env PUBLICATION_WORKER_STAGED_DISPATCH_LIMIT 500
set_env PUBLICATION_WORKER_STAGED_DISPATCH_CONCURRENCY 32
set_env PUBLICATION_WORKER_STAGED_DISPATCH_LEASE_SECONDS 900
set_env PUBLICATION_WORKER_STAGED_MAX_PER_ORGANIZATION_PER_MINUTE 180
set_env PUBLICATION_WORKER_SPOOL_DIR "$spool_dir"
printf '\n' >> "$env_file"
chmod 600 "$env_file"

node --check "$worker_dir/publication-worker.mjs"
node --check "$worker_dir/publication-direct-dispatch.mjs"
node --check "$worker_dir/publication-dispatch-spool.mjs"

pm2 restart athena-publication-worker --update-env
pm2 save

printf 'BACKUP_SUFFIX=%s\n' "$backup_suffix"
sha256sum "$worker_dir/publication-worker.mjs" \
  "$worker_dir/publication-direct-dispatch.mjs" \
  "$worker_dir/publication-dispatch-spool.mjs"
pm2 pid athena-publication-worker

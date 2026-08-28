#!/usr/bin/env bash
set -euo pipefail

set -a
# shellcheck disable=SC1091
. /opt/athena-worker/.env.worker
set +a

if [[ -z "${PUBLICATION_WORKER_SECRET:-}" ]]; then
  echo "PUBLICATION_WORKER_SECRET ausente" >&2
  exit 1
fi

started_at="$(date +%s)"
set +e
response="$(curl --fail-with-body --silent --show-error --max-time 60 \
  --request POST \
  --header "x-worker-secret: ${PUBLICATION_WORKER_SECRET}" \
  https://pomodoro-theta-one-82.vercel.app/api/internal/instagram-observability-maintenance 2>&1)"
exit_code=$?
set -e
duration_seconds="$(( $(date +%s) - started_at ))"
printf '%s exit=%s duration_s=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$exit_code" "$duration_seconds" "$response"
exit "$exit_code"

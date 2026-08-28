#!/usr/bin/env bash
set -u

set -a
# shellcheck disable=SC1091
. /opt/athena-worker/.env.worker
set +a

if [[ -z "${PUBLICATION_WORKER_SECRET:-}" ]]; then
  echo "PUBLICATION_WORKER_SECRET ausente" >&2
  exit 1
fi

failures=0
run_source() {
  local kind="$1" source="$2" started_at response exit_code duration_seconds
  started_at="$(date +%s)"
  response="$(curl --fail-with-body --silent --show-error --max-time 45 \
    --request POST \
    --header "x-worker-secret: ${PUBLICATION_WORKER_SECRET}" \
    --header "content-type: application/json" \
    --data "{\"mode\":\"source\",\"kind\":\"${kind}\",\"source\":\"${source}\"}" \
    https://pomodoro-theta-one-82.vercel.app/api/internal/instagram-observability-maintenance 2>&1)"
  exit_code=$?
  duration_seconds="$(( $(date +%s) - started_at ))"
  printf '%s kind=%s source=%s exit=%s duration_s=%s %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$kind" "$source" "$exit_code" "$duration_seconds" "$response"
  if [[ "$exit_code" -ne 0 ]]; then failures=$((failures + 1)); fi
}

for source in partitions default_events event_rollups worker_rollups incident_actions resolved_incidents; do
  run_source hot "$source"
done
for source in publication_events worker_cycles sync_logs request_anomalies request_rollups; do
  run_source legacy "$source"
done

exit "$failures"

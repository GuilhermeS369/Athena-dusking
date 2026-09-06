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

# Teto de tempo da passada inteira. O flock do cron ja impede sobreposicao; o
# prazo existe para a passada de uma hora nunca invadir a proxima.
deadline=$(( $(date +%s) + ${RETENTION_DEADLINE_SECONDS:-1200} ))
# Lotes por fonte numa passada. Cada chamada apaga ate 500 linhas, e as fontes
# grandes recebem ~200 mil linhas/dia: uma chamada so por fonte nunca alcanca a
# entrada, e foi assim que `request_rollups` acumulou 18 dias com janela de 14.
max_rounds=${RETENTION_MAX_ROUNDS:-60}

run_source() {
  local kind="$1" source="$2" started_at response exit_code duration_seconds round=0
  while [[ "$round" -lt "$max_rounds" ]]; do
    if [[ "$(date +%s)" -ge "$deadline" ]]; then
      printf '%s kind=%s source=%s prazo_esgotado rounds=%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$kind" "$source" "$round"
      return
    fi
    round=$((round + 1))
    started_at="$(date +%s)"
    response="$(curl --fail-with-body --silent --show-error --max-time 45 \
      --request POST \
      --header "x-worker-secret: ${PUBLICATION_WORKER_SECRET}" \
      --header "content-type: application/json" \
      --data "{\"mode\":\"source\",\"kind\":\"${kind}\",\"source\":\"${source}\"}" \
      https://pomodoro-theta-one-82.vercel.app/api/internal/instagram-observability-maintenance 2>&1)"
    exit_code=$?
    duration_seconds="$(( $(date +%s) - started_at ))"
    printf '%s kind=%s source=%s round=%s exit=%s duration_s=%s %s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$kind" "$source" "$round" "$exit_code" "$duration_seconds" "$response"
    if [[ "$exit_code" -ne 0 ]]; then
      failures=$((failures + 1))
      return
    fi
    # A rota devolve 202 com `paused` quando a fila esta com atraso critico.
    # Insistir ai seria disputar I/O com a publicacao.
    case "$response" in
      *'"paused":true'*) return ;;
      *'"hasMore":true'*) ;;
      *) return ;;
    esac
  done
}

for source in partitions default_events event_rollups worker_rollups incident_actions incident_entities resolved_incidents; do
  run_source hot "$source"
done
# As quatro ultimas entraram na 401: eram tabelas de log sem poda nenhuma.
for source in publication_events worker_cycles sync_logs request_anomalies request_rollups media_delivery_attempts analytics_step_events analytics_item_events batch_terminal_outcomes; do
  run_source legacy "$source"
done

exit "$failures"

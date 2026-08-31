#!/usr/bin/env bash
# Analise diaria da tela de Recuperacao (Instagram).
#
# A rota processa UMA organizacao por chamada e devolve `done: true` quando nao
# ha mais nada pendente. O laco fica aqui, e nao dentro do banco, porque o
# statement_timeout de ~8s do PostgREST limita um statement de topo: a unica
# forma de fazer mais trabalho do que cabe nele e dividir em varias chamadas
# separadas, cada uma com seu proprio orcamento (licao da migration 324).
#
# Instalacao:
#   sudo install -m 0755 recovery-analysis-daily.sh /opt/athena-worker/bin/
#   sudo install -m 0644 recovery-analysis.cron /etc/cron.d/athena-recovery-analysis
set -u

set -a
# shellcheck disable=SC1091
. /opt/athena-worker/.env.worker
set +a

SECRET="${RECOVERY_ANALYSIS_WORKER_SECRET:-${PUBLICATION_WORKER_SECRET:-}}"
if [[ -z "${SECRET}" ]]; then
  echo "RECOVERY_ANALYSIS_WORKER_SECRET ou PUBLICATION_WORKER_SECRET ausente" >&2
  exit 1
fi

BASE_URL="${ATHENA_BASE_URL:-https://pomodoro-theta-one-82.vercel.app}"
ENDPOINT="${BASE_URL}/api/internal/recovery-analysis-dispatch"
# Teto de seguranca: cada chamada cobre ~45s de trabalho, entao 40 passadas sao
# muito mais do que qualquer organizacao real precisa. O teto existe para um bug
# de `remaining` nunca virar um laco eterno consumindo banco.
MAX_ATTEMPTS=40

failures=0
attempt=0

while (( attempt < MAX_ATTEMPTS )); do
  attempt=$((attempt + 1))
  started_at="$(date +%s)"
  response="$(curl --fail-with-body --silent --show-error --max-time 90 \
    --request POST \
    --header "x-worker-secret: ${SECRET}" \
    --header "content-type: application/json" \
    --data '{}' \
    "${ENDPOINT}" 2>&1)"
  exit_code=$?
  duration_seconds="$(( $(date +%s) - started_at ))"

  printf '%s attempt=%s exit=%s duration_s=%s %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$attempt" "$exit_code" "$duration_seconds" "$response"

  if [[ "$exit_code" -ne 0 ]]; then
    failures=$((failures + 1))
    break
  fi

  # Pressao critica na fila de publicacao: a analise cede a vez e tenta amanha.
  # Nao e falha — e a prioridade correta.
  if [[ "$response" == *'"paused":true'* ]]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pausado por pressao de publicacao; encerrando"
    break
  fi

  if [[ "$response" == *'"done":true'* ]]; then
    break
  fi
done

if (( attempt >= MAX_ATTEMPTS )); then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) teto de ${MAX_ATTEMPTS} tentativas atingido sem done=true" >&2
  failures=$((failures + 1))
fi

exit "$failures"

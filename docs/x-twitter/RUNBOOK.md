# Runbook operacional — módulo X/Twitter

Este arquivo documenta procedimentos, nunca credenciais. Valores secretos devem ser obtidos dos ambientes já configurados.

## Preflight local

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
git diff --check
npm test
npx tsc --noEmit
npm run build
```

Se branch/commit divergirem de `STATE.json`, registrar drift antes de qualquer mutação.

## Supabase

Projeto esperado: ref `hqwhumdumfmixxbvneae`.

```powershell
Get-Content supabase/.temp/project-ref
npx supabase migration list --linked
```

Antes de push, confirmar projeto e executar dry-run quando a versão do CLI suportar. Migrações são aditivas. Nunca apagar uma migração já remota; corrigir para frente.

Quando Docker/`pg_prove` não estiver disponível, executar um teste SQL transacional diretamente pela Management API:

```powershell
npx supabase db query --linked --file supabase/tests/<teste>.test.sql
```

O arquivo deve começar com `BEGIN`, terminar com `ROLLBACK` e a ausência de resíduos deve ser verificada depois.

## Vercel

Projeto esperado: `pomodoro`; validar `.vercel/project.json` antes do deploy. Criar preview, executar smoke tests e promover somente após gate. Registrar deployment ID/URL/status sem incluir tokens.

## VPS

- Acesso usa chave dedicada já instalada e `BatchMode=yes`.
- Host key deve permanecer validado; não usar `StrictHostKeyChecking=no`.
- Hostname esperado: `srv1881733`.
- Runtime dos workers: Node 22.

Antes de deploy, registrar `pm2 status`, disco, memória, release e hashes. Releases X devem ser extraídos em diretório novo e validado; reiniciar somente processos `athena-twitter-*`. Nunca executar exclusão recursiva sobre caminho não resolvido.

Processos planejados:

- `athena-twitter-publication-worker`
- `athena-twitter-zernio-sync-worker`
- `athena-twitter-analytics-worker`
- `athena-twitter-webhook-reconcile-worker`

Não instalar `athena-twitter-generation-worker`: a ADR-X-017 mantém a materialização financiada dentro da confirmação transacional.

## Ordem segura de deploy

1. migration aditiva;
2. Vercel preview e produção com flag X desligada;
3. worker X em dry-run;
4. shadow;
5. canário;
6. rollout.

### Fallback Vercel do X

- Endpoint exclusivo: `/api/internal/twitter-fallback-dispatch`.
- Manter `TWITTER_FALLBACK_ENABLED=false` e `TWITTER_FALLBACK_LIVE_ENABLED=false` fora de uma janela aprovada.
- Shadow exige `TWITTER_FALLBACK_ENABLED=true`, `TWITTER_PUBLICATION_WORKER_ENABLED=true` e `TWITTER_PUBLICATION_MODE=shadow`.
- Live exige adicionalmente `TWITTER_FALLBACK_LIVE_ENABLED=true`; nunca ativar antes dos gates de analytics, heartbeat stale e shadow.
- `TWITTER_FALLBACK_STALE_SECONDS` deve ficar entre 30 e 900; padrão 120.
- Antes de invocar: verificar heartbeat primário, circuit breaker, itens ready e holds.
- Depois: conferir claimed, attempts, ledger/holds, heartbeat `athena-twitter-vercel-fallback` e restaurar flags.
- Não adicionar o endpoint ao cron da Vercel antes do shadow e do gate final.

### Saúde read-only do rollout X

- Endpoint: `GET /api/internal/twitter-rollout-health`.
- Autorização: `x-twitter-worker-secret` ou Bearer com `TWITTER_ROLLOUT_HEALTH_SECRET`/`CRON_SECRET`; nunca registrar o valor.
- A rota não executa RPC nem mutação. Ela agrega somente filas, attempts, holds, wallets, breakers e heartbeats `twitter_*`.
- `TWITTER_ROLLOUT_HEALTH_STALE_SECONDS` deve ficar entre 30 e 900; padrão 120.
- `unhealthy`/HTTP 503: worker esperado stale, breaker aberto ou resultado/hold financeiro incerto.
- `degraded`/HTTP 200: fila pausada com módulo off ou HTTP 429 nas últimas 24 horas.
- Antes de cada promoção, exigir: flags esperadas, zero unknowns, zero breaker aberto e estado dos processos PM2 conferido separadamente.
- Validador seguro: `scripts/twitter/validate-preview-rollout-health.ps1`; ele rotaciona segredo efêmero de Preview, força todas as flags mutáveis para false, cria Preview e faz somente leitura.

### Gate do primeiro envio por conexão

- A supervisão contínua permanece em `GET /api/internal/twitter-rollout-health`; ela deve estar `ok` antes de confirmar o primeiro programa de uma conexão nova.
- A auditoria pontual é `scripts/twitter/audit-first-send-readiness.ts`. Ela consulta somente tabelas `twitter_*`, não cria programa, não altera saldo e não chama a Zernio.
- Para todas as conexões ativas, executar com as variáveis server-side locais já configuradas:

```powershell
npx tsx --env-file=.env.local scripts/twitter/audit-first-send-readiness.ts
```

- Para uma organização ou conexão específica, definir temporariamente `TWITTER_FIRST_SEND_ORGANIZATION_ID` e/ou `TWITTER_FIRST_SEND_CONNECTION_ID`; nunca documentar identificadores junto com credenciais.
- Estados retornados:
  - `awaiting_profile`: conexão existe, mas o sync ainda não entregou perfil ativo;
  - `ready_for_first_program`: perfil, carteira e workers prontos, sem primeiro programa;
  - `monitoring_first_send`: primeiro item criado ou em trânsito, ainda sem publicação confirmada;
  - `first_send_approved`: existe publicação confirmada, sem resultado financeiro incerto;
  - `blocked`: agir sobre os códigos em `blockers` antes de novo envio.
- Bloqueios mínimos: conexão inativa, carteira ausente/insuficiente, nenhum perfil publicável, `outcome_unknown`, heartbeat stale ou circuit breaker aberto.
- Executar uma vez após conectar/sincronizar, novamente após confirmar o primeiro programa e por fim após o item chegar a estado terminal. Não repetir envio cego para sair de `monitoring_first_send` ou `blocked`.
- Aprovação exige `first_send_approved`, health global `ok`, reserva da conexão sem `outcome_unknown` e saldo `reservedMicros` coerente com a fila restante.

### Segredos por papel

- Cada processo usa exclusivamente seu segredo: `TWITTER_PUBLICATION_WORKER_SECRET`, `TWITTER_SYNC_WORKER_SECRET`, `TWITTER_ANALYTICS_WORKER_SECRET` ou `TWITTER_RECONCILE_WORKER_SECRET`.
- Heartbeat e circuit breaker autenticam o segredo contra o `workerName`; um papel não pode operar como outro.
- Fallback e health usam `TWITTER_FALLBACK_WORKER_SECRET` e `TWITTER_ROLLOUT_HEALTH_SECRET`, sem reutilizar segredos dos workers.
- `scripts/twitter/configure-role-secrets.ps1` configura Production/Preview e atualiza atomicamente a VPS sem imprimir valores.
- `scripts/twitter/validate-preview-role-secrets.ps1` testa o pareamento com claims desligados e exige rejeição cruzada.
- O nome legado `TWITTER_WORKER_SECRET` não pode voltar ao código; removê-lo dos ambientes somente após deploy/release e one-shot aprovados.

### Kill switches por papel

- Flags: `TWITTER_PUBLICATION_WORKER_ENABLED`, `TWITTER_SYNC_WORKER_ENABLED`, `TWITTER_ANALYTICS_WORKER_ENABLED` e `TWITTER_RECONCILE_WORKER_ENABLED`.
- Analytics também exige `TWITTER_ANALYTICS_ENABLED=true`; publicação live exige os gates de modo/canário já documentados.
- A capability de sincronização periódica da Zernio exige adicionalmente `TWITTER_ZERNIO_ANALYTICS_SYNC_ENABLED=true`. Não confundir esse gate com as análises manuais; por padrão ele fica `false` e Inbox nunca é habilitado.
- O heartbeat é a autorização operacional do ciclo: modo `stopped` deve encerrar o executável antes de claim, recovery, mutação financeira ou chamada Zernio. Claims, reconcile e fallback reaplicam o gate global/canário mesmo quando chamados diretamente.
- Em deploy off/one-shot, exigir `stopped` para os quatro papéis e conferir zero mudança em fila, holds, attempts e ledger.

### Sync de perfis X

- O botão Sincronizar apenas cria `twitter_sync_jobs`; não faz leitura Zernio no request público.
- Claim/result exclusivos: `/api/internal/twitter-sync-claims` e `/api/internal/twitter-sync-results`, autenticados somente pelo segredo do papel sync.
- O worker usa lease de 900 segundos, concorrência 1 por conexão e limite de 500 contas por inventário; reaplica `analytics_enabled` do estado auditado e sempre força `inbox=false`.
- Antes de ativar `TWITTER_SYNC_WORKER_ENABLED`, exigir migrations até 242, release `a5edc6c049e1-20260822T235210Z` ou superior e fila inicialmente vazia.
- Kill switch durante job impede novos claims; o claim atual deve concluir ou expirar. Nunca apagar jobs para recuperar lease.

## Rollback

- desligar flags X;
- parar somente `athena-twitter-*`;
- reverter aplicação para deployment/release anterior documentado;
- preservar tabelas e ledger;
- usar migration corretiva aditiva se necessário;
- verificar imediatamente PM2/heartbeats do Instagram.

## Secrets e evidências

- Documentar nomes de variáveis, nunca valores.
- Sanitizar API keys, Authorization, cookies, payloads, captions e URLs assinadas.
- Evidência bruta fica em `artifacts/x-twitter/<timestamp>/`, ignorada pelo Git; documentação guarda apenas resumo, caminho e hash.

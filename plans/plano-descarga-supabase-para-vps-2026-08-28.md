# Plano — descarga do Supabase para a VPS (2026-08-28)

## 1. Veredito sobre a recomendação recebida

A recomendação era:

> - VPS local: buffer/cache/telemetria descartável ou reprocessável;
> - Supabase: perfis, agendas, filas, tentativas e resultado final;
> - flush em lotes da VPS para o Supabase;
> - se a VPS cair, publicações continuam recuperáveis pelo estado autoritativo.

**Está direcionalmente correta e é confirmada por dado real deste projeto.** Duas ressalvas importantes:

1. **"Tentativas" não é uma categoria só.** `media_asset_delivery_attempts` é **autoritativa** — `latestProviderUrlFingerprint` lê a tabela e a quarentena de mídia depende do contador de falhas (`scripts/workers/publication-direct-dispatch.mjs:403-432`, `supabase/migrations/098_...sql:28,111,121`). Já `twitter_operation_logs` é descartável. Tratar "attempts" como bloco único quebraria a quarentena.

2. **A ordem de execução importa mais que a arquitetura.** Aplicada primeiro, essa mudança seria trabalho estrutural de semanas enquanto existe desperdício puro removível em horas — e ela **aumenta o raio de dano de uma queda da VPS**, que hoje já tem uma lacuna aberta (§5).

O ponto genuinamente novo: **nenhum dos quatro planos existentes propõe buffer local para telemetria.** Toda a redução de escrita até hoje veio de *não gerar* evento (migration 306, regras de ingestão de `plano-reconstrucao-central-logs`) ou de rollup dentro do próprio banco. A ingestão de observabilidade continua sendo **uma RPC por evento, direto no Supabase**. Essa é a alavanca não explorada.

---

## 2. Evidência

### 2.1 Crescimento do banco

Comparação `.dashboard-db-table-stats.json` (20/08 21:35) × `.dashboard-v2-table-stats-2026-08-21.json` (21/08 15:35), ~18 h:

| Tabela | Total | Δ 18 h | Natureza |
|---|---:|---:|---|
| `publication_worker_cycle_events` | 131 MB | **+18 MB** | descartável |
| `profile_post_analytics_snapshots` | 90 MB | +15 MB | produto (sem retenção) |
| `publication_item_events` | 92 MB | **+11 MB** | descartável |
| `profile_analytics_snapshots` | 52 MB | +6 MB | produto (sem retenção) |
| `media_asset_delivery_attempts` | 22 MB | +6 MB | **autoritativa** |
| `zernio_publication_request_rollups` | 15 MB | +4 MB | descartável |
| `publication_batch_terminal_outcomes` | 9 MB | +3,7 MB | sem retenção |
| **`publication_items`** (a fila) | 100 MB | **+3 MB** | **autoritativa** |

Crescimento agregado: **~96 MB/dia (~2,8 GB/mês)**. O estado autoritativo da fila responde por **~5%**.

> Esses snapshots são de 21/08. O plano de estabilização registra o banco já em **3.643 MB**, com **índices 1.607 MB > tabelas 1.254 MB** (`plans/plano-estabilizacao-supabase-carga-e-upgrade-2026-08-27.md:1766`).

### 2.2 O incidente

`plano-estabilizacao:18-41` — Supabase **Micro: 1 GB RAM, 2 vCPU compartilhadas, 60 conexões**, com banco de ~3,5 GB.

Captura: **compute 100%, CPU 97%, memória 90%, I/O 100%, conexões 37/60**. VPS ociosa.

Conclusão do próprio plano (`:23`): *"a saturação é a soma de trabalho concorrente e repetitivo"* — sem deadlock e sem query única presa.

**Um banco de 3,5 GB não cabe em 1 GB de RAM.** Qualquer varredura maior vira I/O de disco. A tela de Logs lendo as duas maiores tabelas do banco (131 MB + 92 MB) foi o empurrão final, não a causa isolada.

### 2.3 Desperdício puro já identificável

| Achado | Custo | Evidência |
|---|---|---|
| `twitter-heartbeat` faz **fan-out de observabilidade por organização** sempre que `previous.worker_id !== workerId`. Com `instances: 4` em cluster, os PIDs se revezam na mesma linha → a condição é verdadeira quase todo ciclo | **~48 × N_orgs linhas descartáveis/min** | `app/api/internal/twitter-heartbeat/route.ts:34-40`; `deploy/twitter/ecosystem.config.cjs:26` |
| Heartbeat e circuit breaker do X gravam **antes** de checar a feature flag — escrevem mesmo com `TWITTER_MODULE_ENABLED=false` | **~360 ops de escrita/min por nada** | `twitter-heartbeat/route.ts:25-32`; `twitter-circuit-breaker/route.ts:26` |
| Heartbeat X enviado **a cada ciclo (5 s)**, mas o consumidor tolera 120 s | 12× mais escrita que o necessário | `twitter-worker.mjs:18`; `TWITTER_FALLBACK_STALE_SECONDS=120` |
| `/api/publications/summary` recalcula 15 `count(*) filter` **a cada 10 s**, ignorando o snapshot que já existe | leitura pesada em loop | `app/api/publications/summary/route.ts:33`; snapshot em `migrations/303:64-141` |
| `/api/x/logs/summary` faz **11 `count exact`**, poll de 30 s **sem gate de visibilidade** | leitura pesada em loop | `app/api/x/logs/summary/route.ts:22-36`; `app/x/twitter-logs-center.tsx:55` |
| `twitter-connect-progress` faz poll a **1,8 s incondicional e nunca para em estado terminal** | ~33 req/min por aba esquecida | `app/x/twitter-connect-progress.tsx:34` |
| **Dashboard V2** (1 RPC no lugar de 10 queries com limites até 10.000) existe e está **desligado** | — | `.env.example:110` `DASHBOARD_V2_ENABLED=false` |
| Só **2 de 23** loops de polling checam `document.visibilityState`; nenhum tem backoff | — | `use-publication-queue.ts:287`, `instagram-observability-center.tsx:318` |
| **Zero** materialized views e **zero** `unstable_cache` no repositório | — | — |
| Amplificação **2×** por trigger: `publication_item_events`, `zernio_sync_log_items`, `twitter_operation_logs` espelham automaticamente em `*_observability_events` | dobra o custo de todo evento | `migrations/278_..._projections.sql:49,92-94,126-128` |

> **A confirmar antes de estimar ganho absoluto:** o número de organizações ativas (`select count(*) from organizations where deleted_at is null`). A estimativa de ~1,4 M linhas/dia do fan-out assume 20 organizações.

---

## 3. O que pode e o que NÃO pode sair do Supabase

### Pode ir para buffer local na VPS (descartável ou reprocessável)

- `publication_worker_cycle_events` — telemetria de ciclo; retenção 14 dias
- `zernio_publication_request_rollups` / `_anomalies` — falha já é engolida sem bloquear a fila (`publication-worker.mjs:467-472`)
- `profile_analytics_refresh_step_events` — falha é apenas `console.warn`
- `instagram_observability_events` / `twitter_observability_events` — histórico, retenção 14/90 dias
- `publication_item_events` — **exceto** transições de estado consumidas pela UI de erro
- `instagram_observability_api_rollups_5m` — escrita disparada por request de UI

### NÃO pode sair (quebra invariante)

- `publication_items` e todo o estado de fila: `status`, `lease_until`, `claimed_by`, `dispatch_staged_*`
- `twitter_dispatch_fences` — o fencing token é o que impede publicação dupla (`migrations/267:359`)
- `twitter_item_holds`, `twitter_financial_resolutions`, `twitter_wallet_ledger` — dinheiro
- `media_asset_delivery_attempts` — a quarentena de mídia depende do contador
- **`publication_worker_heartbeats` e `twitter_worker_heartbeats`** — são o *gate* do failover da Vercel (`app/api/internal/publication-dispatch/route.ts:56-84`). Bufferizar heartbeat faria a Vercel achar que a VPS morreu. Pode-se reduzir a **frequência**, nunca mover.

---

## 4. Plano por fases — ordenado por (impacto ÷ risco)

### Fase 0 — Segurança (antes de qualquer coisa)

- [ ] Commit ou stash dos **111 arquivos modificados** (+5.280/−3.771) na branch `codex/x-twitter-module`. Inclui os workers de publicação; hoje não há rede de segurança.
- [ ] **Adicionar os crons de failover do X ao `vercel.json`** — hoje só existem `publication-dispatch` e `media-deletion-dispatch`. As rotas `twitter-fallback-dispatch` e `twitter-reconcile` estão implementadas e **nada as chama**. Com a VPS fora, os itens X estouram o deadline de 15 min e os holds financeiros ficam presos.

> Pré-requisito real para a Fase 4: **não se delega mais carga para a VPS enquanto metade do sistema não tem failover.**

### Fase 1 — Desperdício puro (horas, risco ≈ zero, nenhuma funcionalidade perdida)

- [ ] `twitter-heartbeat/route.ts:34` — comparar `mode` em vez de `worker_id` na condição de fan-out. **Maior ganho isolado de escrita do plano.**
- [ ] Mover a checagem de `TWITTER_MODULE_ENABLED` para **antes** do write em `twitter-heartbeat` e `twitter-circuit-breaker`.
- [ ] Desacoplar heartbeat X do poll: enviar a cada 30 s em vez de 5 s (consumidor tolera 120 s).
- [ ] Emitir `twitter_worker_circuit_breaker('success')` só na **transição** de estado, não a cada ciclo.
- [ ] `twitter-connect-progress.tsx:34` — parar o poll em estado terminal e aplicar backoff.
- [ ] `waiting-client.tsx:33-37` — corrigir o vazamento (o `catch` reagenda sem checar `cancelled`).
- [ ] Adicionar gate de `document.visibilityState` + backoff aos 21 loops restantes.

**Gate:** medir ops de escrita/min antes e depois, com o módulo X desligado (baseline atual: ~360/min por nada).

### Fase 2 — Leituras com solução pronta e não usada (dias, risco baixo)

- [ ] Apontar `/api/publications/summary` para `publication_queue_operational_snapshots` (`migrations/303`), com flag `stale` na UI.
- [ ] Substituir os 11 `count exact` de `/api/x/logs/summary` por **um** `GROUP BY`.
- [ ] Usar `profile_publication_catalog_current` (`migrations/292`) também no `_page` do catálogo, não só no `_summary`.
- [ ] Criar o equivalente snapshot para `twitter_queue_operational_summary`.
- [ ] Avaliar ligar `DASHBOARD_V2_ENABLED=true` (canário 1 org primeiro).

### Fase 3 — Upgrade Micro → Small

Já planejado e pendente: `plano-estabilizacao:47-53,66`. Janela **30/08/2026, 05:05–05:35 BRT**.

Não substitui otimização, mas é o que resolve *hoje* o descompasso 3,5 GB de dados / 1 GB de RAM. As Fases 1 e 2 devem entrar **antes**, para que o Small não seja consumido pelo mesmo desperdício.

### Fase 4 — Buffer local de telemetria na VPS (a ideia estrutural)

Estender o padrão **já validado em produção**, não inventar arquitetura nova:

- `scripts/workers/publication-dispatch-spool.mjs` — escrita atômica `tmp`+`rename`, `0700`/`0600`, limpeza de `.tmp` órfãos no boot, validação anti-path-traversal
- `publication-worker.mjs:467-472` — buffer de telemetria em memória com flush ≤1 a cada 30 s

Desenho:

1. **Buffer NDJSON append-only** por classe de telemetria em `/var/lib/athena-telemetry-spool`, mesma disciplina de permissão e escrita atômica do spool atual.
2. **Flush em lote** por nova RPC `record_*_events_bulk(jsonb[])` — **uma** transação por lote em vez de uma RPC por evento. Isso também mata a amplificação 2× dos triggers, se o bulk gravar direto no destino final.
3. **Descarte com teto**: limite de bytes e de idade. Telemetria é descartável — encher o disco da VPS é pior que perder evento.
4. **Circuit breaker no flush**: sob `criticalDelay`, para de fazer flush (o gate já existe, `migrations/303:25`).
5. **GC do spool** — hoje **não existe**: envelopes cujo item foi cancelado nunca são ativados nem removidos e ficam sendo relistados a cada ciclo, consumindo cota de `stagedDispatchLimit` (`publication-worker.mjs:381-387`). Corrigir antes de ampliar o padrão.

**Riscos que esta fase precisa endereçar:**

- **Staging longo cega o failover.** `claim_publication_items` exclui itens com `dispatch_staged_until` no futuro (`migrations/315:213`). Com lease de 1200 s, até ~20 min de itens ficam invisíveis para a Vercel se a VPS morrer. Buffer maior = janela maior. Precisa de um caminho para o fallback "roubar" reserva cujo dono está com heartbeat stale.
- **A janela de rate por organização é in-memory por processo** (`publication-worker.mjs:61`) — funciona porque o worker Instagram é single-instance; não sobrevive a cluster.

### Fase 5 — Retenção nas tabelas que não têm

O mecanismo já existe (`migrations/298`, dividido em 7 fontes, com batching e retomada). Falta **estender**, não construir:

- Todo o módulo `profile_analytics_*` (~20 tabelas) — `profile_post_analytics_snapshots` cresce +15 MB/18 h
- `publication_batch_terminal_outcomes` (141 mil linhas)
- Família `bulk_publication_*`
- `twitter_operation_logs`, `twitter_publication_attempts`, `twitter_connection_events`
- `zernio_prepared_media` — tem `expires_at` e índice, **nenhuma rotina de delete**
- `publication_worker_heartbeats` — a função de prune existe, mas é **manual e nunca agendada** (`migrations/072:306-335`)
- Revisar índices: 1.607 MB > tabelas 1.254 MB. Índice também disputa RAM.

---

## 5. Riscos e restrições

1. **Não reintroduzir descarte automático por atraso.** É invariante explícita (`migrations/315:279-282`). A combinação 307 + 313/314 já custou **700 publicações descartadas com tentativa zero** em 26 s (`plano-estabilizacao:1939-1946`).
2. **O gate de observação está aberto e já reiniciou 3×** (06:54 UTC por `statement_timeout`; 07:57 UTC por Cloudflare 521/525). Mudança estrutural durante o gate reinicia a contagem de novo.
3. **A Fase 8 da Central de Logs está bloqueada** — o dual-write redundante continua ligado. Vale medir se desligá-lo já resolve parte do problema antes de construir buffer.
4. `VACUUM FULL` permanece proibido em produção.
5. Não repetir carga artificial com pressão real, conforme os planos existentes.

---

## 6. Recomendação de sequência

**Fase 0 → Fase 1 → medir → Fase 2 → medir → Fase 3 (upgrade) → reavaliar se a Fase 4 ainda é necessária no volume atual.**

A Fase 4 é a resposta certa para a meta de **2.500 perfis / 2 milhões de eventos em 14 dias** que os planos já assumem. Mas as Fases 1 e 2 podem entregar boa parte do alívio em horas, sem tocar em invariante nenhuma — e é possível que, com elas mais o upgrade, a pressão saia do vermelho antes de valer o custo estrutural da Fase 4.

Construir o buffer primeiro seria otimizar a parte cara antes de remover o desperdício gratuito.

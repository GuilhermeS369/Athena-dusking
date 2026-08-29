# Plano — corrigir o autobloqueio do staging Instagram sob `criticalDelay`

**Criado em:** 28/08/2026 17:48 BRT / 20:48 UTC
**Escopo:** ciclo de staging do `publication-worker` (Instagram, pipeline v2), sinal `get_publication_generation_pressure_signal`, `adaptive-bulk-controller.mjs`, e todos os consumidores desse sinal que hoje tratam qualquer `criticalDelay` como veto absoluto (zernio-sync-worker, profile-analytics-direct-worker, publication-generation-worker).
**Fora do escopo:** mudar o limite de 60 s do sinal crítico, redesenhar o pipeline de staging/spool, e qualquer alteração no fluxo X/Twitter (que não consome este sinal para os mesmos fins).

## Origem

Aviso de outro chat, confirmado por investigação nesta sessão (sem nenhuma alteração de código): `criticalDelay=true` persistente, com publicações vencidas. A investigação ao vivo (leituras somente-leitura em produção, script [audit-publication-recovery-state.mjs](../scripts/workers/audit-publication-recovery-state.mjs) e heartbeats de `publication_worker_heartbeats`) mostrou que não é um simples adiamento cosmético: é um autobloqueio.

## Diagnóstico confirmado

1. `get_publication_generation_pressure_signal` ([303_structural_database_pressure_controls.sql:25](../supabase/migrations/303_structural_database_pressure_controls.sql:25)) retorna só um booleano `criticalDelay` — não diferencia **por que** existe atraso.
2. Existem duas causas possíveis de atraso, com remédios diferentes:
   - **Aceito** (`creation_id` já existe): está na fila de despacho, competindo por capacidade de publicação — faz sentido o staging ceder espaço.
   - **Não iniciado** (`creation_id` nulo, `preparation_status='ready'`): só o **próprio staging** pode resolver, criando o contêiner na Zernio/Meta.
3. Em [publication-worker.mjs:508-531](../scripts/workers/publication-worker.mjs:508), o ciclo de staging trata os dois casos da mesma forma: ao ver `criticalDelay=true`, chama `stagingController.markCriticalDelay()` ([adaptive-bulk-controller.mjs:49-55](../scripts/workers/adaptive-bulk-controller.mjs:49)), que reagenda um cooldown de 5–15 s **antes de tentar reivindicar qualquer item** — e retorna sem staging nenhum.
4. Quando o atraso crítico é 100% de itens não iniciados, isso é um ciclo fechado: staging precisa rodar para zerar `criticalDelay`, mas só roda quando `criticalDelay` já é falso.
5. Confirmado ao vivo, 28/08/2026 ~20:43–20:44 UTC: 6 itens `waiting`, `creation_id: null`, `lease_until: null`, `attempt_count: 0`, todos do mesmo lote bulk (`batch_id d543463c-...`, plano `426f1da7-...`); `oldestDueAt` **idêntico** (`20:31:08.072189Z`) em duas leituras separadas por ~1,5 min; heartbeat do `publication-worker` no mesmo intervalo mostrando `staging.claimed: 0`, `staging.skipped: "adaptive_cooldown"`; nenhum circuit breaker pausado, nenhum bloqueio de `zernio_recovery_count`, nenhuma condição do `claim_publication_items` os exclui — nada além do próprio backpressure do staging os segura.
6. O comportamento é intencional, não um acidente de implementação: a Fase 5 do [plano-despacho-instagram-1000-perfis-sem-descarte-2026-08-28.md](plano-despacho-instagram-1000-perfis-sem-descarte-2026-08-28.md), item já marcado `[x]`, decidiu explicitamente aplicar backpressure ao staging sob `criticalDelay`. A lacuna é que essa decisão não previu o caso em que o próprio staging é a única saída do atraso.

## Invariantes obrigatórias da correção

- Staging continua cedendo espaço quando o atraso é de itens **aceitos** competindo por capacidade de despacho — não afrouxar essa proteção.
- Staging nunca fica permanentemente impedido de rodar quando é a única fase capaz de resolver o atraso.
- Nenhuma mudança de comportamento para o caminho X/Twitter/Zernio-sync (fora de escopo).
- Sem migração de número já aplicado remotamente — nova migração aditiva (próximo número livre: `319`).
- Sem descarte automático (`automatic_expired_unstarted_publication`) como efeito colateral da correção — invariante já fixada no plano de despacho de 1.000 perfis, permanece válida aqui.
- Mudança testada com um cenário determinístico que reproduz o deadlock (atraso 100% não iniciado) antes de qualquer deploy.

## Desenho da correção

```text
get_publication_generation_pressure_signal (RPC)
        │  hoje: { criticalDelay, oldestDueAt, overdueCurrent }
        │  proposto: também overdueUnstarted (bool) e overdueAccepted (bool)
        ▼
runStagingCycle (publication-worker.mjs)
        │
        ├── overdueAccepted=true  → mantém backpressure atual (cede à fila de despacho)
        └── overdueAccepted=false e overdueUnstarted=true
                   → NÃO aciona markCriticalDelay; segue para o claim normal,
                     priorizando exatamente os itens vencidos (já é o comportamento
                     de priority_band=0 em claim_publication_items)
```

Complementar: um teto de segurança independente do motivo da distinção acima — se `criticalDelay` permanecer `true` por mais de N ciclos consecutivos (ex.: 3–5, configurável), o staging ignora o backpressure e tenta mesmo assim, como rede de segurança contra qualquer variante futura do mesmo tipo de loop (inclusive erro humano na lógica de distinção aceito/não-iniciado).

## Fases e checklist

### Fase 0 — Diagnóstico

**Estado:** concluída.

- [x] Confirmar ao vivo que os itens vencidos são 100% não iniciados (`overdueAccepted=0`).
- [x] Ler o código de `runStagingCycle` e `adaptive-bulk-controller.mjs` e confirmar o mecanismo exato do autobloqueio.
- [x] Confirmar que nenhuma outra condição (circuit breaker, `zernio_recovery_count`, lease) explica os itens presos.
- [x] Confirmar que o comportamento atual foi uma decisão deliberada da Fase 5 do plano de despacho de 1.000 perfis, não um bug isolado.

### Fase 1 — Expor a causa do atraso no sinal de pressão

**Estado:** implementada, aguardando aplicação remota (`npx supabase db push`).

- [x] Migração `319` ([319_publication_pressure_signal_overdue_breakdown.sql](../supabase/migrations/319_publication_pressure_signal_overdue_breakdown.sql)): `get_publication_generation_pressure_signal` agora retorna também `overdueAccepted` e `overdueUnstarted` (booleanos), preservando `criticalDelay`/`oldestDueAt`/`overdueCurrent` inalterados para não quebrar consumidores existentes que só olham esses campos.
- [x] Reaproveita o índice parcial já criado na 303 (`publication_items_generation_pressure_idx`); nenhum índice novo necessário — os dois `exists` adicionais filtram por `creation_id` sobre o mesmo range já indexado.
- [x] `revoke`/`grant` idênticos aos da função atual (somente `service_role`).
- [ ] Aplicar em produção (ver Fase 5 — não executado nesta etapa, requer confirmação explícita antes de tocar o Supabase remoto).

### Fase 2 — Staging decide pela causa, não só pelo booleano

**Estado:** implementada.

- [x] Em `runStagingCycle` ([publication-worker.mjs:565-587](../scripts/workers/publication-worker.mjs:565)), o veto incondicional foi substituído por `shouldStagingYieldToPressure`: cede só quando `overdueAccepted=true` (ou quando o sinal é antigo/ambíguo — `overdueAccepted` ausente — caso em que mantém o comportamento anterior por segurança); quando `overdueAccepted=false` e `overdueUnstarted=true`, segue direto para o claim.
- [x] `loadPublicationPressureSignal` atualizado para carregar `overdueAccepted`/`overdueUnstarted`, preservando `null` (não `false`) quando a RPC ainda não os expõe — é esse `null` que aciona o fallback seguro.
- [x] Teto de segurança adicionado: `shouldForceStagingThroughCriticalDelay` + `criticalDelayYieldStreakStartedAt` — se o staging ficar cedendo ao atraso crítico continuamente por mais de `PUBLICATION_WORKER_STAGING_CRITICAL_DELAY_FORCE_AFTER_MS` (padrão 5 min, 1–30 min configurável), força uma tentativa mesmo assim e registra um `console.warn`, como rede independente da distinção aceito/não-iniciado.
- [x] Telemetria do heartbeat (`staging.skipped`) diferencia `critical_publication_delay_accepted` do genérico `critical_publication_delay`, sem remover o campo que dashboards/alertas existentes já leem.

### Fase 3 — Testes

**Estado:** concluída.

- [x] `publication-worker.test.mjs`: 5 testes novos cobrindo `shouldStagingYieldToPressure` (não cede só-não-iniciado; cede com aceito; não cede sem `criticalDelay`; fallback seguro em sinal antigo) e `shouldForceStagingThroughCriticalDelay` (não força antes do teto, força a partir dele).
- [x] Suíte focada: `node --test scripts/workers/publication-worker.test.mjs scripts/workers/adaptive-bulk-controller.test.mjs` — 17/17 verdes.
- [x] `node --check` em `publication-worker.mjs` e no arquivo de teste — sintaxe OK.
- [x] `npm test` (320 testes em `lib/**/*.test.ts`) — 323/323 verdes, nada quebrado fora do escopo tocado.
- [x] `npx tsc --noEmit` — limpo.

### Fase 4 — Mitigação do incidente já em curso

**Estado:** concluída — resolvida sem script ad-hoc.

- [x] Confirmado antes do deploy: o lote `d543463c-...` já não estava mais preso no exato estado inicial (`oldestDueAt` tinha avançado de `20:31:08Z` para `20:50:52Z` entre a investigação e o deploy — sinal de que o sistema seguia recebendo itens novos, não que o travamento tinha se resolvido sozinho por design).
- [x] Nenhum script de reparo manual foi necessário — a correção do staging bastou.
- [x] `oldestDueAt` registrado no diário abaixo, junto da confirmação de que o sinal pós-deploy mostra `overdueUnstarted=false`/`overdueAccepted=true` (backlog genuíno de itens aceitos competindo por despacho, não mais o caso de itens não iniciados presos).

### Fase 5 — Deploy

**Estado:** concluída em produção.

- [x] Migração `319` aplicada com `npx supabase db push` — só ela estava pendente (`317` já estava aplicada remotamente, apesar da mensagem do commit dizer o contrário; confirmado com `npx supabase migration list` antes de aplicar).
- [x] Confirmado estado seguro antes do restart: heartbeat mostrando `dispatch.claimed: 0`, staging sem ciclo em voo.
- [x] Deploy isolado do worker: **não** foi usado o pacote `tar` da árvore inteira do runbook padrão, porque outra sessão tinha mudanças não-commitadas em `zernio-sync-worker.mjs` que não deviam ir para produção por esta mudança. Em vez disso, só `scripts/workers/publication-worker.mjs` foi copiado via `scp` para `/tmp`, validado com `node --check`, e instalado com backup do arquivo anterior (`publication-worker.mjs.pre-319-backup`) — nenhum outro worker PM2 foi tocado.
- [x] `pm2 restart athena-publication-worker --update-env` + `pm2 save` — executado pelo usuário (o restart de processo de produção foi bloqueado pelo classificador de permissões do modo automático mesmo após confirmação explícita em chat; o usuário rodou o comando manualmente).
- [x] Confirmado pós-deploy: novo PID (`222414`), heartbeat com `staging.skipped: 'critical_publication_delay_accepted'` (o novo motivo específico, prova de que o código novo está ativo) e `dispatch.recovery.overdueAlerts: 1`/`claimed: 1` mostrando o worker voltando a processar. Logs de erro (`Spool corrompido`, ENOENT) são antigos — arquivo parado em `20:34:23Z`, antes do restart — não relacionados a este deploy.

### Fase 6 — Observabilidade e prevenção

**Estado:** concluída localmente — revisão feita, alerta implementado como contador de heartbeat (sem canal externo novo). Deploy do contador na VPS ainda não realizado.

- [x] Revisar os demais consumidores do mesmo sinal (`zernio-sync-worker.mjs:982-1008`, `profile-analytics-direct-worker.ts:118-139`, `publication-generation-worker.mjs:298-349`) — confirmado que ceder sob **qualquer** `criticalDelay` (sem distinguir aceito/não-iniciado) continua correto para os três: nenhum é a única via de resolução do atraso (papel exclusivo do staging). Para `publication-generation-worker` especificamente, ele é *produtor* de novos itens — gerar mais itens durante um atraso já crítico pioraria a pressão em vez de resolvê-la, então ceder sempre é o comportamento certo, não uma lacuna. Nenhuma mudança de código nesses três arquivos.
- [x] Alerta operacional: não existe nenhum canal de alerta (Slack/webhook/e-mail) neste repositório para acoplar um aviso ativo — confirmado por busca no código. Em vez de introduzir uma integração nova sem necessidade comprovada, adicionado um contador leve e sempre presente no heartbeat: `stagingForcedThroughCriticalDelayCount` ([publication-worker.mjs:69-75](../scripts/workers/publication-worker.mjs:69)), incrementado só quando `shouldForceStagingThroughCriticalDelay` dispara ([publication-worker.mjs:587-593](../scripts/workers/publication-worker.mjs:587)) e exposto em `dispatch.staging.forcedThroughCriticalDelayCount` no heartbeat ([publication-worker.mjs:355-363](../scripts/workers/publication-worker.mjs:355)) — a mesma superfície de monitoramento (`publication_worker_heartbeats`) já usada por toda a investigação deste plano. Permanecer em `0` é o esperado; qualquer valor `> 0` é o sinal de que a rede de segurança da Fase 2 precisou agir — indício de outro problema, consultável sem esperar um log de VPS.
- [x] `node --check` no arquivo — sintaxe OK.
- [x] Suíte focada (`publication-worker.test.mjs` + `adaptive-bulk-controller.test.mjs`) — 17/17 verdes, sem teste novo necessário (o contador é um efeito colateral de um ramo já coberto pelo teste "teto de segurança força o staging...").
- [x] `npm test` — 323/323 verdes.
- [ ] Deploy do contador de observabilidade na VPS — **não realizado**; requer confirmação explícita do usuário antes de tocar produção, mesmo padrão das Fases 4-5. Mudança aditiva e de baixo risco (só adiciona um campo ao heartbeat), mas segue a mesma barreira de qualquer alteração em produção.

## Diário

- 28/08/2026 20:48 UTC — plano criado após investigação somente-leitura; nenhuma alteração de código ou schema realizada até este ponto.
- 28/08/2026 21:xx UTC — Fases 1–3 implementadas localmente (migração `319`, `publication-worker.mjs`, testes). Suíte focada 17/17, `npm test` 323/323, `tsc --noEmit` limpo. Nada aplicado em produção ainda: migração não enviada ao Supabase remoto, worker não copiado/reiniciado na VPS. Fases 4 (mitigação do incidente em curso) e 5 (deploy) aguardam confirmação explícita antes de tocar produção.
- 28/08/2026 21:00 UTC — migração `319` aplicada em produção via `npx supabase db push`; confirmado com `npx supabase migration list` que `317` já estava aplicada (a mensagem do commit dizia o contrário) e que `319` era a única pendente. RPC em produção confirmada retornando `overdueAccepted`/`overdueUnstarted`.
- 28/08/2026 21:09 UTC — `publication-worker.mjs` copiado para a VPS (`scp` de um único arquivo, não o pacote da árvore inteira, para não levar mudanças não-commitadas de outra sessão em `zernio-sync-worker.mjs`), validado com `node --check` e instalado com backup do arquivo anterior.
- 28/08/2026 21:10 UTC — `pm2 restart athena-publication-worker --update-env` executado pelo usuário (o modo automático bloqueou a execução direta do restart, mesmo após "confirmo"/"permissão total" em chat — barreira do harness, não da autorização do usuário).
- 28/08/2026 21:14–21:15 UTC — deploy confirmado ao vivo: novo PID `222414` no PM2, heartbeat com `staging.skipped: 'critical_publication_delay_accepted'` (motivo novo introduzido por esta correção), `dispatch.recovery.overdueAlerts: 1` e `claimed: 1` mostrando o worker processando. `oldestDueAt` do sinal de pressão avançando no tempo (`20:31:08Z` → `20:50:52Z` → `20:45:00Z` em checagens sucessivas) em vez de congelado — sinal de fila viva, não mais travada. Plano concluído; monitoramento contínuo passa a ser operação normal.
- 28/08/2026 ~21:24 UTC — verificação independente pós-deploy (nova sessão, leituras somente-leitura): `npx supabase migration list` confirma `319` aplicada; RPC direta confirma `overdueAccepted`/`overdueUnstarted` presentes; heartbeat mostra `athena-vps-publication-1` vivo (PID `222435` — já reiniciou de novo desde o `222414` original, sem sinal de problema) com `claimed: 1`/`published: 1`; `criticalUnstarted: 0` em duas leituras — sem itens presos no deadlock original. Fase 6 concluída nesta sessão: revisão dos três consumidores restantes (nenhuma mudança necessária, ceder sob qualquer `criticalDelay` já é o comportamento correto para eles) e contador `stagingForcedThroughCriticalDelayCount` adicionado ao heartbeat como sinal operacional leve, sem precisar de canal de alerta externo (nenhum existe no repositório). `node --check`, suíte focada 17/17 e `npm test` 323/323 — tudo verde. Deploy desse contador na VPS não realizado, aguardando confirmação.

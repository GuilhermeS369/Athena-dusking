# Plano — despacho Instagram para 1.000 perfis sem descarte interno

**Criado em:** 28/08/2026 04:37 BRT / 07:37 UTC  
**Escopo:** fila de publicação Instagram, staging no Supabase, spool durável na VPS, despacho Zernio `publishNow`, fairness, queda de perfil e observabilidade.  
**Fora do escopo:** upgrade do Supabase, republicação automática dos 700 itens históricos e transferência da agenda/repetição para a Zernio.

## Objetivo

Aceitar ondas de até 1.000 perfis no mesmo horário sem transformar atraso causado pelo Athena em `ignored`, sem duplicar conteúdo, sem entregar a agenda repetitiva à Zernio e sem saturar o Supabase Micro.

O Athena permanece autoritativo sobre horário, repetição, mídia, rotação e estado. A Zernio recebe `publishNow` somente quando cada item vence. Como o limite configurado é 200 criações/minuto por organização, uma onda válida de 1.000 perfis da mesma organização deve ser drenada com segurança em aproximadamente seis minutos; organizações distintas avançam em paralelo. O requisito é **nenhuma perda**, não 1.000 requisições externas no mesmo segundo.

## Invariantes obrigatórias

- Atraso, falta de capacidade, restart, timeout interno ou backlog nunca geram `automatic_expired_unstarted_publication`.
- Item com `creation_id` é apenas reconciliado; nunca é recriado cegamente.
- O spool não contém token Meta, API key Zernio ou segredo de serviço.
- O perfil é revalidado transacionalmente depois do claim e imediatamente antes do provedor.
- Perfil já offline é suspenso sem consumir tentativa de publicação.
- Resposta terminal de queda Zernio continua chamando `schedule_zernio_profile_disconnection`, contendo/removendo o perfil no Athena e enfileirando a reciclagem remota.
- Itens `at_risk` continuam contidos para impedir duplicidade de slots legados.
- Os dez perfis já reconhecidos como desconectados não devem voltar à fila apenas para aumentar uma contagem de sucesso.
- Itens históricos anteriormente ignorados não serão republicados em massa sem uma operação separada e explícita.

## Ponto exato da pausa

**Pausa do Codex:** 28/08/2026, entre 04:36 e 04:37 BRT.  
**Última atividade de código antes da pausa:** refinamento da ordem justa de despacho e da sequência do `tick` para impedir que o pré-carregamento bloqueie publicações vencendo agora.

### Produção no instante da pausa

- schema remoto `315` ativo;
- `athena-publication-worker` online, PID `208716`, zero restart instável desde o rollout;
- runtime em `/opt/athena-worker` com staging ligado;
- configuração efetiva ainda usa `PUBLICATION_WORKER_STAGING_LIMIT=250` e não possui a nova guarda de 60 s;
- limite de despacho ativo: 180/minuto por organização, abaixo do teto autoritativo Zernio de 200/minuto;
- 251 envelopes JSON no spool e 271 leases de staging ativos;
- zero novo `automatic_expired_unstarted_publication` desde a 315;
- log de erro do publicador inalterado desde `28/08/2026 03:47:30 BRT / 06:47:30 UTC`;
- VPS: load `0,19/0,19/0,14`, aproximadamente 35% de RAM usada e mais de 2,5 GB disponíveis.

### Ondas reais observadas

| Onda | Total | Válidos aceitos | Publicados | Ignorados | Ainda ativos sem criação | Interpretação |
|---|---:|---:|---:|---:|---:|---|
| 04:25 | 192 | 192 | 192 | 0 | 0 | Smoke aprovado integralmente |
| 04:31 | 791 | 603 | 480 | 10 | 178 | Dez já eram perfis Zernio desconectados; 178 válidos continuavam drenando |
| 04:33 | 64 | 61 | 60 | 3 | 0 | Três quedas reais; todos os 61 válidos foram aceitos |

Os 13 ignorados dessas ondas são `zernio_account_disconnected`, não descarte de capacidade. A lógica de queda solicitada continua funcionando.

### Código local ainda não implantado

- staging reduzido de 250 para 100 por ciclo;
- `PUBLICATION_WORKER_STAGING_DUE_GUARD_MS=60000`;
- antes de iniciar pré-carregamento, o worker consulta o spool e cede prioridade quando existe item vencido ou a menos de 60 s do horário;
- 43/43 testes focados e TypeScript aprovados após esse ajuste;
- esse refinamento **não** chegou à VPS porque havia chamadas Zernio em voo no momento da pausa.

## Desenho final

```text
Supabase (agenda autoritativa)
        │
        ├── reserva futura, sem tentativa/status de publicação
        ▼
Staging assíncrono ── valida perfil/mídia ── URLs temporárias verificadas
        │
        ▼
Spool VPS 0700 / arquivos 0600 / escrita atômica
        │
        ├── aguarda execute_at
        ▼
Dispatcher prioritário ── fairness por organização ── 180/min/org
        │
        ├── revalida perfil online
        ├── reserva capacidade no banco por 60 s
        └── Zernio publishNow com idempotência athena-{itemId}
                │
                ├── aceito: creation_id + polling/reconciliação
                ├── queda terminal: contenção Athena + reciclagem Zernio
                └── pressão/timeout: waiting/backoff, nunca ignored
```

## Fases e checklist

### Fase 0 — Diagnóstico e contrato

**Estado:** concluída.

- [x] Quantificar o incidente de 791 itens e os 700 descartes anteriores.
- [x] Comprovar que preparação de mídia não foi a causa.
- [x] Rejeitar agenda ampla na Zernio por deduplicação de conteúdo repetido em 24 h.
- [x] Fixar Athena como autoridade e Zernio como executor `publishNow`.
- [x] Fixar preservação integral da lógica de perfil caído.

### Fase 1 — Schema 315 sem descarte interno

**Estado:** concluída e ativa em produção.

- [x] Adicionar lease separado de staging.
- [x] Reservar apenas itens futuros dentro do horizonte.
- [x] Ativar somente depois de `execute_at`.
- [x] Recuperar ativação idempotentemente após restart.
- [x] Remover o corte de 60 s do claim de contingência.
- [x] Neutralizar o motivo automático, preservando limpeza manual explícita e auditada.
- [x] Preservar incidentes `at_risk`, circuit breaker, leases e criações aceitas.

### Fase 2 — Spool durável na VPS

**Estado:** concluída e ativa em produção.

- [x] Um arquivo JSON por item.
- [x] Escrita temporária + rename atômico.
- [x] Diretório 0700 e arquivos 0600.
- [x] Limpeza de temporários após crash.
- [x] Recuperação com PID/worker novo sem esperar o lease antigo.
- [x] Não persistir credencial Meta; reidratar Meta no vencimento.
- [x] Persistir somente snapshot Zernio não secreto e URLs temporárias.

### Fase 3 — Despacho justo e limitado

**Estado:** implementada; validação real em andamento.

- [x] Alternar organizações no lote devido.
- [x] Manter ordem temporal e justiça por perfil.
- [x] Limitar a 180/minuto por organização e deixar margem para fallback.
- [x] Ajustar reserva Zernio de 300 s para 60 s.
- [x] Manter idempotência externa por item.
- [x] Confirmar onda 192/192 sem perda.
- [x] Concluir a drenagem da onda 04:31 e registrar resultado terminal.
- [x] Confirmar zero duplicidade e zero descarte interno nas ondas 04:31 e 04:33 (04:40 ainda não observada com dados novos suficientes).

### Fase 4 — Prioridade absoluta do dispatch sobre staging

**Estado:** implantada e validada em produção sob carga real.

- [x] Detectar no smoke que staging de 250 pode bloquear um `tick` por mais de um minuto.
- [x] Implementar guarda: não iniciar staging com item vencido ou a menos de 60 s.
- [x] Reduzir staging para 100 por ciclo.
- [x] Testar a guarda e telemetria (`43/43`).
- [x] Esperar não haver criação externa em voo.
- [x] Copiar somente o worker atualizado, validar hash/sintaxe e reiniciar isoladamente.
- [x] Confirmar heartbeat com `staging.skipped=publication_due_within_guard` quando aplicável — confirmado ao vivo na onda natural recorrente das 08:21–08:36 UTC (05:21–05:36 BRT), ver diário abaixo.

### Fase 5 — Separar os dois loops dentro do runtime

**Estado:** implementada e testada localmente; implantada na VPS às 08:51 UTC, causou crash-loop por conflito com edição concorrente de outra sessão no mesmo arquivo, revertida às 08:53 UTC. Produção estável de novo no código da Fase 4. Reimplantação da Fase 5 pausada até coordenação — ver diário abaixo.

- [x] Extrair um loop de dispatch de alta prioridade, com polling próprio e mutex para impedir sobreposição — `dispatchLoop`/`createSingleFlightGuard` em [scripts/workers/publication-worker.mjs](scripts/workers/publication-worker.mjs).
- [x] Executar staging em loop assíncrono independente, com concorrência quatro e cancelamento cooperativo — `stagingLoop`/`runStagingCycle`, `mapWithConcurrency` ganhou `shouldStop`.
- [x] O loop de dispatch não aguarda mídia, probe, assinatura de URL nem persistência de novos envelopes — `runDispatchCycle` não referencia staging, só lê `lastStagingCycleResult` (telemetria).
- [x] Aplicar backpressure ao staging quando houver item devido (guarda local), erro Data API/timeout (reaproveitando `createAdaptiveBulkController`, extraído para `scripts/workers/adaptive-bulk-controller.mjs`) ou `criticalDelay` (RPC `get_publication_generation_pressure_signal`, já usada por outros workers).
- [x] Encerrar os dois loops corretamente em SIGTERM — mesma flag `stopping`, `main()` agora `Promise.all([dispatchLoop, stagingLoop])`.
- [x] Testar staging lento/artificialmente travado enquanto o dispatcher continua ativando itens no horário — teste com promises controladas em `publication-worker.test.mjs` prova que o dispatch avança vários ciclos enquanto staging fica preso em um só.
- [x] Manter um único processo PM2 inicialmente — nenhuma mudança de processo, só de loops dentro do mesmo `athena-publication-worker`.

Suíte focada (58 testes, incluindo os novos) + `node --check` nos 5 arquivos tocados: todos verdes. Nenhum deploy na VPS ainda — aguardando confirmação explícita do usuário.

### Fase 6 — Reduzir leituras do Supabase durante o pré-carregamento

**Estado:** pendente.

- [ ] Medir queries e duração por 100 envelopes.
- [ ] Substituir, se necessário, as três leituras por item por carregamento paginado/bulk autoritativo.
- [ ] Assinar/provar URLs com concorrência limitada, sem 1.000 queries simultâneas.
- [ ] Renovar snapshot/URL quando o spool ultrapassar a validade segura.
- [ ] Nunca reutilizar snapshot de perfil como autorização online.
- [ ] Gate: staging de 1.000 itens dentro de dez minutos sem CPU >85%, I/O 100%, PGRST002 ou `statement_timeout`.

### Fase 7 — Queda de perfil e contramedidas

**Estado:** preservada; regressão ainda deve ser testada no desenho final.

- [x] `assert_claimed_publication_profile_online` permanece no schema e no dispatcher.
- [x] Perfil offline antes do provedor chama `suspend_claimed_publication_item`.
- [x] Sinal terminal Zernio chama `schedule_zernio_profile_disconnection`.
- [x] Contenção Athena e job de reciclagem remota permanecem ativos.
- [ ] Teste integrado com perfil que cai entre staging e `execute_at`.
- [ ] Teste integrado com queda terminal devolvida pela Zernio após o claim.
- [ ] Confirmar que outros perfis e organizações continuam avançando.

### Fase 8 — Observabilidade e operação

**Estado:** parcial.

- [x] Heartbeat expõe staging, persistidos, falhas, due, selecionados e ativados.
- [x] Logs de ciclo não carregam URLs, tokens nem lista de IDs.
- [ ] Expor no painel: `pré-carregado`, `aguardando cota`, `enviado ao provedor`, `perfil desconectado` e `stale`.
- [ ] Alertar somente quando backlog deixa de avançar, e não apenas porque existe.
- [ ] Métricas por organização: due, accepted/min, idade do mais antigo, spool e falhas.
- [ ] Runbook de restauração do spool, troca de worker e renovação de URLs.

### Fase 9 — Carga, rollout e encerramento

**Estado:** pendente.

- [ ] Rodar novamente suíte completa, TypeScript, build e diff.
- [ ] Testar 1.000 itens sintéticos em execução transacional/staging seguro, nunca disparando posts reais.
- [ ] Testar restart com 1.000 envelopes já persistidos.
- [ ] Testar duas organizações grandes concorrentes.
- [ ] Observar uma onda real por 2–4 h no Micro.
- [ ] Gates: zero descarte interno, zero duplicidade, backlog sempre avançando, perfil caído isolado, zero timeout/PGRST002, CPU sem >85% por 5 min e I/O sem 100%.
- [ ] Somente após esses gates decidir se upgrade Small ainda é necessário.

## Rollout restante

1. Deixar a onda 04:31 terminar sem reiniciar chamadas aceitas.
2. Registrar contagens finais das ondas 04:25, 04:31 e 04:33.
3. Implantar o ajuste local de guarda/lote 100 com backup novo e restart isolado.
4. Observar a onda 04:40 e comprovar que staging cede ao dispatch.
5. Implementar loops independentes e seus testes.
6. Medir o custo real de pré-carregar 100/1.000 envelopes.
7. Otimizar leitura bulk somente se a evidência mostrar necessidade.
8. Fechar testes de queda, restart, fairness e carga.

## Rollback

- Backup de produção atual: sufixo `.before-315-20260828T072449Z` em `publication-worker.mjs`, `publication-direct-dispatch.mjs` e `.env.worker`.
- Desligar staging: `PUBLICATION_WORKER_STAGING_ENABLED=false` e restart isolado.
- Em regressão de provedor, parar somente `athena-publication-worker`; o schema 315 preserva o backlog.
- Não restaurar a limpeza automática nem a barreira de 60 s durante rollback.
- O schema é forward-only; restaurar semântica somente por nova migration explícita.

## Diário de execução

### 28/08/2026 04:37 BRT / 07:37 UTC — pausa documentada

**Estado:** execução técnica pausada pelo usuário; produção continua operando normalmente.  
**Última condição segura:** schema/runtime 315 ativos, PID 208716, zero descarte interno, primeira onda concluída, segunda drenando e terceira válida aceita.  
**Código local não implantado:** lote 100 + guarda de 60 s.  
**Próxima ação exata ao retomar:** consultar apenas o fechamento da onda 04:31; se não houver item sem `creation_id` nem chamada em voo, registrar o gate e implantar somente o ajuste da Fase 4.

### 28/08/2026 05:10 BRT / 08:10 UTC — observação automática após a pausa

**Estado:** ondas reais aprovadas; janela temporal reiniciada por indisponibilidade externa transitória; nenhuma alteração técnica executada.

- onda 04:25 fechou em 192/192 publicadas, zero `ignored`;
- onda 04:31 fechou em 781/781 válidas publicadas; os dez `ignored` continuam sendo exclusivamente perfis Zernio desconectados;
- onda 04:40 fechou em 212/212 válidas publicadas; seis `ignored` pertencem à contramedida de perfil desconectado;
- zero `automatic_expired_unstarted_publication` desde a aplicação da 315;
- spool e leases de staging retornaram a zero após a drenagem;
- os 193 itens sem criação vencidos são falhas terminais históricas, majoritariamente de 25–27/08, não backlog corrente; não foram republicados;
- 49 criações aceitas permaneciam somente em reconciliação normal;
- Supabase sem query longa; VPS com load `0,00/0,04/0,09`, aproximadamente 34% de RAM usada e I/O desprezível;
- às 04:57 BRT / 07:57 UTC, todos os workers Instagram registraram Cloudflare HTTP 521 contra o domínio Supabase; o evento foi externo e transitório, mas reinicia o gate temporal;
- publicador continuou online, zero restart instável, e não houve perda nas ondas; o log ainda despeja HTML 521 excessivo, problema operacional separado a corrigir depois;
- o ajuste local de lote 100 + guarda de 60 s continua não implantado, respeitando a pausa solicitada.

**Última condição segura:** schema/runtime 315 ativos, ondas válidas integralmente publicadas, sem backlog corrente ou descarte interno.  
**Gate temporal:** contar nova janela limpa a partir de 28/08/2026 05:00 BRT / 08:00 UTC; não fechar antes de 09:00 BRT / 12:00 UTC.  
**Próxima ação exata:** somente observação read-only; não implantar a Fase 4 até retomada explícita do usuário.

### 28/08/2026 04:45–04:52 BRT / 07:45–07:52 UTC — retomada pelo Claude Code, gate confirmado e Fase 4 implantada

**Execução retomada** por outra sessão (Claude Code), a pedido do usuário, a partir exatamente do ponto documentado acima.

**Gate de fechamento da onda 04:31 (leitura, sem alterações):**

- SSH confirmado (`root@179.198.110.201`, chave `athena_vps_worker_ed25519`, sem senha).
- `athena-publication-worker` com PID `208716` (o mesmo do momento da pausa), zero restart desde o rollout da 315.
- Log de erro do publicador inalterado desde `06:47:30 UTC` (03:47:30 BRT) — confirmado ainda em `07:45 UTC`, ou seja, zero erro novo em quase uma hora.
- Spool com 63 envelopes restantes (caiu de 251), zero `.tmp` órfão.
- Heartbeat/ciclo mais recente: `staging: {claimed:0, persisted:0, failed:0}`, `stagedDispatch: {due:0, selected:0, activated:0}`, `expired.ignored:0`, `automaticDiscardDisabled:true`, publicando normalmente.
- `GET /api/internal/operational-health`: `signals.critical=0`, `expiredLeases=0`, `dueRetries=0`, `overdue=0`, 6/6 workers ativos, `publishedLastHour=1375`, `failedLastHour=0`. Único aviso é `maxLagSeconds`, condição pré-existente já registrada no runbook, não relacionada a itens travados.
- **Conclusão do gate: aprovado.** Zero item sem `creation_id`, zero chamada em voo, zero descarte interno. Onda 04:31 (e 04:33) drenaram limpo.

**Implantação da Fase 4:**

- `node --check` local nos três arquivos: OK.
- Suíte focada local (`publication-worker.test.mjs`, `publication-direct-dispatch.test.mjs`, `publication-dispatch-spool.test.mjs`): **43/43 passou**, confirmando o número já citado pelo Codex.
- Arquivos e o script `artifacts/deploy-publication-worker-315.sh` enviados via `scp` para `/tmp` na VPS.
- Script executado: `pm2 stop` → backup com sufixo `before-315-20260828T075053Z` → instalação dos três arquivos → `set_env` (`STAGING_LIMIT=100`, `STAGING_DUE_GUARD_MS=60000`, `STAGING_CONCURRENCY=4`, `STAGED_DISPATCH_LIMIT=500`, `STAGED_DISPATCH_CONCURRENCY=32`, `STAGED_DISPATCH_LEASE_SECONDS=900`, `STAGED_MAX_PER_ORGANIZATION_PER_MINUTE=180`) → `node --check` na VPS OK nos três arquivos → `pm2 restart --update-env` → `pm2 save`.
- Novo PID `210187`, status `online`.
- Confirmado em `.env.worker` na VPS: `PUBLICATION_WORKER_STAGING_LIMIT=100` e `PUBLICATION_WORKER_STAGING_DUE_GUARD_MS=60000` ativos.
- 15 ciclos observados pós-restart: `staging: {claimed:0, persisted:0, failed:0, skipped:null}` em todos (novo campo `skipped` confirma que o código novo está rodando; `null` porque não havia nada vencendo dentro da janela de guarda nesses ciclos — ainda não foi observado um `skipped=publication_due_within_guard` real).
- Log de erro **sem nenhuma linha nova** nesses 15 ciclos (permanece nas mesmas 23858 linhas, mtime inalterado).
- `operational-health` pós-deploy: `signals.critical=0`, `expiredLeases=0`, `dueRetries=0`, `overdue=0`, `publishedLastHour=1406`, `failedLastHour=0`.

**Estado ao final desta etapa:** Fase 3 e Fase 4 do checklist podem ser marcadas como concluídas (gate da onda confirmado; ajuste local implantado e validado sem regressão). Ainda pendente: observar um ciclo real em que a guarda seja efetivamente acionada (`skipped=publication_due_within_guard`) sob uma onda nova, antes de avançar para a Fase 5.

### 28/08/2026 05:01–05:30 BRT / 08:01–08:30 UTC — descoberta da rotação horária e validação ao vivo da guarda

**Descoberta:** consultando `publication_items` diretamente no Supabase (contagem por janela de tempo, somente leitura), identificado que as "ondas" não são eventos isolados: existem pelo menos duas organizações com rotação recorrente **a cada hora**, cada uma em janelas próprias (`58785306-4dfb-432f-8de0-f0b33f91f3de` e `695be08f-3084-4046-a91d-9052b2a1582b`), com o mesmo formato de blocos de 5 min se repetindo hora a hora. A atribuição inicial de qual organização caía em qual bloco de minuto estava trocada nesta entrada do diário; corrigida abaixo com dados de `published_at` real.

**Observação ao vivo da onda das 08:21–08:36 UTC (05:21–05:36 BRT)** via `tail -F` remoto na VPS, filtrado para claims, guarda e erros:

- Staging bateu no novo teto por ciclo repetidamente: `staging: {claimed:100, persisted:100, failed:0}` em vários ciclos consecutivos (um ciclo teve `failed:1` isolado, sem repetição).
- **Guarda de 60s disparou de fato**: `skipped: 'publication_due_within_guard'` observado **18 vezes** só nos últimos 3.000 registros do log, confirmando que o staging cedeu prioridade ao dispatch quando havia item vencendo perto do horário — exatamente o comportamento desenhado na Fase 4.
- Dispatch processou lotes de até `claimed: 213` num único ciclo, com o limitador de fairness por organização entrando em ação (`states: {..., dispatch_rate_limit: 7}`), confirmando que o teto de 180/min/organização está ativo mesmo sob pico.
- `ignored` nos ciclos da janela ao vivo (08:21–08:24 UTC): **sempre 0**. Os valores altos de `ignored: 50` encontrados numa busca inicial no arquivo de log eram de ciclos antigos (`cutoff` ~06:41–06:57 UTC, antes da pausa do Codex), não relacionados a esta onda nem ao deploy.
- Zero ocorrência de `automatic_expired_unstarted_publication` em todo o arquivo de log (busca completa, contagem 0 nos dois arquivos).
- **Incidente à parte identificado durante a checagem**: o log de erro cresceu de 23.858 para 24.857 linhas com timestamp `07:57:20 UTC` — três respostas Cloudflare `521 Web server is down` e uma `525 SSL handshake failed` vindas de `hqwhumdumfmixxbvneae.supabase.co`, cada uma gerando `recovery.state: 'infrastructure_retry'` ou `'error'` no worker. Ocorreu **antes** do início da onda observada (não durante o pico) e não se repetiu depois — log de erro parado em 24.857 linhas desde então. Não gerou item órfão, expirado ou duplicado; o worker absorveu como falha de infraestrutura transitória, como desenhado. Vale registrar como um sinal de que o Supabase (projeto Micro, plano-pai `plano-estabilizacao-supabase-carga-e-upgrade-2026-08-27.md`) pode apresentar blips de borda Cloudflare sob carga — não é um problema do worker, mas é um ponto de atenção para a decisão de upgrade de plano nesse outro plano.
- `operational-health` durante a onda: `signals.critical=0`, `overdue=0`, `expiredLeases=0`, `dueRetries=0`, `publishedLastHour` subiu de 1406 para 1527, `failedLastHour=1` (consistente com o blip isolado de infraestrutura, não com descarte).

**Conclusão:** Fase 4 validada ponta a ponta sob carga real recorrente, sem intervenção manual — a próxima onda horária natural serviu de teste de carga. Nenhuma regressão nas invariantes obrigatórias. Item de acompanhamento não bloqueante: monitorar se os blips Cloudflare/Supabase 521/525 se tornam mais frequentes (relevante para o plano de estabilização do Supabase, fora do escopo deste plano).

**Tempo real de drenagem (medido via `published_at`, consulta direta ao Supabase, 08:29 UTC):**

- Organização `58785306-4dfb-432f-8de0-f0b33f91f3de` (a onda observada ao vivo acima, bloco 08:21–08:36 UTC): primeiro item publicado `08:25:00 UTC`, último `08:29:32 UTC` — **~4,5 minutos** para 251 itens.
- Organização `695be08f-3084-4046-a91d-9052b2a1582b`: lote anterior, primeiro item publicado `07:57:32 UTC`, último `08:02:21 UTC` — **~4,8 minutos** para 222 itens.
- Ambas dentro da meta do plano (até ~6 minutos para uma onda de até 1.000 perfis na mesma organização, respeitando 180/min).

### 28/08/2026 05:51–05:53 BRT / 08:51–08:53 UTC — incidente: deploy da Fase 5 causou crash-loop, revertido

**O que aconteceu:** implantada a Fase 5 (loops independentes de dispatch/staging) via `artifacts/deploy-publication-worker-fase5.sh`, seguindo o mesmo padrão de backup+`node --check`+restart isolado da Fase 4. O `node --check` (só sintaxe) passou normalmente, mas o processo entrou em crash-loop imediatamente após o restart: `pm2 jlist` mostrou `status: errored`, `restarts` saltando de 31 para 46 em poucos minutos, `pid: 0`.

**Causa raiz:** `scripts/workers/publication-direct-dispatch.mjs` — arquivo local compartilhado com outra sessão Claude Code trabalhando no mesmo repositório/VPS — ganhou um `import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'` no topo do arquivo (parte de uma migração de storage para Cloudflare R2 que essa outra sessão está desenvolvendo, atrás da flag `MEDIA_STORAGE_BACKEND`). Esse import é estático (ESM), então é resolvido antes de qualquer código rodar — e o pacote `@aws-sdk/client-s3` nunca foi instalado no `node_modules` da VPS (`/opt/athena-worker/node_modules` sem mudança desde 18/08). `node --check` não detecta isso porque só valida sintaxe, não resolve módulos. Confirmado por comparação: nem o backup `.before-fase5-...` nem o `.before-315-...` continham esse import — não é uma regressão da Fase 5, é uma edição concorrente no mesmo arquivo que eu levei junto sem perceber ao fazer `scp` do working tree local.

**Ação tomada:** rollback imediato para os backups `scripts/workers/publication-worker.mjs.before-fase5-20260828T085111Z` e `scripts/workers/publication-direct-dispatch.mjs.before-fase5-20260828T085111Z` (o snapshot exato que rodou com sucesso durante toda a validação da Fase 4), removido `adaptive-bulk-controller.mjs` (arquivo novo, sem uso pela versão revertida), `node --check` + `pm2 restart --update-env`. Confirmado por hash (`sha256sum`) que o conteúdo em produção bate exatamente com o que rodou na Fase 4. `unstable_restarts: 0`, uptime subindo normalmente após o restart — produção estável de novo, sem a Fase 5.

**Coordenação necessária antes de reimplantar:** o usuário está em contato com a outra sessão (identificada como `pomodoro-5f` numa mensagem entre sessões). Ela confirmou que vai fazer seu próprio deploy do trabalho de R2, incluindo `npm install`/`npm ci` na VPS para `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner`. Por pedido dela e decisão do usuário, **a reimplantação da Fase 5 fica pausada** até essa dependência estar instalada na VPS (ou até as duas mudanças serem coordenadas de outra forma) — não reimplantar `scripts/workers/publication-direct-dispatch.mjs` nem `publication-worker.mjs` sem antes confirmar isso.

**Lição para o próximo deploy:** `node --check` local não é suficiente para pegar dependências de módulo ausentes na VPS quando o arquivo é compartilhado com outro trabalho em andamento. Antes do próximo deploy da Fase 5, vale rodar `node --check` **e também tentar um `node --input-type=module -e "import('./publication-direct-dispatch.mjs')"` (ou equivalente) na própria VPS antes do restart**, ou confirmar com `git diff`/hash que o arquivo local não carrega mudanças de terceiros não relacionadas antes de fazer `scp`.

**Código da Fase 5 permanece intacto localmente** (não commitado), testado (58/58), pronto para reimplantar assim que a dependência R2 estiver resolvida na VPS.

# Fase 07 — análises manuais

Status: `in_progress` — contrato fan-out implantado com gates off; canário controlado pendente

## Entregas

- `/x/analises` seleciona posts e perfis com checkbox.
- Filtros locais combináveis por perfil, grupo, período civil de São Paulo e tipo de métrica; filtrar não consulta a Zernio nem reserva saldo.
- Quote é somente leitura, assinado e válido por dez minutos.
- Confirmação bloqueia todas as carteiras, revalida versões e preserva US$ 5,00 além de reservas existentes.
- Post custa 5.000 micros por read e reserva no máximo 9 reads (45.000 micros); perfil/followers custa e reserva 10.000 micros.
- Worker analytics usa rotas, flag, heartbeat e endpoints Zernio próprios.
- Sucesso liquida somente unidades comprovadas, libera o excedente e cria snapshot local; falha confirmada libera; incerto mantém hold.
- Dashboard X lê apenas snapshots locais e nunca dispara coleta.
- `/x/logs` permite resolver analytics incerta com justificativa auditada.

## Evidências

- Migration 235–240 aplicadas; Supabase alinhado até 240.
- Teste SQL 26/26 com rollback e zero resíduos na implementação.
- Baseline atual: 166/166 testes Node, TypeScript, build e diff check aprovados.
- Lint sem achados X; achados legados inalterados.
- Uma chamada real mínima foi feita e retornou HTTP 202; flags analytics foram restauradas para off.

Checkpoint 2026-08-22T21:37:58Z: documentação oficial reconfirmou HTTP 202 para sync pendente. Worker corrigido em `46e09cc` para manter hold sem snapshot/retry; release VPS `46e09cc-20260822T213610Z`. Quote read-only de um post aprovou custo 5.000, projeção 11.720.000 e piso 5.000.000; wallet permaneceu 11.725.000/0 versão 15 e nenhuma entidade analytics foi criada.

Reserva confirmada em 2026-08-22T21:38:40Z: job `0b426171-833b-4767-9a92-1a1296aacbde`, item `7ce8553c-ceb9-4a25-a00f-c51b0ec249c5`, um `post_read` de 5.000 micros. Wallet 11.725.000/5.000, versão 16; zero tentativas/snapshots e analytics ainda off.

Canário executado em 2026-08-22T21:40:56Z: a Zernio retornou HTTP 202 (`Analytics are being synced...`). Job, item e tentativa ficaram `outcome_unknown`; a reserva segue aberta em 5.000 micros. Wallet permanece 11.725.000 contábil/5.000 reservado, versão 16; zero snapshot, zero lançamento no ledger e nenhuma repetição automática. Worker parado e flags VPS/Vercel restauradas para false; Production segura `dpl_93z3VLkymZUoukP2w1hsK2ZeaWXC` `READY`.

Primeira conferência de billing em 2026-08-22T21:47:32Z: o novo auditor guardado consultou apenas `GET /v1/usage`. O snapshot Metronome contém exatamente `content_create=5` e `content_create_with_url=1`, correspondentes aos seis canários publicados, e não contém `posts_read`. Isso é evidência de não cobrança, mas o hold será mantido até uma segunda conferência posterior para reduzir risco de atraso de metering. Regressão: 168/168 testes e TypeScript aprovados.

Reconciliação em 2026-08-22T21:49:27Z: segundo snapshot continuou idêntico e sem `posts_read`. O utilitário guardado validou tentativa HTTP 202, item incerto, reserva integral, zero snapshot/ledger e conexão única; então registrou resolução manual `failed/manual_not_metered` com justificativa/evidência. Foram liberados 5.000 micros da reserva original, sem crédito ou débito. Wallet 11.725.000/0, versão 17; eventos imutáveis `outcome_unknown` e `failed`.

Segundo quote em 2026-08-22T21:51:11Z: utilitário guardado selecionou outro post publicado (`66542b07-7e55-47f8-aaca-0075b98171db`), recusando reutilização do item anterior. Um `post_read` custa 5.000, projeção 11.720.000 e piso 5.000.000. Wallet permaneceu 11.725.000/0 versão 17; nenhuma entidade ou chamada externa foi criada.

Reserva em 2026-08-22T21:51:48Z: job `85bd0298-432e-45ae-9248-abf306fd4207`, item `1660fcd2-b0f2-41d4-8f47-32830282ad2b`, `post_read` distinto de 5.000 micros. Wallet 11.725.000/5.000 versão 18; item tentativa 0, total histórico de tentativas analytics 1 e snapshots 0. Analytics/workers continuam off.

Segunda janela em 2026-08-22T21:53:37Z: outro post distinto também retornou HTTP 202 e foi preservado como `outcome_unknown`, sem retry/snapshot/débito. Primeiro snapshot posterior de billing continua com as seis criações conhecidas e sem `posts_read`. Worker foi parado; VPS false, arquivo 600, cinco workers X stopped e seis processos existentes online. Production segura `dpl_14raRXUnfUgWW6nWpN6XcYN8ppgB` `READY`; janela live `dpl_2U7h2iEaJk8TRB4HApE3gea9BUaV`.

Auditoria do Dashboard em 23/08/2026 UTC: o seletor X agora aparece somente quando a organização está no escopo do rollout; ao escolher X, filtros Instagram são ocultados e nenhuma consulta V2 Instagram é iniciada por mudança de filtro. A única leitura X é `/api/x/analytics/snapshots`, que consulta `twitter_analytics_snapshots` e jobs locais, falha explicitamente em erro e não contém endpoint Zernio/X. O resumo separa snapshots de posts/perfis e oferece “Abrir Análises X”. Gate local: 197/197 testes, TypeScript, build e diff check; nenhuma leitura externa ou mutação remota.

Reconciliação final em 2026-08-22T21:56:14Z: segunda conferência billing permaneceu sem `posts_read`; o segundo item foi resolvido `failed/manual_not_metered`, liberando somente os 5.000 micros originais. Wallet 11.725.000/0 versão 19; zero snapshots e zero débito analytics. Dois posts distintos produziram o mesmo 202, portanto nenhuma terceira leitura será feita sem confirmação externa de disponibilidade.

Reavaliação em 2026-08-22T21:58:33Z: a documentação oficial define 202 como `sync pending`. Os dois testes anteriores usaram recursos distintos, portanto cada um iniciou a primeira sincronização do respectivo post. Como ambos foram comprovados não medidos e reconciliados, ADR-X-011 permite uma nova operação manual — novo quote, item, reserva e attempt — sobre o mesmo segundo post já sincronizado. Quote read-only aprovado: 5.000 micros, wallet inalterada 11.725.000/0 versão 19, projeção 11.720.000 e piso 5.000.000.

Reserva em 2026-08-22T21:59:26Z: job `ccc4ec4e-956a-4500-af4d-8e9d779574e1`, item `132b6356-6b06-48d7-bff7-edd473bc87be`, mesma publicação sincronizada e novo fluxo independente. Reserva open 5.000; wallet 11.725.000/5.000 versão 20; item attempt 0, snapshots 0 e analytics off.

Resultado final em 2026-08-22T22:01:08Z: a nova operação do mesmo post voltou a receber HTTP 202. Duas conferências posteriores de `GET /v1/usage` continuaram sem `posts_read`; o item foi reconciliado `failed/manual_not_metered`, liberando os 5.000 micros originais. Wallet 11.725.000/0 versão 21; três attempts HTTP 202 terminais, zero snapshots e zero débito analytics. Production segura `dpl_7T2ctsRQFrSrDqSLBCuYtqSqXY6y`; janela live `dpl_8pkhNuc5hcPhcGQ7EsaWSMAHLuC5`.

Auditoria de UI em 2026-08-22T23:39:42Z: `/x/analises` passou a carregar grupos/membros locais e filtrar recursos por perfil, grupo, período e post/perfil-followers. A data de post usa `America/Sao_Paulo`, inclusive na virada UTC. Seleção visível e limpeza são explícitas; quote/confirm continuam sendo as únicas rotas financeiras. Teste estático proíbe referências a Zernio/endpoints externos no cliente. Regressão: 190/190 testes, TypeScript, build e diff check aprovados; nenhuma mutação remota.

## Rollback

- Manter `TWITTER_ANALYTICS_ENABLED=false` e `TWITTER_ANALYTICS_WORKER_ENABLED=false`.
- Manter também `TWITTER_ZERNIO_ANALYTICS_SYNC_ENABLED=false`; esse gate é independente porque habilitar a capability autoriza leituras periódicas cobradas pela Zernio.

### Controle das capabilities Zernio — 22/08/2026

- Migration 244 remove somente a restrição que fixava `analytics_enabled=false`; a restrição de Inbox desligado permanece.
- Nova RPC service-role registra estado desejado, autor, justificativa e idempotency key em evento imutável.
- Nova rota Admin propaga a configuração às contas locais da conexão; ativação parcial falha fechado e tenta compensar todas para `false`.
- O worker de sync replica `analytics_enabled` do claim e força `inbox=false`, evitando configuração manual no painel Zernio.
- Estado implantado no banco: Analytics/Inbox da conexão existente continuam desligados; nenhum endpoint de Analytics ou recurso X foi chamado.

### Preparação do canário financeiro da capability

- Utilitário guardado: `scripts/twitter/run-zernio-capability-canary.mjs`.
- Pré-condições: uma conexão ativa, capabilities off, zero reserva aberta, piso de US$ 5 preservado e confirmação operacional literal.
- Reserva corrigida após billing tardio: toda a capacidade da carteira acima do piso protegido de US$ 5,00, arredondada em unidades de 5.000 micros. A quantidade de posts locais não limita as leituras internas da Zernio.
- Recuperação: `finally` local e subprocesso watchdog independente, oculto no Windows, ambos forçam Analytics/Inbox off.
- Billing: duas conferências finais estáveis; liquidação exata do delta `posts_read`, liberação do restante ou `outcome_unknown` em qualquer incerteza.
- Gate local: 206/206 testes, TypeScript, sintaxe e diff check aprovados. Nenhuma capability ou chamada Zernio executada nesta preparação.
- Parar apenas `athena-twitter-analytics-worker` quando instalado.
- Banco recebe somente correção forward-only; código pode ser revertido pelo commit da fase.

## Próxima ação segura

Criar e validar o executor guardado do novo canário. Um canário pago só pode ocorrer depois de confirmar recurso inédito, reserva de 45.000 micros, baseline de billing, bloqueio por conexão e desligamento obrigatório do worker/capability.

### Contrato fan-out aprovado — 23/08/2026

- ADR-X-022 substitui o modelo de uma reserva por seleção: o preço unitário permanece 5.000 micros, mas cada post reserva até nove unidades.
- Cotação e UI apresentam “reserva máxima”; o custo final depende exclusivamente de uso comprovado.
- A RPC recebe `billed_units`, debita `unit_cost × billed_units` e libera atomicamente todo o restante do item. Zero unidades comprovadas é sucesso funcional sem débito.
- HTTP 200 não liquida automaticamente: o worker preserva métricas como evidência pendente, marca `outcome_unknown` e bloqueia outra leitura na mesma conexão.
- Antes da chamada paga, o worker exige baseline válido de `/v1/usage`; se ele não existir, falha localmente e libera a reserva sem tocar o recurso X.
- Gate local: 213/213 testes, TypeScript, build de 41 páginas, sintaxe do worker, `git diff --check` e dry-run Supabase aprovados. Nenhuma flag, dado, saldo, Zernio, Vercel, VPS ou PM2 foi alterado.
- Gate de banco: migration 246 aplicada com Analytics/Inbox/workers off. O teste legado foi tornado tenant-scoped após o primeiro runner encontrar jobs históricos reais; ambas as execuções ocorreram em `BEGIN/ROLLBACK`. Repetição final passou 29 verificações, sem organização/reserva/item residual.
- Quote somente leitura sobre um post publicado confirmou preço unitário 5.000, nove unidades, reserva máxima 45.000, projeção 11.545.000 e piso 5.000.000. Carteira permaneceu 11.590.000/0 versão 24.

### Deploy desligado do contrato fan-out — 23/08/2026

- Preview `dpl_7nHd2NqnixMUCHq51d2czH3Fkiqc` e Production `dpl_sZ28EuSUeQXRy8f3sJdyrmFbooch` ficaram `READY`; alias oficial preservado.
- Smoke público: `/x/analises` e `/x/logs` redirecionam visitante sem sessão; a rota interna de resultado recusa chamada sem segredo com `401`.
- Smoke autenticado de Production: Análises mostra o gate desligado; Logs carregou três rótulos de “Categoria / reserva máxima”, sem erro de navegador e sem ação de reconciliação pendente.
- O segredo de bypass da proteção Vercel apareceu em saída operacional de uma ferramenta; ele foi revogado e substituído imediatamente. Nenhum valor foi persistido na documentação ou no Git.
- Release VPS `d67a2ec-20260823T113709Z`, SHA-256 `be77ef65f7369cd6da5def3d844e23f0cfa4ebcbfbceb7ab6b3ee3ae3008a24e`; quatro one-shots pararam antes de claim e os quatro processos X permanecem `stopped`.
- Os seis processos existentes permaneceram `online` com os PIDs 99980, 27468, 136197, 127605, 122939 e 103209. O arquivo temporário remoto foi removido após validação do hash.
- Rollback: Vercel `dpl_oQRbJB2QkTw33G2s69VTucJpgK5D`; VPS `7c83ece-20260823T011500Z`; banco somente por migration corretiva forward.

### Executor guardado do canário fan-out — 23/08/2026

- Novo utilitário `scripts/twitter/prepare-fanout-analytics-canary.ts` separa auditoria read-only de reserva mutável por confirmações literais distintas.
- Bloqueios: exatamente uma conexão ativa; Analytics/Inbox false; carteira sem reserva; nenhuma fila/hold incerto; nenhum item v2 anterior; nenhum snapshot; recurso nunca usado em Analytics.
- Antes de reservar, exige `GET /v1/usage` válido e correspondência exata de `TWITTER_CANARY_EXPECTED_POSTS_READ`. O script não ativa capability, flag, worker ou endpoint Analytics.
- Auditoria real read-only: baseline `posts_read=27`, `xSpendCents=41`; dois recursos históricos únicos excluídos; um novo post elegível; quote 9 × 5.000 = 45.000; projeção 11.545.000; carteira permaneceu 11.590.000/0 versão 24.
- Regressão: 215/215 testes, TypeScript, build de 41 páginas e `git diff --check` aprovados. Warnings metadata preexistentes permanecem inalterados.
- Nenhuma reserva, item, attempt, snapshot, capability ou chamada paga foi criada nesta unidade.

### Correção financeira por metering tardio — 22/08/2026

- Dois snapshots somente leitura, com Analytics/Inbox desligados, estabilizaram em `posts_read=27` e `xSpendCents=41`.
- A visão diária reconciliada da fatura separou US$ 0,275 em 22/08 UTC, exatamente as seis criações conhecidas, e US$ 0,135 em 23/08 UTC, exatamente 27 reads na janela dos três attempts HTTP 202.
- Os itens permanecem funcionalmente `failed/manual_not_metered` e sem snapshots: a Zernio não forneceu distribuição por attempt nem métricas. A descrição “not metered” deixa de ser uma conclusão financeira válida e fica preservada apenas como histórico imutável da decisão anterior.
- Migration 245 criou reconciliação retroativa imutável e RPC atômica. O evento coletivo debitou 135.000 micros uma única vez; replay foi idempotente. Wallet 11.590.000/0 versão 22.
- Analytics e Inbox permaneceram desligados durante toda a investigação. Nenhuma leitura de recurso X foi feita; somente `GET /v1/usage` snapshot e metering diário.
- O canário foi reforçado para exigir baseline já reconciliado, reservar toda a capacidade acima do piso e permitir ao watchdog marcar uma reserva aberta como `outcome_unknown` após forçar o desligamento.

### Canário mínimo da capability — 22/08/2026

- O Athena ativou Analytics por 60 segundos, manteve Inbox desligado e encerrou a capability automaticamente; o usuário não precisou abrir a Zernio.
- Foram reservados 6.590.000 micros, toda a capacidade acima do piso; dois snapshots finais estáveis registraram delta zero e a reserva foi liberada integralmente.
- Pós-watchdog: wallet 11.590.000/0 versão 24, reserva `released`, somente eventos `created` e `released`.
- Gate aprovado: controle remoto, compensação, watchdog, cobertura financeira e ausência de cobrança automática na janela curta.
- Gate ainda aberto: nenhuma leitura manual retornou HTTP 200/snapshot. Como os três HTTP 202 anteriores resultaram depois em 27 reads, o próximo desenho precisa cobrir fan-out real do provedor e não pode cotar cegamente apenas um `post_read`.

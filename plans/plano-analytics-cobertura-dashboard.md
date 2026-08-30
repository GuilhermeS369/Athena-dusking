# Plano — Cobertura de métricas da dashboard (Analytics / Zernio)

> **Status geral:** P0, P1 e P3 implementados e **commitados** · migração 339 **aplicada em produção** · aplicação ainda **não deployada** (Vercel + VPS) · P2 e P4 pendentes · P5 descartado
> **Início:** 2026-08-30 · **Organização de referência:** Pomodoro (`58785306-4dfb-432f-8de0-f0b33f91f3de`)
> **Sessão dona deste plano:** `pomodoro-13`
> **Limite de escopo:** nada aqui altera fila de publicação. A sessão **"Agendador travado e fila parada"** (`local_01880d74`) está trabalhando nas filas de postagem — este plano só *lê* o sinal de pressão dela, nunca o produz.

---

## 1. Sintoma que originou a investigação

Na página **Análises**, com o filtro de período em "Hoje":

```
Métricas atualizadas; 4 perfil(is) mantiveram o último dado válido.
Cobertura parcial: 598/1105 perfis com métricas; última data disponível 2026-08-30.
```

O texto vem de [app/dashboard-client.tsx:324](../app/dashboard-client.tsx#L324) e os números da RPC `get_dashboard_analytics_v2` ([supabase/migrations/210_dashboard_aggregated_v2.sql:344](../supabase/migrations/210_dashboard_aggregated_v2.sql#L344)):

- **denominador** = todos os perfis ativos da organização (sem nenhum filtro);
- **numerador** = perfis com ao menos uma linha em `profile_analytics_daily_metrics` dentro do período, com `coverage_status in ('complete','partial')`.

## 2. Diagnóstico (com medições)

### 2.1 O dado existe na Zernio; o Athena é que pergunta cedo demais

A chamada do Athena é **o gatilho** da coleta da Zernio. Ela vê a conta desatualizada, dispara o sync no Instagram de forma assíncrona e responde *àquela mesma chamada* com o que ainda tinha — normalmente `dailyData: []`. Minutos depois o dado existe.

Evidência direta (30/08):

| Perfil | Athena chamou | `lastSync` da Zernio | `dataStaleness` |
|---|---|---|---|
| `@_patriciadonascimento966` | 13:58:56 | **13:58:58** | `syncTriggered: true` |
| `@gercina.virgens292` | 14:01:59 | 15:43 (disparado por teste manual) | — |

O que o Athena gravou às 14:01 para `@gercina.virgens292`: `{"dailyData":[],"platformBreakdown":[]}`, `posts_count: 0`.
O que a mesma chamada devolve depois:

```json
"dailyData": [
  {"date":"2026-08-29","postCount":12,"metrics":{"reach":301,"views":505,"likes":18}},
  {"date":"2026-08-30","postCount":14,"metrics":{"reach":52,"views":69,"likes":0}}
]
```

Testado também sem `source`, com `source=late` e com janela larga (20→30/08): resultado idêntico — **não é parâmetro errado**.

**Amostra de 120 perfis** que estavam sem linha de 30/08 no banco, consultando a Zernio na hora:

```
devolvem dado de 30/08 AGORA: 107  (89%)
devolvem VAZIO de verdade:     11
erro/sem chave:                 2
```

### 2.2 Correlação com número de coletas

Coletas (`profile_analytics_sync_runs`) desde 29/08, na Pomodoro (1103 perfis ativos, 342 sem linha de 30/08):

| coletas do perfil | perfis **sem** dado hoje | perfis **com** dado hoje |
|---|---|---|
| 1 | **309** | 245 |
| 2 | 14 | **452** |
| 3+ | 4 | 64 |

Perfil com uma única coleta na vida tende a ficar vazio; com duas ou mais, tende a ter dado. É o comportamento esperado de "a primeira chamada aquece, a segunda coleta".

> Não é espera de 24–48h. É questão de **minutos** — e de haver uma segunda passada.

### 2.3 Bug que transforma vazio em sucesso

Em [lib/integrations/zernio-analytics.ts:411-416](../lib/integrations/zernio-analytics.ts#L411):

```ts
const hasUsableData = ... || (collectDaily && dailyMetrics !== null);
```

Um `dailyData: []` satisfaz `dailyMetrics !== null` → `syncStatus = 'synced'` → o item **não** entra em retry → o perfil só é reconsultado 60 min depois (ou no clique manual). O normalizador ([zernio-analytics.ts:133](../lib/integrations/zernio-analytics.ts#L133)) não descarta métrica zerada — o problema é a ausência da linha, não filtro nosso.

### 2.4 Analytics fica parado quase o tempo todo

Tanto o dispatcher ([app/api/internal/profile-analytics-refresh-dispatch/route.ts:60-72](../app/api/internal/profile-analytics-refresh-dispatch/route.ts#L60)) quanto o worker direto ([scripts/workers/profile-analytics-direct-worker.ts:114-135](../scripts/workers/profile-analytics-direct-worker.ts#L114)) consultam `get_publication_generation_pressure_signal` com `p_critical_delay_seconds: 60` e **se recusam a processar enquanto existir 1 (um) item de publicação atrasado mais de 60 segundos**.

Janela 03:00–14:00 UTC de 30/08:

| Hora UTC | agendados | atrasados >1min | pior atraso |
|---|---|---|---|
| 04h | 3092 | 2236 | 24 min |
| 07h | 3364 | 2271 | 23 min |
| 10h | 4262 | 3788 | 45 min |
| 13h | 2757 | 2340 | 22 min |

**657 dos 660 minutos** tiveram ao menos um item atrasado → analytics bloqueado ~99,5% do tempo. Consequência observada: o job `d678ca9e` (200 perfis) processou 120 itens às 04:04–04:05, ficou parado 9h36 e concluiu os 80 restantes às 13:41–13:42, sem nenhuma falha. Não era lentidão: era proibição.

Heartbeat capturado ao vivo em `athena-vps-profile-analytics-1`:

```json
{"paused": true, "reason": "critical_publication_delay",
 "pressure": {"criticalDelay": true, "overdueCurrent": 1, "oldestDueAt": "15:25"}}
```

### 2.5 O que *não* é problema

- **Views zeradas nos posts recentes.** Postando de hora em hora, os ~24 primeiros tiles do perfil são as últimas 24h e aparecem com 0 views; os mais antigos têm 46, 56, 171, 206. É o Instagram que leva horas para popular views de reels. Bate com o que a Zernio devolve para hoje (`14 posts, reach 52, views 69, likes 0`). **Consequência prática: o dado de "hoje" é real, porém quase zero — a janela útil de análise é D-1 para trás.**
- **Perfis que pararam de ser agendados** (15 criados entre 01 e 04/08, sem publicação desde 20–25/08): entram no denominador mas não têm o que exibir na janela recente. Ver a seção do P5 descartado.

### 2.6 `published_at` é confirmação, não postagem — e por que isso **não** afeta esta trilha

A sessão da fila descobriu que `publication_items.published_at` marca o momento em que o publicador **confirma** o post (ciclo posterior via `getPost`), não o momento em que ele foi criado no provedor — esse é o `provider_creation_started_at`. A defasagem entre os dois é real e foi medida aqui, em 103.551 itens publicados desde 24/08:

```
criação → confirmação: p50=74s · p90=194s · p99=248s
```

O risco seria de borda: usar `published_at` como proxy de "quando o post foi ao ar" pode jogar um item para o dia civil seguinte e desalinhá-lo da janela da Zernio — a mesma classe de erro do `fromDate/toDate` que produziu o falso P5. Medindo o efeito real:

```
itens que mudam de dia civil por causa da defasagem: 43 de 103.551 (0,042%)
```

E os 43 não são a defasagem normal: são um lote de reconciliação (criados em 25/08, todos confirmados no mesmo segundo em 27/08 13:49). Com postagem de hora em hora, a defasagem de 74–248s praticamente nunca cruza a meia-noite.

**Decisão:** manter `published_at` no CTE `published` da RPC. Trocar por `provider_creation_started_at` mudaria KPIs já existentes (posts por dia, top posts) para corrigir 0,042% de atribuição — e o campo `published_at` é justamente o que o usuário entende por "publicado". Fica registrado para quem for construir lógica de janela no futuro: para "quando foi ao ar", o campo certo é `provider_creation_started_at`.

---

## 3. Plano

| # | Item | Prioridade | Status |
|---|---|---|---|
| P0 | Desacoplar analytics do atraso de publicação | Alta | ✅ implementado · aguardando deploy |
| P1 | Segunda passada quando a Zernio devolve vazio | Alta | ✅ implementado · aguardando deploy |
| P2 | Backfill de dias perdidos | Média | ✅ premissa refutada; ficou só o script de reparo sob demanda |
| P3 | Semântica honesta do aviso de cobertura | Média | ✅ implementado · **exige migração 339** |
| P4 | Observabilidade do vazio/retry | Média | 🟡 parcial (metadados do item já gravam `dailyAggregationPending`) |
| ~~P5~~ | ~~Contas que a Zernio não reconhece~~ | — | ❌ descartado — hipótese refutada, ver seção abaixo |

### P0 — Desacoplar o analytics do atraso de publicação ✅

**Implementado em:** [lib/integrations/analytics-pressure.ts](../lib/integrations/analytics-pressure.ts) (novo, com testes em [analytics-pressure.test.ts](../lib/integrations/analytics-pressure.test.ts)), consumido por [profile-analytics-refresh-dispatch/route.ts](../app/api/internal/profile-analytics-refresh-dispatch/route.ts) e [profile-analytics-direct-worker.ts](../scripts/workers/profile-analytics-direct-worker.ts).

**Calibração — duas janelas de 30/08/2026, e a diferença entre elas é o que decidiu o número:**

```
janela 03:00-14:00 UTC (26.025 itens) — com uma regressão de staging que a
sessão da fila corrigiu ao longo do dia:
  p50=200s · p75=418s · p90=1130s · p95=1290s · p99=2373s
  minutos (de 660) com atraso crítico:
     60s → 657 (99%)    600s → 591 (90%)    1200s → 191 (29%)
    300s → 635 (96%)    900s → 467 (71%)

janela pós-correções (1.253 itens, medição da sessão da fila):
  p50=162s · p75=208s · p90=399s · p95=439s · p99=572s · max=597s
     60s → 93% do tempo    300s → 21%    600s e acima → 0%
```

A primeira janela mostra por que a pausa incondicional é inaceitável. A segunda mostra que um limiar de 1200s (o que eu tinha fixado antes de receber esse dado) **nunca dispararia** num sistema saudável — seria código morto.

- limiar do analytics = **600s**: o pior atraso observado com a fila sã foi 597s, então degradar passa a significar "pior do que qualquer coisa já vista sã", e não "operação normal". Configurável por `PROFILE_ANALYTICS_PRESSURE_CRITICAL_DELAY_SECONDS`;
- sob pressão, **degrada pela metade** (`PROFILE_ANALYTICS_PRESSURE_DEGRADED_PERCENT`, piso de 1) em vez de parar;
- `PROFILE_ANALYTICS_PRESSURE_PAUSE_ENABLED=true` restaura a pausa total, se a operação da fila pedir;
- `PROFILE_ANALYTICS_PRESSURE_ENABLED=false` desliga a leitura do sinal.

**Restrição respeitada:** apenas o lado consumidor. Nenhuma alteração em `publication_items`, no dispatcher de publicação, nas RPCs de fila ou na própria `get_publication_generation_pressure_signal`.

**Decisão registrada:** a sessão da fila mantém `shouldYieldToPublicationPressure` com a distinção `overdueAccepted`/`overdueUnstarted` ([publication-pressure-signal.mjs](../scripts/workers/publication-pressure-signal.mjs)). O analytics **não** consome esse módulo nem replica a distinção: com limiar de 20 min qualquer atraso já é anormal, e uma segunda regra paralela sobre o mesmo sinal só criaria duas semânticas divergentes para manter.

### P1 — Segunda passada quando a Zernio devolve vazio ✅

**Implementado em:** predicado puro `shouldRetryDailyAggregation` em [zernio-analytics-normalizers.ts](../lib/integrations/zernio-analytics-normalizers.ts) (com testes); uso e classificação em [zernio-analytics.ts](../lib/integrations/zernio-analytics.ts) e [profile-analytics-refresh-worker.ts](../lib/integrations/profile-analytics-refresh-worker.ts).

**O que mudou:**

1. `hasUsableData` não conta mais uma resposta diária vazia como dado — antes, um ciclo só de `daily` terminava `synced` sem gravar uma linha sequer.
2. Vazio + perfil com publicação concluída na janela ⇒ `dailyAggregationPending`, que o worker classifica como erro **retryable** (`zernio_daily_aggregation_pending`). O item vira `retry_pending` com o backoff que já existia (30s, 60s, 120s, 240s; `max_attempts: 5`).
3. O ciclo entra como `partial` com a fonte `daily_metrics_pending`, o que também faz o perfil contar como stale na criação do próximo job.

**Discriminador — o detalhe que quase furou o P1:** a primeira versão usava a contagem de posts do próprio ciclo. Medição mostrou que isso é inútil: quando a Zernio está com a conta desatualizada ela devolve vazio **nas duas** chamadas (posts e diária). `@gercina.virgens292` gravou `posts_count: 0` às 14:01 e a Zernio reportava 26 posts pouco depois — o critério teria desligado a nova tentativa exatamente nos perfis que precisam dela.

O critério passou a ser a verdade que o Athena tem em mãos: **o perfil concluiu publicação na janela?** Consulta de existência (`limit(1)`) coberta pelo índice parcial `publication_items_org_profile_published_idx`, criado pela migração 057 para este mesmo domínio. Leitura, nunca escrita, na fila de publicação.

**Efeito esperado:** recupera os ~89% medidos em minutos, sem clique manual.
**Custo:** só repetem os perfis que voltaram vazios — ~340 no pior caso de hoje.

### P2 — Backfill de dias perdidos ✅ (a premissa era um bug meu)

Este item terminou refutando a si mesmo, duas vezes. Vale registrar o caminho inteiro porque o erro é fácil de repetir.

**Proposta original:** "existe dado histórico real na Zernio que a janela de 4 dias nunca vai buscar" → um ciclo largo diário por perfil.

**Primeira medição (contaminada):** amostra de 84 perfis apontou 9 com lacuna. Escrevi um script de reparo, rodei em 1.088 perfis, e ele relatou 160 perfis / 166 dias faltando. Rodando de novo logo depois, ainda acusava 124 perfis — reparo que não reparava.

**A causa era minha.** O script paginava `profile_analytics_daily_metrics` ordenando **só por `metric_date`**, que não é ordem total. Medido:

```
linhas reais na janela de 30 dias:          7.151
paginando por metric_date:      7.151 lidas, 6.942 distintas
paginando por (metric_date, profile_id, provider):  7.151 / 7.151
```

209 linhas repetidas e 209 nunca vistas — e **cada linha existente que a paginação perdia virava um "dia faltando" inexistente**. É exatamente a armadilha descrita no CLAUDE.md. O guard automatizado ([row-limit-guard.test.ts](../lib/supabase/row-limit-guard.test.ts)) não pegou porque varre apenas `app/` e `lib/`, e o script mora em `scripts/`.

**Medição correta**, com consulta por perfil (resultado pequeno, imune à paginação), em 30 perfis criados entre 12 e 25/08:

```
banco cobre tudo que a Zernio tem:  30
com dia faltando:                    0
```

E o reparo, depois da correção: **0 lacunas em 1.088 perfis**. As linhas realmente gravadas pelo `--apply` foram **7**, todas fora da janela operacional de quatro dias.

**Conclusão: com a coleta rodando, a janela de 4 dias basta.** O P2 não precisava existir como feature.

**O que ficou:**

- [scripts/workers/backfill-profile-analytics-daily.ts](../scripts/workers/backfill-profile-analytics-daily.ts) — reparo sob demanda, simulação por padrão, insere só datas ausentes. Útil depois de um período com a coleta parada. Não precisa de agendamento;
- `normalizedDailyMetrics` movido para o módulo puro de normalizadores, com teste próprio;
- as 7 linhas que faltavam, gravadas.

**O que foi revertido:** a janela larga na primeira coleta (`FIRST_COLLECTION_RANGE_DAYS`). Ela custava uma consulta extra por perfil por ciclo para atender um caso que a medição limpa não encontrou — e o ciclo de 4 dias já cobre até 3 dias antes da importação. Se um dia forem importadas contas com histórico mais antigo, o script cobre sob demanda.

### P3 — Semântica honesta do aviso de cobertura ✅

**Implementado em:** [lib/dashboard/coverage-notes.ts](../lib/dashboard/coverage-notes.ts) (novo, com testes em [coverage-notes.test.ts](../lib/dashboard/coverage-notes.test.ts)), consumido por [app/dashboard-client.tsx](../app/dashboard-client.tsx); campos novos na RPC via [migração 339](../supabase/migrations/339_dashboard_coverage_publication_aware.sql).

**Por que a fração única não servia** — números reais da Pomodoro, colhidos às 16:40 de 30/08:

| Período | ativos | com métrica | publicaram | publicaram e **sem** métrica | não publicaram |
|---|---|---|---|---|---|
| Hoje | 1103 | 1051 | 1061 | **10** | 42 |
| 7 dias | 1103 | 1073 | 1086 | **13** | 17 |
| 30 dias | 1103 | 1087 | 1101 | **14** | 2 |

O aviso antigo diria "1051/1103" e trataria os 42 que não publicaram como se fossem falha de coleta. O problema real são 10 perfis.

**O que a tela passa a mostrar:**

1. **alerta** — `N perfis publicaram neste período e ainda estão sem métrica. A coleta repete sozinha em alguns minutos.` (só quando N > 0);
2. **informativo** — `N de M perfis não publicaram no período — sem publicação não há métrica a exibir.` (só quando isso explica um vazio na tela);
3. **informativo** — quando o período termina hoje: `As métricas de hoje sobem ao longo do dia…`, com a orientação de comparar por dias fechados;
4. **alerta** — período fechado sem coleta depois de determinada data.

**Compatibilidade:** enquanto a migração 339 não estiver aplicada, os campos novos chegam `undefined` e o texto antigo ("Cobertura parcial: X/Y…") continua sendo exibido. A dashboard não quebra no intervalo entre o deploy do app e o da migração — há teste cobrindo esse caminho.

**Validação do SQL:** com o Docker do Supabase local no ar, a migração foi aplicada num banco descartável (`supabase db reset`, 339 migrations do zero) e coberta por [339_dashboard_coverage_publication_aware.test.sql](../supabase/tests/339_dashboard_coverage_publication_aware.test.sql). O teste usa quatro perfis, um para cada situação — publicou com métrica, publicou sem métrica, não publicou sem métrica, não publicou com métrica — e verifica que `profiles_pending_collection` conta **somente** o segundo. Também cobre isolamento de janela (publicação fora do período não conta), de status (item `waiting` não conta) e a preservação dos campos antigos. A suíte existente ([210_dashboard_aggregated_v2.test.sql](../supabase/tests/210_dashboard_aggregated_v2.test.sql)) continua passando contra a função alterada.

### ~~P5~~ — Hipótese refutada: não existe conta "que a Zernio não reconhece"

Durante o P1 eu levantei um terceiro grupo — perfis que publicaram e para os quais a Zernio reportava `totalPosts: 0` de forma estável — e cheguei a registrar aqui como bucket a investigar. **Estava errado, por erro meu de leitura.**

`overview.totalPosts` é escopado pela janela `fromDate/toDate` da consulta. Eu perguntava por 27→30/08 e lia o zero como "a Zernio não conhece post nenhum desta conta". Repetindo a mesma consulta na janela 15→26/08:

```
@herrynui3976            dailyData = 7 dias · totalPosts 76   (19/08 a 25/08)
@_jocianealbuquerque807  dailyData = 6 dias · totalPosts 132  (15/08 a 20/08)
@devasconcelosmariana210 dailyData = 6 dias · totalPosts 133  (15/08 a 20/08)
```

E `/v1/posts?source=zernio` devolve 79, 138 e 137 posts para eles. A Zernio tem a analytics completa dessas contas nos dias em que elas publicaram.

O que realmente acontece: **esses perfis pararam de ser agendados** entre 20 e 25/08 (confirmado pela sessão da fila: itens cancelados em 25/08, arquivados em 27/08, zero itens na fila hoje, e 135/135 publicações com `creation_id` e permalink real do Instagram). Como a janela de coleta é de 4 dias, o vazio recente é legítimo.

Duas consequências:

1. O discriminador do P1 ("publicou na janela?") já trata esse caso corretamente — eles não entram em retry, porque de fato não publicaram.
2. Reforça o **P2**: existe dado histórico real na Zernio (15–25/08) que a janela de 4 dias nunca vai buscar. O período de 30 dias da dashboard ficaria mais completo com um ciclo largo.

### P4 — Observabilidade

Registrar por ciclo: perfis com `dailyData` vazio, itens que entraram em retry, itens recuperados na segunda passada, e tempo em que o analytics rodou degradado por pressão. Expor na página de operação. Sem isso, a diferença entre "a Zernio não tem" e "a gente perguntou cedo demais" continua invisível — foi exatamente o que levou a um diagnóstico inicial errado.

---

## 4. Ordem de execução sugerida

1. **P0 + P1** juntos — resolvem o buraco de verdade, mudança localizada, sem migração de banco.
2. **P3** — percepção do usuário.
3. **P2** e **P4**.

## 5. Como validar

- Antes/depois: `profiles_with_metrics / selected_profiles` da RPC para "Hoje" e "Últimos 7 dias".
- Contagem de perfis que publicaram no dia **e** não têm linha diária (às 15h eram 342 de 1103; às 16h40, com a fila normalizada, **10**).
- Tempo médio entre a publicação e a linha diária existir.
- Nenhuma regressão no atraso da fila de publicação (métrica da outra sessão — só observar, não mexer).

## 6. Deploy e coordenação

**Já feito:**

- commit `2c123e6` — P0, P1 e P3 (código, testes, plano, migração 339 e seu pgTAP);
- commit `00306c6` — versiona as migrations 335-338, que estavam aplicadas em produção e fora do git;
- migração 339 **aplicada no banco em nuvem** (`supabase db push`, 30/08). Verificada em produção: a RPC devolve `profiles_pending_collection` 10 (hoje), 13 (7 dias) e 14 (30 dias), batendo com o cálculo independente feito pela API.

**Ainda falta para o P0/P1 entrarem em vigor:**

- deploy da rota `/api/internal/profile-analytics-refresh-dispatch` na Vercel;
- restart dos workers `athena-vps-profile-analytics-direct-1` e `athena-vps-profile-analytics-1` na VPS com o código novo.

A migração sozinha é inofensiva para a versão em produção da aplicação: o cliente antigo não lê os campos novos e continua exibindo o texto anterior.

**Pedido da sessão da fila (30/08, ~16:15 UTC):** segurar o analytics contínuo até ~17:30 UTC, para não contaminar a janela de medição do efeito de `PUBLICATION_WORKER_STAGED_DISPATCH_CONCURRENCY=64`. É preferência, não bloqueio — mas como o deploy é ação manual, basta não subir antes disso.

**Combinado sobre a Zernio:** as duas frentes vão aumentar chamadas ao provedor ao mesmo tempo (a fila subiu limite 44→100 e concorrência 32→64). Orçamento medido pela outra sessão: 2.213 publicações/hora em 1.087 chaves, pico de 4/hora por chave contra o teto de 25/hora — ~16% do limite. Se aparecer **429 da Zernio**, avisar a outra sessão antes de recuar sozinho, porque agora existem duas causas possíveis.

## 7. Registro de alterações

| Data | O que mudou |
|---|---|
| 2026-08-30 | Documento criado com diagnóstico e plano P0–P4. Nenhum código alterado. |
| 2026-08-30 | P2: script de reparo criado, bug de paginação não determinística encontrado no próprio script (7.151 lidas / 6.942 distintas), corrigido, e a premissa do item refutada — 0 lacunas reais. Janela larga na primeira coleta revertida por falta de justificativa. 7 linhas gravadas. |
| 2026-08-30 | Medida a distribuição de atraso (26.025 itens): limiar de 900s ainda degradaria 71% do tempo → limiar do analytics fixado em 1200s e degradação por porcentagem. P0 implementado. |
| 2026-08-30 | P1 implementado. Discriminador trocado de "posts do ciclo" para "publicou na janela" após medir que a Zernio devolve vazio nas duas chamadas durante o priming. |
| 2026-08-30 | Descoberto o bucket P5 (contas que a Zernio não reconhece, ~36 perfis). |
| 2026-08-30 | `lib/database-pressure-controls.test.ts` atualizado: o contrato do analytics passou de "pausa" para "degrada", preservando a intenção original de respeitar pressão. |
| 2026-08-30 | Limiar recalibrado de 1200s para **600s** após a sessão da fila medir a janela pós-correção (max=597s): 1200s nunca dispararia. |
| 2026-08-30 | P5 descartado: `overview.totalPosts` é escopado pela janela da consulta; a Zernio tem a analytics dessas contas. Elas apenas pararam de ser agendadas. |
| 2026-08-30 | P3 implementado, incluindo a migração 339 (não aplicada). Suíte completa: 362 testes, 0 falhas. |
| 2026-08-30 | Migração 339 validada em banco local descartável (Docker), coberta por pgTAP próprio, aplicada em produção e conferida contra dado real. Commits `2c123e6` e `00306c6`. |
| 2026-08-30 | Cobertura de "Hoje" subiu sozinha de 598/1105 (15h) para 1051/1103 (16h40) **conforme a fila normalizou** — confirmação empírica de que o buraco era vazão de coleta, não dado ausente. Atribuição: o intervalo acumula três mudanças da sessão da fila (correção do staging, limite 44→100, concorrência 32→64) e a drenagem do arquivo frio; **não dá para isolar qual delas destravou** — registrar como "fila normalizada", nunca como efeito de um commit específico. |

# Plano — Incidente do agendador travado (29/08/2026) e prevenção definitiva

**Data:** 2026-08-29
**Gatilho:** agendamentos criados por volta das 00:00 BRT (03:00 UTC) ficaram travados até depois das 03:00 BRT. Alguns perfis publicaram, outros não. Itens "sumiram da lista", o usuário reagendou achando que tinha falhado, e a fila ficou engasgada.
**Status:** diagnóstico concluído e confirmado com dados de produção. Correção e contenção pendentes de execução.

---

## 1. O que realmente aconteceu

Não foi o despacho (o pipeline corrigido no plano de 28/08). Foi a **geração em massa** — a etapa que expande um plano de rotação em `publication_items`.

### 1.1 Sintoma medido em produção (29/08, 11:00 UTC)

Planos ativos ordenados por `created_at`, com o horário do último progresso real de geração:

| Criado (UTC) | Org | Plano | Gerado / Esperado | Último progresso |
|---|---|---|---:|---|
| 08-27 23:31 | Pomodoro | 27-08 GGBIEL RRELS | 14.544 / 15.960 | **10:32** ✅ |
| 08-27 23:32 | Pomodoro | 27-08 LAURINHA REELS | 28.731 / 30.096 | **10:33** ✅ |
| 08-29 03:03 | Vini | Lexy / 29/08 / Reels | 25.131 / 32.904 | **10:42** ✅ |
| 08-29 03:04 | Vini | GGigor / 29/08 / Reels | 13.296 / 17.496 | **10:52** ✅ |
| 08-29 03:05 | Vini | GGigor / 29/08 / Storie | 623 / 729 | **10:58** ✅ |
| 08-29 03:05 | Vini | Igor / 29/08 / Reels | 879 / 1.152 | 09:50 |
| 08-29 03:06 | Vini | Igor / 29/08 / Story | 32 / 48 | 05:01 |
| 08-29 03:07 | Vini | Julio / 29/08 / Reels | 162 / 216 | 09:51 |
| 08-29 03:30 | Pomodoro | 28-08 LEXY REELS pt2 | 2.483 / 7.200 | 09:57 |
| 08-29 03:31 | Pomodoro | 28-08 LEXY STORY PT2 | **0 / 100** | **NUNCA** |
| 08-29 03:45 | Pomodoro | 28-08 JULIO REELS PT2 | **0 / 2.376** | **NUNCA** |
| 08-29 03:46 | Pomodoro | 28-08 JULIO STORY PT2 | **0 / 33** | **NUNCA** |
| 08-29 03:56 | Vini | Lexy / 29/08 / Story | **0 / 1.371** | **NUNCA** |
| 08-29 05:33 | Vini | Laurinha / 29/08 / Reels | **0 / 32.976** | **NUNCA** |
| 08-29 05:41 | Vini | Lexy / 29/08 / Storie | **0 / 1.371** | **NUNCA** |
| 08-29 05:42 | Vini | Laurinha / 29/08 / Story | **0 / 1.374** | **NUNCA** |
| 08-29 05:44 | Vini | Julio / 29/08 / Reels | **0 / 216** | **NUNCA** |
| 08-29 05:44 | Vini | Julio / 29/08 / Story | **0 / 9** | **NUNCA** |

A fronteira é perfeita e cai exatamente na ordem de criação: **tudo que foi criado depois de 03:31 UTC gerou literalmente zero item em mais de 7 horas.**

### 1.2 Causa raiz — inanição por ordenação estrita (head-of-line blocking)

`public.claim_bulk_rotation_generation_chunks` ([303_structural_database_pressure_controls.sql](../supabase/migrations/303_structural_database_pressure_controls.sql)) seleciona os chunks a processar com:

```sql
order by plan.created_at, plan.id, profile_plan.ordinal, chunk.chunk_ordinal, chunk.id
for update of chunk skip locked limit p_limit
```

`p_limit` vem de `PUBLICATION_GENERATION_WORKER_BULK_CHUNK_LIMIT`, **cujo valor em produção é 1**. Ou seja: **um chunk por ciclo, sempre o do plano mais antigo que ainda tem trabalho disponível.**

Isso é prioridade absoluta por idade, sem nenhuma forma de rodízio. Enquanto qualquer plano antigo tiver um único slot elegível, nenhum plano novo recebe um ciclo sequer.

### 1.3 Por que os planos antigos nunca "acabam"

`process_bulk_rotation_generation_chunk` só materializa slots dentro de um **horizonte de 48 horas**:

```sql
horizon_slot_exclusive := floor(extract(epoch from ((now() + interval '48 hours') - schedule_base_at)) / 60 / interval_minutes);
range_end := least(range_start + p_step_size, chunk.slot_start + chunk.slot_count, horizon_slot_exclusive);
```

Para um plano de rotação horária (`interval_minutes = 60`), cada perfil ganha **exatamente 1 slot novo por hora**, para sempre, até o plano terminar seus 3–5 dias. Um plano de 457 perfis, portanto, gera 457 unidades de trabalho novas **toda hora**, indefinidamente.

Os planos antigos nunca ficam ociosos. A fila de prioridade nunca drena. Os novos nunca são alcançados.

### 1.4 Por que a capacidade não sobra

O custo é de **uma ida e volta ao banco por item gerado**:

- ciclo do worker: `PUBLICATION_GENERATION_WORKER_POLL_INTERVAL_MS = 2000` (2s)
- 1 chunk reivindicado por ciclo (`BULK_CHUNK_LIMIT = 1`)
- por causa do horizonte, o chunk quase sempre tem **1 slot novo** disponível — confirmado no heartbeat ao vivo: `lastProcessedItems: 1`, apesar de `currentStep: 25`
- mais `250 ms` de cooldown adaptativo entre fatias

**Teto de capacidade: ~1.800 itens/hora.**
**Vazão medida ao vivo (amostra de 90s): 1.555 itens/hora (0,43 item/s).**

A demanda em regime permanente da frota (≈1.261 perfis com rotação horária) é da mesma ordem de grandeza que o teto. O gerador roda a ~86% da capacidade só para manter os planos antigos em dia. **Não sobra folga para plano nenhum novo.**

Backlog atual: **59.706 itens**. ETA nesse ritmo: **38,4 horas**.

### 1.5 Por que "alguns perfis postaram e outros não"

Dentro de um mesmo plano, os chunks são ordenados por `profile_plan.ordinal`. A geração avança perfil a perfil.

Em `28-08 LEXY REELS pt2`: **46 perfis com itens gerados, 54 perfis com zero**. Não é aleatório — é o corte exato de onde o gerador parou. Os primeiros perfis da lista publicaram; os últimos nunca chegaram a existir na fila.

### 1.6 Por que "sumiu da lista"

O `batch` é criado imediatamente e aparece; os `publication_items` só existem depois da geração. Um plano travado deixa um lote com **zero itens** — invisível na tela de fila.

Pior: a tela `/queue` mostra um painel de geração que consulta `publication_generation_jobs` ([app/api/publication-generation-jobs/route.ts](../app/api/publication-generation-jobs/route.ts)) — tabela **legada e vazia** (0 linhas em produção). O componente que de fato lê `bulk_publication_plans` (`BulkPlanProgressFeed`) só é renderizado em `/postagem` ([app/postagem/publishing-client.tsx:369](../app/postagem/publishing-client.tsx)), com `limit=12` e ordenado por `updated_at` — e havia 18 planos ativos.

**Na tela onde o usuário procura a fila, não existe nenhuma indicação de que 8 planos estão parados.** Daí o reagendamento.

### 1.7 O dano do reagendamento

O usuário recriou os agendamentos. Como a chave de idempotência é `bulk:{plan_id}:{profile_id}:{slot_index}`, planos diferentes **nunca deduplicam entre si**.

Duplicata real confirmada (mesma organização, mesmo grupo, mesma base, mesmo intervalo, mesmas mídias):

| Criado | Plano | id |
|---|---|---|
| 08-29 03:56 | Lexy / 29/08 / Story | `83d3116b-5808-45ad-9f4f-34f500b7cd5e` |
| 08-29 05:41 | Lexy / 29/08 / Storie | `8b3651de-4633-461f-b159-ebf143d55a6c` |

Ambos: 457 perfis × 3 slots, `schedule_base_at = 2026-08-28T10:00:00Z`. Se os dois gerarem, **cada perfil Lexy recebe dois stories idênticos por dia, por 3 dias**.

Os demais planos recriados são distintos (grupos/mídias diferentes) e não duplicam.

### 1.8 Risco de publicação atrasada ainda não materializado

Sete planos travados, quando alcançados, criarão itens com `execute_at` **já vencido**:

| Plano | execute_at do próximo slot | Atraso |
|---|---|---:|
| 28-08 JULIO REELS PT2 | 08-29 04:45 | 373 min |
| 28-08 LEXY STORY PT2 | 08-29 05:00 | 359 min |
| 28-08 JULIO STORY PT2 | 08-29 05:15 | 344 min |
| Laurinha / 29/08 / Reels | 08-29 06:33 | 266 min |
| Lexy / 29/08 / Story | 08-29 10:00 | 59 min |
| Lexy / 29/08 / Storie | 08-29 10:00 | 59 min |
| Laurinha / 29/08 / Story | 08-29 10:00 | 59 min |
| Julio / 29/08 / Story | 08-29 10:00 | 59 min |

Desde a [315_stage_publications_without_internal_discard.sql](../supabase/migrations/315_stage_publications_without_internal_discard.sql), o descarte automático por atraso foi **removido de propósito** (para nunca perder publicação por contenção interna). A consequência não prevista: **item vencido criado tarde é publicado tarde, sem limite.**

Verificado às 11:00 UTC: `0` itens elegíveis para publicação atrasada **neste instante** — o dano ainda não começou. Ele começa assim que a geração alcançar esses planos.

### 1.9 Achado independente — 182 itens zumbis (a "fila parada na Pomodoro")

`claim_publication_items` exige, para itens em `failed`:

```sql
and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
```

Itens que terminam em `failed` com `next_attempt_at = NULL` e `attempt_count < 5` **nunca mais podem ser reivindicados** — e também não são um estado terminal fechado. Ficam na fila para sempre.

**182 itens nessa condição, 181 deles na organização Pomodoro**, com datas desde 25/08:

| Motivo | Qtd |
|---|---:|
| `user_content` | 141 |
| `zernio_creation_outcome_unknown` | 12 |
| `platform_error` | 8 |
| `zernio_recovery_confirmation_timeout` | 7 |
| `57014` (statement timeout) | 5 |
| `zernio_processing_timeout` | 4 |
| outros | 5 |

São falhas terminais reais, mas ficam visíveis como fila ativa porque nunca foram arquivadas. É isso que o usuário vê como "fila de postagem parada até aqui na Pomodoro". `clean_publication_queue_finished` ([270](../supabase/migrations/270_fix_instagram_queue_cleanup_and_cancellation.sql)) já arquiva esse estado — só nunca foi acionado.

---

## 2. Contenção imediata (antes de qualquer mudança de código)

Ordem importa. Cada passo é reversível.

- [ ] **C1.** Pausar (`set_bulk_rotation_plan_generation_hold`) os 7 planos que produziriam itens vencidos. Reversível; não apaga nada; impede que a correção de vazão dispare uma onda de publicações atrasadas.
- [ ] **C2.** Decidir e cancelar um dos dois planos duplicados de Lexy Story.
- [ ] **C3.** Para cada plano pausado, rodar `advance_bulk_rotation_cursor_past_cutoff(plan_id, nome_exato, cutoff = agora, dry_run = true)` e conferir; depois `dry_run = false`. Isso pula os slots vencidos **sem criar `publication_items`** — exatamente o "não postar o que já passou do horário".
- [ ] **C4.** Arquivar os 182 itens `failed` zumbis via `clean_publication_queue_finished` na Pomodoro e na Vini.
- [ ] **C5.** Despausar os planos e confirmar que voltam a gerar apenas slots futuros.

---

## 3. Correção estrutural

### Fase 1 — Acabar com a inanição (obrigatória)

- [ ] **1.1** Nova migration: trocar a ordenação estrita por **rodízio justo entre planos** em `claim_bulk_rotation_generation_chunks`. Usar `row_number() over (partition by chunk.plan_id order by profile_plan.ordinal, chunk.chunk_ordinal)` e ordenar por essa posição **antes** de `plan.created_at`. Assim, todo plano ativo recebe um chunk por rodada; a idade só desempata dentro da mesma posição. Mesmo padrão de justiça que `claim_publication_items` já usa por organização/perfil.
- [ ] **1.2** Garantia dura: nenhum plano ativo pode ficar mais de N minutos sem progresso. Priorizar explicitamente planos com `generated_publications = 0` — um plano que nunca gerou nada é o pior caso possível de experiência.

### Fase 2 — Quebrar o teto de ~1.800 itens/hora (obrigatória)

O gargalo não é o banco; é o formato do trabalho: uma chamada RPC por item.

- [ ] **2.1** Subir `PUBLICATION_GENERATION_WORKER_BULK_CHUNK_LIMIT` de `1` para um valor ≥ 25, e processar os chunks reivindicados em paralelo limitado (o worker já tem `mapWithConcurrency`).
- [ ] **2.2** Nova RPC que materializa **um slot para N perfis do mesmo plano numa única instrução** (`insert ... select` sobre o conjunto de perfis), em vez de N chamadas de 1 slot. É a mesma transformação de "cursor linha a linha → orientado a conjunto" que resolveu o cancelamento em lote na [323](../supabase/migrations/323_batch_cancel_publication_queue_items.sql). Respeitar o teto de `statement_timeout` (~8s) processando em blocos limitados, como a [324](../supabase/migrations/324_chunk_large_publication_queue_cancellations.sql).
- [ ] **2.3** Medir de novo e fixar um número: capacidade alvo mínima de **10.000 itens/hora**, com folga de pelo menos 5× sobre a demanda em regime permanente da frota.

### Fase 3 — Nunca publicar atrasado (obrigatória)

Hoje há duas metades incompatíveis: a geração pode criar item vencido, e o despacho não tem mais limite de atraso.

- [ ] **3.1** Na geração: nunca materializar slot com `execute_at < now()`. Avançar o cursor e registrar evento de auditoria (`slot_skipped_overdue`). É a política que hoje só existe como operação manual (`advance_bulk_rotation_cursor_past_cutoff`) — passa a ser automática e invariante.
- [ ] **3.2** No despacho: reintroduzir uma **tolerância máxima de atraso configurável** (proposta: 30 min, por organização), aplicada **somente** a itens sem `creation_id`. Item aceito pelo provedor continua sempre reconciliável — a invariante da 315 é preservada. Passando da tolerância, o item vira `ignored` com motivo explícito e auditável, nunca é publicado.
- [ ] **3.3** Teste pgTAP cobrindo: item vencido além da tolerância não é reivindicado nem publicado; item vencido **com** `creation_id` continua reconciliável.

### Fase 4 — Tornar o travamento impossível de passar despercebido (obrigatória)

O incidente durou 3 horas porque nada gritou, e escalou porque o usuário não tinha como saber.

- [ ] **4.1** Renderizar o progresso real dos planos (`BulkPlanProgressFeed`) **na tela `/queue`**, não só em `/postagem`. Remover o painel morto que lê `publication_generation_jobs`.
- [ ] **4.2** Estado explícito na fila: um lote com plano ativo e zero itens deve aparecer como **"Gerando… X de Y"**, com o horário do último progresso. Nunca como lista vazia.
- [ ] **4.3** Alerta operacional: plano ativo sem progresso por mais de 15 minutos vira alerta crítico em `operational_alerts`. Idem para plano com `generated_publications = 0` há mais de 10 minutos.
- [ ] **4.4** Bloquear a duplicata na origem: ao confirmar um plano, recusar (ou exigir confirmação explícita) quando já existir plano ativo com a mesma assinatura `(organização, grupo, formato, schedule_base_at, interval_minutes, slots_per_profile)`. A `request_key` existente não cobre esse caso.

### Fase 5 — Fechar o estado zumbi

- [ ] **5.1** Migration: item em `failed` com `attempt_count < 5` e `next_attempt_at is null` é, por definição, terminal. Marcar explicitamente (coluna ou status) para que nunca mais apareça como fila ativa.
- [ ] **5.2** Rotina recorrente de arquivamento das falhas terminais já reconhecidas, para a fila não acumular ruído permanente.

---

## 4. Invariantes que a correção deve garantir

1. Nenhum plano ativo pode ficar sem progresso enquanto outro plano gera — rodízio, nunca prioridade absoluta.
2. Nenhum item é criado com horário já vencido.
3. Nenhum item sem `creation_id` é publicado além da tolerância de atraso configurada.
4. Item com `creation_id` é sempre reconciliável — nunca descartado (invariante herdada da 315).
5. Todo lote com plano ativo é visível na fila com progresso real, mesmo com zero itens.
6. Dois planos ativos com a mesma assinatura não coexistem sem confirmação explícita.
7. Nenhum item fica em estado que não é nem reivindicável nem terminal.

---

## 5. Sobreposição entre lotes do mesmo tipo — investigado a fundo

**Pergunta:** dois lotes do mesmo formato, para os mesmos perfis, agendados enquanto a fila estava travada, podem se intercalar e postar em intervalo menor que o configurado (ex.: um lote às 03/04/05 e outro às 03:30/04:30/05:30)?

**Resposta: para Reels e demais formatos em modo intervalo, NÃO — o encadeamento já existe e funciona. Para Stories em modo diário, existe um buraco.**

### 5.1 Modo intervalo (Reels/Imagem) — protegido

`create_bulk_rotation_plan_v2` ([177_scope_bulk_horizons_by_publication_format.sql](../supabase/migrations/177_scope_bulk_horizons_by_publication_format.sql)) calcula a base de cada perfil assim:

```sql
active_last   := max(item.execute_at) dos itens ATIVOS daquele perfil NAQUELE formato;
reserved_last := max(horizon.reserved_through) dos horizontes ATIVOS de planos DAQUELE formato;
schedule_base := greatest(now, active_last, reserved_last);
```

O ponto decisivo: a **reserva de horizonte** (`bulk_publication_profile_horizons`) é criada no momento da confirmação do plano, cobrindo o período inteiro — **mesmo que nenhum item tenha sido gerado ainda**. Então um lote criado enquanto o anterior estava travado em "gerando" mesmo assim enxerga a reserva do anterior e começa **depois** dele.

**Prova com dado real do incidente** (exatamente o cenário do reagendamento):

| Plano | Criado | 1º post | Último post |
|---|---|---|---|
| Julio / 29/08 / Reels | 08-29 03:07 | 08-29 04:07:29 | 09-01 03:07:29 |
| Julio / 29/08 / Reels *(recriado durante o travamento)* | 08-29 05:44 | **09-01 04:07:29** | 09-04 03:07:29 |

O segundo começa exatamente **um intervalo depois** do fim do primeiro. Somou-se à fila, não se intercalou.

**Prova empírica sobre a fila inteira:** varredura de **90.668 itens futuros**, agrupados por `(perfil, formato)` e ordenados por horário — **zero** casos de dois itens de lotes diferentes se intercalando. Todos os 3 pares de planos ativos que compartilham perfis (os três planos "Julio" do grupo `7be0fa22`) estão encadeados corretamente.

Cuidado ao interpretar: `origin_group_id` é o **grupo de mídia**, não o grupo de perfis. `GGigor / 29/08 / Reels` e `Igor / 29/08 / Reels` usam o mesmo grupo de mídia `29f22ff6` e se sobrepõem no tempo, mas têm **0 perfis em comum** (226 e 16). Não é colisão.

### 5.2 Modo diário (Stories) — buraco real

`create_bulk_daily_rotation_plan` ([174_daily_bulk_schedule_starts_from_requested_calendar_time.sql](../supabase/migrations/174_daily_bulk_schedule_starts_from_requested_calendar_time.sql)) chama o criador encadeado e, **logo depois, sobrescreve** `schedule_base_at` e a reserva de horizonte com o horário diário fixo:

```sql
update public.bulk_publication_plan_profiles
set schedule_base_at = first_daily - interval '1 day', first_execute_at = first_daily, ...
update public.bulk_publication_profile_horizons
set reserved_from = first_daily - interval '1 day', ...
```

O encadeamento é descartado. Dois planos diários do mesmo formato para os mesmos perfis produzem itens **no mesmo instante exato**. Foi o caso dos dois planos de story da Lexy (ambos com base `08-28T10:00Z`).

Consequência: não é post duplicado — `enforce_active_publication_slot_uniqueness` bloqueia dois itens ativos com o mesmo `(organização, perfil, formato, execute_at)`. Mas o insert falha com `23505`, `process_bulk_rotation_generation_chunk` levanta "Conflito de idempotência ao materializar chunk compacto", e **o segundo plano trava para sempre** — mais um modo silencioso de engasgo.

- [ ] **5.2.1** Fazer o modo diário respeitar o encadeamento: quando já existe plano/horizonte ativo do mesmo formato para o perfil, o primeiro slot diário deve ser o primeiro horário diário **posterior** ao fim da reserva existente, em vez do próximo horário diário absoluto.
- [ ] **5.2.2** Recusar a criação (ou exigir confirmação explícita) quando a assinatura `(organização, perfis, formato, daily_time)` já existir em plano ativo — hoje só a `request_key` protege, e ela muda a cada clique.

---

## 6. Registro de execução

### 29/08/2026 — contenção e correção estrutural (sessão Claude Code)

**Contenção (tudo reversível, nesta ordem):**
1. Pausados os 8 planos que produziriam itens vencidos, via `set_bulk_rotation_plan_generation_hold` — 8/8 OK.
2. Cancelados 3 planos, conforme decisão do usuário: `28-08 LEXY STORY PT2` e `28-08 JULIO STORY PT2` (1 slot por perfil, já vencido → o plano ficaria vazio) e `Lexy / 29/08 / Story` de 03:56 (duplicata do de 05:41). Usado o executor oficial `execute_server_publication_queue_cancellation`. Os 3 lotes tinham 0 itens; fechados como `cancelled`.
3. **Efeito colateral a registrar:** ao tentar limpar as falhas terminais, `clean_publication_queue_finished` arquivou ~10.000 itens já **encerrados** (published/cancelled/ignored) antes de chegar nas falhas — a função gasta o orçamento com encerrados primeiro, e havia ~155k deles pendentes de limpeza. É o mesmo efeito do botão "Limpar encerradas", não é destrutivo (só marca `archived_at`), mas não foi pedido. Os 182 zumbis **não** foram arquivados.

**Correção estrutural:**
4. [326_fair_bulk_generation_and_no_overdue_slots.sql](../supabase/migrations/326_fair_bulk_generation_and_no_overdue_slots.sql) escrita, testada localmente (Docker + `supabase db reset` com as 326 migrations do zero) e **aplicada em produção** junto com a 325 pendente de outra sessão (decisão do usuário).
   - Teste [326_fair_bulk_generation_and_no_overdue_slots.test.sql](../supabase/tests/326_fair_bulk_generation_and_no_overdue_slots.test.sql): **15/15 passa**.
   - Falhas pré-existentes confirmadas por baseline (mesmo resultado com e sem a 326): `086` (fixture insere em coluna gerada), `088`/`090` ("permission denied for schema auth"), `091` (sem plano TAP), `303` (afirma sobre string removida pela migration 315). `304` passa nos dois cenários.
5. Despausados os 5 planos que devem continuar. Atenção: `set_bulk_rotation_plan_generation_hold` só restaura chunks cuja `last_error_message` casa **exatamente** com `'Pausa operacional: ' || motivo` — despausar com motivo diferente do usado na pausa restaura 0 chunks silenciosamente. 1.407 chunks restaurados na segunda tentativa.

**Verificação pós-correção:**
- Justiça funcionando: o progresso passou a se dividir entre planos diferentes na mesma janela (antes era 100% do plano mais antigo). Os 5 planos famintos saíram de 0 imediatamente após o despause (prioridade de inanição).
- `itens ativos com horário já vencido: 0`.
- `colisões entre lotes distintos: 0` em 90.668 itens futuros.
- Contador `ignored_publications` subindo nos planos atrasados (7, 6, 1, 1, 1) — são os slots vencidos sendo pulados sem virar publicação, exatamente como desenhado.

**Vazão (Fase 2, parcial):**
6. `PUBLICATION_GENERATION_WORKER_BULK_CHUNK_LIMIT` alterado de `1` para `25` em `/opt/athena-worker/.env.worker` (backup em `.env.worker.before-326-chunk25`) e `athena-generation-worker` reiniciado.
   - Vazão medida antes: **1.198 itens/hora**. Depois: **211.696 itens/hora**. ETA do backlog caiu de ~48h para ~12 minutos.
   - VPS após a mudança: load average **0,37**, memória folgada, nenhum erro novo no log do worker. O gargalo nunca foi o banco — era o formato do trabalho (uma ida e volta por item).
   - Falta ainda a Fase 2.2 (materializar um slot para N perfis numa única instrução), mas com 25 chunks por ciclo ela deixou de ser urgente.

**Fase 5 — estado zumbi fechado:**
7. [327_archive_terminal_publication_failures.sql](../supabase/migrations/327_archive_terminal_publication_failures.sql): nova RPC `clean_publication_queue_terminal_failures`, que arquiva **apenas** falhas terminais (`status = 'failed'` e `(next_attempt_at is null or attempt_count >= 5)` — exatamente a condição que `claim_publication_items` usa para recusar o item), com janela de acomodação configurável (padrão 15 min) para nunca cancelar um retry legítimo por corrida. Índice parcial incluído.
   - Teste [327_archive_terminal_publication_failures.test.sql](../supabase/tests/327_archive_terminal_publication_failures.test.sql): **11/11 passa**, cobrindo os dois lados (o que é terminal é arquivado; retry vivo, `waiting` e `published` não são tocados).
   - Aplicada em produção. **182 falhas terminais arquivadas** (181 Pomodoro, 1 Vini), restante 0. O status `failed` desapareceu por completo da fila ativa.

**Verificação final em produção (29/08, ~12:00 UTC):**

| Métrica | Resultado |
|---|---|
| Itens futuros ativos | 114.805 |
| Colisões entre lotes distintos (mesmo perfil + formato) | **0** |
| Itens ativos com horário já vencido | **0** |
| Falhas zumbis na fila | **0** |
| Sinal de pressão | `criticalDelay = false` |
| Restante a gerar | 31.906 (≈10 min no ritmo atual) |

Os contadores `ignored_publications` dos planos atrasados (Laurinha Reels 2.040, LEXY REELS pt2 432, Laurinha Story 334, Lexy Storie 338, JULIO REELS PT2 263) são os slots vencidos sendo **pulados sem virar publicação** — exatamente o comportamento pedido: o que passou do horário não é postado atrasado.

**Pendências conhecidas:** ver a seção 7, que as resolveu na mesma sessão.

---

## 7. Segunda rodada — fim do horizonte de 48h, piso de intervalo e visibilidade

**Gatilho:** com a fila destravada, ficou visível que o gerador estava **ocioso** (`claimedChunks: 0` em todo ciclo) com **24.350 itens ainda por gerar**, e que **todo** plano ativo tinha o último item colado em `agora + 48h` — nenhum materializado até a data pedida. O usuário identificou a causa: a janela móvel de 48h.

### 7.1 O horizonte era o problema, não uma proteção

- Introduzido **só** na migration `303` (28/08), dentro de uma migration chamada "Controles estruturais de pressão". Justificativa documentada: reduzir WAL e evitar `statement_timeout`. Custo de banco, nada mais.
- As migrations `084`, `086`, `196` e `207` **não têm horizonte**. O sistema gerou planos inteiros de 084 até 303.
- Prova em produção: o lote `27-08 GGBIEL RRELS` (15.960 itens) foi gerado **inteiro em ~2 minutos** em 27/08 — `created_at` dos itens do slot 119 entre `23:32` e `23:33`, com o plano criado `23:31:29`.
- Efeito colateral central: cada plano de rotação horária ganhava 1 slot por perfil por hora, **para sempre**. O gerador nunca ficava ocioso e disputava banco permanentemente com as publicações do momento.
- O custo por transação nunca dependeu dele: `p_step_size` continua limitado a 100 slots por chamada.

### 7.2 Escopo — fila de postagem intocada

Por decisão explícita do usuário, esta rodada mexe **apenas** na fila de agendamento/geração e nas telas. Nada de `claim_publication_items`, staging, `180/min` ou `publication-worker.mjs`. A **Fase 3.2** (tolerância de atraso no despacho) foi **removida do escopo** e não será feita aqui.

Medição que embasou a decisão: a fila de postagem publicava ~1.500–1.780/hora com **zero** itens atrasados e `criticalDelay=false` — no ritmo da demanda, não travada. O `STAGING_LIMIT=100` já pré-carrega ~1.200 itens/min contra um teto de consumo de 180/min, então subir para 200 não mudaria nada.

### 7.3 O que foi implantado

[328_generate_full_plan_and_space_conflicting_slots.sql](../supabase/migrations/328_generate_full_plan_and_space_conflicting_slots.sql), com [teste pgTAP 12/12](../supabase/tests/328_full_plan_generation_and_spacing_window.test.sql):

1. **Horizonte removido** de `claim_bulk_rotation_generation_chunks` e `process_bulk_rotation_generation_chunk`. O fim do próprio plano (`segment_end`) passa a ser o único limite. Rodízio entre planos e faixa de prioridade para plano faminto (da `326`) preservados intactos.
2. **Janela de espaçamento de 10 minutos**, exigida pelo usuário: um slot que caia a menos de 10 minutos de um post ativo do mesmo perfil e formato **vindo de outro lote** é pulado e contabilizado como ignorado. Antes, esse caso levantava `23505` e **travava o lote inteiro para sempre** (foi o que aconteceu com os dois lotes de Story da Lexy). A verificação `materialized_count` passou a comparar com o total desejado **após** o filtro. Story continua ancorado no horário pedido — sem encadear, sem regra extra.
3. **Piso de 29 minutos** no intervalo, via constraint `bulk_publication_plans_minimum_interval_check`. Substitui o horizonte como freio de tamanho e protege os perfis. Verificado: nenhum plano jamais usou intervalo abaixo de 50 minutos, então a constraint validou sem reescrever linha alguma. Espelhado em `MIN_BULK_INTERVAL_MINUTES` ([bulk-rotation.ts](../lib/publications/bulk-rotation.ts)), usado pela validação da API e pelo input da UI.

Camada de aplicação (deploy manual via `vercel --prod` — a Vercel **não** está ligada ao GitHub):

4. `lib/publications/bulk-horizon-status.ts` → [bulk-operational-status.ts](../lib/publications/bulk-operational-status.ts). O status sintético `horizon_ready` ("Horizonte abastecido: próximas 48 horas prontas") deixou de existir junto com a janela.
5. **"Agenda e some":** `confirmPlan` não disparava nada que recarregasse o feed, e o `useEffect` tinha deps `[]` com reagendamento **condicionado ao payload anterior** — se não havia plano ativo quando a página abriu, nenhum timer era criado e o feed congelava para sempre. Agora há um `refreshSignal` que sobe no confirm, e o polling **sempre** reagenda (só varia o intervalo).
6. **"A ordem não fica correta":** [app/api/bulk-publications/route.ts](../app/api/bulk-publications/route.ts) ordenava por `updated_at`, coluna que o worker bumpa em planos antigos a cada contador — o lote novo era empurrado para baixo e, com `limit=12`, saía da lista. Passou a `created_at desc` (o índice já existia desde a 084) e o limite subiu para 20.
7. **"/queue cega":** `BulkPlanProgressFeed location="queue"` montado em [queue-client.tsx](../app/queue/queue-client.tsx) — o componente já suportava esse modo mas nunca era instanciado. O painel de `publication_generation_jobs` foi mantido (serve o compositor comum acima de 500 itens) e renomeado para "Envios grandes do compositor", para não se confundir com programação em massa.
8. **Aviso de empilhamento** na revisão: quando o primeiro horário sai depois do escolhido, a tela informa que o lote vai começar após o lote existente, com a data. Puramente informativo. **Nenhum bloqueio de lote repetido foi criado** — bloquear impediria agendar mais Reels para um perfil que já tem Reels, que é o comportamento correto.

Testes obsoletos corrigidos em [303_structural_database_pressure_controls.test.sql](../supabase/tests/303_structural_database_pressure_controls.test.sql): a asserção de `ceil(p_limit * 0.25)` (obsoleta desde a 315, já falhava antes desta sessão) e a de `interval '48 hours'` (invertida pela 328). O arquivo voltou a passar 8/8.

**Suíte completa:** 325/325 nos testes JS, `tsc --noEmit` limpo, e SQL `303`, `304`, `326`, `327`, `328`, `232` todos verdes.

### 7.4 Resultado medido em produção (29/08, 12:54 UTC)

| Métrica | Antes da 328 | Depois |
|---|---|---|
| Itens pendentes de geração | 24.350 (worker ocioso) | **0** |
| Vazão durante a drenagem | — | **175.394 itens/hora** |
| Planos ativos travados | 10 | **0** (só resta 1 pausado por perfil offline, anterior) |
| Planos materializados além de agora+48h | 0 | **16** |
| Itens futuros ativos | 114.805 | **140.514** |
| Itens com horário vencido | 0 | **0** |
| Falhas zumbis na fila | 0 | **0** |
| Sinal de pressão | — | `criticalDelay = false` |
| Load da VPS | 0,37 | **0,14** |

Os planos agora alcançam suas datas reais — `Lexy / 29/08 / Reels` até `01/09 03:03`, `27-08 LAURINHA REELS` até `02/09 16:40`, e o `Julio` recriado durante o travamento até `04/09 03:07`, encadeado depois do anterior.

**A confirmação mais importante:** terminada a drenagem, o heartbeat mostra `remainingPublications: 0`, `claimableChunks: 0`, `generatingPlans: 0`. **O gerador ficou ocioso** — não disputa mais banco com as publicações do momento, que era o objetivo central da mudança.

As 3 adjacências entre lotes distintos detectadas na varredura dos 140.514 itens têm gap de **60 minutos** — é a fronteira normal entre lotes encadeados, não sobreposição.

### 7.5 Teto de 7 dias por plano

Fecha a única pendência de tamanho que restava. Com o horizonte fora, a duração passou a definir sozinha quanto é materializado de uma vez, e `duration_days` não tinha limite nenhum — o schema só exige `> 0` ([084:20](../supabase/migrations/084_bulk_rotation_plans_and_atomic_horizons.sql)) e a aplicação só validava inteiro positivo.

[329_cap_bulk_plan_duration_at_seven_days.sql](../supabase/migrations/329_cap_bulk_plan_duration_at_seven_days.sql), com [teste pgTAP 5/5](../supabase/tests/329_cap_bulk_plan_duration_at_seven_days.test.sql), mais `MAX_BULK_DURATION_DAYS = 7` em [bulk-rotation.ts](../lib/publications/bulk-rotation.ts), a validação amigável em [bulk-api.ts](../lib/publications/bulk-api.ts) e `max` nos dois campos de duração da UI (modo intervalo e modo diário).

**Por que gatilho `BEFORE INSERT` e não `CHECK` constraint:** existem **10 planos legítimos acima de 7 dias** em produção, todos concluídos — dois de 20 dias (15/08) e vários de 9 e 10. Uma `CHECK` falharia na validação da tabela; e mesmo declarada `NOT VALID` ela passaria a ser exigida em **qualquer UPDATE** dessas linhas antigas — e `refresh_bulk_rotation_plan_state`, pausa operacional e cancelamento por escopo escrevem em planos existentes. O gatilho preserva o histórico intacto e limita só o que for criado daqui para frente. O teste cobre exatamente isso: uma linha histórica de 20 dias continua atualizável.

Verificado após o deploy: os 10 planos históricos seguem na tabela, `local=329 remote=329`.

### 7.6 Gargalo seguinte, exposto pela remoção do horizonte: a preparação de mídia

Poucas horas depois da 328, o sinal de pressão passou a acusar `overdueUnstarted: true` com **794 itens já vencidos** — todos parados em `preparation_status = 'pending'`. O claim de publicação exige `preparation_status = 'ready'` para item v2 sem `creation_id`, então eles nunca seriam publicados.

**Causa:** `PUBLICATION_WORKER_PREPARATION_LIMIT` estava em **4** — quatro itens por ciclo, exatamente a mesma forma do `BULK_CHUNK_LIMIT = 1` da seção 6. Vazão medida: **960 itens/hora**, contra uma fila de **30.348 itens dentro da janela de 24 h** que a preparação enxerga. Trinta e uma horas de trabalho para uma janela de 24: nunca alcançaria, e o vencido só acumularia.

Não era um bug novo. A vazão sempre foi essa; ficou visível porque, sem o horizonte, os itens passaram a existir todos de uma vez em vez de pingar 1 por perfil por hora.

**Cuidado que mudou a abordagem:** a preparação roda **dentro do laço de despacho** (`preparePublicationQueueDirect` é chamada por `dispatchPublicationQueueDirect`, dentro de `runDispatchCycle`). Subir o limite para centenas travaria o despacho — o mesmo deadlock que a Fase 5 do plano de 28/08 corrigiu para o staging. Mitigante que tornou o ajuste seguro: no mesmo ciclo, `dispatchDueStagedPublications` (itens vencidos, via spool) roda **antes** da preparação.

Por isso o ajuste foi gradual e medido, não um chute alto: `4 → 50`, com backup em `.env.worker.before-prep50`.

| Métrica | Antes | Depois |
|---|---:|---:|
| Vazão da preparação | 960/hora | **7.912/hora** |
| Itens vencidos | 794 | **365 e caindo a 3.062/hora** |
| Fila dentro da janela de 24 h | 30.348 | drenando a 6.721/hora |
| Publicações/hora | 1.943–2.079 | **2.596** |
| Load da VPS | — | 0,26 |

O despacho **não** foi prejudicado: publicou mais, porque passou a ter item preparado disponível. Os 157 `Spool corrompido` no log são históricos (última escrita 10:03 UTC, anterior à mudança), nenhum novo.

Margem em regime permanente: itens vencem a ~2.600/hora e a preparação faz 7.912/hora — 3× de folga.

- [ ] **7.6.1** Considerar mover a preparação para um laço próprio, como foi feito com o staging na Fase 5 do plano de 28/08. Enquanto ela dividir ciclo com o despacho, o limite fica preso a um teto baixo para não atrasar publicação — hoje 50 resolve, mas é um acoplamento que volta a incomodar se a frota crescer.

### 7.7 Pendências que permanecem
- **Contenção de emergência mudou de ferramenta.** Com tudo materializado, `advance_bulk_rotation_cursor_past_cutoff` (que pulava slots vencidos sem criar itens) perde relevância; a contenção passa a ser `ignore_overdue_unstarted_publications` (50 por chamada, manual). Em compensação, o cenário que a exigia — plano parado por horas gerando aos poucos — é justamente o que deixou de existir.
- **Cancelar/limpar lote fica proporcionalmente mais lento**, por haver mais itens materializados. A `324` já resolve por blocos de 1.500; só leva mais tempo de parede.
- **Modo diário não encadeia** ([174:91-101](../supabase/migrations/174_daily_bulk_schedule_starts_from_requested_calendar_time.sql) sobrescreve a base). Por decisão de produto isso **fica como está** — Story posta no horário pedido. A janela de 10 minutos é a proteção escolhida no lugar do encadeamento.
- ~145 mil itens já encerrados seguem pendentes de arquivamento — não afeta o funcionamento.
- **Fila de postagem**: fora do escopo por decisão do usuário, a ser tratada em outra sessão.

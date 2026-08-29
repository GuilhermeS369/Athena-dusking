# Plano — Corrigir cancelamento de fila que trava em filas grandes

**Data:** 2026-08-29
**Gatilho:** usuário tentou cancelar a fila do grupo "GG Lexy" (457 contas, ~15.135 itens ativos) e a operação ficou presa em "Cancelando… 5%" indefinidamente, com a mensagem "Não foi possível confirmar o cancelamento da fila selecionada." reaparecendo a cada poll.

## Status

- [x] Root cause identificada e confirmada empiricamente (não só por leitura de código).
- [x] Incidente da GG Lexy destravado manualmente em produção (ver "Mitigação aplicada em 2026-08-29").
- [x] Correção permanente aplicada em produção: [323_batch_cancel_publication_queue_items.sql](../supabase/migrations/323_batch_cancel_publication_queue_items.sql) + [324_chunk_large_publication_queue_cancellations.sql](../supabase/migrations/324_chunk_large_publication_queue_cancellations.sql).
- [x] Prevenção de operações duplicadas para o mesmo alvo (idempotency key) — parte da migration 323.
- [x] Validação com dados sintéticos em produção (organização isolada, apagada depois) cobrindo bloqueio, cancelamento normal e escala de 20.000 itens — ver "Validação".
- [x] Teste pgTAP formal (`supabase/tests/`) cobrindo o caminho em blocos — ver [324_chunk_large_publication_queue_cancellations.test.sql](../supabase/tests/324_chunk_large_publication_queue_cancellations.test.sql). **Executado localmente** (Docker configurado nesta sessão) contra um Postgres com as 324 migrations aplicadas do zero: 16/16 passou.

## O que estava acontecendo

### Sintoma
Tela de fila mostrava "Cancelando GG Lexy com segurança…" travado em 5% por minutos, sem avançar, intercalado com o erro "Não foi possível confirmar o cancelamento da fila selecionada."

### Causa raiz (confirmada)
`public.cancel_publication_queue_scope` ([187_durable_safe_publication_queue_cancellation.sql](../supabase/migrations/187_durable_safe_publication_queue_cancellation.sql), redefinida em [190](../supabase/migrations/190_fix_scoped_cancellation_organization_identifier.sql)) cancela os itens da fila com um **cursor linha a linha**:

```sql
for item_row in select ... where status in ('waiting','ready','failed','suspended') for update loop
  update publication_items set status='cancelled', ... where id = item_row.id;
  delete from publication_profile_daily_reservations where publication_item_id = item_row.id;
  delete from publication_dispatch_rate_reservations where publication_item_id = item_row.id;
  perform log_publication_item_event(...); -- 1 select + 1 insert
end loop;
```

Cada iteração dispara ~5 instruções SQL. Para um escopo de ~15 mil itens (grupo grande com backlog acumulado), isso é **~75 mil instruções dentro de uma única transação**, chamada por `execute_server_publication_queue_cancellation` ([270](../supabase/migrations/270_fix_instagram_queue_cleanup_and_cancellation.sql)) a partir da rota `POST /api/publications/cancel` ([route.ts](../app/api/publications/cancel/route.ts)).

**Confirmado ao vivo:** reexecutar a mesma RPC (`execute_server_publication_queue_cancellation`) diretamente contra produção, sem nenhum limite de tempo do lado do cliente (fora da Vercel), abortou em **8,8 segundos** com:

```
code: 57014
message: canceling statement due to statement timeout
```

Ou seja, o teto não é o timeout da função serverless da Vercel — é o `statement_timeout` do próprio Postgres/PostgREST para o papel usado. Isso explica por que **toda tentativa aborta e reverte por completo antes de gravar qualquer progresso**: a atualização de `progress = 20` (dentro de `execute_publication_queue_cancellation`, a etapa do plano compacto) só acontece **depois** que `cancel_publication_queue_scope` retorna — e essa função nunca retorna a tempo para um escopo desse tamanho. A operação fica eternamente com o `progress = 5` (valor padrão da coluna, nunca sobrescrito).

### Por que parecia "travado" em vez de simplesmente falhar
A UI (`QueueCancellationProgress` em [queue-client.tsx](../app/queue/queue-client.tsx)) faz poll a cada 3s enquanto `status === 'running'` e chama `resumeCancellationOperation()` → `execute: true` de novo. Como a transação sempre reverte por completo (nunca fica com falha terminal — o código trata isso como "estado preservado para retomar"), o ciclo se repete indefinidamente: nova tentativa, mesmo custo, mesmo timeout, para sempre, enquanto a aba do navegador ficar aberta. Isso também gera carga real e recorrente no banco (lock em milhares de linhas a cada 3s) sem nunca terminar.

Comparação útil: `public.clean_publication_queue_finished` (mesma migration 270, botão "Limpar encerradas" da mesma tela) resolve exatamente esse tipo de problema corretamente — processa em blocos limitados (`limit`, `for update skip locked`), devolve `remaining_finished_count`, e o cliente ([`cleanFinished`](../app/queue/use-publication-queue.ts)) chama de novo até `remaining === 0`. O cancelamento nunca recebeu esse tratamento.

### Fator agravante: operação duplicada
`idempotencyKey` é um `crypto.randomUUID()` novo a cada clique em "Cancelar grupo" ([use-publication-queue.ts](../app/queue/use-publication-queue.ts) `cancelScope`), não uma chave estável por `(scope, targetId)`. Isso permitiu que o mesmo alvo (grupo GG Lexy) acabasse com **duas** linhas em `publication_queue_cancellation_operations` presas em `running`/5% simultaneamente (provavelmente por um segundo clique após a página ter perdido o `localStorage` da primeira tentativa, ou por um reload).

## Mitigação aplicada em 2026-08-29 (produção)

Sem alterar nenhum código, para não arriscar um deploy às pressas:

1. Confirmado que **0 itens** do grupo estavam em `preparing`/`publishing` (nenhuma chamada ao provedor seria interrompida).
2. Reproduzido manualmente, via script pontual com a service-role key, o mesmo efeito do laço linha a linha — porém como updates/deletes **em lote** (por sub-grupos de perfis, sem cursor por item): ~15.090 itens levados a `cancelled`, reservas de capacidade apagadas, evento de auditoria `cancelled` gravado por item (mesma semântica de `log_publication_item_event`).
3. Reexecutada a RPC oficial `execute_server_publication_queue_cancellation` nas duas operações presas — como o escopo já estava vazio, ela concluiu em ~1s cada, cancelou os planos/jobs residuais (nenhum havia), resincronizou os lotes afetados e marcou as duas operações como `completed` / `progress=100` / `verified=true`.
4. Verificado ao final: **0 itens ativos** restantes no grupo; as duas operações com `status='completed'`.

Nenhuma migration foi aplicada, nenhum código foi alterado — só dados corrigidos diretamente, replicando a lógica já existente. Os scripts usados foram temporários e já removidos do working tree.

## Correção permanente implementada

### Migration 323 — reescrita orientada a conjunto (não bastou sozinha)

`cancel_publication_queue_scope` teve os dois cursores linha-a-linha (checagem de bloqueio e cancelamento) trocados por instruções únicas orientadas a conjunto: agregação com `FOR UPDATE` em subconsulta para detectar bloqueio, e um `UPDATE`/`DELETE`/`INSERT` encadeados via `WITH` para cancelar. `begin_publication_queue_cancellation` passou a reaproveitar uma operação `running` já existente para o mesmo `(organização, escopo, alvo)` em vez de criar uma duplicata (mais um índice único parcial `publication_queue_cancellation_operations_one_running_per_target` como reforço contra a corrida). O array `cancelledItemIds` (não usado por nenhum cliente) foi removido do retorno para não crescer sem limite em escopos grandes.

**Isso sozinho não bastou.** Testado com 20.000 itens sintéticos (organização isolada em produção, apagada depois), o mesmo `57014 statement timeout` voltou a acontecer — não pelo cursor (já eliminado), mas porque `publication_items` tem cerca de 20 índices, e uma única instrução mudando 6 colunas (`status`, `cancelled_at`, `next_attempt_at`, `lease_until`, `claimed_by`, `creation_id`) em 20 mil linhas precisa manter todos eles, e só essa manutenção de índice já passa dos ~8s de `statement_timeout`. Isso vale tanto para `UPDATE` quanto para `DELETE` (confirmado à parte: apagar só 5 linhas de `publication_items` levou ~5s, ver nota abaixo) — o teto é por *quantidade de linhas mutadas num único statement*, não pela forma da instrução. `statement_timeout` limita o tempo de UM statement/transação; a única forma de fazer mais trabalho do que cabe em 8s é dividir em várias chamadas separadas, cada uma com seu próprio orçamento de tempo.

### Migration 324 — divisão em blocos entre chamadas

- Nova função `cancel_publication_queue_scope_chunk(scope, targetId, chunkSize=1500)`: trava e processa só os próximos 1500 itens mais antigos do escopo por chamada (`ORDER BY created_at, id LIMIT ... FOR UPDATE`), devolvendo quantos itens restam.
- `execute_server_publication_queue_cancellation` agora mede o volume pendente primeiro (consulta agregada barata); se ultrapassar 1500 itens, processa só um bloco, grava progresso real em `operation.result` (`totalCancelableItemsAtStart`, `cancelledSoFar`, `remainingCancelableItems`) e devolve a operação como `running` — o polling de 3s que a UI já tinha chama de novo sozinho até esvaziar. Escopos que cabem numa chamada continuam exatamente como antes (nenhuma mudança de comportamento para o caso comum).
- Um bloco que encontra algo em `preparing`/`publishing` não cancela nada *nessa chamada*, mas a operação continua `running` (não vira um estado terminal de erro) — como o dispatcher tende a liberar o item sozinho em segundos, o próximo poll normalmente já consegue avançar. Isso é uma mudança de semântica deliberada: bloquear a operação inteira sempre que qualquer item do escopo estiver em voo tornaria um grupo grande e ativo praticamente impossível de cancelar por completo.
- **Mudança de contrato que não estava no plano original**: a suposição inicial ("nenhuma mudança de contrato é necessária no cliente") estava errada. A rota (`app/api/publications/cancel/route.ts`) tratava qualquer resultado "não completed" de uma chamada `execute:true` como erro (500); e o cliente (`runCancellation` em `app/queue/use-publication-queue.ts`) mostrava a mensagem genérica de falha sempre que o status não fosse `completed`. Ambos foram ajustados para tratar `status:'running'` com progresso real como um resultado normal (200, sem mensagem de erro), já que agora é o resultado esperado de qualquer chamada intermediária num cancelamento grande.

### Validação (dados sintéticos, produção, organização isolada e apagada depois)

Sem Docker/Postgres local disponível neste ambiente para os testes pgTAP existentes, a validação foi feita com uma organização sintética própria (perfis, grupo, lotes e itens fictícios, sem nenhum dado real) diretamente em produção:
- Bloqueio: 1 item em `preparing` bloqueia corretamente, sem alterar os demais.
- Cancelamento pequeno (5 itens): conclui numa única chamada, `verified=true`, lote sincronizado para `cancelled`.
- Escala (20.000 itens, escopo grupo): **14 chamadas**, progresso subindo de forma real (8% → 15% → 23% → … → 100%), maior chamada individual **5,7s** (bem abaixo do teto de 8s), total **20.000/20.000 cancelados**, `verified=true`, 20.000 eventos de auditoria gravados.
- Idempotência: duas chamadas `begin_publication_queue_cancellation` para o mesmo alvo devolvem a mesma operação (nenhuma duplicata criada).

Testes existentes revisados por leitura para confirmar compatibilidade (não alterados): [167_safe_scoped_publication_queue_cancellation.test.sql](../supabase/tests/167_safe_scoped_publication_queue_cancellation.test.sql) e [266_mass_cancellation_stays_local.test.sql](../supabase/tests/266_mass_cancellation_stays_local.test.sql) — ambos operam bem abaixo do limiar de 1500 itens que aciona o caminho em blocos, e checam apenas `state`/`verified`/`cancelledItems`/`blockedItems`, todos preservados pela migration 323.

### Achado à parte, fora do escopo deste plano

Apagar linhas de `publication_items` (via `DELETE`, não usado pelo fluxo normal de cancelamento) está anormalmente lento — 5 linhas levaram ~5s — sugerindo uma FK `on delete cascade`/`set null` sem índice numa tabela filha. Não afeta o cancelamento de fila (que só faz `UPDATE`), mas foi sinalizado como tarefa separada (`task_10f61611`) para investigar e corrigir, e para limpar duas organizações de teste sintéticas que ficaram para trás por causa disso.

### Validação local (Docker configurado nesta sessão, executada de verdade)

Docker Desktop já estava instalado na máquina mas fora do `PATH`; foi adicionado permanentemente ao `PATH` do usuário (registro do Windows) e usado para subir o stack local do Supabase (`supabase db reset --local`, aplicando as 324 migrations do zero) e rodar os testes pgTAP de verdade:

- [324_chunk_large_publication_queue_cancellations.test.sql](../supabase/tests/324_chunk_large_publication_queue_cancellations.test.sql): **16/16 passou** — escopo de 1800 itens exigindo duas chamadas com progresso real persistido entre elas, e bloqueio dentro de um bloco (item em `preparing` no início da fila) que não cancela nada mas também não vira um estado terminal de erro.
- Ao rodar isso, **dois testes de cancelamento pré-existentes (não relacionados às minhas mudanças) também falharam**: [266_mass_cancellation_stays_local.test.sql](../supabase/tests/266_mass_cancellation_stays_local.test.sql) faltava o `insert into organization_members` do usuário de teste — sem isso, `has_organization_role` sempre nega e a RPC nunca passa do primeiro `raise exception`. Corrigido (agora 7/7 passa) e usado como confirmação de que o problema era só a fixture do teste, não a lógica das migrations 323/324.
- [167_safe_scoped_publication_queue_cancellation.test.sql](../supabase/tests/167_safe_scoped_publication_queue_cancellation.test.sql) e [204_queue_reference_summary_excludes_closed_items.test.sql](../supabase/tests/204_queue_reference_summary_excludes_closed_items.test.sql) falham por um motivo diferente e não relacionado ("permission denied for schema auth" ao tentar redefinir `auth.jwt()`) — sinalizado como tarefa separada (`task_44fc2eff`), já que é anterior a este trabalho.
- [232_twitter_cancel_scope_and_lease_recovery.test.sql](../supabase/tests/232_twitter_cancel_scope_and_lease_recovery.test.sql) passa sem alteração.

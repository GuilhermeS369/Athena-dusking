# Plano — aceleração e blindagem do plug de Instagram em massa (Zernio)

**Criado em:** 28/08/2026 BRT
**Escopo:** finalização pós-callback das adições Zernio de Instagram (`zernio-sync-worker.mjs`, `claim_zernio_connection_additions`, `reserve_zernio_addition_finalization_slot`), rota `/api/integrations/zernio/start`, tela `/zernio/concluindo` e varredura de tentativas órfãs.
**Fora do escopo:** módulo X/Twitter, pipeline de publicação Instagram, reprocessamento de resíduos históricos e qualquer alteração no contrato da API Zernio.

## Objetivo

Reduzir o tempo de celular aberto por conta plugada, mantendo intactas as garantias que impedem uma conta Instagram de ser registrada numa chave Zernio e depois aceita em outra.

A operação real é: MoreLogin com proxy, 10+ celulares abertos simultaneamente, cliques praticamente ao mesmo tempo em todas as etapas, retorno coletivo ao Athena e carregamento simultâneo da etapa final. Cada minuto de celular aberto é custo direto. A etapa final é hoje a mais lenta e a mais opaca.

## Invariantes obrigatórias (nada neste plano pode enfraquecê-las)

Cada uma foi verificada no código e está no banco, não na aplicação:

- **Profile remoto exclusivo por tentativa.** `zernio_connection_remote_profiles` com `unique(claimed_by_attempt_id)` e índice único global em `zernio_profile_id` (`161_zernio_isolated_remote_profiles.sql:8-32`). Dois celulares nunca compartilham profile remoto.
- **Bloqueio de atribuição cruzada entre chaves.** `zernio_profile_belongs_to_connection` é chamada dentro de `reconcile_zernio_connection_accounts`; `profileId` que não pertence à conexão vira `conflict` e nada é atribuído (`161:226-241`, `164_reconnect_zernio_tombstone_by_immutable_identity.sql`).
- **Perfil ativo sempre vence.** O reconcile trava por `accountId`, por username e por identidade imutável do Instagram via `pg_advisory_xact_lock`, e recusa mover um vínculo existente.
- **Claim de conta globalmente único.** `zernio_addition_account_claims.zernio_account_id` é `unique` na tabela inteira (`160_zernio_parallel_oauth_finalization_fifo.sql:45-56`).
- **Contagem de slot atômica.** `reserve_zernio_addition_finalization_slot` usa `pg_advisory_xact_lock` por organização e soma `instagram_profiles` ativos + reservas não liberadas.
- **Nenhuma confirmação falsa.** A tela só declara sucesso com `worker_status = 'completed'`, `status = 'synced'`, `synced_count > 0` e grupo atribuído.

**Conclusão que orienta todo o plano:** a fila de uma finalização por organização **não** é o que garante nenhuma das invariantes acima. Ela é uma camada redundante, e é a que custa tempo de celular.

## Resultados das medições (28/08/2026, leitura somente)

Base: 3.092 tentativas, 2.909 profiles remotos, 1.195 chaves Zernio ativas, 1.841 perfis Instagram Zernio, 3 organizações (2 ativas).

### M1 — A cadência da fila é o gargalo, e ela dobrou entre ontem e hoje

O intervalo entre duas conclusões consecutivas é o teto de vazão. Ele é extremamente estável, o que descarta "latência aleatória da Zernio" como causa principal:

| dia | n | gap p50 | gap p90 | espera p50 | espera p90 | espera máx |
|---|---|---|---|---|---|---|
| 17/08 | 315 | 5,9s | 6,5s | 22,1s | 1,0min | 18,8min |
| 19/08 | 367 | 6,0s | 6,4s | 30,4s | 1,1min | 1,5min |
| 24/08 | 432 | 6,0s | 6,5s | 30,9s | 1,0min | 1,5min |
| 27/08 | 371 | 6,2s | 7,1s | 45,8s | 1,6min | 3,6min |
| **28/08** | **252** | **11,3s** | **12,4s** | **1,0min** | **2,1min** | **3,2min** |

Por hora UTC, a transição é um degrau limpo, sem valores intermediários: 6,2s até 27/08 09h → 11,3s a partir de 28/08 07h.

O heartbeat vivo do worker (`athena-vps-zernio-sync-1`) reporta `pollMs=10000, limit=5, lease=180`. O gap observado é `pollMs + ~1,3s` de trabalho real. Ou seja: **~88% do tempo de fila é espera de poll, não trabalho.** Com 6,2s o trabalho útil era 1,2s; com 11,3s continua sendo 1,3s.

**Causa confirmada na VPS (28/08, leitura somente).** O log `athena-zernio-sync-worker-out.log` registra a configuração a cada inicialização. As cinco reinicializações registradas mostram a mudança:

| restart | pollMs | limit | heartbeat |
|---|---|---|---|
| 1 | 5000 | 10 | 30000 |
| 2 | 5000 | 10 | 30000 |
| **3** | **10000** | **2** | 30000 |
| 4 | 10000 | 2 | 60000 |
| 5 (atual) | 10000 | 5 | 60000 |

O restart 4 ocorreu por volta de 28/08 02:02 UTC; o restart 3, que introduziu o poll de 10 s, foi entre 27/08 09h e essa marca — exatamente a janela do degrau observado no banco. `pm2 list` confirma **um único processo** `athena-zernio-sync-worker` em modo `fork` (não há segundo processo mascarando a configuração), com 5 reinicializações acumuladas. Hipótese de "dois workers" descartada.

Observação de método: `started_at` do heartbeat não é atualizado em restart (`188_operational_worker_heartbeat_accuracy.sql` não toca a coluna no `on conflict`), então o "uptime" de 240 h que o banco mostra é falso. Quem sabe a verdade é o PM2 e o log de inicialização.

### M2 — O que o operador sente é posição na fila, não aleatoriedade

Pico de celulares esperando ao mesmo tempo: 24 em 27/08, 13 hoje. Com cadência de 11,3s, o 13º da fila espera ~2,4 min; o 1º espera ~11s. É determinístico pela posição — daí a impressão de "hora rápido, hora lento".

### M3 — As duas organizações praticamente não competem

Finalizações que coexistiram no tempo com outra organização: 0 de 432 em 24/08, 6 de 367 em 19/08. As duas empresas plugam em janelas diferentes. Com `limit=5` na configuração viva, o worker também comporta uma terceira organização por ciclo sem inanição.

### M4 — R2 é recorrente, mas **não custa slot pago**

170 tentativas presas em `redirected` (sem callback): 144 Pomodoro, 26 Vini. Distribuição por idade: 19 com menos de 1h (a onda de hoje), 65 entre 1 e 7 dias, 86 com mais de 7 dias. Picos coincidem com as ondas grandes: 46 em 19/08, 46 em 24/08, 19 hoje — cerca de 7% a 12% de cada onda. Correspondem a 165 profiles remotos `dedicated` presos em `claimed` (168 há mais de 30 min; alguns há 260h).

**Verificação direta na API Zernio (28/08, 89 chaves consultadas, `GET /v1/accounts`, leitura somente, zero falhas):**

- conta remota órfã (existe na Zernio, ocupa slot, ausente no Athena): **0**
- profile isolado vazio (nunca chegou a autorizar): **170 de 170**
- conta já importada por outra tentativa: 0

Ou seja: as 170 são linhas que o operador abriu e abandonou antes de o Instagram autorizar. **Nenhum slot pago está preso e não existe divergência remoto vs local.** Nas 89 chaves: 162 contas remotas contra exatamente 162 locais, 0 chaves acima do limite, 74 exatamente no limite (2/2), 15 com folga.

Isso rebaixa R2 de "recuperação de conta perdida" para "higiene de estado": o custo é lixo em `zernio_connection_attempts`, profiles remotos vazios acumulando na Zernio, e ruído na tela de Adições. O cenário temido — conta criada remotamente e invisível no Athena — **não está ocorrendo hoje**.

### M5 — R3 confirmado: a contagem canônica está cega em 82% das chaves

Ocupação local 1.841 perfis contra 29 contados remotamente. 975 de 1.195 chaves têm `remote_instagram_account_count < instagram_profile_count`. O limite por chave é 2 (free tier da Zernio). A checagem pré-OAuth do `/start` está morta na prática. O Bulk Zernio continua correto porque usa `max(local, remoto)`: hoje ele oferece 441 vagas para Vini e 105 para Pomodoro, e nenhuma chave está sem snapshot válido.

### M6 — R4 já está armada com dados

`zernio_remote_inventory_observations`: 2.647 linhas, das quais **2.253 em `suspected_absent`** e apenas 205 em `present`. São contas saudáveis marcadas como ausentes só porque o sync olha o profile canônico. Nada lê essa tabela hoje. Qualquer remoção automática construída sobre ela desconectaria 2.253 perfis.

### M7 — Falhas: o teto do plano gratuito domina

104 falhas no total. Por mensagem: 46 "Add a payment method to connect more than 2 accounts" (mais 3 `free_tier_exceeded`), 17 "O state retornado pela Zernio não corresponde ao attempt ativo", 12 sem detalhe, 10 "A identidade Instagram já pertence a outro perfil ativo". As duas últimas são **as proteções funcionando** — a de identidade é exatamente a que impede registrar a mesma conta em outra chave, e ela barrou 10 casos.

## Diagnóstico

### D1 — Serialização por organização

`zernio_addition_organization_locks` tem `organization_id` como primary key (`160:36-43`). `claim_zernio_connection_additions` varre até 200 candidatos em FIFO por `callback_received_at` e só consegue inserir a trava do primeiro de cada organização. Resultado: dentro de uma empresa, N celulares finalizam estritamente um por vez, independentemente de quantos workers existam. Organizações distintas não disputam a mesma trava.

### D2 — Adições em série e acopladas ao sync pesado

`tick()` processa as adições num `for … await` (`zernio-sync-worker.mjs:752`) e só volta a buscar adições depois de terminar a fase de sync de lotes (`:803`) mais `pollMs` (`:22`, `:906`). O intervalo entre finalizações é: adição (1 chamada Zernio, timeout 25 s) + fase de sync inteira (até 2 itens, cada um com outro `/v1/accounts`) + 5 s. Sem fila concorrente isso dá 6-10 s; com sync de lote junto, 30-60 s. É a origem principal do "hora rápido, hora lento".

Como o processo é único e as adições rodam uma após a outra dentro do mesmo `tick`, **organizações diferentes não se bloqueiam por trava, mas compartilham o mesmo worker de thread única**: a finalização da empresa B espera a da empresa A terminar antes de começar.

### D3 — Backoff de recuperação longo demais — **medido: impacto baixo**

Quando a Zernio ainda não expôs a conta no momento do callback, o attempt volta à fila com atraso 5 → 10 → 20 → 40 → 60 → 90 → 120 → 180 s (`:159-162`), teto de 1500 s.

**Medição de 28/08/2026:** apenas 9 de 3.092 tentativas (0,3%) entraram em recuperação. Das 958 finalizações analisadas, 950 tiveram `recovery_observation_count = 0`. O backoff **não** é o gargalo do dia a dia; ele só define a cauda (essas 8-9 tentativas levaram ~29 min cada, ou pararam em `recovery_paused`). Continua valendo achatar, mas com prioridade baixa.

### D4 — Latência variável da própria Zernio

`/v1/accounts` devolve o inventário completo da chave, sem filtro por profile, e fica mais pesado conforme a chave enche. `docs/incidente-erro-23-timeout-zernio-2026-08-18.md` já registrou 82 timeouts de 25 s em horário de pico, no mesmo provedor usado pelo despacho de publicação.

### D5 — `/start` com 3-4 chamadas remotas sequenciais

`listAccounts` (`start/route.ts:81`) → `createProfile` (`:152`) → `listAccounts` de novo (`:164`) → `startConnect` (`:197`), cada uma com timeout de 45 s e sem retry. A segunda listagem só confirma que um profile recém-criado está vazio. Há ainda consulta duplicada a `profile_groups` (`:63` e `:75`).

## Riscos operacionais encontrados

### R1 — Congelamento de 3 minutos por organização em caso de crash

O lease da trava é de 180 s (`:27`) e só sai por expiração. Com 10 celulares abertos, um crash silencioso custa 30 minutos de celular somados.

### R2 — Tentativa presa em `redirected` sem varredura automática — **medido: sem custo de slot**

Se a proxy cai depois do Instagram autorizar e antes de o callback chegar, a tentativa fica em `redirected`, o profile isolado fica `claimed` para sempre e a conta *poderia* já existir na Zernio ocupando slot real, invisível para o Athena. Não existe varredor automático; só scripts de incidente (`clean-vini-zernio-residues.mjs`, `cancel-zernio-restoration-attempt.mjs`). A tela Operação → Adições Zernio mostra o registro parado, sem ação disponível.

**A leitura da API Zernio (M4) mostrou que as 170 presas têm profile vazio: 0 contas órfãs, 0 slots pagos presos, 0 divergências remoto vs local.** O risco permanece estruturalmente aberto — nada impede que aconteça numa onda em que a Zernio demore —, mas hoje o custo é apenas lixo de estado e profiles vazios acumulados.

### R3 — Checagem de limite pré-OAuth virou letra morta

`start/route.ts:81-92` conta apenas contas no profile **canônico**. No modelo atual toda conta nova nasce em profile **dedicado**, então essa contagem tende a zero e nunca barra ninguém. O limite real só é aplicado no fim, depois de a conta já existir na Zernio. Hoje quem segura o excesso é o Bulk Zernio, que usa `max(contagem local, contagem remota)` (`zernio-bulk.ts:125-140`) — proteção real, porém única e no cliente.

### R4 — Mina inerte no snapshot de inventário

O sync de rotina filtra pelo profile canônico (`zernio-sync-worker.mjs:229`) e chama `record_zernio_connection_inventory_snapshot` com `p_complete_snapshot: true`. Isso marca contas que vivem em profiles dedicados como `absence_observed` e, na segunda passada, `suspected_absent`. **Nada lê essa tabela hoje** — verificado em todo o repositório —, e o `reconcile` é upsert-only, então não há perda de dado. Mas construir remoção automática sobre `zernio_remote_inventory_observations` antes de corrigir o escopo do sync desconectaria em massa contas saudáveis.

## Acoplamento que qualquer mudança de trava precisa respeitar

`reserve_zernio_addition_finalization_slot` faz `join` obrigatório em `zernio_addition_organization_locks` para provar que o attempt está sob lease daquele worker. Remover ou trocar a trava sem reescrever essa RPC na mesma migration derruba a reserva de slot, que é a quinta invariante. Este é o principal item de cautela do plano.

## Fases

### Fase 0 — Ajuste de ambiente, sem código — **prioridade máxima, resolve a lentidão de hoje**

A configuração viva é `ZERNIO_SYNC_WORKER_POLL_INTERVAL_MS=10000`. O trabalho real por finalização é de ~1,3s; todo o resto é espera de poll. Efeito direto sobre a espera do último celular de uma onda de 13:

| poll | cadência | 13º da fila |
|---|---|---|
| 10000 ms (hoje) | ~11,3s | ~2,4 min |
| 5000 ms (até 27/08) | ~6,2s | ~1,3 min |
| 2000 ms | ~3,3s | ~43s |
| 1000 ms (mínimo aceito) | ~2,3s | ~30s |

Recomendação: voltar para 5000 imediatamente e avaliar 2000 em seguida, medindo a carga no Supabase entre os dois passos. O clamp do worker aceita mínimo de 1000 ms (`zernio-sync-worker.mjs:22`).

- **Risco:** mínimo. Mais ciclos por minuto significam mais chamadas de `claim_zernio_connection_additions` — que retornam vazio quase sempre fora das ondas. Nenhuma invariante é tocada.
- **Rollback:** restaurar a variável e reiniciar o processo PM2.
- **Antes de aplicar:** confirmar na VPS, com `pm2 describe`, se existe um ou dois processos `zernio-sync` ativos. Se existirem dois com o mesmo `ZERNIO_SYNC_WORKER_ID`, resolver essa duplicidade primeiro — dois processos disputando o mesmo heartbeat mascaram a configuração real.
- **Não fazer:** subir `ZERNIO_SYNC_WORKER_LIMIT` esperando ganho dentro de uma mesma empresa — a trava por organização anula. O valor atual (5) já cobre uma terceira organização.

### Fase 1 — Drenar a fila dentro do mesmo ciclo (worker apenas, sem migration)

**Esta é a correção estrutural, e ela não exige mexer na trava.** A trava por organização apenas serializa; ela é liberada ao fim de cada adição (`release_zernio_addition_organization_lock`). Quem limita a vazão é o `sleep(pollMs)` entre ciclos: hoje o worker faz **uma** rodada de claim por ciclo e dorme, mesmo com 12 celulares esperando.

Mudança: em `tick()`, repetir `claim_zernio_connection_additions` + processamento **em laço, até o claim voltar vazio** (com teto de segurança por ciclo e respeito ao `stopping`), antes de seguir para a fase de sync e dormir.

Efeito esperado, com o trabalho real medido de ~1,3s por adição: uma onda de 13 celulares sai de ~2,4 min para ~17s, sem depender do valor do poll.

1. Laço de drenagem das adições (item principal).
2. Separar a fase de adições da fase de sync de lotes, para que a drenagem não fique atrás do `/v1/accounts` do lote.
3. Achatar o backoff de recuperação (teto na casa de 15-20 s em vez de 180 s), mantendo `ZERNIO_POST_CALLBACK_RECOVERY_SECONDS` inalterado. Prioridade baixa: mede-se em 0,3% das tentativas (M1/D3).

- **Risco:** baixo. Nenhuma das cinco invariantes é tocada; todas as RPCs permanecem idênticas e continuam sendo chamadas na mesma ordem. A drenagem não introduz concorrência nova: continua uma adição por vez, apenas sem dormir entre elas.
- **Cuidado:** manter o teto por ciclo e a checagem de `stopping`, para que um backlog grande não impeça o heartbeat nem a fase de sync de rodar.
- **Rollback:** `pm2 restart` na versão anterior do arquivo.
- **Validação:** o gap entre conclusões deve cair de ~11s para a casa de 1-2s durante uma onda.

### Fase 2 — Higiene das tentativas abandonadas (R2, reescopada após a medição)

A medição mostrou que as 170 presas têm profile isolado **vazio**: ninguém autorizou, nenhuma conta remota existe, nenhum slot pago está preso. Portanto o varredor **não precisa recuperar conta nenhuma** — precisa apenas encerrar o que foi abandonado.

Rotina que, para tentativas em `redirected` há mais de X minutos:

1. consulta o profile isolado do attempt (e **somente** ele);
2. se estiver vazio, marca o attempt como expirado e libera o profile remoto via `release_zernio_attempt_remote_profile`, que já move `dedicated` para `cleanup_pending`;
3. se — contra a expectativa atual — houver conta, finaliza pelo mesmo caminho do callback, sem abrir OAuth novo nem criar profile novo, reaproveitando `claim_zernio_addition_account`, `mark_zernio_attempt_remote_profile_connected`, `reserve_zernio_addition_finalization_slot` e `reconcile_zernio_connection_accounts` como estão.

O ramo 3 é o seguro contra o cenário que hoje não ocorre, mas que ocorreria se a Zernio ficasse lenta no meio de uma onda.

- **Risco:** baixo-médio. Mitigação: começar em modo somente relatório na tela de Adições Zernio, e só depois habilitar a expiração automática.
- **Prioridade:** média. Não é o que custa tempo de celular; é o que mantém o painel legível e evita acúmulo de profiles vazios na Zernio.
- **Rollback:** desligar por feature flag/env, sem migration reversa.

### Fase 3 — Trava por conexão em vez de por organização (provavelmente desnecessária)

Daria paralelismo real: celulares em chaves diferentes finalizando ao mesmo tempo. Exige migration **e** reescrita conjunta de `reserve_zernio_addition_finalization_slot`.

- **Avaliação após as medições:** com trabalho real de ~1,3s por adição, a Fase 1 já entrega ~17s para uma onda de 13. O ganho adicional desta fase é pequeno diante do risco de mexer na trava de que a reserva de slot depende. **Recomendação: não executar**, a menos que as ondas passem a ter dezenas de celulares por organização e a Fase 1 não dê conta.
- **Pré-requisito:** medir se as fases 0-2 já resolveram. Não executar antes disso.
- **Risco:** alto se feito isoladamente; a RPC de slot depende da trava.
- **Validação obrigatória antes do deploy:** ensaio com duas chaves e dois aparelhos, confirmando que o `reconcile` continua bloqueando atribuição cruzada.

### Fase 4 — Higiene do `/start` (opcional, ganho de segundos)

Remover a segunda listagem redundante (`:164`), unificar a consulta duplicada a `profile_groups` e decidir o destino da checagem de limite pré-OAuth descrita em R3 — corrigi-la para contar profiles dedicados, ou removê-la assumindo explicitamente que o Bulk Zernio é a barreira.

## Medições — executadas em 28/08/2026

As quatro leituras planejadas foram executadas contra o Supabase de produção, somente com `select` e `count`, sem tocar em migration, PM2 ou qualquer estado remoto. Resultados na seção "Resultados das medições" acima. Nenhuma coluna de token ou chave foi lida.

Também executadas, com autorização explícita:

- **VPS (SSH, somente leitura):** `pm2 list` e leitura do log de inicialização do worker. Nenhum processo reiniciado, nenhuma configuração alterada, nada escrito na VPS. Resultado em M1.
- **API Zernio (`GET /v1/accounts`, 89 chaves, concorrência 2):** classificação das 170 tentativas presas. Nenhuma escrita, nenhuma chave registrada em log. Resultado em M4.

## Execução — 28/08/2026

Passos 1 e 2 aplicados em produção, em janela com a fila vazia (0 adições pendentes, 0 travas de organização ativas, 0 itens de sync pendentes, verificado imediatamente antes de cada restart).

**Passo 1 — poll restaurado.** `ZERNIO_SYNC_WORKER_POLL_INTERVAL_MS` alterado de `10000` para `5000` em `/opt/athena-worker/.env.worker` e worker reiniciado. Confirmado pela linha de inicialização: `pollMs: 5000, limit: 5, leaseSeconds: 180`.

**Passo 2 — laço de drenagem.** `drainConnectionAdditions()` em [scripts/workers/zernio-sync-worker.mjs](../scripts/workers/zernio-sync-worker.mjs): o ciclo repete `claim_zernio_connection_additions` + processamento até o claim voltar vazio, em vez de uma rodada por poll. Cada adição continua serial e usa as mesmas RPCs na mesma ordem — a trava por organização, a reserva de slot, a reconciliação e o vínculo de grupo não foram tocados.

Tetos de segurança, ambos ajustáveis por ambiente:

- `ZERNIO_SYNC_WORKER_ADDITION_DRAIN_LIMIT` (padrão 120): máximo de adições por ciclo.
- `ZERNIO_SYNC_WORKER_ADDITION_DRAIN_BUDGET_MS` (padrão 120000): teto de tempo por ciclo.

Ao bater qualquer teto, o worker registra `drenagem interrompida por teto` e segue para o sync de lotes; o backlog restante é retomado no ciclo seguinte. Durante drenagens longas o heartbeat continua sendo emitido, para o worker não parecer morto na observabilidade. `SIGTERM`/`SIGINT` encerram a drenagem entre adições, sem interromper uma em andamento.

O resumo gravado no heartbeat passou a ser agregado (`compactSummary`), já que uma onda drenada produziria dezenas de resultados detalhados no `metadata`. O log do ciclo mantém o detalhe completo.

**Validação executada:** `node --check` local e na VPS; simulação do fluxo de controle com sete cenários (onda de 13 numa organização, duas organizações, falha isolada de item, teto de quantidade, teto de tempo, parada graciosa, fila vazia) — todos passaram; observação do log em produção após o restart, com `additionDrain: { rounds: 0, stopReason: 'empty', elapsedMs: ~45 }` em fila vazia, ou seja, uma única consulta por ciclo quando não há trabalho. Log de erro sem entradas novas após o deploy.

**Rollback:** `/opt/athena-worker/scripts/workers/zernio-sync-worker.mjs.bak-20260828` contém a versão anterior, idêntica ao HEAD do repositório no momento do deploy (diferença zero, conferida por diff).

**Pendente de validação real:** a próxima onda de plug. O que observar no log: `additionDrain.rounds` maior que 1 e `elapsedMs` acompanhando o tamanho da onda; e, no banco, o gap entre conclusões consecutivas caindo de ~11s para a casa de 1-2s.

**Nota:** a alteração no worker está no working tree, ainda não commitada.

## Ordem de execução recomendada

1. **Agora, sem código:** devolver `ZERNIO_SYNC_WORKER_POLL_INTERVAL_MS` para 5000 na VPS e reiniciar o worker. Restaura a cadência de ontem (~6,2s) e corta a espera pela metade. Verificar em seguida a linha `[zernio-sync-worker] iniciando` no log, que imprime a configuração efetiva.
2. **Em seguida, Fase 1 (laço de drenagem):** leva a cadência para a casa de 1-2s durante as ondas e torna o valor do poll quase irrelevante. Sem migration, sem tocar nas invariantes.
3. **Depois, decidir o poll definitivo:** com a drenagem no lugar, 5000 é suficiente; não há motivo para descer a 1000 e aumentar carga no Supabase à toa.
4. **Fase 2 (higiene):** primeiro em modo relatório, depois com expiração automática.
5. **Fase 4 (higiene do `/start`):** ganho de segundos no clique, sem urgência.
6. **Fase 3:** não executar, salvo mudança de escala.

Validação após cada passo: repetir a medição de gap entre conclusões e de espera `callback → worker_completed_at` na primeira onda seguinte, e comparar com a tabela de M1.

## Proibições explícitas

- Não reexecutar migrations já aplicadas remotamente.
- Não construir remoção automática sobre `zernio_remote_inventory_observations` antes de corrigir o escopo do sync (R4).
- Não remover a trava por organização sem reescrever `reserve_zernio_addition_finalization_slot` na mesma migration.
- Não ampliar o escopo de profiles consultados na recuperação: a restrição ao profile isolado do attempt é o que impede importar conta de outra chave.
- Não introduzir retry automático que abra um segundo OAuth para a mesma intenção.

## Questões em aberto

- Qual é a janela real de propagação da Zernio entre callback e conta visível no inventário? Define o teto do backoff da Fase 1.
- A Zernio aceita filtro por `profileId` em `/v1/accounts`? Se sim, reduz D4 e o custo de cada finalização.
- O limite de slot por chave deve ser aplicado antes do OAuth (custa uma leitura remota a mais no `/start`) ou continuar apenas no Bulk Zernio?

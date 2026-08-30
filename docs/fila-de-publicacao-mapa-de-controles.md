# Fila de publicação — mapa de controles

**Para que serve este documento:** quando alguém precisar ajustar a fila para uma
frota maior (5.000, 30.000 perfis), este é o lugar para ler ANTES de mexer. Ele
diz **onde cada botão está, o que ele controla de verdade, e o que já foi medido**
— inclusive os experimentos que falharam, para não serem repetidos.

Escrito em 30/08/2026, depois de três dias de investigação em produção. Todos os
números aqui são **medidos**, não estimados. Quando algo é estimativa, está dito.

---

## 1. O caminho de uma publicação, do agendamento ao post

```
  plano em massa
       │
       ▼
  GERAÇÃO  ──► publication_items (status=waiting, preparation_status=pending)
       │        worker: publication-generation-worker.mjs
       │
       ▼
  PREPARAÇÃO ──► preparation_status=ready
       │          resolve mídia, valida, monta o que o provedor precisa
       │          laço próprio dentro de publication-worker.mjs
       ▼
  STAGING ──► spool em disco (/var/lib/athena-publication-spool/*.json)
       │       monta o "envelope" com até 10 min de antecedência
       │       NÃO chama a API de publicação — só lê banco e resolve URLs
       ▼
  DESPACHO ──► POST na Zernio (createPost) ──► creation_id
       │        dois caminhos, ver seção 3
       │        ~6,5s por chamada (medido)
       ▼
  CONFIRMAÇÃO ──► getPost ──► published_at + meta_media_id (permalink)
                   acontece em ciclo POSTERIOR, ~75s depois (p50 medido)
```

### Armadilha nº 1, e a mais cara: `published_at` não é o horário da publicação

`published_at` marca a **confirmação**, não o envio. O publicador cria o post,
devolve `state: 'processing'` e só confirma num ciclo seguinte.

**Quem for medir capacidade de publicação tem que usar `provider_creation_started_at`.**
Medir por `published_at` embute uma defasagem de p50=75s / p90=200s e faz o
sistema parecer 3× mais lento do que é. Perdi horas otimizando essa métrica errada.

---

## 2. Onde fica cada botão

Todos os parâmetros abaixo vivem em **`/opt/athena-worker/.env.worker` na VPS**,
lidos por `scripts/workers/publication-worker.mjs`. Os valores-padrão estão no
código (`integerEnv(...)`), e **o padrão do código é o que vale num deploy limpo** —
mudar só o `.env` da VPS deixa o repositório mentindo.

### Geração

| Variável | Padrão | O que controla |
|---|---:|---|
| `PUBLICATION_GENERATION_WORKER_POLL_INTERVAL_MS` | 2000 | frequência do laço de geração |

Regras de negócio da geração ficam em **SQL**, não em env: `claim_bulk_rotation_generation_chunks`
e `process_bulk_rotation_generation_chunk` (migrations 326 e 328).

### Preparação

| Variável | Padrão | O que controla |
|---|---:|---|
| `PUBLICATION_WORKER_PREPARATION_LIMIT` | 150 | itens preparados por ciclo |
| `PUBLICATION_WORKER_PREPARATION_CONCURRENCY` | 8 | paralelismo da preparação |
| `PUBLICATION_WORKER_PREPARATION_POLL_INTERVAL_MS` | 5000 | frequência do laço |
| `PUBLICATION_WORKER_PREPARATION_DUE_GUARD_MS` | 5000 | cede se há publicação vencendo nessa janela |
| `PUBLICATION_WORKER_PREPARATION_MAX_CONSECUTIVE_SKIPS` | 3 | **teto de cessões seguidas** |
| `PUBLICATION_WORKER_PREPARATION_IN_DISPATCH` | false | volta a preparar dentro do laço de despacho |

**Capacidade medida:** ~17.000 itens/hora (pico de 2.870 absorvido em 10 min).
Folga confortável para 5.000 perfis (~5.000/h).

### Staging (o que enche o spool)

| Variável | Padrão | O que controla |
|---|---:|---|
| `PUBLICATION_WORKER_STAGING_ENABLED` | true | liga/desliga o spool |
| `PUBLICATION_WORKER_STAGING_LIMIT` | 100 | itens por ciclo |
| `PUBLICATION_WORKER_STAGING_CONCURRENCY` | 8 | paralelismo |
| `PUBLICATION_WORKER_STAGING_WINDOW_SECONDS` | 600 | antecedência com que prepara |
| `PUBLICATION_WORKER_STAGING_LEASE_SECONDS` | 1200 | validade da entrada no spool |
| `PUBLICATION_WORKER_STAGING_DUE_GUARD_MS` | 5000 | cede se há publicação vencendo |
| `PUBLICATION_WORKER_STAGING_MAX_CONSECUTIVE_SKIPS` | 1 | teto de cessões seguidas |
| `PUBLICATION_WORKER_STAGING_PRESSURE_YIELD` | **false** | ceder à pressão global (ver 5.4) |
| `PUBLICATION_WORKER_STAGING_CRITICAL_DELAY_FORCE_AFTER_MS` | 300000 | teto de segurança da cessão por pressão |

**Capacidade medida:** ~125 itens/min preparados no spool.

### Despacho

| Variável | Padrão | O que controla |
|---|---:|---|
| `PUBLICATION_WORKER_LIMIT` | 100 (teto de código) | **teto** do lote do caminho direto |
| `PUBLICATION_WORKER_POLL_INTERVAL_MS` | 5000 | frequência do laço |
| `PUBLICATION_WORKER_LEASE_SECONDS` | 180 | lease do item durante o processamento |
| `PUBLICATION_WORKER_STAGED_DISPATCH_LIMIT` | 500 | itens por ciclo, caminho do spool |
| `PUBLICATION_WORKER_STAGED_DISPATCH_CONCURRENCY` | 64 | paralelismo do caminho do spool |
| `PUBLICATION_WORKER_STAGED_DISPATCH_LEASE_SECONDS` | 900 | lease do despacho |
| `PUBLICATION_WORKER_STAGED_MAX_PER_ORGANIZATION_PER_MINUTE` | 600 | teto de seleção por organização/min |
| `PUBLICATION_WORKER_ADAPTIVE_COLLAPSE_RATIO` | 0.1 | **ver seção 4 — é o botão que mais importa** |

### Zernio (provedor)

| Variável | Padrão | O que controla |
|---|---:|---|
| `PUBLICATION_WORKER_ZERNIO_CREATE_SPACING_MS` | 75 | espaçamento entre criações → **teto de 800/min** |
| `PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_SPACING_MS` | 200 | espaçamento sob backpressure → teto de 300/min |
| `PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_MS` | 60000 | duração do backpressure |
| `PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_THRESHOLD` | 3 | falhas transitórias para ligar |
| `PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_WINDOW_MS` | 60000 | janela dessas falhas |
| `ZERNIO_REQUEST_TIMEOUT_MS` | 45000 | timeout de requisição |

### Manutenção

| Variável | Padrão | O que controla |
|---|---:|---|
| `MEDIA_MAINTENANCE_ARCHIVE_ENABLED` | true | arquiva itens encerrados (marca `archived_at`) |
| `MEDIA_MAINTENANCE_COLD_STORAGE_ENABLED` | true | **move** arquivados para tabela fria |
| `MEDIA_MAINTENANCE_COLD_STORAGE_RETENTION_DAYS` | 7 | idade mínima para mover (piso de 7 no SQL) |
| `MEDIA_MAINTENANCE_COLD_STORAGE_BATCH` | 50 | itens por chamada (ver 5.6) |

---

## 3. Os dois caminhos de despacho — e por que isso confunde

Existem **dois** caminhos, e eles competem pelos mesmos itens:

**Caminho do spool (`dispatchDueStagedPublications`)**
Lê o spool em disco, seleciona por `selectWithinOrganizationDispatchWindow`,
ativa via `activate_staged_publication_items`, processa com concorrência 64.

**Caminho direto (`dispatchPublicationQueueDirect`)**
Reivindica direto do banco via `claim_publication_items`, com lote de tamanho
**adaptativo** (seção 4).

**As ondas grandes vão pelo caminho direto.** Descobri isso da pior forma: passei
horas ajustando botões do caminho do spool (concorrência 32→64, teto por
organização 300→600) e **nenhum teve efeito**, porque o caminho que fazia o
trabalho era o outro.

**Antes de mexer em qualquer botão de despacho, confirme qual caminho está
processando**, olhando o log: `stagedDispatch: { due, selected, activated }` para
o spool, `claimed: N` para o direto.

---

## 4. O controlador adaptativo — o gargalo principal, e a matemática dele

Em `nextAdaptiveDispatchLimit` (`publication-direct-dispatch.mjs`). É o botão que
mais afeta a vazão, e o mais fácil de entender errado.

O tamanho do lote do caminho direto **não é** `PUBLICATION_WORKER_LIMIT`. Esse é
só o **teto**. O valor real é adaptativo: começa em 10 e se ajusta sozinho.

### O defeito que existia até 30/08/2026

```
+20% quando o lote enche   |   METADE quando UM ÚNICO item dá timeout ou erro de rede
```

Com a taxa de erro real da Zernio em **~1%** (30 erros em 2.958 requisições), a
chance de um lote de tamanho L ter ao menos um erro é `1-(0,99)^L`. O equilíbrio:

```
(1-P)·log(1,2) + P·log(0,5) = 0   =>   P = 20,8%
1-(0,99)^L = 0,208                =>   L ≈ 23
```

**O controlador convergia para ~23 itens por ciclo e não passava disso**,
independente da capacidade da máquina, do banco ou do provedor. Confirmado em
produção: `used: 30`, ciclos de 9 a 16 itens, e **64 vagas de concorrência
ociosas** (espera por slot: 3 ms).

Isso também explica duas ondas do **mesmo minuto** rendendo 41/min (447 itens) e
702/min (187 itens): não era o tamanho da onda, era **onde o controlador estava**
quando ela chegou.

### Como ficou

| Sinal | Reação |
|---|---|
| 429, rate limit, retry-after | metade, na hora, mesmo sozinho |
| timeout / erro de rede ≥ 10% do lote | metade |
| timeout / erro de rede < 10% do lote | **segura** (não cresce, não cai) |
| lote limpo | +20% |

`PUBLICATION_WORKER_ADAPTIVE_COLLAPSE_RATIO=0` restaura o comportamento antigo.

### Se um dia precisar ir para 30.000 perfis, comece por aqui

A conta é `vazão ≈ tamanho_do_lote ÷ tempo_por_item`. Com 6,5 s por criação:

| Lote | Vazão teórica |
|---:|---:|
| 23 (equilíbrio antigo) | ~210/min |
| 100 (teto atual) | ~920/min |
| 200 | ~1.850/min |

30.000 perfis postando de hora em hora, espalhados em 10 min, exigem **3.000/min**.
Isso passa do teto de 800/min do espaçamento da Zernio (seção 2) — nesse regime o
`ZERNIO_CREATE_SPACING_MS` vira o próximo limite, e a saída provavelmente é
**mais de um processo publicador**, já que o espaçamento é por processo.

---

## 5. O padrão que causou quase todos os bugs: guarda sem teto

Sete bugs distintos, todos com a mesma forma: **um componente cede a um sinal de
pressão que ele mesmo é o único capaz de resolver**, ou por um evento
estatisticamente rotineiro.

| # | Onde | O que acontecia |
|---|---|---|
| 5.1 | Preparação | cedia enquanto houvesse item vencendo em 60 s — sob carga, sempre |
| 5.2 | Staging (guarda de 60 s) | mesma coisa; rodava 1 ciclo a cada 4 |
| 5.3 | Staging (janela) | 60 s é sempre verdade sob carga; baixado para 5 s |
| 5.4 | Staging (pressão) | cedia por itens já aceitos aguardando confirmação — durante ondas, sempre |
| 5.5 | Backpressure Zernio | 5 min de vazão pela metade por **um** erro de rede |
| 5.6 | Controlador adaptativo | metade do lote por **um** erro (seção 4) |
| 5.7 | Analytics (outra sessão) | parava 99,5% do tempo por `criticalDelay` |

**Regra prática:** toda guarda que cede precisa de **teto de cessão** ou de
**limiar proporcional**. Ceder é certo; ceder indefinidamente por causa de ruído
não é. E antes de fazer um componente ceder a um sinal, pergunte se ele **consome
o recurso em disputa** — o staging cedia capacidade da Zernio que ele nem usa.

### Limiares: 60 s não é sinal, é ruído

Medido em 30/08 (660 minutos): existia item vencido há mais de 60 s em **99%** dos
minutos. Por limiar:

| Limiar | Minutos com sinal ativo |
|---:|---:|
| 60 s | 99% |
| 300 s | 96% |
| 600 s | 90% |
| 1200 s | 29% |

**Um limiar que fica verdadeiro 99% do tempo não informa nada.** Depois das
correções a distribuição mudou (p90=380 s, máximo=597 s), e hoje quem discrimina
é ~300 s. Recalibre contra a distribuição real antes de escolher.

---

## 6. Experimentos que FALHARAM — não repita

| Experimento | Resultado | Por quê |
|---|---|---|
| Concorrência do staged dispatch 32 → 64 | **sem efeito** (62 vs 69/min) | caminho ocioso; quem trabalha é o direto |
| Teto por organização 300 → 600 | **sem efeito** (75 vs 81/min) | não era o limitante |
| Reduzir cessão do staging de 3 para 1 | **sem efeito** na drenagem | o limitante era o controlador adaptativo |
| Subir `PUBLICATION_WORKER_LIMIT` 44 → 100 | ajudou (42 → 69/min) | mas o adaptativo continuava travando em ~23 |

---

## 7. Como medir sem se enganar

1. **Use `provider_creation_started_at`**, não `published_at` (seção 1).
2. **Ordenação determinística ao paginar.** Uma onda tem centenas de itens com o
   **mesmo** `execute_at`; paginar por ele sem desempate perde e repete linhas.
   Medido: 91 repetidas e 91 perdidas em 11.332 (0,8%) — o bastante para inverter
   conclusões. Use `order=execute_at,id`. O guard em
   [`lib/supabase/row-limit-guard.test.ts`](../lib/supabase/row-limit-guard.test.ts)
   acusa isso hoje, inclusive em `scripts/`.
3. **Separe onda de vale.** As ondas são a cada 30 min; medir "durante uma hora"
   não garante amostra da onda. A instrumentação do laço carimba o número de itens
   por ciclo, então dá para separar depois.
4. **Atividade humana concorrente muda os tempos.** Agendamento em massa,
   cancelamento e sincronização de perfis rodando durante a medição dissolvem a
   atribuição de causa. Medir **por dentro** do laço é imune a isso.
5. **Log de erro do PM2 é o sinal de saúde.** Não escreva informação esperada nele
   (`console.info`, não `console.warn`), senão o alarme cega.

### Instrumentação disponível

`publication-worker.mjs` loga, em cada ciclo com trabalho:

```
tempos do ciclo de despacho { itens, concorrencia, cicloMs,
  fasesMs: { lerSpool, selecionar, ativarNoBanco, descartarMortos, processarItens },
  porItemMs: { p50, p90, max }, esperaPorSlotMs: { p50, p90, max } }
```

`esperaPorSlotMs` alto = concorrência saturada. `esperaPorSlotMs` baixo com
poucos itens = **despacho faminto**, o problema está a montante.

---

## 8. Números de referência (30/08/2026)

| Métrica | Valor medido |
|---|---:|
| Perfis Zernio | 3.290 |
| Chaves Zernio distintas | 1.213 |
| Publicações/hora | ~2.300 |
| Pico por chave Zernio | 4/hora (limite: 25/hora) |
| Duração de uma criação Zernio | 6,5 s (máx. 45 s) |
| Taxa de erro Zernio | ~1% |
| Defasagem criação → confirmação | p50 75 s, p90 200 s |
| Atraso agendado → publicado | p50 156 s, p90 380 s, máx 597 s |
| Preparação | ~17.000/hora |
| Staging | ~125/min |
| VPS | 2 vCPU, 8 GB, load ~0,2 |
| Supabase | Medium, 4 GB |

---

## 9. Onde as regras de negócio ficam (SQL, não env)

| Regra | Onde |
|---|---|
| Espaçamento mínimo entre posts do mesmo perfil, por formato | migration 330 |
| Espalhamento dos perfis numa janela ao criar plano | migration 331 |
| Intervalo mínimo de 29 min entre slots | migration 328 |
| Teto de 7 dias de duração de plano | migration 329 |
| Geração justa entre planos, sem materializar slot vencido | migration 326 |
| Arquivar só falha terminal | migration 335 |
| Arquivo frio (tabela + função de mover) | migration 333 |
| Índices de FK que tornam o DELETE viável | migration 334 |

**A guarda de espaçamento é por perfil e por formato**, não por organização.
Reel conta contra reel; story é trilha separada. O valor padrão é 25 min
(deliberadamente **abaixo** dos 30 min de intervalo de plano, para não cascatear).

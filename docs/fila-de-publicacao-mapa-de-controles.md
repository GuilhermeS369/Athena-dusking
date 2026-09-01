# Fila de publicação — mapa de controles

**Para que serve:** quando alguém precisar **aumentar a velocidade** da fila ou
ajustá-la para uma frota maior, este é o lugar para ler ANTES de mexer. Ele diz
onde cada botão está, o que ele controla de verdade, qual é o teto que morde
primeiro hoje, e quais experimentos já falharam — para não repetir.

Escrito em 31/08/2026, depois de três dias de investigação em produção. **Todos os
números são medidos, não estimados.** Onde há estimativa, está dito.

---

## 1. Estado atual (31/08/2026, 04:05 UTC)

| Métrica | Valor medido |
|---|---:|
| **Criação (publicação real)** | **736/min** |
| Confirmação (`published_at`) | 123/min |
| Onda de 434 itens escoa em | **0,6 min** |
| Atraso p50 / p90 / p99 | 142 s / 485 s / 694 s |
| Itens vencidos em regime normal | 0–16 |
| Duração de uma criação Zernio | ~5,8 s |
| Taxa de erro Zernio | ~1% |
| VPS | 2 vCPU / 8 GB, load ~0,2 |

**Como estava no início da investigação:** onda de 452 itens em 10 minutos
(45/min). O ganho foi de **16×**, e veio quase todo de UMA correção — a da
seção 3.

---

## 2. O caminho de uma publicação

```
  plano em massa
       │
       ▼
  GERAÇÃO ──► publication_items (waiting, preparation_status=pending)
       │       publication-generation-worker.mjs
       ▼
  PREPARAÇÃO ──► preparation_status=ready     [~17.000/hora]
       │          resolve mídia, valida
       │          laço próprio em publication-worker.mjs
       ▼
  STAGING ──► arquivo no spool em disco       [~480/min]
       │       /var/lib/athena-publication-spool/<id>.json
       │       monta o envelope ATE 600s ANTES de vencer
       │       NÃO chama a API de publicação
       ▼
  DESPACHO ──► POST na Zernio ──► creation_id  [736/min medido]
       │        dois caminhos, ver seção 5
       ▼
  CONFIRMAÇÃO ──► getPost ──► published_at + permalink   [123/min]
                   ciclo POSTERIOR, ~75s depois
```

### Armadilha nº 1: `published_at` NÃO é o horário da publicação

`published_at` marca a **confirmação**, não o envio. O publicador cria o post,
devolve `state: 'processing'`, e confirma num ciclo seguinte.

**Para medir capacidade, use `provider_creation_started_at`.** Medir por
`published_at` embute 75–176 s de defasagem e faz o sistema parecer 3–6× mais
lento do que é. Isso me custou horas.

---

## 3. A CAUSA RAIZ que segurava tudo, e a família dela

O sistema tinha **quatro guardas** que cediam a uma condição
**permanentemente verdadeira sob carga**: "existe publicação vencendo".

Durante uma onda isso é sempre verdade. Então cada guarda, sozinha, parava seu
estágio o tempo inteiro.

| # | Onde | O que fazia | Correção |
|---|---|---|---|
| 1 | Preparação | cedia enquanto houvesse item vencendo em 60 s | teto de cessões seguidas |
| 2 | Staging — guarda de entrada | idem; rodava 1 ciclo a cada 4 | teto de cessões + janela 60 s → 5 s |
| 3 | Staging — guarda de pressão | cedia por itens já aceitos aguardando confirmação | desligada: staging não usa capacidade do provedor |
| 4 | **Staging — cancelador cooperativo** | **abortava o ciclo em andamento a cada 2 s** | **desligado** |

**A nº 4 era a que mais custava**, e foi a última a ser encontrada — só aparece
lendo o código, nunca em métrica externa:

```js
const cancelWatcher = setInterval(() => {
  stagingHasSafeWindow(spool, Date.now())
    .then((safe) => { if (!safe) cancelled = true; });
}, 2000);
```

Todo ciclo de staging morria ~2 segundos depois de começar. Os números batiam
exatamente: `claimed: 100, persisted: 32-37, duracaoMs: 2237-2771`. Reivindicava
100, gravava ~30, liberava 70, repetia.

**Consequência:** o spool chegava na onda com um terço dela preparada. O resto
caía no caminho lento. Depois da correção, o spool chega com **685 itens
carregados** e a onda escoa em 36 segundos.

### A regra que evita repetir isso

> **Toda guarda que cede precisa de teto de cessão ou limiar proporcional.**
> E antes de fazer um componente ceder a um sinal, pergunte se ele **consome o
> recurso em disputa**. O staging cedia capacidade da Zernio que ele nem usa.

### Limiares: 60 s não é sinal, é ruído

Medido em 660 minutos: existia item vencido há mais de 60 s em **99% dos
minutos**.

| Limiar | Minutos com sinal ativo |
|---:|---:|
| 60 s | 99% |
| 300 s | 96% |
| 600 s | 90% |
| 1200 s | 29% |

**Um limiar verdadeiro 99% do tempo não informa nada.** Recalibre contra a
distribuição real antes de escolher.

---

## 3-A. O INCIDENTE DE 31/08/2026 — leia antes de subir concorrência

**3.315 publicações perdidas, 946 perfis, 20 horas sangrando.** Não foram
atrasos: foram posts que nunca saíram, encerrados em definitivo com
`retryable: false` na primeira tentativa. O usuário percebeu como intervalos de
2 a 5 horas entre posts de um mesmo perfil.

| hora (UTC) | taxa de perda |
|---|---:|
| até 31/08 14h | 0,0% |
| 31/08 15h | 12,0% |
| 31/08 20h | **19,7%** |
| 01/09 03h–10h | 2,5–5,6% |

### O gatilho

Subir `STAGED_DISPATCH_CONCURRENCY` de 64 para **160**, em cima da medição de
saturação da onda de 1.486 itens (`esperaPorSlot` p50 de 34 s). A leitura da
saturação estava certa. A conclusão de que bastava dar mais vagas estava errada.

`reserve_publication_dispatch_capacity` pega um **advisory lock por
organização**, e uma onda inteira é de uma organização só. Os 160 despachos
enfileiraram no mesmo lock, cada um segurando uma conexão enquanto esperava. O
pool do Supabase esgotou: primeiro `statement timeout` (57014), depois
`ConnectTimeoutError` — o banco recusando conexão nova.

**A concorrência não virou vazão, virou espera dentro do banco em vez de espera
dentro do worker.** E a vazão *caiu*: 1.566–1.989 publicações/hora durante o
incidente, contra 2.200–2.400 normais.

### O amplificador, que é o defeito de verdade

Uma queda de conexão com o banco deveria ser adiada por 30 s com a tentativa
intacta. Não foi, porque `isPublicationInfrastructureError` testava
`error instanceof TypeError` — e **o supabase-js não propaga o TypeError
original**: entrega um objeto simples
`{ message: 'TypeError: fetch failed', details, hint, code: '' }`, que não é
instância de `Error`. O texto "fetch failed" também não batia com nenhum termo
da lista de mensagens. Statement timeout escapava disso só porque vem com
`code: '57014'`.

Pior: **o cron da Vercel não tinha guarda nenhuma**, nem quebrada. Dois
despachantes com catch-alls idênticos, um só protegido.

Corrigido em `lib/publications/infrastructure-error.ts`, agora módulo único para
os dois caminhos, com `infrastructure-error.test.ts` comparando as duas
implementações caso a caso.

### A regra que fica

**Não suba a concorrência de despacho sem fatiar o advisory lock por
organização antes** (opção 3 da remediação de lock, ainda pendente). Enquanto
ele serializar, subir daqui só troca uma fila visível no worker por uma fila
invisível dentro do Postgres — e essa apaga publicação.

E a lição de método, que é a terceira vez que aparece neste documento:
**uma medição correta não valida a ação que você deduziu dela.** Eu tinha o
número certo (`esperaPorSlot` saturado) e agi sem observar a janela depois de
aplicar — justamente a etapa que o plano exige e que eu pulei porque o
experimento anterior no mesmo parâmetro tinha sido inócuo.


## 4. COMO AUMENTAR A VELOCIDADE A PARTIR DAQUI

Esta é a seção a ler quando a frota crescer. **Os tetos estão em ordem de quem
morde primeiro.**

### Teto nº 1 — o espaçamento serializado da Zernio (JÁ ESTAMOS NELE)

```js
// publication-direct-dispatch.mjs
const zernioCreateMinimumSpacingMs = integerEnv('PUBLICATION_WORKER_ZERNIO_CREATE_SPACING_MS', 75, 0, 2_000);
```

`paceZernioCreate` é um **portão serializado do processo**: cada criação começa
pelo menos 75 ms depois da anterior.

```
75 ms  →  13,3/s  →  800/min   ← medimos 736/min. Estamos a 92% do teto.
```

**Para ir além de ~800/min, há duas saídas:**

1. **Baixar o espaçamento.** 40 ms → 1.500/min; 25 ms → 2.400/min. Barato, mas
   aumenta rajada contra o provedor. A folga existe: medido pico de **4 posts/hora
   por chave** contra o limite de **25/hora por conta** — 16% do teto da Zernio.
2. **Mais de um processo publicador.** O portão é **por processo**, então dois
   publicadores dobram o teto sem tocar no espaçamento. Exige `PUBLICATION_WORKER_ID`
   distinto por processo (o claim e as reservas já são seguros para concorrência).

**Sob backpressure o espaçamento vira 200 ms → 300/min.** Ver seção 6.

### Teto nº 2 — a confirmação (123/min)

O post vai ao ar em 36 s, mas `published_at` só chega a 123/min. Isso **não
atrasa a publicação**, atrasa a contabilidade. Vira problema se alguma decisão
depender de `published_at` chegar rápido.

O caminho de confirmação é o polling: item criado volta 120 s depois
(`zernioPollingDelaySeconds`) e tem **prioridade sobre criações novas**
(`priority_band = 0` em `claim_publication_items`). Se um dia a confirmação for
o gargalo, é nesses dois pontos que se mexe.

### Teto nº 3 — os limites de conta da Zernio

25 posts/hora por conta, 100/dia por conta. Medido: pico de 4/hora. **Só vira
problema se um mesmo perfil postar mais de 25 vezes por hora**, o que a regra de
espaçamento de 25 min entre reels já impede.

### A conta para dimensionar

```
vazão necessária = perfis ÷ janela_de_espalhamento_em_minutos

5.000 perfis / janela de 10 min  =   500/min   ← cabe hoje (736/min)
10.000 perfis / janela de 10 min = 1.000/min   ← exige teto nº 1
30.000 perfis / janela de 10 min = 3.000/min   ← exige múltiplos processos
```

---

## 5. Os dois caminhos de despacho — e por que isso confunde

**Caminho do spool** (`dispatchDueStagedPublications`): lê o spool em disco,
seleciona, ativa via `activate_staged_publication_items`, processa com
concorrência 64. **É o caminho rápido** — um ciclo já processou 712 itens.

**Caminho direto** (`dispatchPublicationQueueDirect`): reivindica direto do banco
via `claim_publication_items`, com lote de tamanho **adaptativo**. Mais lento.

**Um item só vai pelo caminho rápido se estiver no spool quando vencer.** O
staging só prepara itens com `execute_at` **no futuro** — depois de vencer, um
item nunca mais entra no spool.

⚠️ **Antes de mexer em qualquer botão de despacho, confirme qual caminho está
processando**, no log: `stagedDispatch: { due, selected, activated }` para o
spool, `claimed: N` para o direto. Horas foram gastas ajustando botões do caminho
que estava ocioso.

---

## 6. Onde fica cada botão

Todos em **`/opt/athena-worker/.env.worker` na VPS**. Os padrões estão no código
(`integerEnv(...)`), e **o padrão do código é o que vale num deploy limpo** —
mudar só o `.env` deixa o repositório mentindo.

### Staging (enche o spool — o estágio mais sensível)

| Variável | Padrão | Controla |
|---|---:|---|
| `PUBLICATION_WORKER_STAGING_LIMIT` | 100 | itens por ciclo |
| `PUBLICATION_WORKER_STAGING_CONCURRENCY` | 8 | paralelismo |
| `PUBLICATION_WORKER_STAGING_WINDOW_SECONDS` | 600 | antecedência com que prepara |
| `PUBLICATION_WORKER_STAGING_LEASE_SECONDS` | **660** | validade da reserva — ver nota |
| `PUBLICATION_WORKER_STAGING_DUE_GUARD_MS` | 5000 | cede se há publicação vencendo |
| `PUBLICATION_WORKER_STAGING_MAX_CONSECUTIVE_SKIPS` | 1 | teto de cessões |
| `PUBLICATION_WORKER_STAGING_PRESSURE_YIELD` | **false** | guarda nº 3 (seção 3) |
| `PUBLICATION_WORKER_STAGING_COOPERATIVE_CANCEL` | **false** | guarda nº 4 — **não religue sem ler a seção 3** |
| `PUBLICATION_WORKER_STAGING_FAST_PER_ITEM_MS` | 1200 | limiar do controlador adaptativo |

> **Nota sobre o lease (660 s):** ele deve ficar **logo acima da janela** (600 s).
> A conta importa: se o arquivo do spool se perder, o item fica invisível para os
> dois caminhos até a reserva expirar. Com lease 1200 e janela 600, isso dava
> `1200 − 600 = 600 s` = **10 minutos** presos — e era exatamente a duração
> constante de todas as ondas, de 189 a 512 itens. Duração constante independente
> do tamanho **não é limite de vazão, é relógio.**

### Despacho

| Variável | Padrão | Controla |
|---|---:|---|
| `PUBLICATION_WORKER_LIMIT` | 100 | teto do lote do caminho direto |
| `PUBLICATION_WORKER_POLL_INTERVAL_MS` | 5000 | frequência do laço |
| `PUBLICATION_WORKER_STAGED_DISPATCH_LIMIT` | 500 | itens por ciclo (spool) |
| `PUBLICATION_WORKER_STAGED_DISPATCH_CONCURRENCY` | 64 | paralelismo (spool) |
| `PUBLICATION_WORKER_STAGED_MAX_PER_ORGANIZATION_PER_MINUTE` | 600 | teto de seleção por org |
| `PUBLICATION_WORKER_ADAPTIVE_COLLAPSE_RATIO` | 0.1 | ver abaixo |

### Zernio

| Variável | Padrão | Controla |
|---|---:|---|
| `PUBLICATION_WORKER_ZERNIO_CREATE_SPACING_MS` | **75** | **teto de 800/min — ver seção 4** |
| `PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_SPACING_MS` | 200 | sob backpressure → 300/min |
| `PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_MS` | 60000 | duração do backpressure |
| `PUBLICATION_WORKER_ZERNIO_BACKPRESSURE_THRESHOLD` | 3 | falhas transitórias para ligar |

### Preparação e manutenção

| Variável | Padrão | Controla |
|---|---:|---|
| `PUBLICATION_WORKER_PREPARATION_LIMIT` | 150 | itens por ciclo |
| `PUBLICATION_WORKER_PREPARATION_CONCURRENCY` | 8 | paralelismo |
| `PUBLICATION_WORKER_PREPARATION_MAX_CONSECUTIVE_SKIPS` | 3 | teto de cessões |
| `MEDIA_MAINTENANCE_COLD_STORAGE_ENABLED` | true | move arquivados para tabela fria |
| `MEDIA_MAINTENANCE_COLD_STORAGE_BATCH` | 50 | itens por chamada |

### No BANCO, não em env

| Onde | Valor | Cuidado |
|---|---:|---|
| `publication_rate_limit_settings.max_provider_publications_per_minute` (zernio) | 600 | **não é vazão pura** |

⚠️ Esse teto é comparado contra *publicados no último minuto* **mais as reservas
ativas**. Cada publicação/minuto custa ~4 unidades por causa dos itens em voo.
Medido: 48 publicados + 152 reservas = 200, batendo no teto antigo de 200 e
prendendo a vazão real em ~50/min.

---

## 7. O controlador adaptativo, e a matemática dele

`nextAdaptiveDispatchLimit` decide o tamanho do lote do caminho direto. Ele
**começa em 10** e se ajusta sozinho — `PUBLICATION_WORKER_LIMIT` é só o teto.

A versão antiga fazia **+20% quando o lote enchia e METADE a cada UM erro**. Com
a taxa de erro real de ~1%:

```
(1-P)·log(1,2) + P·log(0,5) = 0   =>   P = 20,8%
1-(0,99)^L = 0,208                =>   L ≈ 23
```

**Convergia para ~23 itens e não passava disso**, qualquer que fosse a
capacidade. Hoje: 429/rate-limit derruba na hora; erro transitório só derruba
com ≥10% do lote (`PUBLICATION_WORKER_ADAPTIVE_COLLAPSE_RATIO`); abaixo disso
segura sem punir.

O staging usa **outro** controlador (`createAdaptiveBulkController`), cujos
limiares padrão são de **banco de dados** (25 ms/item). O staging faz **rede**
(500–690 ms/item), então ficava travado no mínimo. Corrigido com limiares próprios.

---

## 8. Como medir sem se enganar

1. **Use `provider_creation_started_at`**, não `published_at`.
2. **Ordenação determinística ao paginar.** Uma onda tem centenas de itens com o
   mesmo `execute_at`; paginar por ele sem desempate perde e repete linhas.
   Medido: 91 repetidas e 91 perdidas em 11.332 — o bastante para **inverter
   conclusões**. Use `order=execute_at,id`.
3. **Separe onda de vale.** Ondas a cada 30 min; medir "durante uma hora" não
   garante amostra da onda.
4. **Atividade humana concorrente muda os tempos.** Agendamento em massa e
   cancelamento durante a medição dissolvem a atribuição de causa.
5. **Meça POR DENTRO do laço.** A instrumentação por fase foi o que finalmente
   localizou o problema; métrica de fora nunca mostraria.
6. **`console.info`, não `console.warn`.** O log de erro do PM2 é o sinal de
   saúde que decide rollback — não polua com informação esperada.

### Instrumentação disponível no log

```
tempos do ciclo de despacho { itens, concorrencia, cicloMs,
  fasesMs: { lerSpool, selecionar, ativarNoBanco, descartarMortos, processarItens },
  porItemMs: {p50,p90,max}, esperaPorSlotMs: {p50,p90,max} }

tempos do ciclo DIRETO { itens, limiteAdaptativo, cicloMs, fasesMs, porItemMs }

controlador do staging { passoAtual, minimo, maximo, motivo, duracaoMs, msPorItem }
```

**`esperaPorSlot` alto** = concorrência saturada.
**`esperaPorSlot` baixo com poucos itens** = despacho **faminto**, o problema
está a montante.

---

## 9. Experimentos que FALHARAM — não repita

Sete hipóteses foram refutadas por medição antes de a causa aparecer. Todas
mexiam em **capacidade**, e a fila não estava esperando capacidade.

| Experimento | Resultado |
|---|---|
| Concorrência do staged dispatch 32 → 64 | sem efeito (62 vs 69/min) |
| **Concorrência do staged dispatch 64 → 160** | **causou o incidente de 31/08: 3.315 posts perdidos. Ver seção 3-A** |
| Teto por organização no worker 300 → 600 | sem efeito (75 vs 81/min) |
| Reduzir cessão do staging 3 → 1 | sem efeito na drenagem |
| Teto por minuto no banco 200 → 600 | adiamentos zeraram, vazão não mudou |
| Destravar o controlador do staging (25 → 100) | passo subiu, vazão não mudou |
| Corrigir o controlador adaptativo (23 → 78) | limite subiu, vazão não mudou |
| Liberar reserva de item não despachado | no-op: a ativação já limpava |

**Só funcionaram:** lease 1200 → 660 (45% do ganho) e **desligar o cancelador
cooperativo** (o resto).

---

## 10. Onde as regras de negócio ficam (SQL, não env)

| Regra | Migration |
|---|---|
| Espaçamento mínimo entre posts do mesmo perfil, por formato | 330 |
| Espalhamento dos perfis numa janela ao criar plano | 331 |
| Intervalo mínimo de 29 min entre slots | 328 |
| Teto de 7 dias de duração de plano | 329 |
| Geração justa entre planos, sem materializar slot vencido | 326 |
| Arquivar só falha terminal | 335 |
| Arquivo frio (tabela + função de mover) | 333 |
| Índices de FK que tornam o DELETE viável | 334 |
| Teto por minuto da Zernio (600) | 340 |

**A guarda de espaçamento é por perfil e por formato**, não por organização. Reel
conta contra reel; story é trilha separada. Padrão de 25 min, deliberadamente
**abaixo** dos 30 min de intervalo de plano, para não cascatear.

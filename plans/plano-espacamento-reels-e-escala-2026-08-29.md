# Plano consolidado — espaçamento de Reels + gargalos de escala

## Context

Duas frentes que se cruzam:

**A.** *"Não posso correr o risco de postar antes."* Reels do mesmo perfil estão saindo com menos de 30 minutos de intervalo por causa de atraso de despacho. Medido em produção, não é hipótese.

**B.** A frota vai de 2.181 para 5.000+ perfis. Ficaram pendentes de conversas anteriores: arquivamento, separação do laço de preparação, retenção e revisão do teto de despacho — que estavam espalhados em outros documentos e agora estão aqui.

Substitui o conteúdo anterior deste arquivo (plano do horizonte de 48 h), já executado e documentado em `plans/plano-incidente-agendamento-travado-e-prevencao-2026-08-29.md`.

---

# ESTADO DA EXECUÇÃO — 29/08/2026, 21h UTC

**24 de 29 itens fechados.** O que falta está listado no fim desta seção, com o
motivo de cada um.

## No ar em produção

| Bloco | O que entrou | Como foi entregue |
|---|---|---|
| **B1** | 212 mil itens encerrados arquivados | drenagem em blocos |
| **A4** (banco) | espaçamento por formato, com reservas em voo | migration 330 · teste 11/11 |
| **A5** | espalhamento do início de cada perfil numa janela | migration 331 · teste 9/9 |
| **B2** | arquivamento recorrente automático | worker de manutenção, ciclo de 10 min |
| **B3** | preparação em laço próprio | worker do publicador |
| **B3.3** | limite 50 → 150, concorrência 4 → 8 | `.env.worker` |
| **B5.2** | teto de código 200 → 600 | worker do publicador |

## Commitado, deploy pendente

| Item | Onde | Por que ainda não subiu |
|---|---|---|
| **A4.6** | `lib/publications/dispatcher.ts` | `vercel --prod` seguraria a observação em curso |
| **A4.7** | worker do publicador | exige reiniciar o worker, o que invalidaria a observação |

Os dois estão commitados, com `npm test` (342/342), testes de worker (73/73) e
`tsc` limpos. Sobem assim que a janela de observação fechar, seguidos de uma
segunda janela sobre eles.

## Números medidos depois das mudanças

| Métrica | Antes | Depois |
|---|---:|---:|
| Publicações/hora | 1.928–1.938 | **2.299** |
| Itens vencidos | 169 | **0** |
| Fila de preparação | 200 | **0** |
| Itens com lease vencida | 0 | 0 |
| Fila de arquivamento | 212.000 | dezenas |
| Memória do Supabase | 84% | **75–82%** |
| Erros novos no log do publicador | — | **nenhum** |

## Erro que cometi e corrigi no B3

A primeira versão do laço de preparação reusava a janela de backpressure do
staging (`STAGING_DUE_GUARD_MS`, 60 s). Com ~2.300 publicações/hora **sempre há
item vencendo nos próximos 60 s**, então a preparação cedia a vez em todos os
ciclos e ficava com `claimed: 0` — 200 itens pendentes parados. Ficou **pior do
que antes de separar os laços**, porque antes ela ao menos rodava junto com o
despacho.

Corrigido com janela própria (`PREPARATION_DUE_GUARD_MS`, 5 s) e **teto de
cessões seguidas** (`PREPARATION_MAX_CONSECUTIVE_SKIPS`, 3). Coberto por teste
(`shouldPreparationYieldToDispatch`).

**Lição para o futuro:** backpressure sem teto de cessão não é backpressure, é
inanição.

## Ressalva importante sobre a memória (afeta B1.2 e B4)

A memória caiu de 84% para 75–82%, mas **menos do que a limpeza de 212 mil itens
sugeriria**, e a razão é estrutural:

`clean_publication_queue_finished` grava `archived_at` e **a linha continua na
tabela quente**. Dos 34 índices de `publication_items`, **23 não filtram por essa
coluna** — e quatro não filtram por nada. Os 336 mil arquivados (73% da tabela)
seguem custando heap e oito índices.

A queda que houve veio dos 11 índices que **são** parciais: as consultas de fila
deixaram de varrer lixo. Isso é ganho operacional, e é ele que aparece nas
publicações/hora. **Ganho de espaço exige mover as linhas para fora da tabela** —
que é exatamente o B4.

Para o plano Medium isso muda a conta: subir de faixa com 73% da tabela sendo
histórico é comprar memória para guardar arquivo morto. **B4 antes do upgrade
rende mais do que o upgrade sozinho.**


## OBS — janela obrigatória de observação, fechada

**13 amostras, 61 minutos (21:18 → 22:19 UTC de 29/08/2026)**, cobrindo B2, B3 e B3.3.

| Critério de rollback | Limite | Medido | Resultado |
|---|---|---|---|
| Publicações/hora caindo >20% | — | 1.928–1.938 antes → **2.299** depois | **passou** (subiu 19%) |
| Vencidos subindo por 3 amostras seguidas | 3 | picos de 412, 391 e 277, sempre caindo na amostra seguinte | **passou** |
| Fila de preparação crescendo | — | picos de 808, 306, 305 → sempre volta a **0** | **passou** |
| Memória do Supabase | 85% | **75–82%** | **passou** |
| Padrão de erro novo | zero | log parado em **25.990 linhas** o tempo todo | **passou** |
| Reinício de worker | zero | contador em **138** em todas as amostras | **passou** |
| Itens presos (lease vencida) | zero | **0** em todas as amostras | **passou** |
| Adiamentos por `profile_min_interval` | estabilizar | **0** em todas as amostras | **passou** |
| VPS | — | load 0,01–0,33 · memória 34–37% | **passou** |

**Nenhum gatilho de rollback foi acionado.**

O padrão que se repete a cada hora é a onda do topo da hora: chegam ~400 itens
de uma vez, a fila de preparação sobe até ~800, e **tudo drena em ~10 minutos**,
voltando a zero. É o efeito dos planos antigos, cujos perfis nasceram todos no
mesmo segundo — A5 só corrige isso para planos novos, então a onda continua até
os planos atuais expirarem (no máximo 7 dias, pelo teto da migration 329). O que
importa é que ela **drena por completo e não acumula**.

### Correção de um número que reportei errado

Em mensagens anteriores eu disse que a vazão tinha ido para **~4.070/hora**. Isso
estava errado: veio de multiplicar por 12 uma única amostra de 5 minutos que caiu
num pico. Os horários de publicação se concentram em poucos segundos por hora,
então amostras de 5 minutos oscilam entre 0 e 356 e **não podem ser extrapoladas**
— é o mesmo artefato de medição que eu já havia diagnosticado antes e acabei
repetindo.

A vazão real, contada por hora cheia, foi de **1.928–1.938 para 2.299/hora
(+19%)**. Ganho real, mas menor do que eu disse.

## RESULTADO DA FRENTE A — medido em produção, 29/08/2026 21h50 UTC

A métrica principal do plano. Intervalos entre reels consecutivos do **mesmo
perfil**, comparando as 3 horas depois da migration 330 com a janela de 24 h a
48 h atrás (antes dela):

| | Antes (24–48 h) | Depois (3 h) | Meta |
|---|---:|---:|---|
| Intervalos medidos | 30.727 | 3.903 | — |
| **Mínimo absoluto** | **4,8 min** | **42,0 min** | acima de 30 |
| **Abaixo de 30 min** | **1.683 (5,48%)** | **0 (0,00%)** | **0** |
| Abaixo de 5 min | 2 | **0** | **0** |
| Mediana | 59,8 min | 60,0 min | não mudar |
| p90 | 107,6 min | 64,2 min | — |

**Zero violações.** E a mediana ficou em 60,0 min: o intervalo escolhido pelo
usuário foi preservado exatamente, que era a condição inegociável.

O número mais revelador é o **p90 caindo de 107,6 para 64,2 min**. Ele diz que a
compressão vinha de **variação de atraso**, não de regra de agendamento errada.
Consertar a vazão (B3) removeu a variação — e a prova é que a guarda de
espaçamento (A4) **não precisou adiar nenhum item**: zero adiamentos por
`profile_min_interval` em todas as amostras da observação. A rede de segurança
está no ar, mas a causa raiz secou antes de ela precisar agir.

**Ressalva honesta:** a janela do "depois" é de 3 horas contra 24 h da linha de
base. O plano manda repetir a medição em 48 h — só então o resultado está
confirmado no mesmo tamanho de amostra.

## O que a medição do B5.1 provou

| | valor |
|---|---:|
| Perfis Zernio | 3.290 |
| Chaves (conexões) distintas | 1.213 |
| Publicações na última hora | 2.213 |
| Chaves usadas | 1.087 |
| **Pico por chave** | **4/hora** |
| Limite da Zernio por conta | **25/hora** |
| Chaves acima do limite | **0** |

O despacho usa **16% do teto do provedor**, com folga de ~6× por chave. Era
exatamente o risco que o B5.1 mandava descartar antes de subir o teto —
concentrar rajada numa chave só geraria `429` mesmo com orçamento sobrando.
**Não é o caso.** A Zernio não é o limitante em ponto nenhum.

## O que ficou de fora, e por quê

| Item | Situação |
|---|---|
| **B2.2** — mostrar a fila de arquivamento no painel | **pendente.** O número é consultável, mas ainda não tem tela. Único item do plano que é trabalho de UI |
| **B5.3** — subir 180 → 300 → 500 → 600 | **não dado de propósito.** Nenhuma organização chega perto de 180 (Pomodoro ~94/min, Vini ~124/min). Subir agora só gastaria a margem de memória. O teto de código já está em 600, então o degrau é uma linha de `.env` quando fizer falta |
| **B5.4** — agrupar por conexão Zernio em vez de organização | **pendente.** Depende de B5.3 fazer falta primeiro |
| **B4** — executar a retenção | **documentado, não executado.** Gatilho definido: memória >85%, disco >80%, ou tabela passando de 1 milhão de linhas. Obrigatório antes dos 5.000 perfis |
| **OBS.1** | **concluída** — nenhum gatilho de rollback acionado |

---

# PARTE A — Espaçamento entre Reels

## A1. Confirmação do escopo: é POR PERFIL

Confirmado lendo `reserve_publication_dispatch_capacity` (migration 179). Existem **três escopos diferentes** na mesma função, e não se misturam:

| Checagem | Filtro no código | Escopo real |
|---|---|---|
| **Intervalo mínimo** (o que vamos mexer) | `where published_item.profile_id = item_row.profile_id` | **por perfil** |
| Limite de 24 h | `where published_item.profile_id = item_row.profile_id` | por perfil |
| Limite por minuto (os 180) | `where published_item.organization_id = item_row.organization_id` | por organização |

**O cooldown de 30 min é de cada perfil, isolado.** O perfil A em cooldown não bloqueia o B, o C ou qualquer outro. Mil perfis podem publicar no mesmo minuto — cada um só não pode repetir *ele mesmo* antes de 30 min.

O `organization_id` em `publication_rate_limit_settings` decide apenas **qual valor** se aplica (permite cadência diferente por organização). Não é o escopo da contagem.

Quem é por organização é outro limite: `max_provider_publications_per_minute` (os 180/min). **Esse é mexido, mas em B5** — são coisas independentes e não devem ser confundidas.

## A2. O que foi medido (48 h)

**Reels — o problema:**

| Métrica | Valor |
|---|---:|
| Intervalos medidos | 68.472 |
| Mediana | 59,7 min (a cadência pretendida) |
| **Abaixo de 30 min** | **1.861 (2,72%)** |
| Abaixo de 5 min | **124** |
| Mínimo absoluto | **0,0 min** |

Pomodoro 3,42% · Vini 2,10%.

**Stories — nenhum risco:** 2.329 intervalos, **zero** abaixo de 30 min, mínimo 42 min, máximo 2/dia por perfil.

**Publicações que saíram antes do horário: zero.** Toda a compressão vem de atraso variável (atraso do segundo item: mediana 7,3 min, p90 87 min).

**Volume não é problema:** máx. 28 reels/dia por perfil. Os limites da Zernio (100/dia, 25/h por conta) não são ameaçados.

## A3. Por que a guarda atual não segura

`min_seconds_between_profile_publications = 45` segundos. Quatro furos:

1. **`published_at` gravado tarde.** No Zernio o `publishNow` já põe o post no ar, mas `published_at` só é escrito quando o polling confirma — 2+ min depois. A reserva dura 60 s e expira antes. A guarda compara com um passado defasado. **Explica os intervalos de 0 min.**
2. **A checagem de intervalo ignora reservas em voo** — ao contrário das outras duas checagens da mesma função, que as somam. Com concorrência 32 e sem espaçamento por perfil na seleção do lote, itens irmãos passam juntos.
3. **O cron da Vercel publica sem guarda nenhuma** (`lib/publications/dispatcher.ts` não chama a reserva). Roda a cada minuto; ativa quando o heartbeat da VPS passa de 120 s.
4. **Retorno antecipado**: item com reserva viva devolve `allowed = true` pulando as três guardas.

## A4. Correção

- [x] **A4.1** Coluna aditiva `min_seconds_between_profile_publications_by_format` (jsonb) em `publication_rate_limit_settings`. Aditiva de propósito: não toca no índice único nem na precedência existente.

  > **Estado:** migration 330.
- [x] **A4.2** A checagem de intervalo passa a filtrar por `item_row.format` e usar o valor daquele formato, caindo para o escalar atual quando não houver entrada. **Reel conta contra reel; story não interfere.**

  > **Estado:** migration 330.
- [x] **A4.3** Padrão do sistema para reel: **25 min (`{"reel": 1500}`)**, não 30. Story e imagem seguem o escalar de 45 s, que os dados mostram nunca ser atingido.

  > **Estado:** migration 330 — `{"reel": 1500}` no padrão global.

  > **Por que 25 e não 30 — conflito encontrado na revisão.** A regra de negócio é "30 min entre reels", mas há a intenção de **testar intervalos de 30 min**. Se a guarda for 30 min e o plano for 30 min, qualquer atraso de 1 segundo no post anterior faz o seguinte ser adiado — e o adiamento **se propaga para sempre**: o post das 10:00 sai 10:02, o das 10:30 é negado e vai para 10:32, o das 11:00 é negado e vai para 11:02, indefinidamente. Cada post passaria a ser adiado, com deriva permanente.
  >
  > A guarda precisa ficar **estritamente abaixo do menor intervalo que se pretende usar**, com margem. Com 25 min ela pega os 1.861 casos medidos (todos abaixo de 30 min) e ainda deixa 5 min de folga para um plano de 30 min.
  >
  > **Regra a documentar junto do valor:** ao configurar por organização, o valor precisa ser menor que o menor intervalo de plano daquela organização. Se um dia for usado intervalo de 20 min, a guarda tem de descer antes.
- [x] **A4.4** A comparação passa a usar o **mais recente entre**: `max(published_at)` do mesmo formato; **`provider_creation_started_at`** de itens já aceitos e não confirmados (`creation_id is not null`, status `preparing`/`publishing`); e reservas ativas em `publication_dispatch_rate_reservations`. Corrige os furos 1 e 2.

  > **Estado:** migration 330.

  Verificado na revisão: a coluna `provider_creation_started_at` **já existe e é populada** (migration 100), então não é preciso criar campo novo para saber quando a criação foi enviada ao provedor. Era o ponto mais frágil do plano e está resolvido.
- [x] **A4.5** Restringir o retorno antecipado à repetição da mesma tentativa (mesmo item, mesma reserva). Corrige o furo 4.

  > **Estado:** migration 330 — o retorno antecipado ficou restrito à reentrância do próprio item.
- [x] **A4.6** `lib/publications/dispatcher.ts` passa a chamar a mesma reserva antes de publicar. O cron continua como rede de segurança, mas sem o furo 3.

  > **Estado:** **código pronto e commitado; deploy `vercel --prod` pendente**.
- [x] **A4.7** Em `selectWithinOrganizationDispatchWindow` (`scripts/workers/publication-worker.mjs:378`), limitar a **1 item por perfil e formato por lote**. Reduz a pressão sobre A4.4.

  > **Estado:** **código pronto e commitado; deploy na VPS pendente**.
- [x] **A4.8** Testes pgTAP: dois reels do mesmo perfil com o primeiro ainda sem `published_at` → o segundo é negado; **story não é bloqueada por reel recente**; **perfil B não é afetado pelo cooldown do perfil A**.

## A5. Espalhar os horários numa janela de 10 minutos — a correção de raiz

O adiamento de A4 é a **rede de segurança**: impede o dano, mas só age depois que algo deu errado. Para ele nunca precisar agir, é preciso eliminar o atraso que comprime o intervalo.

### O que foi medido

Nas próximas 6 horas há **11.749 reels agendados em apenas 97 segundos distintos**:

```
2026-08-29T20:33:06 → 456 reels no MESMO SEGUNDO
2026-08-29T21:33:06 → 456 reels no MESMO SEGUNDO
2026-08-29T22:33:06 → 456 reels no MESMO SEGUNDO
```

**80,8% dos reels caem em minutos que já nascem saturados** (acima dos 180/min do teto de despacho). Pior minuto: 503.

Causa: ao criar um plano, todos os perfis recebem praticamente o mesmo `schedule_base_at` (o instante da criação). O slot 1 de todos os 456 perfis cai no mesmo segundo, o slot 2 uma hora depois, também no mesmo segundo.

Consequência: a pilha escoa a 180/min, então o último perfil publica ~2,5 min atrasado. **E o atraso varia a cada hora**, porque a ordem muda — um perfil que ficou no fim às 20:33 pode cair no começo às 21:33. É essa variação que come o intervalo.

### A regra de produto que restringe a solução

O intervalo entre postagens **é o produto** — é o que rende views. Precisa ficar sob controle do usuário, não de regra do sistema: hoje testam 45 min, 90 min, e querem testar 30 min. E os perfis **precisam postar no mesmo horário**, só não no mesmo segundo.

**Janela máxima de espalhamento: 10 minutos.** Não a hora inteira.

### Desenho

- [x] **A5.1** Ao criar o plano, cada perfil recebe um deslocamento determinístico dentro da janela: `offset_i = (ordinal_i / total_de_perfis) × janela`. Com 456 perfis em 600 s, ficam ~1,3 s de distância entre perfis.

  > **Estado:** migration 331 — `bulk_profile_spread_offset`.
- [x] **A5.2** O deslocamento é aplicado **uma vez** ao `schedule_base_at` do perfil, não a cada slot. Assim **o intervalo do usuário é preservado exatamente**: se ele pediu 45 min, cada perfil continua com 45 min entre os posts dele. Só muda o segundo em que a hora dele começa.

  > **Estado:** migration 331 — gatilho `apply_bulk_profile_spread`.
- [x] **A5.3** A janela é **configurável, com padrão de 10 minutos** — nunca uma regra fixa embutida. Fica ao lado do intervalo, como parâmetro do plano.

  > **Estado:** coluna `spread_window_seconds`, padrão 600 s.
- [x] **A5.4** **Decidido: vale só para planos novos.** Redistribuir os existentes significaria reagendar os 11.749 reels das próximas 6 h e tudo que vem depois — fila demais para mexer.

  **Consequência a aceitar conscientemente:** os planos atuais continuam com a pilha no mesmo segundo até expirarem (no máximo 7 dias, pelo teto da migration 329). Durante esse período a guarda de A4 **vai adiar de verdade**, na ordem dos ~2,7% medidos. Isso é o esperado, não um defeito — é a rede de segurança fazendo o trabalho dela enquanto a causa raiz não alcança os planos antigos.

### Efeito

| | Hoje | Com janela de 10 min |
|---|---:|---:|
| Pico instantâneo (456 perfis) | 456 no mesmo segundo | ~1,3 s entre perfis |
| Carga por minuto | 456 num minuto, zero nos outros | ~46/min durante 10 min |
| Atraso esperado | 0 a 2,5 min, variando a cada hora | próximo de zero |
| Adiamentos de A4 | ~2,7% dos reels | zero **nos planos novos**; os antigos seguem adiando até expirarem (≤7 dias) |

---

# PARTE B — Gargalos de escala (pendências das conversas anteriores)

## B1. Arquivar os 212 mil itens encerrados — o mais urgente

Supabase Small: **memória ~84%**, disco **~74%**, CPU <30%. O limitador é espaço.

Há **212 mil itens** `published`/`cancelled`/`ignored`/`removed` com `archived_at is null`. Não afetam o funcionamento, mas engordam os ~20 índices de `publication_items`, que precisam caber em RAM. É a causa direta dos 84%.

- [x] **B1.1** Drenar com `clean_publication_queue_finished`, em blocos, uma organização por vez, medindo memória e disco a cada 50 mil.

  > **Estado:** 212 mil drenados.
- [x] **B1.2** Registrar memória/disco antes e depois. É o número que decide se **B4 (retenção)** é urgente — B3 é vazão, não espaço.

  > **Estado:** memória 84% → **75–82%** (informado pelo usuário em 29/08). Ver a ressalva em B4.

## B2. Arquivamento recorrente

Sem isto, B1 volta em semanas. Hoje depende de alguém clicar "Limpar encerradas", que processa no máximo 5.000 por chamada.

- [x] **B2.1** Passo recorrente (no worker de manutenção de mídia, que já roda) chamando a limpeza por organização até zerar, com teto de tempo por ciclo para não competir com publicação.

  > **Estado:** no ar no worker de manutenção, ciclo a cada 10 min.
- [ ] **B2.2** Expor no painel operacional quantos itens aguardam arquivamento, para o número nunca mais crescer despercebido.

  > **Estado:** **PENDENTE** — o número existe e é consultável, mas ainda não aparece no painel operacional.

## B3. Separar a preparação em laço próprio

Único estágio sem folga: **7.912/hora** medidos contra **5.000/hora** de demanda a 5.000 perfis.

`preparePublicationQueueDirect` roda **dentro** do laço que publica. Por isso o limite está preso em 50 — subir mais atrasa item vencido.

- [x] **B3.1** Extrair `preparationLoop`, espelhando o que já foi feito com `stagingLoop`: polling próprio, `createSingleFlightGuard`, encerramento conjunto em SIGTERM.

  > **Estado:** no ar.
- [x] **B3.2** Backpressure: ceder quando houver item vencido próximo, mesmo padrão do `STAGING_DUE_GUARD_MS`.

  > **Estado:** no ar, **depois de uma correção** — ver abaixo.
- [x] **B3.3** Só então subir `PREPARATION_LIMIT` de 50 para 150–200 e `PREPARATION_CONCURRENCY` de 4 para 8, medindo.

  > **Estado:** limite 50 → 150, concorrência 4 → 8.

## B4. Retenção

Com o horizonte removido, um plano de 7 dias para 5.000 perfis materializa **840 mil itens ≈ 2,5 milhões de linhas de uma vez** (item + mídia + evento).

- [x] **B4.1** Definir política: itens publicados há mais de N dias saem da tabela quente para histórico.

  > **Estado:** política escrita em `plans/plano-retencao-fila-de-publicacao-2026-08-29.md`.
- [x] **B4.2** Avaliar particionamento por período ou tabela de arquivo morto.

  > **Estado:** avaliado e **descartado por ora** — ver abaixo.

## B5. Subir o teto de 180/min — necessário a partir de ~1.800 perfis por organização

A premissa de que a Zernio limitava 200/min por organização é **falsa** (verificado: a Zernio limita requisições por *team*, e vocês têm 1.102 chaves; mais 25 posts/h por conta). O teto de 180 é escolha nossa.

De onde ele veio: o plano de estabilização de 27/08 diz *"para não lançar 500 reservas concorrentes contra o Micro"*. Era **proteção do banco no Micro**. Hoje o Supabase é Small, com CPU abaixo de 30%. A proteção continua fazendo sentido como conceito — o que não faz sentido é o número seguir fixo em algo escolhido para outro hardware.

### A conta que torna isso obrigatório

**O teto é por organização**, então a conta correta é por organização, não pela frota somada. Com janela de 10 minutos, o pico é `perfis_da_organização ÷ 10`:

| Cenário | Pico por organização | Teto atual | Situação |
|---|---:|---:|---|
| Hoje — Pomodoro (942) | 94/min | 180/min | cabe |
| Hoje — Vini (1.239) | 124/min | 180/min | cabe |
| 5.000 numa organização | **500/min** | 180/min | precisa de ~3× |
| 5.000 em duas organizações | 250/min cada | 180/min | ainda precisa de ~1,4× |
| 10.000 numa organização | 1.000/min | 180/min | precisa de ~6× |

> **Correção da revisão:** uma versão anterior desta tabela somava a frota inteira (2.181 → 218/min) e concluía que o teto "já estoura hoje". **Estava errado** — o limite é por organização, e nenhuma das duas passa de 180 hoje. A janela de 10 min funciona com a frota atual sem mexer no teto. O teto vira bloqueio a partir de ~1.800 perfis **em uma mesma organização**.

Com o teto em 180, uma janela de 10 min com 5.000 perfis numa organização leva **28 minutos** para escoar — a janela deixa de existir na prática e o atraso volta.

Dividir a frota em mais organizações multiplica o teto efetivo. Isso vale para o **nosso** limite — **não** para a Zernio, que conta por chave de API e não sabe o que é organização do Athena.

- [x] **B5.1** Medir como o despacho distribui entre as 1.102 chaves antes de subir. O limite da Zernio é por chave: concentrar rajada numa só gera `429` mesmo com orçamento agregado sobrando.

  > **Estado:** medido: pico de 4/hora por chave contra o limite de 25/hora.
- [x] **B5.2** **Bloqueio encontrado na revisão:** o worker limita esse parâmetro a **200 no próprio código** — `integerEnv('PUBLICATION_WORKER_STAGED_MAX_PER_ORGANIZATION_PER_MINUTE', 180, 1, 200)` em `scripts/workers/publication-worker.mjs:50`. Passar de 200 **não é mudança de env, exige alterar o código e reimplantar o worker**. Elevar esse teto de código é o primeiro passo de B5, não uma consequência automática.

  > **Estado:** teto de código 200 → 600.
- [ ] **B5.3** Só então subir em degraus — **180 → 300 → 500 → 600** — medindo a cada passo: memória e CPU do Supabase, taxa de `429`, publicações/hora e itens vencidos. Parar no degrau onde a memória passar de 85% ou aparecer `429`.

  > **Estado:** **NÃO DADO DE PROPÓSITO** — o valor em uso continua 180 e nenhuma organização chega perto.
- [ ] **B5.4** Avaliar trocar o agrupamento de organização do Athena para **conexão Zernio**, que é a unidade que o provedor de fato conta. Assim o limite passa a refletir a realidade em vez de um número arbitrário.

  > **Estado:** **PENDENTE** — trocar o agrupamento de organização do Athena para conexão Zernio.
- [x] **B5.5** Documentar o número final **com a medição que o justifica**, para ele não virar outro 180 herdado sem contexto.

  > **Estado:** documentado com a medição em `plans/plano-ajuste-gargalos-reais-2026-08-29.md`.

---

## Segurança do deploy e impacto no Supabase

**Dá para aplicar com as filas correndo? Sim.**

| Mudança | Como aplica | Downtime |
|---|---|---|
| `create or replace function` | atômico; a próxima chamada usa a nova versão | nenhum |
| `alter table add column` (jsonb, sem default) | instantâneo no Postgres moderno, sem reescrever a tabela | nenhum |
| Worker (A4.7, B3) | restart do PM2 com backup do `.env.worker` | segundos, e os itens ficam na fila |
| App (A4.6) | `vercel --prod` | nenhum |

**Carga adicional: praticamente zero.** A4.4 amplia uma consulta que já roda uma vez por publicação — duas condições a mais sobre índices que já existem. Não há consulta nova nem varredura nova.

O efeito colateral real é **mais adiamentos**: ~2,7% das publicações de reel seriam adiadas ao menos uma vez. Cada adiamento é um `update` de uma linha. Confirmado que **adiar não consome tentativa** (`defer_publication_item` não toca `attempt_count`), então nada corre risco de esgotar retries esperando espaçamento.

**Rollback em uma linha:** zerar `min_seconds_between_profile_publications_by_format` faz tudo voltar ao comportamento atual imediatamente, sem migration reversa e sem deploy.

**Ordem segura:**

1. **B1** — arquivar os 212 mil. Alivia memória antes de qualquer outra coisa, e é o que dá margem para B5.
2. **A4** — a guarda de 30 min por perfil. Rede de segurança no ar antes de mexer em vazão.
3. **A5** — espalhar na janela de 10 min. Elimina a causa do atraso.
4. **B2**, **B3** — arquivamento recorrente e laço de preparação.
5. **B5** — subir o teto. **Não é urgente hoje**: com a janela de 10 min, Pomodoro fica em 94/min e Vini em 124/min, ambos sob os 180. Vira bloqueio quando uma organização passar de ~1.800 perfis. Precisa vir depois de A5 (só faz sentido com a carga distribuída) e depois de B1 (consome a margem de memória que B1 libera).
6. **B4** — retenção, quando o número de B1.2 indicar.

Correção da revisão: uma versão anterior tratava A5 e B5 como interdependentes, dizendo que espalhar sem subir o teto não resolveria. **Não é o caso na frota atual** — a janela de 10 min cabe nos 180/min de hoje em ambas as organizações. A dependência real é a inversa: **subir o teto sem espalhar não resolve nada**, porque só faz a pilha do mesmo segundo escoar mais rápido sem corrigir a variação de atraso que come o intervalo.

---

## Verificação

**Testes:** pgTAP dos casos A4.8, mais os existentes `326`, `327`, `328`, `329`, `303`, `304`. Depois `npm test` e `npx tsc --noEmit`.

**Produção**, repetindo a mesma medição 48 h depois:

| Métrica | Hoje | Meta |
|---|---:|---|
| Reels abaixo de 30 min | 1.861 (2,72%) | **0** |
| Reels abaixo de 5 min | 124 | **0** |
| Stories abaixo de 30 min | 0 | continua 0 |
| Publicações/hora | ~2.600 | não cair de forma relevante |
| Itens vencidos | ~365 e caindo | não subir de forma sustentada |
| Memória do Supabase | 84% | cair após B1 |

**Deploy:** migration por `npx supabase db push`; worker por SSH com backup; app por `npx vercel --prod` (a Vercel não está ligada ao GitHub — commit não publica).

## Etapa final obrigatória — observar a fila por pelo menos 1 hora

Nenhuma etapa é considerada concluída antes disto. Vale depois de **cada** bloco que toca produção (B1, A4, A5), não só no fim.

- [x] **OBS.1** Acompanhar por **no mínimo 1 hora contínua**, com amostragem a cada 5 minutos:

  > **Estado:** **CONCLUÍDA** — 13 amostras, 61 min (21:18 → 22:19 UTC de 29/08). Nenhum gatilho de rollback acionado.
  - **publicações/hora** — não pode cair (baseline ~2.600/h)
  - **itens vencidos** (`overdueUnstarted`) — não pode subir de forma sustentada
  - **itens em `preparation_status = pending`** — não pode crescer
  - **adiamentos** por `dispatch_rate_limit` — esperado subir com A4; tem de estabilizar, não acelerar
  - **`429` da Zernio** — tem de continuar em zero
- [x] **OBS.2** VPS: load, memória e reinícios do PM2. Nenhum worker pode entrar em ciclo de restart.

  > **Estado:** load 0,03–0,29, memória da VPS 34–36%, zero reinícios de worker.
- [x] **OBS.3** Supabase: memória, CPU e disco. Memória não pode passar de 85%.

  > **Estado:** memória **75–82%**, abaixo do gatilho de 85%.
- [x] **OBS.4** Log de erro dos workers: comparar o tamanho antes e depois. Padrão de erro **novo** é motivo de rollback, mesmo que as métricas estejam boas.

  > **Estado:** log de erro do publicador parado em 25.990 linhas — **nenhum erro novo**.
- [x] **OBS.5** Conferir que nenhum item ficou preso: nada em `preparing`/`publishing` com lease vencida acumulando.

  > **Estado:** zero itens em `preparing`/`publishing` com lease vencida em todas as amostras.

**Gatilho de rollback durante a observação:** publicações/hora caindo mais de 20%, vencidos subindo por 3 amostras seguidas, memória do Supabase acima de 85%, ou qualquer padrão de erro novo. O rollback de A4 é uma linha (zerar a coluna jsonb); o de B1 não existe (arquivar não é destrutivo); o de A5 vale só para planos criados depois da mudança.

---

## O que NÃO fazer

- **Não aplicar o espaçamento entre formatos diferentes.** Story depois de reel é normal; bloquear adiaria 3.846 publicações corretas em 48 h.
- **Não tornar o cooldown por organização.** É por perfil — o contrário travaria a operação inteira a 2 posts/hora.
- **Não resolver pulando slots na geração.** Adiar não perde publicação; pular perde.
- **Não subir de faixa no Supabase antes de B1** — seria comprar memória para guardar 212 mil linhas de lixo.
- **Não subir `STAGED_DISPATCH_CONCURRENCY` nem o teto de 180/min antes de A4** — mais paralelismo com a guarda furada aumenta a compressão.
- **Não mexer no intervalo que o usuário escolheu.** O intervalo é o produto — é o que rende views, e é testado deliberadamente (45, 90, 30 min). O espalhamento de A5 desloca apenas o **ponto de partida** de cada perfil dentro de uma janela; o intervalo entre os posts de um mesmo perfil continua exatamente o que foi pedido.
- **Não espalhar além de 10 minutos.** Os perfis precisam postar no mesmo horário; a janela é para não disputarem o mesmo segundo, não para diluir o horário.
- **Não deixar a janela como regra fixa do sistema.** Ela é parâmetro configurável, ao lado do intervalo, sob controle de quem agenda.

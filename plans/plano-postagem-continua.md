# Plano — Postagem contínua por grupo ("chave liga/desliga")

Escrito em 06/10/2026 a partir da conversa com o dono. **Nada foi codado nem aplicado.**
Base de leitura: `docs/fila-de-publicacao-MASTER.md` (inteiro), o caminho da publicação no
mapa de controles e a migration 328.

## 1. O que é

Um tipo novo de plano, ao lado dos atuais. Em vez de criar uma linha por post para até 7 dias,
o grupo guarda **uma regra** e cada perfil guarda **onde parou e quando é o próximo post**. A
linha do post só nasce na hora de postar e segue pelo despacho e pela confirmação que já existem.

Fica como está: post de data única, planos Rotação/Diário/Sequencial, tratamento de erros da
Meta, publicadores, velocidade de postagem. Ficam de fora deste modo: vídeo único por post,
agenda e fila futura na tela.

## 2. Decisões do dono (06/10/2026)

| Tema | Decisão |
|---|---|
| Controle | só a quantidade por dia; padrão 24, alterável por grupo |
| Programar à frente | não existe; liga e posta até a conta cair ou a chave ser desligada |
| Mídias | vêm de uma origem escolhida na configuração; o ciclo **sempre repete**, com as regras de sorteio de hoje (`same_order` / `diversified`) |
| Espalhamento | pela hora inteira (pelo intervalo inteiro), cada perfil com o **início do envio** a ~60 min do anterior, sem contar o tempo da Meta |
| Post perdido por falha nossa | pula, não recupera; precisa de aviso com detalhe |
| Erro 9 da Meta | perfil descansa algumas horas e volta sozinho |
| Story | entra: escolhe uma faixa de horas e posta dentro dela |
| Ligar | recusa se o grupo ainda tem fila aberta do mesmo formato |
| Tela | na tela de Grupos: botão Configurar e chave Ligar/Desligar |
| Rollout | um grupo pequeno primeiro; migrar o resto se der certo |

## 3. Como funciona

### 3.1 O relógio de cada perfil

- Intervalo = 24 h ÷ posts por dia (24 → 60 min; 12 → 120 min).
- Cada perfil recebe um **deslocamento fixo** dentro do intervalo, sorteado pela semente da
  regra (24/dia: um minuto e segundo fixos da hora).
- Os horários formam uma grade fixa: `próximo = anterior + intervalo`. A grade não depende de
  quando o post anterior terminou, então o início do envio fica sempre a 60 min do anterior.
- Com ~2.200 perfis a 24/dia, a carga vira ~37 posts por minuto, constante. Hoje os picos
  passam de 600 em 5 min.

### 3.2 A hora do post

Uma função nova no banco, chamada pelos publicadores, faz tudo numa transação:

1. pega os perfis com "próximo post" vencido (`for update skip locked`);
2. calcula a mídia do ciclo (`deslocamento + posição × passo`, a mesma conta da rotação v2);
3. cria o item já reivindicado pelo publicador;
4. avança a posição e o próximo horário do perfil.

Como a criação do item e o avanço do relógio são a mesma transação, o perfil nunca posta em
dobro. Daí em diante o item é um item comum: reserva de capacidade, sonda do R2, contêiner,
espera, confirmação, retry. Limite de 100/24 h e intervalo mínimo de reel (1.500 s) continuam
valendo pela reserva.

### 3.3 Quando algo dá errado

| Situação | O que acontece |
|---|---|
| Horário passou da tolerância sem o post começar (publicador parado, banco fora) | não cria item; grava **um aviso de post pulado**; relógio segue para o próximo horário |
| Falha retentável da Meta ou do R2 | retry de hoje; se passar do corte, encerra como hoje e vira aviso |
| Erro 9 ("muitas ações") | perfil entra em descanso até uma hora marcada e volta sozinho; um aviso por descanso, com quantos posts ficaram de fora |
| 190 / 25 (checkpoint, restrição) | queda de perfil de hoje; o relógio do perfil para; **nenhuma linha futura para ignorar** |
| Muitas falhas seguidas em perfis diferentes | a regra do grupo pausa sozinha e avisa (disjuntor por regra) |
| Mídia da origem com defeito | a mídia é pulada no ciclo e avisada; a origem é validada ao configurar e quando entra mídia nova |
| Perfil entra no grupo | começa a postar no próximo horário dele |
| Perfil sai do grupo / chave desligada | para; o que já está em voo termina |

### 3.4 Story

Configuração própria: faixa de horas (ex.: 08:00–22:00 BRT) e quantidade por dia (padrão 1).
Cada perfil recebe um horário sorteado dentro da faixa, sorteado de novo a cada dia. A
tolerância de atraso é a de story de hoje (1 h).

## 4. O que precisa existir

**Banco** (uma migration, ensaiada em transação desfeita):
- regra por grupo e formato: ligada/desligada, origem das mídias, modo de sorteio, posts por
  dia, faixa de horas (story), legenda opcional, semente;
- estado por perfil e formato: deslocamento, posição no ciclo, próximo post, descanso até;
- avisos de post pulado: perfil, grupo, horário devido, motivo, código do erro, atraso;
- função da hora do post (3.2), função de ligar (com a guarda de fila aberta), função de
  descanso do erro 9, leitura e limpeza dos avisos;
- ligação item → regra em **tabela lateral**, sem coluna nova em `publication_items` (mesma
  disciplina da 436: nada a espelhar no arquivo frio, nenhum gatilho novo na tabela quente).

**Publicador**: chamada da função nova atrás de uma chave de env, desligada por padrão;
tratamento do erro 9 que distingue item de regra contínua (descanso) de item de plano
(cancelamento da 438).

**Painel**: na tela de Grupos, Configurar (origem, sorteio, posts por dia, faixa do story,
legenda) e a chave; linha de estado por grupo (ligado desde, postados hoje, pulados hoje,
perfis em descanso); painel de avisos com filtro por grupo, perfil, motivo e período. Liberado
por lista de organizações, como `BULK_VIDEO_VARIANT_ORG_IDS`.

**Documento mestre**: seções 1.3, 2, 3, 4, 5, 6, 8.8 e 11 no mesmo commit de cada etapa.

## 5. Etapas

| # | Etapa | Sai dela |
|---|---|---|
| 0 | Linha de base: custo do claim no `pg_stat_statements`, linhas abertas por grupo, vencidos por dia | números para comparar depois |
| 1 | Conferir no código os três pontos da seção 7 e fechar o desenho das tabelas | desenho final, revisado pelo dono |
| 2 | Migration ensaiada em transação desfeita com um grupo real (ligar, postar, pular, descanso, queda, desligar) | migration pronta; dono aplica |
| 3 | Publicador com a chave desligada nos cinco; ligar só no 5, num vale | canário sem tráfego |
| 4 | Tela de Grupos e avisos, liberada só para a organização de teste | chave utilizável |
| 5 | Piloto: um grupo pequeno, fila apagada, chave ligada, 48 h | comparação com a linha de base |
| 6 | Ligar a chave nos publicadores 1–4, um por vale; migrar grupos aos poucos | frota no modo novo |
| 7 | Com a frota migrada: reavaliar número de publicadores e o que do gerador/preparação/staging pode ser desligado | menos peças |

Critério do piloto: 24 inícios de envio por perfil por dia, intervalo entre inícios de 60 min,
zero post duplicado, todo post que faltou com aviso e motivo, custo da função nova medido.

## 6. O que se espera ganhar

- claim sobre uma linha por perfil em vez de centenas de milhares de linhas futuras;
- fim das ondas (carga constante por minuto) e, com isso, dos vencidos por capacidade;
- queda de perfil, cancelamento de grupo e troca de configuração deixam de reescrever milhares
  de linhas;
- gerador, preparação 24 h antes, staging e reserva de horizonte sem trabalho para esses grupos.

Não muda: tempo por post na Meta, erros da Meta, banda do R2, histórico do que foi postado.

## 7. Conferido no código em 09/10/2026

**1. A "pasta" é um grupo.** A origem do plano em massa é um grupo (`media_group_assignments`)
ou "Sem grupo" (`app/api/bulk-publications/origins/route.ts`). Mídia elegível, pela
`list_bulk_rotation_media_ids` (085): `status = 'ready'`, não apagada nem com exclusão pedida,
objeto presente no storage, reel = vídeo, story = qualquer tipo, na ordem `(created_at, id)`.
O plano de hoje **fotografa** a lista na confirmação (`bulk_publication_plan_media`, com
`ordinal`); mídia que entra depois no grupo não entra no plano. Na regra contínua a lista
própria da regra (mesmo formato, com `ordinal`) é atualizada quando a mídia entra ou sai do
grupo: a nova ganha o ordinal seguinte, a apagada sai.

**2. Todo item exige lote.** `publication_items.batch_id` é `not null` com FK para
`publication_batches`, e o lote exige `created_by` (usuário). O `unique (batch_id, profile_id)`
da 007 caiu na 017, então um lote aceita vários posts do mesmo perfil. Fica: **um lote por
regra por dia (BRT)**, criado por quem ligou a chave. Sem linha em `bulk_publication_plans`
para o lote, o item não é tratado como sequencial e os intervalos mínimos (45 s; reel 1.500 s)
valem normalmente. O disjuntor de lote existente age só no lote do dia; a pausa que vale é a
da regra.

**3. O ponto de entrada é o claim do caminho direto.** `dispatchPublicationQueueDirect`
(`publication-direct-dispatch.mjs`) chama `claim_publication_items(p_worker_id, p_limit,
p_lease_seconds)` em dois lugares: o lote inicial e a reposição da janela deslizante. A função
nova devolve o mesmo formato de linha e é chamada nesses dois pontos, antes do claim comum,
usando parte das vagas. Daí em diante `processClaimedItem` não muda: `loadWorkItem` lê perfil,
`publication_item_media` e o estado do item, sem depender de plano. O spool e o staging não
participam (não há item 600 s antes).

Três consequências que o desenho tem de respeitar:

- **O item nasce `preparing` com `preparation_status = 'ready'`**, e as mídias são ligadas na
  mesma transação. O gatilho da 264 só devolve a preparação a `pending` em item
  `waiting`/`ready`; se nascesse `waiting`, cairia em `pending` e o retry (que o claim comum só
  aceita com preparação `ready`) ficaria esperando o laço de preparação do publicador 1.
- **A função nova faz as validações da preparação** (perfil online, mídia pronta, formato),
  porque o item pula essa etapa.
- **A guarda de "ligar" olha também as reservas de horizonte ativas** do perfil
  (`bulk_publication_profile_horizons`), além dos itens abertos: o gatilho de insert recusa
  item que cai dentro da reserva de outro plano (`23505 bulk_publication_horizon_conflict`).

Polling e retry seguem pelo claim comum: item com `creation_id` passa direto; retry que estoura
o corte é encerrado por `expire_late_publication_items` e aparece nos avisos pela tabela lateral.

## 7-A. Origem das mídias e o piloto (09/10/2026)

**Decisão do dono:** a origem pode ser um grupo diferente do grupo dos perfis. O rumo é ter
**pastas de verdade**, separadas dos grupos, com um padrão por tipo de post ("reels do grupo X
saem da pasta Y"), sem interromper o que roda hoje. Pastas não entram nesta entrega: a regra
guarda **uma origem por formato** (reel e story), que hoje aponta para um grupo e depois passa
a apontar para uma pasta sem mudar a lógica de postagem.

**Piloto: grupo `BrunaIork` (Pomodoro).** Lido no banco em 09/10/2026:

| | |
|---|---|
| Perfis online / fora | 30 / 18 |
| Provedores | `meta_official` e `zernio` misturados — a regra só posta em perfil `meta_official` online |
| Mídias prontas no grupo | 57 vídeos, 1 imagem |
| Reels e stories abertos | 0 e 0 |
| Reservas de horizonte ativas | 0 |
| Grupo `STORY BrunaIork` | 0 perfis, 1 vídeo — é um grupo usado como pasta de story |

A 24 por dia são 720 posts por dia no grupo; com 57 vídeos cada perfil repete um vídeo a cada
~2,4 dias. A guarda de "ligar" passa limpa hoje.

**Estado do repositório em 09/10/2026:** HEAD em `b790a9b` (migration 442, aplicada em
produção). A próxima migration é a **443**. Antes de escrever, reler o que a 442 mudou no
documento mestre. Há quatro arquivos da tela `/meta` alterados e não commitados na árvore.

## 8. Padrões propostos (o dono pode trocar)

| Item | Proposta | Por quê |
|---|---|---|
| Tolerância antes de pular um reel | 300 s | é o corte de reel de hoje |
| Descanso do erro 9 | 4 h | em 21/09 os 189 perfis voltaram em 3 h 18 (mediana) e 4 h 07 (p90) |
| Disjuntor da regra | 5 falhas seguidas em perfis diferentes, sem contar 9, 25, 190 e infraestrutura | mesma régua do lote de hoje |
| Máximo de posts por dia na configuração | reel 57, story 100 | intervalo mínimo de reel de 1.500 s; limite da Meta de 100/24 h |
| Legenda | opcional; aceita a lista da 437 | mesma regra de troca a cada post |

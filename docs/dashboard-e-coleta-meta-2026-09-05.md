# A dashboard volta a ter dado — e a coleta pela API da Meta passa a existir

**05/09/2026.** Fecha a pendência aberta pela migração da Zernio para a API
oficial: os perfis religados preservaram o histórico, mas ninguém continuava
coletando métrica para eles, e a tela ainda mostrava o histórico escondido atrás
de um placeholder zerado.

---

## O que estava acontecendo

Três problemas separados, com o mesmo sintoma ("a dashboard não presta"):

### 1. Nenhuma métrica era coletada desde 03/09

`syncProfileAnalytics` só sabia falar com a Zernio. Para perfil
`meta_official` ela gravava um snapshot **zerado** com
`sync_status = 'not_configured'` e ia embora. Medido antes de mexer:

| medida | valor |
|---|---:|
| perfis `meta_official` ativos | 958 |
| linhas diárias coletadas em 04/09 | **0** |
| linhas diárias coletadas em 03/09 (Zernio) | 2.814 |
| snapshots zerados `not_configured` | **996** |

### 2. O placeholder escondia o histórico preservado

`initialize_profile_analytics_state` (migrations 057/221) inseria, a cada
reconexão, um snapshot de período `hoje-29 .. hoje` com tudo em zero. Como toda
leitura de "estado atual do perfil" pega o snapshot de maior `period_end`, esse
zero passava à frente de meses de coleta. A tomada de perfil (migrations
373/375) preservou o histórico com todo o cuidado — UPDATE na mesma linha,
nunca INSERT — e o placeholder o encobria logo em seguida.

### 3. A tela era lenta, ruidosa e grande

| medida (Pomodoro, 30 dias) | antes | depois |
|---|---:|---:|
| `get_dashboard_analytics_v2` | 4.892 ms | **159 ms** |
| metade operacional (fila) | (dentro dos 4.892) | 1.675 ms, em paralelo |
| `get_dashboard_bootstrap_v2` | 633 KB | **299 KB** |
| linhas de estado enviadas ao navegador | 2.024 | **60** |
| tarjas de aviso simultâneas | até 6 | **1** |

A origem da lentidão: a mesma função agregava 12 mil linhas de métrica **e**
varria 226 mil publicações do período, mais `publication_scope` filtrando por
`coalesce(published_at, execute_at, created_at)` — expressão que nenhum índice
cobre. Noventa e poucos por cento do tempo era fila de publicação.

---

## O que foi feito

### Coleta pela API da Meta (o que faltava)

- `lib/integrations/meta-analytics-normalizers.ts` — leitura das respostas,
  classificação de erro, janela do dia. Sem imports, coberto por teste.
- `lib/integrations/meta-analytics.ts` — as chamadas: `me` (seguidores),
  `me/insights` (um dia por chamada) e `me/media` (mídias).
- `lib/integrations/meta-analytics-refresh.ts` — a rodada: coleta em paralelo,
  escreve **em lote** (uma requisição por tabela, não por perfil).
- `app/api/internal/meta-analytics-dispatch/route.ts` + cron de 5 em 5 minutos.
- `app/api/profile-analytics/refresh/route.ts` — o botão da tela, que agora
  coleta dentro da própria requisição em vez de criar job e ficar perguntando.

Três decisões que valem registro:

**Um dia por chamada.** A Meta agrega insights no fuso da CONTA, que não temos
como saber, e nem toda métrica aceita série temporal na versão atual. Pedir uma
janela de um dia e carimbar a data que pedimos é o único jeito de garantir que a
linha caia no dia certo.

**A lista de métricas se ajusta sozinha.** A Meta recusa a chamada INTEIRA
quando uma única métrica não se aplica — uma métrica aposentada zeraria o perfil
todo. O nome recusado é lido da mensagem de erro, removido, e a chamada repetida;
o que a versão da API não aceita fica registrado para o resto da rodada.

**Falha nunca escreve linha zerada.** Erro atualiza só
`profile_analytics_current` (uma linha por perfil, sobrescrita). Foi a regra que
faltava — e é a que impede o problema 2 de voltar.

### Reparo e prevenção

- Migration **380** — `select_meta_analytics_refresh_batch` (quem coletar a
  seguir) e o fim do placeholder mentiroso: `initialize_profile_analytics_state`
  não cria estado inicial para perfil que já tem histórico.
- Migration **381** — apaga (por `deleted_at`) os 996 snapshots zerados. A
  condição exige TODAS as colunas de valor em zero, então nenhuma linha com
  número é tocada.

### Velocidade

- Migration **382** — separa `get_dashboard_analytics_v2` (métrica) de
  `get_dashboard_operations_v2` (fila). A tela pede as duas em paralelo e desenha
  cada metade quando chega. A de métrica passou a trazer TODAS as métricas de uma
  vez (`series_by_metric`), o que faz a troca de métrica na tela ser instantânea.
- Migration **383** — o bootstrap manda a lista de PROBLEMAS (no máximo 60) e a
  contagem por situação, em vez das 2.024 linhas de estado da frota inteira.

### A tela

Refeita: período em pílulas com **Hoje** como padrão; abas de métrica que trocam
o gráfico inteiro (no lugar de um seletor por cartão, que fazia os cartões
discordarem entre si); gráfico de área com eixo, grade e tooltip com o valor do
dia sob o cursor; e **uma** linha de estado, quando há algo a fazer.

Saíram: a seção inteira de caixa de entrada (seis cartões mostrando zero, sem
fonte de dados), "melhor horário para postar" (nunca teve amostra), "posts por
plataforma" (só existe Instagram), o esqueleto decorativo e a lista rolável de
mil e quatrocentos perfis em "saúde das fontes".

---

## Custo do ciclo automático

Por perfil, por ciclo: **3 chamadas** à Meta (conta + dois dias de insights).
Uma vez por hora a passada é mais funda: 4 dias e a lista de mídias, porque o
Instagram continua consolidando um dia por ~48h.

No Supabase, por lote de 60 perfis: **2 leituras e até 5 escritas**, todas em
lote. As linhas são sempre as MESMAS (a chave é perfil + dia), então a tabela
não cresce com a frequência — só é reescrita.

Medido em produção com 3 perfis: 2,0 s, `X-App-Usage` em **0%**.

O despachante nunca disputa banco com a publicação: sob atraso crítico da fila
ele sai sem trabalhar, igual aos outros despachantes internos.

---

## O dia da Meta não é o nosso dia — e isso deslocou TODO o histórico

Este foi o erro mais caro do dia, e ele não aparecia como erro: aparecia como
número plausível na data errada.

Pedindo a série temporal de `reach` para a mesma conta, todo balde volta assim:

```
2026-09-02T07:00:00+0000 : 10
2026-09-03T07:00:00+0000 : 2
2026-09-04T07:00:00+0000 : 2
2026-09-05T07:00:00+0000 : 3
```

**07:00 UTC é meia-noite em Los Angeles.** A Meta agrega insights no fuso da
CONTA, e as contas desta frota estão em horário do Pacífico — não em São Paulo.

O balde que ela rotula `end_time = 2026-09-05T07:00:00Z` cobre **das 04:00 de
04/09 às 04:00 de 05/09, hora de São Paulo**. É o dia 04/09.

A coleta pedia a janela do dia de São Paulo (03:00Z → 03:00Z) e carimbava o
resultado com a data que havia pedido. Só que a única fatia que cai nessa janela
é a que termina às 07:00Z do mesmo dia — a do dia ANTERIOR. Resultado: todo
número entrou **um dia adiantado**. O que a tela chamava de "hoje" era ontem.

Foi isso, e não uma liberação tardia da API, que fez a dashboard "acordar" com
visualizações em "Hoje" por volta das 04h da manhã: era o balde de ontem
fechando e sendo gravado com a data de hoje.

**A correção** (`metaBucketLocalDate`): a data sai do próprio `end_time`. Se a
meia-noite local cai às `h` horas UTC, o deslocamento é `-h` (h ≤ 12) ou `24-h`,
e a data do balde é a do seu início nesse fuso. A coleta passou a pedir a janela
alinhada ao balde da conta — `[end_time - 24h, end_time]` — em vez de ao nosso
calendário. Zero adivinhação: a fronteira vem da API, conta por conta.

As 3.121 linhas já gravadas foram apagadas e recoletadas (migration 384). Optei
por apagar e não por `metric_date - 1`, que seria mais rápido: o deslocamento em
bloco assume que toda conta tem a mesma fronteira, e essa é exatamente a
suposição que causou o problema.

**Consequência que fica:** o dia corrente de São Paulo nunca tem número
completo, porque o dia da conta só fecha às 04:00 (horário de Brasília). Para
ter "hoje" de verdade só pelo caminho de post a post — ver abaixo.

## O dia corrente: a Meta não devolve enquanto ele está aberto

Medido em 05/09/2026 à 01h31, na conta @_laudiceiagranjeiro18, pedindo a janela
de hoje (00:00 → agora):

```
{ "dia": "2026-09-05", "httpStatus": 200, "body": { "data": [] } }
```

**Lista vazia**, não zeros. A mesma chamada para o dia anterior fechado devolve
tudo: `reach 504`, `views 841`, `likes`, `shares`, `total_interactions`.

Duas consequências:

1. **"Hoje" fica sem número até a Meta liberar o dia.** Não é falha da coleta e
   não é "os posts não performaram" — é ausência de medição. Por isso
   `metaDailyRowHasSignal` não grava linha vazia e a tela mostra travessão, não
   zero: com 1.030 publicações feitas no dia, exibir "0 visualizações" faria
   qualquer um concluir a coisa errada.

2. **A janela do dia corrente termina AGORA.** Antes ela ia até a meia-noite
   seguinte — até 22 horas no futuro — o que é pedir um intervalo que ainda não
   existe. Corrigido em `saoPauloDayWindow`, com piso de uma hora para a virada
   do dia. (A correção não faz o dia corrente aparecer: a Meta segue devolvendo
   vazio. Ela elimina a *outra* explicação possível, que era nossa.)

## O portão de pressão estava fechando cedo demais

`get_publication_generation_pressure_signal` com `p_critical_delay_seconds = 60`
acende `criticalDelay` com **um** item dois minutos atrasado — rotina numa fila
que despacha milhares por hora. Resultado medido: o ciclo das 04h25 de
05/09/2026 não rodou, e a coleta ficava intermitente. O limiar passou para 600s.
O portão continua existindo — publicação vem antes de métrica —, ele só deixou
de confundir "um atrasadinho" com "a fila caiu".

## O botão de atualizar não cabia na requisição — e acabou saindo

O escopo global pedia 120 perfis com 40s de orçamento: 360 chamadas à Meta, que
encostam nos 60s da função da Vercel. A requisição morria no meio e o botão
girava sem devolver nada. O ajuste para 45 perfis e 22s fez a requisição voltar,
mas não resolveu o problema de fundo: um clique varria a frota inteira e a
pergunta real do operador era "esse número está fresco?".

**O botão foi removido.** No lugar ficou o indicador de coleta (ver a seção das
três rodadas), e `/api/profile-analytics/refresh` deixou de existir.

## O outro endpoint: métrica por post existe desde a publicação

`/{media-id}/insights` responde AGORA para post publicado hoje — medido em
05/09/2026:

```
2026-09-05T04:31  views=1  reach=0  likes=0  shares=0  saved=0
```

É o único caminho para um "hoje" real. O número muda de significado — passa a
ser "desempenho do que saiu hoje" em vez de "views da conta no dia".

**Correção de uma estimativa minha que estava errada.** Escrevi aqui que `?ids=`
aceitaria 50 mídias por requisição e o custo ficaria em ~3 chamadas por perfil.
Não existe lote nesta API. As duas formas foram testadas em 05/09/2026 contra
`graph.instagram.com` v26:

```
?ids=a,b,c&fields=insights.metric(...)  -> 500 "The ids query parameter is deprecated in v26.0+"
POST /?batch=[{method,relative_url}]    -> 400, corpo vazio
```

É **uma chamada por post**: 26 por perfil que publicou (1 lista + 25 posts), 4
por perfil que não publicou. O custo é de worker, não de banco — a soma vai em
memória e só a linha diária é gravada.

E a primeira versão engolia o erro do lote com um `continue`, gravando linha de
zeros: 108 perfis registraram "13 posts, 0 views" antes de alguém notar. A linha
do dia corrente agora exige métrica de verdade, não só contagem de posts.

## A rodada que não terminava: 127% e subindo

A rodada precisa de um critério de "ainda não visitado NESTA rodada", e eu
traduzi isso para "parado há N minutos", com N = minutos desde o início dela.
Parece equivalente e não é: **N cresce junto com a rodada.** Aos 19 minutos N
vale 19, e o perfil coletado no minuto zero volta a ser elegível.

Medido na rodada manual das 13:41 de 05/09/2026, com 1.683 perfis no total:

```
16:57 | 1842/1683 (109%) | ok 1399 | falhas 368
16:59 | 2131/1683 (127%) | ok 1588 | falhas 468
```

Nenhum erro apareceu. Ela simplesmente girava, gastando chamada à Meta e escrita
no banco em perfil já coletado — exatamente o desperdício que as três rodadas por
dia existem para evitar.

A correção (migration 390) é usar o instante em que a rodada começou, que não se
move: `current_synced_at < p_collected_before`. A assinatura antiga de quatro
argumentos foi derrubada de propósito. `p_stale_minutes` continua existindo só
para o cron da Vercel, que é rede de segurança e não tem rodada.

**Mas essa não era a causa principal, e a segunda rodada provou isso.** Com a 390
aplicada e no ar, a rodada das 14:03 chegou a 194%. A medição que faltava:

```
contados como processados : 3.276
perfis DISTINTOS tocados  : 1.130   -> 2,90x de trabalho repetido
nunca visitados na rodada :   546
```

`select_meta_analytics_refresh_batch` é um SELECT puro: **não existe reserva.**
Dois chamadores concorrentes recebem os MESMOS perfis do topo da fila (ordenada
por `current_synced_at asc nulls first`) e coletam os dois. Eu estava conduzindo
o endpoint com três chamadores em paralelo enquanto o worker da VPS também o
chamava de 10 em 10 segundos — quatro ao mesmo tempo. O topo da fila era moído
de novo e de novo, e a cauda (546 perfis) nunca era alcançada.

Em produção o desenho é de **um chamador só**: `athena-vps-profile-analytics-1`
roda um laço sequencial (`await tick()`), e o `profile-analytics-direct-1` usa a
fila legada com lease, não este caminho.

**E a prova estava na tabela o tempo todo.** As três rodadas de 05/09/2026, lado
a lado:

| rodada | condutores | contados | distintos | repetição | fim |
|---|---|---:|---:|---:|---|
| 09:00 | só a VPS | 1.636/1.719 (95%) | — | — | encerrou em 29 min |
| 13:41 | VPS + 3 meus | 2.391/1.683 (142%) | — | — | não encerrava |
| 14:03 | VPS + 3 meus | 3.276/1.689 (194%) | 1.130 | **2,90x** | forcei o fim |
| **15:00** | **só a VPS** | **1.741/1.709 (102%)** | **1.741** | **1,00x** | **encerrou em 35,9 min** |

A das 09:00 rodou ANTES da migration 390, com a fórmula de minutos que eu
acusei — e convergiu. O que separa as três é o número de chamadores, não a
versão do código. A 390 continua valendo como endurecimento (o critério vira
exato em vez de arredondado ao minuto), mas ela não consertou um defeito de
produção: **o defeito era o meu jeito de testar.**

A rodada das 15:00 fechou a conta: **1.741 processados para 1.741 perfis
distintos — 1,00x, nenhuma repetição**, cobrindo 100% da frota em 35,9 minutos
(49 perfis distintos/min). Os 102% não são trabalho repetido: `total_profiles` é
uma foto tirada quando a rodada abre, e perfis que entram no ar durante ela
também são coletados. A tela já mostra `least(100, ...)`, então o operador vê
100%.

Fica a ausência de reserva como buraco real: qualquer segundo chamador — um
worker novo, uma segunda instância no PM2, uma chamada manual — duplica chamada
à Meta e escrita no Supabase sem que nada acuse. Com quatro chamadores a vazão
sobe para 102 perfis/min, mas 2,9x do trabalho vai no lixo.

## O que ainda merece atenção

- **O fuso da conta.** A janela do dia usa -03:00 (São Paulo). Se alguma conta
  estiver configurada em outro fuso no Instagram, a métrica dela pode cair no dia
  vizinho. Conferir contra o app do Instagram em um perfil por lote.
- **`instagram_slot_limit` conta vagas, não chamadas.** O outro eixo do limite
  da Meta é o volume de requisições por app. Agora `X-App-Usage` é lido a cada
  resposta e a rodada desacelera sozinha acima de 75%, mas o número real por app
  ainda não foi observado sob carga.
- **`npm run probe:meta-analytics`** existe para conferir, contra uma conta real,
  quais métricas a versão atual da API aceita. Rodar depois de toda subida de
  versão da Graph API.

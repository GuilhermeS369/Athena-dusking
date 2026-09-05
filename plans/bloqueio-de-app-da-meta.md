# Tratamento do bloqueio de app da Meta ("API access blocked")

Status: **em execução.** Aberto em 05/09/2026.

## O incidente que originou isto

A Meta devolveu `code 200 / "API access blocked."` para 4 apps de 28:
`Lari Lote 1`, `Lari Lote 2`, `Julio Lote 2`, `PeachySara Lote 1` — 169 perfis,
11.973 publicações agendadas. Verificado ao vivo às 15:50 com uma chamada `/me`:
os 4 continuam bloqueados, e `Igor Lote 3` e `BIEL 04-09 1`, usados como
controle, respondem OK. Não é conta, não é token: é o app.

136 reels morreram terminais na janela de 11:59 a 12:29. Nenhum chegou a criar
contêiner. Por decisão do usuário eles ficam `ignored` — já passaram do horário.

## O que o sistema fez de errado

1. **Tratou como falha de item.** Código 200 não é retentável, então cada item
   que encostou no app bloqueado morreu em definitivo.
2. **Deixou o disjuntor pausar o lote inteiro.** O lote é a unidade errada:
   `Julio / 05/09 / Reels` mistura os dois apps do Julio, então pausá-lo
   congelou **6.120 itens do `Julio Lote 1`, que está saudável** — 540 já
   vencidos às 17:33, e crescendo.
3. **Congelou a observabilidade.** Item congelado continua "vencido" para
   `get_publication_generation_pressure_signal`, que devolve `criticalDelay` com
   **um único** item atrasado. Três coisas obedecem a esse sinal: a manutenção
   de observabilidade (que se auto-pausou e deixou o snapshot da tela parado às
   11:15), a coleta de analytics e o worker de geração. Um app bloqueado
   envenena o sistema inteiro por deixar lixo vencido na fila.

## O desenho — janela deslizante de uma hora

Definido pelo usuário em 05/09. A ideia central: **bloqueio não represa fila.**

1. Ao aparecer `200 / API access blocked`, marca-se o **app** como bloqueado por
   **uma hora**, e todo item daquele app com `execute_at <= fim da janela` vira
   `ignored`. Isso cobre de uma vez o que já estava atrasado e a próxima hora.
2. Passada a hora, a janela expira sozinha. O próximo item que vencer é tentado
   normalmente — **a própria fila é a sonda**. Publicou, acabou o bloqueio.
3. Falhou de novo com o mesmo erro? Nova janela de uma hora, e assim vai,
   adiando até alguém resolver.
4. O aviso fica na tela `/meta`, e o botão de desbloquear zera a janela na hora,
   para quando o usuário destravar antes de ela expirar.

**Por que é melhor do que sondar:** a versão anterior deste plano previa um
worker novo na VPS chamando `/me` de 5 em 5 minutos para descobrir o
desbloqueio. A janela deslizante dispensa esse processo — menos código e
nenhuma peça nova na VPS, o que conta depois do estrago de ontem com PM2.

**O custo, medido em 05/09:** uma janela de uma hora custa exatamente um post
por perfil — 68 no `Lari Lote 1`, 53 no `Lari Lote 2`, 38 no `Julio Lote 2`, 10
no `PeachySara`. O teste de retomada custa 1 item por app por hora.

### Decisões de detalhe

- **A janela conta do instante da detecção**, não da hora cheia. Detectou 14:37,
  vale até 15:37. Evita a borda de detectar 14:59 e a janela durar um minuto.
- **A varredura usa `execute_at <= fim da janela`** — uma regra só para o
  atrasado velho e para a próxima hora. Sem isso o atrasado continua envenenando
  o sinal de pressão, que é metade do problema de hoje.
- **O item que detectou vira `ignored`, nunca `failed`.** É isso que faz o
  disjuntor não contar e nenhum lote pausar.
- **Item em voo (`preparing`/`publishing`) não é varrido**, para não arrancar
  trabalho sob lease de outro worker. Cada um resolve sozinho: ao falhar com o
  mesmo erro, cai no mesmo caminho e vira `ignored`.
- **Sem escalonamento.** Uma hora sempre, não 1h→2h→4h. Previsível é melhor que
  esperto, e a tela já está avisando.
- **"Bloqueado agora" é `api_block_until > now()`.** Não existe flag para
  limpar: a janela expira sozinha, e é isso que faz o desenho funcionar sem
  nenhuma máquina extra.

## Execução

- [x] 1. Migration: colunas de bloqueio em `meta_apps`
- [x] 2. Migration: `flag_meta_app_api_blocked` e `clear_meta_app_api_block`
- [x] 3. Migration: `claim_publication_items` pula perfil de app bloqueado
- [x] 4. Migration: sinal de pressão ignora item de lote pausado
- [x] 5. `isMetaAppApiBlocked` em `lib/integrations/meta-graph-errors.ts`
- [x] 6. Ramo no dispatcher do painel
- [x] 7. Ramo no worker da VPS (`publication-direct-dispatch.mjs`)
- [x] 8. Aviso e botão na tela `/meta` + rota de desbloqueio
- [x] 9. Testes
- [x] 10a. `db push --dry-run` e migrations aplicadas em produção
- [x] 10b. Worker da VPS trocado e reiniciado
- [x] 10c. Deploy da Vercel — feito pelo operador em 05/09 21:0x
- [x] 11. Retomar o lote do Julio, que hoje congela 6.120 itens de app saudável

## Dívida registrada, fora do escopo de hoje

`isMetaTerminalProfileDisconnection` existe duplicado — em
`lib/publications/dispatcher.ts:209` e em
`scripts/workers/publication-direct-dispatch.mjs:951`. Foi exatamente essa
duplicação que fez a correção do `ERROR` de contêiner, em 04/09, valer só no
lugar onde o problema não acontecia. `isMetaAppApiBlocked` já nasce
compartilhado; unificar a antiga fica para depois.


## Resultado da primeira ativação em produção (05/09, 20:54Z)

Migrations aplicadas, worker da VPS trocado (`pm2 restart athena-publication-worker`,
backup em `publication-direct-dispatch.mjs.before-deploy-20260905T205319Z`) e os
três lotes retomados. Em noventa segundos:

```
412 itens  ignored / meta_app_api_blocked   (todos de app bloqueado)
  0 itens  failed
  0 lotes  pausados
Lari Lote 1: janela ate 21:55:21Z · 1 janela · 412 ignorados
```

Publicação seguiu em ~127 por 5 minutos durante a ativação. O `oldestDueAt` do
sinal de pressão saiu de 14:38 -- travado desde a manhã por item congelado --
para 15:19, confirmando a migration 395.

A primeira tentativa de retomada, às 20:53, foi feita com o worker antigo ainda
no ar e os três lotes pausaram de novo em 40 segundos. É a demonstração direta
do que a mudança faz: mesmo erro, mesma fila, mesmo minuto -- muda só quem
trata.

## O bloqueio se espalhou durante a implantação

Às 15:50 eram 4 apps; às 21:00, 5. O `Julio Lote 1` caiu no meio do caminho, e
foi marcado pelo tratamento novo sem ninguém intervir.

Varredura dos 29 apps às 21:02, um `GET /me` em cada um:

```
BLOQUEADOS NA META:  5   todos marcados pelo sistema
RESPONDENDO OK:     24   nenhum marcado indevidamente
sem perfil testável: 10
```

Os cinco são `Julio Lote 1`, `Julio Lote 2`, `Lari Lote 1`, `Lari Lote 2` e
`PeachySara Lote 1` -- todos criados em 04/09. Igor, BIEL, CHRYS, LAURINHA,
LEXY, Tia Lau, YUNA e Bruna seguem publicando.

Consequência para o registro: os 6.120 itens do `Julio Lote 1` que estavam
congelados no lote pausado não teriam publicado de qualquer forma. O dano
colateral existiu das 11:42 às ~21:00 e depois virou prejuízo do mesmo bloqueio.

## O que resta observar

A expiração da primeira janela, entre 21:55 e 22:01. É a única parte do desenho
ainda não exercitada em produção: janela vence, a fila tenta um item, a Meta
recusa de novo, e uma janela nova abre (`api_block_window_count` vai a 2). Se a
Meta tiver liberado, o app volta a publicar sem ninguém tocar em nada.

# Módulo X/Twitter — DESLIGADO em 07/09/2026

> **Não reative sem autorização explícita do responsável pela operação.**
> A decisão foi dele, tomada em 07/09/2026: "pode matar toda a estrutura do
> twitter, não vamos usar e documente para um dia futuramente só depois da minha
> autorização reativar".

## O que foi desligado

Dez processos removidos do PM2 na VPS, com `pm2 save` para que não voltem no
boot:

```
athena-twitter-publication-worker      (4 instâncias)
athena-twitter-preparation-worker
athena-twitter-zernio-sync-worker
athena-twitter-analytics-worker
athena-twitter-webhook-reconcile-worker
athena-twitter-connect-worker
athena-twitter-observability-worker
```

**Nada foi apagado além dos processos.** O código, as migrations, as tabelas, os
dados e as conexões Zernio continuam onde estavam. Isto é um desligamento
operacional, não uma remoção.

## Por que, além da decisão de não usar

O gatilho imediato foi capacidade. Em 07/09/2026 o pipeline de publicação do
Instagram ficou fora do ar duas vezes por esgotamento do pool do PostgREST, que
tem **41 conexões e é compartilhado por todo o projeto**. No momento do
incidente havia **17 processos** disputando essas 41 vagas, e **dez deles eram
do Twitter** — um módulo que a operação não estava usando.

Isso não faz do Twitter a causa do incidente (a causa está registrada na seção
3-D de [fila-de-publicacao-mapa-de-controles.md](../fila-de-publicacao-mapa-de-controles.md):
uma tempestade de retry no caminho de preparo). Mas dez processos ociosos
consumindo um recurso escasso são dez processos a menos de margem quando algo dá
errado.

## O que deixou de acontecer

Com os processos parados:

- publicações agendadas para X/Twitter **não saem**;
- a sincronização com a Zernio para de correr, então contas removidas ou
  alteradas lá não se refletem aqui;
- analytics de X/Twitter param de ser coletadas — a série temporal vai ter um
  buraco a partir de 07/09/2026;
- webhooks recebidos deixam de ser reconciliados;
- a fila de conexão de contas novas para de ser processada.

**A fila não some.** Itens agendados continuam na tabela e vão vencendo. Quando
o módulo voltar, a regra de atraso vale para eles como para qualquer outro: o
que passou do horário não é republicado.

## Como reativar, quando houver autorização

Na VPS, em `/opt/athena-worker`. Comece por UM processo, meça, só depois suba o
resto — a lição de 07/09 é que processo novo entra medido.

```bash
# 1. antes de qualquer coisa, olhe o pool. Se estiver perto de 41, PARE.
#    select count(*) filter (where state='active') as ativas, count(*) as total
#    from pg_stat_activity where usename='authenticator';

# 2. um processo, e só um
pm2 start npm --name athena-twitter-publication-worker -- run worker:twitter:publication

# 3. meça o pool de novo depois de 2 minutos. Se subiu muito, pare aqui.

# 4. os demais, um a um, medindo entre cada um
pm2 start npm --name athena-twitter-preparation-worker    -- run worker:twitter:preparation
pm2 start npm --name athena-twitter-zernio-sync-worker    -- run worker:zernio-sync
pm2 start npm --name athena-twitter-analytics-worker      -- run worker:twitter:analytics
pm2 start npm --name athena-twitter-connect-worker        -- run worker:twitter:connect
pm2 start npm --name athena-twitter-observability-worker  -- run worker:twitter:observability

pm2 save
```

Os nomes exatos dos scripts estão no bloco `scripts` do
[package.json](../../package.json) — confira antes, porque eles mudam.

## O que conferir ANTES de reativar

1. **O pool aguenta?** Hoje o pipeline do Instagram sozinho, com um publicador,
   convive bem com as 41 vagas. Cada processo novo é disputa. Se a operação
   cresceu desde 07/09, o teto pode ter ficado apertado — meça antes.
2. **As feature flags.** `TWITTER_MODULE_ENABLED` e
   `TWITTER_CANARY_ORGANIZATION_IDS` continuam valendo
   ([lib/twitter/feature.ts](../../lib/twitter/feature.ts)). Processo no ar com a
   flag desligada não publica nada.
3. **O estado da Zernio.** Depois de meses parado, o inventário local e o remoto
   vão estar divergentes. Rode a sincronização e confira antes de deixar o
   publicador solto.
4. **A fila acumulada.** Veja quantos itens vencidos existem e decida
   explicitamente o que fazer com eles, em vez de deixar o corte de atraso
   decidir por volume.

## Estado dos documentos do módulo

Os documentos de continuidade em `docs/x-twitter/` continuam válidos como
registro do que foi construído e por quê. Este arquivo não os substitui — ele
marca que a execução está suspensa. Quem for reativar deve ler
[README.md](README.md) e [RUNBOOK.md](RUNBOOK.md) antes, inclusive a lista de
proibições explícitas que continua de pé.

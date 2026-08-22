# Fase 07 — análises manuais

Status: `blocked` — implementação e proteção financeira aprovadas; Zernio ainda não disponibilizou snapshot analytics para dois posts distintos

## Entregas

- `/x/analises` seleciona posts e perfis com checkbox.
- Quote é somente leitura, assinado e válido por dez minutos.
- Confirmação bloqueia todas as carteiras, revalida versões e preserva US$ 5,00 além de reservas existentes.
- Post custa 5.000 micros; perfil/followers custa 10.000 micros.
- Worker analytics usa rotas, flag, heartbeat e endpoints Zernio próprios.
- Sucesso liquida somente o recurso e cria snapshot local; falha confirmada libera; incerto mantém hold.
- Dashboard X lê apenas snapshots locais e nunca dispara coleta.
- `/x/logs` permite resolver analytics incerta com justificativa auditada.

## Evidências

- Migration 235–240 aplicadas; Supabase alinhado até 240.
- Teste SQL 26/26 com rollback e zero resíduos na implementação.
- Baseline atual: 166/166 testes Node, TypeScript, build e diff check aprovados.
- Lint sem achados X; achados legados inalterados.
- Uma chamada real mínima foi feita e retornou HTTP 202; flags analytics foram restauradas para off.

Checkpoint 2026-08-22T21:37:58Z: documentação oficial reconfirmou HTTP 202 para sync pendente. Worker corrigido em `46e09cc` para manter hold sem snapshot/retry; release VPS `46e09cc-20260822T213610Z`. Quote read-only de um post aprovou custo 5.000, projeção 11.720.000 e piso 5.000.000; wallet permaneceu 11.725.000/0 versão 15 e nenhuma entidade analytics foi criada.

Reserva confirmada em 2026-08-22T21:38:40Z: job `0b426171-833b-4767-9a92-1a1296aacbde`, item `7ce8553c-ceb9-4a25-a00f-c51b0ec249c5`, um `post_read` de 5.000 micros. Wallet 11.725.000/5.000, versão 16; zero tentativas/snapshots e analytics ainda off.

Canário executado em 2026-08-22T21:40:56Z: a Zernio retornou HTTP 202 (`Analytics are being synced...`). Job, item e tentativa ficaram `outcome_unknown`; a reserva segue aberta em 5.000 micros. Wallet permanece 11.725.000 contábil/5.000 reservado, versão 16; zero snapshot, zero lançamento no ledger e nenhuma repetição automática. Worker parado e flags VPS/Vercel restauradas para false; Production segura `dpl_93z3VLkymZUoukP2w1hsK2ZeaWXC` `READY`.

Primeira conferência de billing em 2026-08-22T21:47:32Z: o novo auditor guardado consultou apenas `GET /v1/usage`. O snapshot Metronome contém exatamente `content_create=5` e `content_create_with_url=1`, correspondentes aos seis canários publicados, e não contém `posts_read`. Isso é evidência de não cobrança, mas o hold será mantido até uma segunda conferência posterior para reduzir risco de atraso de metering. Regressão: 168/168 testes e TypeScript aprovados.

Reconciliação em 2026-08-22T21:49:27Z: segundo snapshot continuou idêntico e sem `posts_read`. O utilitário guardado validou tentativa HTTP 202, item incerto, reserva integral, zero snapshot/ledger e conexão única; então registrou resolução manual `failed/manual_not_metered` com justificativa/evidência. Foram liberados 5.000 micros da reserva original, sem crédito ou débito. Wallet 11.725.000/0, versão 17; eventos imutáveis `outcome_unknown` e `failed`.

Segundo quote em 2026-08-22T21:51:11Z: utilitário guardado selecionou outro post publicado (`66542b07-7e55-47f8-aaca-0075b98171db`), recusando reutilização do item anterior. Um `post_read` custa 5.000, projeção 11.720.000 e piso 5.000.000. Wallet permaneceu 11.725.000/0 versão 17; nenhuma entidade ou chamada externa foi criada.

Reserva em 2026-08-22T21:51:48Z: job `85bd0298-432e-45ae-9248-abf306fd4207`, item `1660fcd2-b0f2-41d4-8f47-32830282ad2b`, `post_read` distinto de 5.000 micros. Wallet 11.725.000/5.000 versão 18; item tentativa 0, total histórico de tentativas analytics 1 e snapshots 0. Analytics/workers continuam off.

Segunda janela em 2026-08-22T21:53:37Z: outro post distinto também retornou HTTP 202 e foi preservado como `outcome_unknown`, sem retry/snapshot/débito. Primeiro snapshot posterior de billing continua com as seis criações conhecidas e sem `posts_read`. Worker foi parado; VPS false, arquivo 600, cinco workers X stopped e seis processos existentes online. Production segura `dpl_14raRXUnfUgWW6nWpN6XcYN8ppgB` `READY`; janela live `dpl_2U7h2iEaJk8TRB4HApE3gea9BUaV`.

Reconciliação final em 2026-08-22T21:56:14Z: segunda conferência billing permaneceu sem `posts_read`; o segundo item foi resolvido `failed/manual_not_metered`, liberando somente os 5.000 micros originais. Wallet 11.725.000/0 versão 19; zero snapshots e zero débito analytics. Dois posts distintos produziram o mesmo 202, portanto nenhuma terceira leitura será feita sem confirmação externa de disponibilidade.

## Rollback

- Manter `TWITTER_ANALYTICS_ENABLED=false` e `TWITTER_ANALYTICS_WORKER_ENABLED=false`.
- Parar apenas `athena-twitter-analytics-worker` quando instalado.
- Banco recebe somente correção forward-only; código pode ser revertido pelo commit da fase.

## Próxima ação segura

Obter confirmação externa da Zernio de que o snapshot está disponível. Até lá, manter analytics off e não abrir outra leitura. O gate de snapshot bem-sucedido permanece bloqueado.

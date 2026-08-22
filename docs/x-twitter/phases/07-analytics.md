# Fase 07 — análises manuais

Status: `blocked` — implementação/proteção financeira aprovadas; Zernio retornou HTTP 202 inclusive para nova operação do mesmo post já sincronizado

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

Reavaliação em 2026-08-22T21:58:33Z: a documentação oficial define 202 como `sync pending`. Os dois testes anteriores usaram recursos distintos, portanto cada um iniciou a primeira sincronização do respectivo post. Como ambos foram comprovados não medidos e reconciliados, ADR-X-011 permite uma nova operação manual — novo quote, item, reserva e attempt — sobre o mesmo segundo post já sincronizado. Quote read-only aprovado: 5.000 micros, wallet inalterada 11.725.000/0 versão 19, projeção 11.720.000 e piso 5.000.000.

Reserva em 2026-08-22T21:59:26Z: job `ccc4ec4e-956a-4500-af4d-8e9d779574e1`, item `132b6356-6b06-48d7-bff7-edd473bc87be`, mesma publicação sincronizada e novo fluxo independente. Reserva open 5.000; wallet 11.725.000/5.000 versão 20; item attempt 0, snapshots 0 e analytics off.

Resultado final em 2026-08-22T22:01:08Z: a nova operação do mesmo post voltou a receber HTTP 202. Duas conferências posteriores de `GET /v1/usage` continuaram sem `posts_read`; o item foi reconciliado `failed/manual_not_metered`, liberando os 5.000 micros originais. Wallet 11.725.000/0 versão 21; três attempts HTTP 202 terminais, zero snapshots e zero débito analytics. Production segura `dpl_7T2ctsRQFrSrDqSLBCuYtqSqXY6y`; janela live `dpl_8pkhNuc5hcPhcGQ7EsaWSMAHLuC5`.

## Rollback

- Manter `TWITTER_ANALYTICS_ENABLED=false` e `TWITTER_ANALYTICS_WORKER_ENABLED=false`.
- Parar apenas `athena-twitter-analytics-worker` quando instalado.
- Banco recebe somente correção forward-only; código pode ser revertido pelo commit da fase.

## Próxima ação segura

Aguardar a Zernio disponibilizar resposta HTTP 200. Não criar novo canário pago até mudança externa verificável.

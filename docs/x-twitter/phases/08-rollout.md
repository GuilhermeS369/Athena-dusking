# Fase 08 — rollout e handoff

Status: `in_progress` — preparação reversível; rollout geral/live bloqueado pelo gate da Fase 7

Entregas: ativação progressiva, fallback validado, monitoramento, comparação Instagram e handoff final. Gate: módulo independente, observável e reversível.

Nota de topologia atual: registros abaixo que mencionam cinco processos descrevem releases históricos. A ADR-X-017 reduziu o contrato vigente a quatro papéis reais — publicação, sync, analytics e reconciliação — sem alterar a confirmação financeira atômica.

## Topologia de quatro workers implantada e desligada

- ADR-X-017 implantada em 23/08/2026 UTC; confirmação continua materializando reservas e itens financiados atomicamente.
- Preview `dpl_FF72a8zwrhaJFDNfm9ord3ac5X27` e Production `dpl_BYjrGwDcg9WtPy4nV1CWwvZ9kKGv` estão `READY`; alias oficial atualizado; rota interna sem segredo retorna `401`.
- Variáveis `TWITTER_GENERATION_*` removidas de Preview/Production. Todos os demais flags X permanecem off.
- Release VPS `/opt/athena-twitter/releases/e732fed77971-20260823T000341Z`, SHA-256 `c0834c2fda517056cb1e31a9a0e9d44c2c8b382b57d673df7c489b396014a4a8`; quatro one-shots off aprovados.
- Arquivo remoto continua `600`; backup recuperável `/opt/athena-twitter/shared/.env.worker.backup-before-generation-removal-20260823T000341Z`; zero linhas `TWITTER_GENERATION_*` ativas.
- PM2: quatro entradas X `stopped`; entrada generation ausente; seis processos existentes online com PIDs 99980, 27468, 136197, 127605, 122939 e 103209.
- Supabase alinhado até 242; fila sync/publicação/analytics não terminal, holds e snapshots em zero; wallet 11.725.000/0 versão 21.
- Rollback: Vercel `dpl_9rAv31d1QTHQzbhwMkcpJZV5CsEe`; VPS `a5edc6c049e1-20260822T235210Z`; ao voltar ao release antigo, restaurar explicitamente o backup com as variáveis antigas e manter tudo off.

## Checkpoint de segurança anterior ao preview

- Migration 240 aplicada de forma aditiva e alinhada no remoto.
- Remoção de conexão agora libera somente holds que nunca iniciaram; holds ativos ou incertos permanecem para reconciliação.
- Leases expirados de analytics passam para `outcome_unknown`, sem retry cego.
- Os cinco workers consultam circuit breaker persistente próprio e registram sucesso/falha.
- Regras financeiras futuras possuem gestão somente por admin, combinação exata, eventos imutáveis e desativação sem exclusão.
- Teste SQL 240: 13/13 em transação com rollback; nenhum resíduo.
- Regressão: 163/163 testes, TypeScript e build aprovados; warnings metadata preexistentes permanecem fora do escopo.
- Commit de código: `1a74e4afd77f166674b05d43647d5abb1951bb38`.

Próximo gate: preview Vercel com todas as flags X desligadas e smoke test. Não promover para produção nem executar canário sem credencial X dedicada.

## Deploy desabilitado e instalação operacional

- Preview final: `dpl_2JSe1hjSEdWCCVZH9VJ96zC7QXua`, estado `READY`.
- Produção final: `dpl_Akd9xnWZxrfeZpz9XpvsA5JgZgAR`, estado `READY`, alias `https://pomodoro-theta-one-82.vercel.app`.
- Rollback Vercel anterior: `dpl_DuXLdmBjjofPwJEsCNSSf6b5D39J` / `https://pomodoro-mwify00nv-shoows-projects-2caaf9e9.vercel.app`.
- Flags Production e Preview: módulo, publicação e analytics explicitamente desligados; modo de publicação `shadow`.
- Segredos exclusivos X foram configurados em Vercel e VPS sem registrar valores.
- Release VPS: `/opt/athena-twitter/releases/3f3821171839-20260822T184649Z`.
- SHA-256 do pacote: `9aaf4f732665bf3b853c2296646abe9f4a21f2a113f12de4dfd3621c7b87cb33`.
- Artefato local ignorado: `artifacts/x-twitter/20260822T184649Z/athena-twitter-worker.tar.gz`.
- Config compartilhada: `/opt/athena-twitter/shared/.env.worker`, permissão `600`.
- Os cinco processos `athena-twitter-*` estão instalados e persistidos no PM2 em estado `stopped`.
- One-shot final dos cinco papéis contra produção: aprovado; heartbeats `stopped`; zero claims, zero analytics em processamento e zero resolução financeira.
- Os seis processos existentes permaneceram `online` com os mesmos PIDs observados antes da instalação.

## Smoke e desvios registrados

- Login produção `200`; páginas autenticadas Instagram e X redirecionam visitante sem sessão com `307`; heartbeat sem segredo retorna `401`.
- A primeira execução remota do pacote falhou antes da rede porque usou `cwd=/root`; foi repetida do release correto e aprovada.
- O primeiro teste de pareamento Production retornou `401` antes de claim; o segredo foi rotacionado atomicamente, redeployado e o teste final dos cinco papéis passou após propagação.
- Nenhuma API Zernio foi chamada, nenhum post foi criado e nenhuma reserva foi materializada durante o rollout desabilitado.

## Bloqueio do gate

A organização Pomodoro, a credencial dedicada e os seis canários de publicação já foram aprovados; o bloqueio anterior está encerrado. A Fase 8 agora aguarda somente o gate da Fase 7: dois posts distintos retornaram HTTP 202 em analytics, foram comprovados como não cobrados e reconciliados sem holds. Não habilitar rollout geral nem fallback enquanto não existir um snapshot analytics bem-sucedido e liquidado.

Próxima ação segura: obter confirmação da Zernio de que analytics dos posts está disponível; executar um novo canário distinto e, somente após sucesso, atualizar este gate para os preparativos progressivos de todas as organizações.

## Fallback Vercel exclusivo — implementação desligada

- Rota exclusiva: `/api/internal/twitter-fallback-dispatch`.
- Autorização: `CRON_SECRET` ou `TWITTER_FALLBACK_WORKER_SECRET`, comparação constante.
- Kill switches: `TWITTER_FALLBACK_ENABLED=false` e `TWITTER_FALLBACK_LIVE_ENABLED=false` por padrão.
- Live exige simultaneamente fallback, worker de publicação, modo live e autorização live explícita.
- Heartbeat recente de `athena-twitter-publication-worker` sempre impede claim.
- Circuit breaker do worker primário é respeitado; claim máximo 1.
- Shadow conclui pelo RPC shadow; live reutiliza os mesmos endpoints de start/result, a mesma idempotency key Zernio e a mesma classificação financeira do worker.
- A rota ainda não está em `vercel.json`; cron só será adicionado depois do gate analytics.
- Testes atuais: 171/171; TypeScript e build aprovados. Variáveis documentadas em `.env.example`.

Shadow aprovado em 2026-08-22T22:15:39Z: deployment `https://pomodoro-mh4mbhh3y-shoows-projects-2caaf9e9.vercel.app`, heartbeat primário expirado, `fallback=true`, `mode=shadow`, `claimed=0`. Banco permaneceu com zero não terminais/holds, seis attempts históricos e wallet 11.725.000/0 versão 21; somente heartbeat `athena-twitter-vercel-fallback` foi gravado. Preview seguro restaurado em `https://pomodoro-83c6mwiww-shoows-projects-2caaf9e9.vercel.app` com fallback e worker false.

O primeiro smoke retornou 503 porque a rota tentava chamar endpoints internos pelo domínio Preview protegido. Nenhum claim ocorreu. A correção eliminou o loop HTTP e passou a usar diretamente os mesmos RPCs transacionais; o segundo smoke aprovou. Próximo: endpoint read-only de saúde do rollout. Nenhuma ativação Production/live.

Após o smoke, a correção foi endurecida para falhar fechado quando a leitura ou a gravação do heartbeat não estiver disponível e para registrar `success` no circuit breaker ao concluir cada ciclo. Regressão local: 171/171 testes, TypeScript, build e `git diff --check` aprovados; somente os warnings de metadata já conhecidos apareceram no build.

## Observabilidade read-only aprovada

- Endpoint autenticado `/api/internal/twitter-rollout-health`, sem RPCs ou mutações e sem referências a tabelas operacionais Instagram.
- Agregados: estados da fila de publicação/analytics, holds e reservas incertas, HTTP 429 em 24h, wallets em micros, piso protegido, workers esperados/stale e circuit breakers.
- Preview final `dpl_8M49y4r42PvVXJD2E9hCSBmmWCsc` / `https://pomodoro-3o8tbywqd-shoows-projects-2caaf9e9.vercel.app`, `READY`, com módulo, workers, analytics e fallback off.
- Smoke autenticado: `status=ok`, filas/holds/unknowns/429/signals zerados e wallet 11.725.000/0 micros. Smoke sem segredo: `401`.
- Production permaneceu em `dpl_7T2ctsRQFrSrDqSLBCuYtqSqXY6y`, `READY`; nenhum cron foi adicionado.
- VPS read-only: 42 GB livres, 2.932 MB disponíveis, sem swap; cinco workers X `stopped` e seis processos existentes `online`.
- Supabase local/remoto alinhado até 240. Regressão final desta unidade: 175/175 testes, TypeScript, build e diff check aprovados.

Gate de observabilidade aprovado. A liberação geral e o fallback live continuam bloqueados exclusivamente pelo sucesso HTTP 200 de analytics e pelo checklist progressivo final.

## Enforcement e checklist progressivo

- Novo layout `/x/*` retorna 404 quando a organização ativa não está no escopo; esconder o menu não é mais a única barreira.
- Todas as APIs públicas X foram varridas por teste: exigem `getTwitterRequestContext`; a única exceção é o webhook, protegido por HMAC e necessário para reconciliação.
- Quote, confirm e UI de analytics agora usam `isTwitterAnalyticsEnabled(organizationId)`, evitando custo fora do canário.
- Semântica validada: lista canário habilita seletivamente com flag global off; a flag global habilita todas; health reconhece ambos os estados sem expor IDs.
- Preview `dpl_8UNUQJQFawiknFu8wAZBBxd9nJ7F`, `READY`, com lista canário vazia e todas as flags mutáveis off: health `ok`, zero fila/holds/unknowns/429/sinais.
- `ROLLOUT_CHECKLIST.md` registra gates, sequência de uma organização por vez, janela mínima, critérios de pausa e rollback sem perda de ledger.
- Testes: 178/178, TypeScript, build local/Vercel e diff check aprovados. Production, Supabase e VPS não foram alterados.

Preparação local do rollout progressivo concluída. A execução continua proibida até o gate externo da Fase 7.

## Segredos independentes por papel

- Gap da auditoria fechado: cinco workers, fallback e health possuem sete segredos distintos; não há fallback para o segredo genérico legado.
- Heartbeat/circuit breaker validam o segredo contra o `workerName`; analytics não autenticou como publicação no teste cruzado.
- Configuração: sete nomes em Production/Preview; cinco valores pareados na VPS, arquivo `600`, backup `/opt/athena-twitter/shared/.env.worker.backup-20260822T224443Z`; nenhum valor impresso.
- Preview `dpl_GPSKWSXtc3YF3LLyrQjA9EQgHii9`, `READY`: cinco heartbeats/breakers aprovados, cross-role rejeitado, publication/analytics claims e fallback disabled, health `ok`.
- PM2: cinco X stopped; seis processos existentes online. Nenhuma chamada Zernio, item, hold ou débito.
- Verificação local: 180/180 testes e TypeScript aprovados antes do checkpoint; build/deploy final será registrado após o commit.

Próximo gate: Production off + release VPS/one-shot. Só depois remover o segredo genérico legado dos ambientes.

## Kill switches completos por papel

- Gap adicional: reconciliação não possuía flag própria e seu ciclo de recovery podia prosseguir mesmo quando o heartbeat informava `stopped`.
- Correção: `TWITTER_RECONCILE_WORKER_ENABLED=false` por padrão; heartbeat calcula modo por papel; o executável encerra imediatamente ao receber `stopped`.
- Preview final `dpl_95mw9RpuRp7aZ1gX1CSS1SUYfDiH`, `READY`, URL `https://pomodoro-mwqw12xhw-shoows-projects-2caaf9e9.vercel.app`: cinco papéis autenticaram com modo `stopped`, cross-role foi rejeitado, chamadas diretas de publication claim, analytics claim, reconcile e fallback ficaram disabled e health `ok`.
- Validação local: 181/181 testes, TypeScript, build, sintaxe do worker e diff check aprovados. Warnings de metadata permanecem preexistentes.
- O segredo efêmero de health do Preview foi rotacionado preventivamente depois da validação; nenhum segredo Production/VPS foi afetado.

Próximo gate: commit desta unidade, Production explicitamente off e release VPS versionado com one-shot dos cinco papéis.

## Production e release VPS off aprovados

- Commit executável: `dc997750ddc2953e151f1817468abcfd03c4ff68`.
- Production final: `dpl_soJv1T88XQ2iCmLFtW1fzw4jQLZu`, `READY`, URL `https://pomodoro-nt69m3dr0-shoows-projects-2caaf9e9.vercel.app`, alias oficial preservado.
- Release VPS: `/opt/athena-twitter/releases/dc997750ddc2-20260822T231419Z`; SHA-256 `4bb116e2660be97c6d7f440363196da4b4313bb6e38c74bf5184375dd09b3f57`.
- Cinco one-shots aprovaram antes e depois da remoção do segredo genérico; cinco heartbeats `stopped`. Production/Preview/VPS não possuem mais `TWITTER_WORKER_SECRET` como configuração ativa.
- PM2: os cinco X apontam para o novo release e estão `stopped`; os seis processos existentes continuaram `online` com PIDs 99980, 27468, 136197, 127605, 122939 e 103209.
- Banco antes/depois: publicação não terminal 0, holds 0, attempts publicação 6, analytics não terminal 0, attempts analytics 3, snapshots 0, wallet 11.725.000/0 versão 21. Migrações local/remoto 1–240 alinhadas.
- Backup da configuração antes da remoção legado: `/opt/athena-twitter/shared/.env.worker.backup-before-legacy-removal-20260822T231419Z`; modo ativo `600`.
- Rollback: flags permanecem off; retornar symlink/PM2 ao release `46e09cc-20260822T213610Z` e restaurar o backup apenas se realmente reverter código anterior. Vercel anterior imediato: `dpl_7tjP62du6hnNXC84YkSbjbRiJqhy`.

Próxima ação segura: auditoria final requisito por requisito. Rollout geral/fallback live seguem proibidos pelo gate externo de analytics HTTP 200.

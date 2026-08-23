# Fase 08 — rollout e handoff

Status: `in_progress` — aplicação/release fan-out implantados de forma reversível e desligada; rollout geral/live bloqueado pelo canário da Fase 7

Entregas: ativação progressiva, fallback validado, monitoramento, comparação Instagram e handoff final. Gate: módulo independente, observável e reversível.

Nota de topologia atual: registros abaixo que mencionam cinco processos descrevem releases históricos. A ADR-X-017 reduziu o contrato vigente a quatro papéis reais — publicação, sync, analytics e reconciliação — sem alterar a confirmação financeira atômica.

## Gate visual/CSS obrigatório

A menção original a páginas responsivas na Fase 3 não substitui uma auditoria visual completa. Antes do rollout geral, todas as páginas `/x/*` serão inspecionadas em 1440, 1024, 768, 390 e 320 px, incluindo estados vazio/erro/loading/sem saldo, overflow, foco/teclado, contraste, modais e formulários. Estilos novos serão isolados por classes `twitter-*`/`x-*`; qualquer seletor compartilhado alterado exige evidência de regressão das telas Instagram correspondentes.

## Topologia de quatro workers implantada e desligada

- ADR-X-017 implantada em 23/08/2026 UTC; confirmação continua materializando reservas e itens financiados atomicamente.
- Preview `dpl_FF72a8zwrhaJFDNfm9ord3ac5X27` e Production `dpl_BYjrGwDcg9WtPy4nV1CWwvZ9kKGv` estão `READY`; alias oficial atualizado; rota interna sem segredo retorna `401`.
- Variáveis `TWITTER_GENERATION_*` removidas de Preview/Production. Todos os demais flags X permanecem off.
- Release VPS `/opt/athena-twitter/releases/e732fed77971-20260823T000341Z`, SHA-256 `c0834c2fda517056cb1e31a9a0e9d44c2c8b382b57d673df7c489b396014a4a8`; quatro one-shots off aprovados.
- Arquivo remoto continua `600`; backup recuperável `/opt/athena-twitter/shared/.env.worker.backup-before-generation-removal-20260823T000341Z`; zero linhas `TWITTER_GENERATION_*` ativas.
- PM2: quatro entradas X `stopped`; entrada generation ausente; seis processos existentes online com PIDs 99980, 27468, 136197, 127605, 122939 e 103209.
- Supabase alinhado até 242; fila sync/publicação/analytics não terminal, holds e snapshots em zero; wallet 11.725.000/0 versão 21.
- Rollback: Vercel `dpl_9rAv31d1QTHQzbhwMkcpJZV5CsEe`; VPS `a5edc6c049e1-20260822T235210Z`; ao voltar ao release antigo, restaurar explicitamente o backup com as variáveis antigas e manter tudo off.

## Fila granular e transferência v2 implantadas off

- Preview `dpl_C2KQoYkdeMGbRtw1evfTFHsU3ZK4` e Production `dpl_A1ByNkEstDGPsLejpaXXgHj3q5tu` `READY`; alias oficial atualizado.
- Rotas de cancelamento e transferência retornaram `401` sem sessão tanto no Preview quanto no smoke final de Production; nenhuma mutação funcional foi invocada.
- Supabase migration 243 e teste 13/13 aprovados; após deploy: zero evento de transferência, zero filas/holds, wallet 11.725.000/0 versão 21.
- VPS não recebeu release: quatro workers X seguem `stopped`; seis processos existentes mantêm os PIDs preservados.
- Rollback Vercel imediato: `dpl_BYjrGwDcg9WtPy4nV1CWwvZ9kKGv`; migration 243 permanece forward-only e dormente se a UI for revertida.

## Dashboard X local implantado off

- Preview `dpl_8LaGXgY5ATkhLWitQmVbXbfYp4ZY` e Production `dpl_HMe8QrEt4YDPnTTztNFjiP9JZXtf` `READY`; alias oficial atualizado.
- `/api/x/analytics/snapshots` sem sessão retornou `401` nos dois ambientes; nenhum endpoint de provedor foi chamado.
- Pós-deploy: snapshots 0, eventos de transferência 0, filas/holds 0 e wallet 11.725.000/0. Todos os flags X seguem off; VPS não foi alterada.
- Rollback Vercel: `dpl_A1ByNkEstDGPsLejpaXXgHj3q5tu`.

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

## Gate visual/CSS — inspeção estrutural local

Em 23/08/2026 UTC, a auditoria encontrou classes de composição usadas pelas páginas X sem definição global (`page-stack`, `content-stack`, `summary-grid`, `notice-banner` e linhas de ações). Como o reset global remove margens de títulos e parágrafos, isso deixava as páginas visualmente comprimidas.

- Foi criado um wrapper exclusivo `.twitter-module-shell` no layout `/x/*`.
- Todos os estilos novos ficaram abaixo desse wrapper: espaçamento, formulários, avisos, resumos, ações, estados vazios e breakpoints. Nenhum seletor operacional Instagram foi alterado.
- Um harness local ignorado pelo Git reproduziu os estados representativos de cabeçalho, resumo, formulário, galeria e ações. Em 1440, 1024, 768, 390 e 320 px, `scrollWidth === clientWidth` no documento e no conteúdo X.
- Todos os botões X medidos ficaram com altura mínima de 44 px. A navegação por teclado apresentou outline visível de 3 px.
- A inspeção real sem sessão confirmou apenas o redirecionamento de proteção; portanto, o smoke visual autenticado de todas as rotas em Preview continua sendo parte do gate, não foi presumido a partir do harness.
- Regressão: 210/210 testes, TypeScript isolado e build de 41 páginas aprovados. O primeiro TypeScript foi iniciado em paralelo ao build e recebeu `TS6053` enquanto o Next regenerava `.next/types`; repetido após o build, passou sem erros. Permanecem apenas os warnings preexistentes de metadata.
- Rollback local: reverter o wrapper em `app/(painel)/x/layout.tsx`, o bloco `.twitter-module-shell` em `app/globals.css` e `lib/twitter/css-gate.test.ts`. Não há banco, saldo, Storage, Zernio, Vercel ou VPS para desfazer nesta unidade.

Gate parcial: estrutura e responsividade local aprovadas. Próxima ação segura: checkpoint Git, Preview com flags off e smoke autenticado de todas as rotas `/x/*` antes de marcar o gate visual completo.

Checkpoint `07be9b1` publicado somente em Preview: `dpl_62c6NFsmkGL5JQ9HTHsHkwLd8nV8`, `READY`. O smoke sem sessão retornou `307 /login`. Como não havia sessão Athena no navegador de inspeção, Production não foi promovida e o gate permanece parcial.

Uma sessão Athena autorizada permitiu a matriz real local contra a organização Pomodoro, sem persistir credenciais. O domínio Preview permaneceu protegido pela Vercel; a proteção não foi reduzida. Foram executados 50 casos autenticados (10 rotas × 5 larguras), que revelaram e permitiram corrigir a grade da Galeria, a seleção de conjuntos de mídia, o overflow interno dos Logs e o cabeçalho de perfil em 320 px. Reexecução: 50/50 sem overflow, zero alvo abaixo de 44 px e foco visível. Analytics/Inbox/workers permaneceram off. Novo Preview do checkpoint corrigido ainda é o próximo gate.

Checkpoint `9200b4e` foi implantado em Preview `dpl_8aB1TheK2kW1noy9HJfAAGB7jozx` e Production `dpl_oQRbJB2QkTw33G2s69VTucJpgK5D`, ambos `READY`. A matriz 10 × 5 foi repetida em Production canário com 50/50 aprovações efetivas; dois carregamentos a 320 px apenas precisaram de espera maior. Postagem Instagram passou em 1440/390 px e permaneceu fora do wrapper X. Gate visual/CSS concluído. Banco e VPS continuaram sem fila/hold e com workers X parados.

O início do rollout progressivo continua bloqueado pelo gate financeiro Analytics: três seleções cobraram 27 `posts_read`, mas o contrato atual reserva uma unidade por seleção. É necessária decisão explícita antes de alterar o custo exibido/reservado ou executar novo canário pago.

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

## Agenda e detalhe de Perfis implantados com o módulo off

- Código implantado: `5cc8c75`.
- Preview: `dpl_8cECc3Eqr7cPMCKuu6TRzbteEfMa`, URL `https://pomodoro-ie9rz726k-shoows-projects-2caaf9e9.vercel.app`, `READY`.
- Production: `dpl_44NHJUgWMrcW1kA9mwhedcBYyd7W`, URL `https://pomodoro-izxrdi9iz-shoows-projects-2caaf9e9.vercel.app`, `READY`, alias oficial preservado.
- Smokes sem sessão em `/x/agenda` e `/x/perfis/<uuid>` retornaram `307` para `/login` nos dois ambientes, confirmando proteção das páginas sem chamar Zernio.
- Supabase permaneceu alinhado até 243: publicação/analytics não terminais 0, holds 0, snapshots 0, transferências 0 e wallet 11.725.000/0 versão 21.
- VPS read-only: quatro processos X continuam `stopped`; os seis processos existentes continuam `online` com PIDs 99980, 27468, 136197, 127605, 122939 e 103209.
- Rollback de aplicação: promover `dpl_HMe8QrEt4YDPnTTztNFjiP9JZXtf`; Supabase e VPS não exigem rollback.

Próxima ação segura: auditar Galeria, Grupos e Postagem em massa X. Todas as flags permanecem off; gate de rollout geral continua bloqueado pelo analytics HTTP 200.

## Galeria, Grupos e contrato de Revisão implantados off

- Código implantado: `b37e09f`.
- Preview: `dpl_6FUjQ5g5DGoFeUzedD7NFZj4hfjp`, URL `https://pomodoro-mbz7bkpje-shoows-projects-2caaf9e9.vercel.app`, `READY`.
- Production: `dpl_5P8V7o1iyS9ckkkXkfDUHqSXzQhe`, URL `https://pomodoro-bvqsmutez-shoows-projects-2caaf9e9.vercel.app`, `READY`, alias oficial preservado.
- Smokes: `/x/galeria`, `/x/grupos` e `/x/postagem` retornaram `307 /login`; `POST /api/x/bulk/review` sem sessão retornou `401`. Nenhuma revisão, reserva, upload, grupo ou chamada externa foi criada.
- Pós-deploy: publicação/analytics não terminais 0, holds 0, snapshots 0, transferências 0; wallet 11.725.000/0 versão 21. Quatro X stopped; seis existentes online com PIDs preservados.
- Rollback: promover `dpl_44NHJUgWMrcW1kA9mwhedcBYyd7W`; banco e VPS não foram alterados.

Próxima ação segura: auditoria estrutural final requisito por requisito. Rollout geral e fallback live continuam bloqueados pelo gate analytics HTTP 200.

## Auditoria estrutural final de navegação e papéis

Em 23/08/2026 UTC, os dois menus expansíveis foram reconferidos com todas as rotas Instagram/X, Dashboard geral e importação geral. O rótulo compartilhado foi alinhado para “Importação em massa”. Viewer agora recebe explicitamente uma página somente leitura em `/x/postagem`, sem composer; Review e Confirm continuam exigindo Operator/Admin no servidor. Gate local: 203/203 testes, TypeScript, build e diff check; nenhuma mutação remota.

Deploy final off: código `4cb7502`; Preview `dpl_2stTwHisyFgd6GfNFvCMihRJqZYs` e Production `dpl_Cvbbi7kWV7w32ct71frjGR3SfRSj`, ambos `READY`. `/x/postagem` retornou `307 /login` nos dois ambientes. Pós-deploy: filas/holds/snapshots/transferências 0 e wallet 11.725.000/0. Rollback Vercel: `dpl_5P8V7o1iyS9ckkkXkfDUHqSXzQhe`; banco/VPS não mudaram.

## Contrato fan-out implantado com todos os gates desligados

- Código executável `d67a2ec`; migration 246 alinhada local/remoto e pgTAP tenant-scoped 29/29 em transação com rollback.
- Preview `dpl_7nHd2NqnixMUCHq51d2czH3Fkiqc` e Production `dpl_sZ28EuSUeQXRy8f3sJdyrmFbooch`, ambos `READY`; rollback imediato `dpl_oQRbJB2QkTw33G2s69VTucJpgK5D`.
- Release VPS `/opt/athena-twitter/releases/d67a2ec-20260823T113709Z`, hash `be77ef65f7369cd6da5def3d844e23f0cfa4ebcbfbceb7ab6b3ee3ae3008a24e`; rollback `7c83ece-20260823T011500Z`.
- Quatro one-shots X encerraram no modo desligado; PM2 mantém os quatro processos X parados. Os seis processos existentes continuaram online, sem reinício e com PIDs preservados.
- Smokes público e autenticado aprovaram proteção, gate Analytics desligado e apresentação da reserva máxima nos Logs. Nenhuma chamada de recurso X/Zernio, reserva, débito ou reconciliação foi criada.
- O arquivo temporário remoto foi removido somente após confirmar o release e o hash. O bypass de proteção Vercel foi rotacionado preventivamente após exposição em saída operacional; nenhum segredo consta deste registro.

Gate de deploy desligado concluído. Próxima unidade: executor guardado e canário de uma seleção inédita, com limite de 45.000 micros. Rollout geral e fallback live continuam proibidos.

## Preflight formal da Fase 8 — sete de nove gates

- Zernio já retornou HTTP 200 com métricas para o novo canário fan-out; este item do gate está aprovado.
- Production segura `dpl_sZ28EuSUeQXRy8f3sJdyrmFbooch` está `READY`; login 200 e `/x/postagem` sem sessão 307 para login.
- Supabase 246/246, nenhuma migration pendente. VPS release `d67a2ec-20260823T113709Z`, 42 GB livres, 2.917 MB disponíveis e sem swap.
- Quatro processos X PM2 `stopped`; fallback Vercel não é PM2. Seis processos existentes `online` com PIDs 99980, 27468, 136197, 127605, 122939 e 103209.
- Zero publicação não terminal, zero publicação unknown, zero breaker aberto e zero HTTP 429 em 24 horas.
- O único sinal crítico é o item Analytics HTTP 200 em `billing_pending`, acompanhado de uma reserva aberta de 45.000 micros. Por isso health deve continuar `unhealthy` até reconciliação; esse estado não será mascarado.
- Checklist corrigido para a topologia vigente de quatro PM2 + fallback separado. Sete de nove itens aprovados; faltam snapshot/débito exato/hold zero e health `ok` posterior.

Nenhuma organização foi adicionada, nenhum worker foi iniciado e fallback continua off. A expansão progressiva permanece bloqueada até os dois itens restantes.

### Inventário e aceite por tipo de organização

- O ambiente contém três organizações: uma com conexão X ativa e duas sem conexão X.
- A organização conectada exigirá 30 minutos de observação, uma publicação confirmada, ledger/hold reconciliados e health antes/depois.
- Cada organização sem conexão exigirá 30 minutos, páginas/rotas e permissões corretas, estados vazios e zero chamada externa/fila/reserva/ledger. Nenhuma credencial ou publicação artificial será criada.
- Após uma organização sem conexão adicionar X futuramente, o primeiro envio terá gate operacional próprio; a aprovação visual anterior não autoriza publicação automática.
- ADR-X-023 registra esta distinção. A ordem concreta e IDs permanecerão fora da documentação pública; somente contagens são registradas.

### Gate zero financeiro concluído e onboarding de novas organizações — 23/08/2026

- O canário Analytics está terminal com snapshot e zero hold; wallet 11.590.000/0 versão 26. A ocorrência não deve ser repetida.
- Foi criado reconciliador cumulativo para qualquer cobrança tardia futura, sem nova leitura de recurso.
- Organização sem conexão recebe estados vazios em Postagem, Fila, Galeria, Perfis, Grupos, Agenda, Zernio, Logs e Análises. Postagem orienta para `/x/zernio` e bloqueia Revisar sem perfil, texto e início.
- Nenhum desses estados vazios referencia tabelas/rotas Instagram ou endpoint externo. Futuras organizações permanecem aptas a conectar seu próprio X e recebem o grant único por identidade pelo fluxo já implementado.
- Validação local: 218/218 testes, TypeScript, build de 41 páginas e `git diff --check`; warnings metadata preexistentes inalterados.
- Próximo gate: checkpoint Git, Preview seguro, QA autenticado e promoção Production antes da ativação progressiva.

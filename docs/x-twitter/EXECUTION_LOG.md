# Execution log — módulo X/Twitter

Registros são append-only.

## X-0001 — início da Fase 0

- UTC: 2026-08-22T17:10:17Z
- São Paulo: 2026-08-22T14:10:17-03:00
- Executor: Codex GPT-5
- Objetivo: congelar e documentar o baseline antes do módulo X.
- Branch/commit inicial: `codex/pre-x-baseline-analytics` em `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`.
- Estado inicial: worktree sujo preexistente de Analytics; migrações 210–222 locais não rastreadas, porém já aplicadas no remoto.
- Verificações: Supabase alinhado até 222; Vercel vinculado; SSH/PM2 saudáveis; 137 testes, TypeScript e build aprovados no preflight anterior.
- Mudanças desta etapa: branch de baseline criada; plano aprovado consolidado; estrutura de continuidade criada; globs inválidos do `.gitignore` corrigidos sem apagar arquivos.
- Mutação remota: nenhuma.
- Rollback: reverter somente o futuro commit da documentação/sintaxe; não alterar migrações remotas.
- Riscos: alterações Analytics precisam de revisão e commit antes do início das migrations X.
- Status: `in_progress`.
- Próxima ação segura: repetir testes/build/diff check e revisar o diff Analytics.
- Não repetir: migrações 210–222; reinício dos workers Instagram.

## X-0002 — validação do gate da Fase 0

- UTC: 2026-08-22T17:13:45Z
- São Paulo: 2026-08-22T14:13:45-03:00
- Objetivo: validar o worktree completo antes do checkpoint.
- Comandos: `git diff --check`, `npm test`, `npx tsc --noEmit`, `npm run build`.
- Resultado: diff sem erro; 137/137 testes aprovados; TypeScript aprovado; build Next.js aprovado.
- Warnings preservados: reparsing ESM nos testes e metadata `viewport/themeColor` nas páginas preexistentes `/login`, `/onboarding` e `/_not-found`.
- Supabase: sem mutação; continua alinhado 001–222.
- Vercel/VPS: sem deploy ou restart.
- Invariantes: nenhum arquivo operacional do X existe fora de documentação; Instagram não foi alterado nesta etapa além do worktree Analytics preexistente que está sendo consolidado.
- Rollback: reverter o futuro commit do checkpoint; não tocar no remoto.
- Status: `completed`.
- Próxima ação segura: commit de baseline e abertura da branch X.

## X-0003 — checkpoint da Fase 0 criado

- UTC: 2026-08-22T17:14:12Z
- São Paulo: 2026-08-22T14:14:12-03:00
- Commit: `41fd0c2414a46672210487e0dcee25ecc17aed82`.
- Conteúdo: consolidação Analytics/migrations 210–222, plano aprovado, documentação de continuidade e correção dos globs do `.gitignore`.
- Resultado: commit criado com 63 arquivos; nenhuma mutação remota.
- Rollback: branch de baseline preservada; reverter o commit somente se houver decisão explícita, sem alterar Supabase remoto.
- Status: `completed`.
- Próxima ação segura: abrir `codex/x-twitter-module` e iniciar Fase 1 local/desligada.

## X-0004 — início da Fase 1

- UTC: 2026-08-22T17:14:58Z
- São Paulo: 2026-08-22T14:14:58-03:00
- Branch: `codex/x-twitter-module` a partir do baseline documentado.
- Objetivo: fundação aditiva, financeira e desligada por flag.
- Escopo imediato: migration 223 local, RLS, carteira/ledger/reservas, módulos puros, testes e navegação.
- Fora do escopo: chamada Zernio, aplicação de migration, deploy Vercel ou PM2.
- Estado remoto: inalterado; Supabase continua em 222.
- Status: `in_progress`.
- Próxima ação segura: escrever e validar a fundação local.

## X-0005 — fundação local da Fase 1 validada

- UTC: 2026-08-22T17:23:14Z
- São Paulo: 2026-08-22T14:23:14-03:00
- Entregas: migration 223, SQL test 223, feature flags, menu expansível e módulos puros de preço, caracteres, rotação, financiamento e resultados.
- Testes: 149/149 Node aprovados; TypeScript aprovado; build aprovado; diff check aprovado.
- Supabase dry-run: somente `223_twitter_module_financial_foundation.sql`; nenhuma migration enviada.
- Avisos: Docker não está instalado localmente; por isso a validação SQL final será o teste transacional `--linked` após commit e push exclusivo da migration.
- Vercel/VPS: sem deploy ou restart.
- Rollback previsto: desligar flags; migration é aditiva; eventual correção de banco será forward-only.
- Status: `in_progress`, validação local concluída.
- Próxima ação segura: commit local e aplicação controlada da migration 223.

## X-0006 — migration 223 aplicada; correção forward-only necessária

- UTC: 2026-08-22T17:24:24Z
- São Paulo: 2026-08-22T14:24:24-03:00
- Commit implantado no banco: `f861710fd2c4fd5268f0a88b846e4d80facb039f`.
- Supabase: project ref confirmado; migration 223 aplicada isoladamente.
- Teste pgTAP: não executado porque o runner do CLI exige Docker local.
- Lint remoto: detectou casts ausentes em dois `CASE` de funções Twitter; migration foi criada, mas essas funções não devem ser chamadas antes da 224.
- Erros preexistentes fora do escopo: duas ambiguidades PL/pgSQL em funções antigas não Twitter.
- Decisão: preservar 223 e corrigir para frente em 224.
- Rollback/mitigação: módulo e flags continuam desligados; nenhuma identidade, carteira ou reserva real foi criada.
- Status: `in_progress`.
- Próxima ação segura: criar/aplicar 224 e repetir lint.

## X-0007 — gate da Fase 1 aprovado

- UTC: 2026-08-22T17:28:57Z
- São Paulo: 2026-08-22T14:28:57-03:00
- Migrations: 224 corrigiu casts; 225 removeu grants automáticos de `anon` e restringiu RPCs de worker ao `service_role`.
- Teste SQL: 19 verificações executadas via Management API dentro de transação com rollback; resultado final `ok 19`.
- Verificação pós-teste: zero registros residuais nas tabelas financeiras.
- ACL remoto: conferido função por função; política esperada confirmada.
- Lint: sem erros Twitter; dois erros legados fora do escopo permanecem documentados.
- Aplicação: 149/149 testes Node, TypeScript e build aprovados.
- Vercel/VPS: inalterados; flags desligadas.
- Rollback: flags já desligadas; schema é aditivo; correções posteriores serão forward-only.
- Status: `completed`.
- Próxima ação segura: commit do gate e início da Fase 2 local.

## X-0008 — início da Fase 2 e reconferência Zernio

- UTC: 2026-08-22T17:30:50Z
- São Paulo: 2026-08-22T14:30:50-03:00
- Fontes oficiais reconferidas: plataforma Twitter, Connecting Accounts, Account Health, auth/verify no changelog e x-pricing.
- Decisões confirmadas: OAuth `twitter`; identidade global por `userId`; filtro por profile; health local; `analytics=false` e `inbox=false`; pricing externo apenas diagnóstico.
- Restrição de identidade: username nunca será usado para fusão. Se o payload não trouxer ID imutável do X, o perfil permanece vinculado ao account ID Zernio e uma reconexão diferente não será mesclada automaticamente.
- Escopo: migration 226, cliente separado e telas/APIs Zernio/Perfis.
- Mutação remota nesta etapa: nenhuma ainda.
- Status: `in_progress`.
- Próxima ação segura: implementação local e testes.

## X-0009 — implementação local da Fase 2 validada

- UTC: 2026-08-22T17:39:53Z
- São Paulo: 2026-08-22T14:39:53-03:00
- Executor: Codex GPT-5; task ID não disponibilizado pelo ambiente.
- Objetivo: implementar conexão Zernio X, identidade/perfil estáveis e épocas sem qualquer chamada real ao provedor.
- Arquivos principais: migration/teste 226, cliente e serviços `lib/twitter/zernio-*`, guard de request, APIs `/api/x/integrations/zernio/*`, `/api/x/profiles`, páginas `/x/zernio` e `/x/perfis`.
- Invariantes: nenhuma tabela/RPC Instagram referenciada; chave em tabela secreta; username não prova identidade; analytics/inbox false; grant não reinicia em rotação.
- Validação: 152/152 testes Node; TypeScript aprovado; build aprovado; `git diff --check` aprovado.
- Build: somente warnings de metadata preexistentes em login/onboarding/not-found.
- Supabase: projeto ainda alinhado remotamente até 225; dry-run listou somente 226.
- Vercel/VPS: sem deploy, release, segredo, worker ou restart.
- Riscos pendentes: a migration 226 ainda precisa ser executada e testada no PostgreSQL remoto dentro de transação revertida.
- Rollback: antes do push, reverter o commit local; depois do push, manter flags off e corrigir forward-only.
- Status: `in_progress`, implementação local concluída.
- Próxima ação segura: criar commit local, confirmar o projeto vinculado, aplicar apenas 226 e executar o teste SQL 226.
- Não repetir: não cadastrar API key real para validar schema; não reiniciar PM2.

## X-0010 — migration 226 aplicada e contratos de perfil validados

- UTC: 2026-08-22T17:41:53Z
- São Paulo: 2026-08-22T14:41:53-03:00
- Commit aplicado: `fc6584f1126121658bd7fed779f05c49ed582cfb`.
- Supabase: linked ref reconfirmado como `hqwhumdumfmixxbvneae`; antes 225, depois 226.
- Mutação: somente `226_twitter_zernio_profiles_and_epochs.sql`.
- Teste SQL: 23/23 verificações concluídas via Management API com `BEGIN`/`ROLLBACK`.
- Pós-teste: zero registros X residuais em identidades, wallets, perfis, épocas, OAuth attempts e eventos.
- Segurança: quatro RPCs mutáveis da fase negados a anon/authenticated e permitidos apenas a service role.
- Lint: nenhum erro X. Erros legados preservados: ambiguidade `state` em `rollback_legacy_waiting_randomization` e `batch_id` em `enqueue_zernio_organization_sync_batch`.
- Vercel/VPS: inalterados; nenhuma chave real chamada; flags desligadas.
- Rollback: schema aditivo com correção forward-only; mitigação imediata é manter flags desligadas (estado atual).
- Gate: implementação aprovada; teste vivo depende de API key X dedicada inserida por admin.
- Próxima ação segura: commit da documentação e desenvolvimento local da Fase 3; rollout continua bloqueado até o teste vivo.
- Não repetir: não reaplicar 226; não reutilizar secret Instagram; não executar sincronização real sem ação explícita de admin.

## X-0011 — início controlado da Fase 3

- UTC: 2026-08-22T17:41:53Z
- São Paulo: 2026-08-22T14:41:53-03:00
- Objetivo: assets, upload retomável, grupos e páginas X isoladas.
- Estado inicial: branch limpa em `2d498a7`; Supabase alinhado até 226; flags desligadas.
- Limite: nenhuma liberação/canário e nenhuma inferência de aprovação do gate vivo da Fase 2.
- Próxima ação segura: criar migration 227 local, APIs/páginas e testes; dry-run antes de qualquer push.

## X-0012 — Fase 3 validada localmente

- UTC: 2026-08-22T17:46:53Z
- São Paulo: 2026-08-22T14:46:53-03:00
- Entregas: schema 227, teste SQL 227, upload TUS retomável, catálogo de assets, grupos/membros, galeria/grupos/agenda X.
- Streaming: chunks de 6 MB; nenhum `File` completo é enviado ao Next.js ou carregado no worker.
- Isolamento: bucket, paths, tabelas, APIs e páginas usam namespace X; grupos só referenciam `twitter_profiles`.
- Testes: 153/153 Node; TypeScript aprovado; build aprovado; diff check aprovado.
- Supabase: remoto permanece 226; dry-run lista somente 227.
- Vercel/VPS: inalterados.
- Status: `in_progress`, implementação local validada.
- Próxima ação segura: commit e aplicação controlada de 227, seguida do teste SQL transacional.

## X-0013 — gate da Fase 3 aprovado

- UTC: 2026-08-22T17:48:00Z
- São Paulo: 2026-08-22T14:48:00-03:00
- Commit de código: `f47dd4cad2f09d55a621c744c7af4317b9a4c749`.
- Supabase: migration 227 aplicada isoladamente; local/remoto alinhados.
- Teste SQL: 14/14 em `BEGIN`/`ROLLBACK`; zero dados residuais.
- Segurança: RPC de membros negado a anon/authenticated; service role permitido; tenant e path Storage isolados.
- Lint: zero erro X; duas ambiguidades legadas inalteradas.
- Vercel/VPS: inalterados; nenhum upload real executado.
- Rollback: flags desligadas e correção de banco forward-only.
- Status: `completed`.
- Próxima ação segura: commit deste checkpoint e início local da Fase 4.

## X-0014 — Fase 4 validada localmente

- UTC: 2026-08-22T17:54:31Z
- São Paulo: 2026-08-22T14:54:31-03:00
- Entregas: migration/teste 228, token HMAC de revisão, algoritmo financiável limitado pelo saldo, confirmação atômica, composer e APIs X.
- Revisar: não cria item, reserva ou débito; token expira em 10 minutos.
- Confirmar: revalida versão da carteira/rate card/perfil; conflito retorna 409; excedente fica agregado.
- Testes: 154/154, TypeScript, build e diff check aprovados.
- Supabase remoto: ainda 227; dry-run somente 228. Zernio/Vercel/VPS inalterados.
- Próxima ação segura: commit, push isolado 228 e teste SQL 16/16 com rollback.

## X-0015 — gate da Fase 4 aprovado

- UTC: 2026-08-22T17:57:05Z
- São Paulo: 2026-08-22T14:57:05-03:00
- Commit/migration: `f5c5d73`; migration 228 aplicada isoladamente.
- Teste: primeira execução 15/16 por fixture concorrente com lista vazia; schema agiu corretamente. Fixture corrigida e execução final 16/16.
- Invariantes: dois itens financiados, um excedente compacto, 215.000 micros reservados, saldo contábil 12.000.000, replay idempotente e stale snapshot rejeitado.
- Pós-teste: zero programa, item, reserva ou identidade residual.
- Lint: sem erro X; erros legados inalterados. Vercel/VPS/Zernio inalterados.
- Status: `completed`.
- Próxima ação segura: commit da correção do teste/documentação e início da Fase 5 shadow.

## X-0016 — rascunho de schema da Fase 5

- UTC: 2026-08-22T17:59:47Z
- São Paulo: 2026-08-22T14:59:47-03:00
- Estado inicial: branch limpa em `6d71972`; Supabase alinhado até 228.
- Rascunho local: migration 229 com hold por item, tentativa, log imutável, heartbeat, circuit breaker, claim de uma chamada por perfil, conclusão shadow e cancelamento seguro.
- Dry-run: lista somente 229; migration não aplicada e ainda não possui teste SQL.
- Vercel/VPS/Zernio: inalterados; nenhum processo instalado e nenhuma chamada externa.
- Status: `in_progress`, não validado.
- Próxima ação segura: revisar SQL e criar teste transacional antes de commit/push.
- Não repetir: não aplicar 229 no estado de rascunho e não iniciar worker live.

## X-0017 — Fase 5 aplicada, corrigida e validada

- UTC: 2026-08-22T18:14:14Z
- São Paulo: 2026-08-22T15:14:14-03:00
- Executor: Codex GPT-5; task ID não exposto pelo ambiente.
- Supabase: projeto `hqwhumdumfmixxbvneae`, antes 228 e depois 232; migrations aditivas 229–232.
- A primeira execução do teste 229 revelou ambiguidade PL/pgSQL no retorno do claim; 230 corrigiu os nomes forward-only. Não reaplicar 229/230.
- Schema: hold por item, tentativas, logs imutáveis, heartbeat, circuit breaker, matriz de resultados, resoluções manuais imutáveis, regras futuras, cancelamento por escopo e recuperação de lease.
- Testes SQL: 229 com 18/18, 231 com 16/16 e 232 com 9/9; todos em `BEGIN`/`ROLLBACK`. Pós-teste: zero wallets, holds, tentativas, resoluções e logs residuais.
- Invariantes: falha local/confirmada libera; 429 usa no mínimo 240s e mantém reserva; publicado liquida uma vez; timeout/5xx incerto mantém hold; lease pós-chamada nunca gera retry cego; cancelamento por item não amplia escopo.
- Aplicação: fila, agenda e logs X; resolução manual com justificativa; endpoints internos start/result/reconcile; cinco roles de worker separadas, concorrência inicial 1 e modo shadow sem cliente Zernio.
- Testes locais: 154/154, TypeScript, build e `git diff --check` aprovados. Build manteve somente warnings metadata preexistentes.
- Lint remoto: nenhum erro X; permaneceram as ambiguidades legadas `state` e `batch_id` já registradas.
- Zernio: documentação oficial reconferida; nenhuma credencial ou chamada real utilizada.
- Vercel/VPS/PM2: inalterados; nenhum deploy, release ou restart.
- Rollback: flags continuam off; banco é corrigido somente forward; remover código por revert de commit sem apagar migrations remotas.
- Status: implementação shadow `completed`; instalação PM2 fica para a preparação de rollout.
- Próxima ação segura: adaptador live com mocks e depois deploy desabilitado. Não publicar sem credencial dedicada e gate canário.
- Não repetir: não reaplicar 229–232; não cancelar programa quando a intenção for item; não reclassificar `outcome_unknown` sem evidência e justificativa.

## X-0018 — preparação do canário sem chamada real

- UTC: 2026-08-22T18:20:24Z; São Paulo: 2026-08-22T15:20:24-03:00.
- Contrato oficial reconferido: `POST /v1/posts`, `publishNow`, `platform=twitter`, `accountId` e `mediaItems`; webhook usa HMAC-SHA256 do corpo bruto e event ID estável.
- Código: adaptador X, claim live enriquecido, decriptação somente no worker, classificação de 2xx/4xx/429/5xx/timeout/existingPost, assinatura e persistência de webhooks.
- Migrations: 233 aplicada; primeiro teste encontrou conta Zernio na época, não no perfil estável; 234 corrigiu forward-only. Não reaplicar ambas.
- Testes: Node 161/161; webhook SQL 7/7 com rollback; TypeScript e diff check aprovados.
- Segurança: nenhuma chave real lida; valor cifrado só é entregue ao worker autenticado em live; webhook rejeita assinatura ausente/inválida; payload persistido é sanitizado.
- Vercel/VPS: inalterados. Flags off e modo padrão shadow.
- Status: preparação concluída; gate bloqueado por ausência de API key X dedicada cadastrada por admin.
- Próxima ação segura: implementar análises manuais; não executar a ordem do canário até a credencial existir.

## X-0019 — gate da Fase 7 aprovado sem leitura externa

- UTC: 2026-08-22T18:34:18Z; São Paulo: 2026-08-22T15:34:18-03:00.
- Supabase: migrations 235–239 aplicadas; alinhamento local/remoto 239.
- Entregas: quote read-only, confirmação transacional multi-carteira, piso protegido de 5.000.000 micros, jobs/itens/reservas, claim por perfil, snapshots locais, worker manual e resolução auditada de resultados incertos.
- Correções forward-only: 237 limita o mesmo statement a um item por perfil; 238 remove warnings de lint X; 239 impede liquidação terminal repetida com idempotency key diferente.
- Teste SQL: 26/26 via `BEGIN`/`ROLLBACK`. Comprovou reservas de publicação preservadas, 5k/10k, sucesso parcial, falha/liberação, unknown/hold, replay e piso. Pós-teste sem dados X residuais.
- Testes locais: 163/163; TypeScript, build e diff check aprovados. Build contém somente warnings metadata preexistentes.
- Dashboard: seleção X lê `/api/x/analytics/snapshots`, que consulta apenas tabelas locais, e oferece “Abrir Análises X”. Nenhum page view chama Zernio.
- Flags: analytics e worker analytics continuam false. A execução só ocorre após quote/confirm e ambas as flags.
- Lint: nenhum erro/warning X; permaneceram apenas achados legados já documentados.
- Zernio/Vercel/VPS: nenhuma credencial real, leitura externa, deploy ou restart nesta fase.
- Rollback: flags off e worker parado; banco somente forward-only; código por revert do checkpoint.
- Status: `completed`.
- Próxima ação segura: commit e preparar deploy/PM2 desabilitado da Fase 8.

## X-0020 — lacunas de segurança do rollout fechadas

- UTC: 2026-08-22T18:41:57Z; São Paulo: 2026-08-22T15:41:57-03:00.
- Executor: Codex GPT-5; task ID não exposto pelo ambiente.
- Commit de código: `1a74e4afd77f166674b05d43647d5abb1951bb38`.
- Supabase: projeto `hqwhumdumfmixxbvneae`; antes 239 e depois 240; somente migration aditiva 240 foi aplicada.
- Correções: exclusão de conexão não libera holds iniciados/incertos; lease expirado de analytics vira resultado incerto; circuit breaker persistente ligado a cada worker; regras futuras administráveis e auditadas sem exclusão.
- Teste SQL: 13/13 em `BEGIN`/`ROLLBACK`; regras desativadas preservadas, eventos imutáveis, breaker abre/fecha e recovery vazio idempotente.
- Testes locais: 163/163; TypeScript, build e `git diff --check` aprovados. Build manteve apenas warnings metadata preexistentes.
- Lint remoto: zero achado X; duas ambiguidades legadas (`state` e `batch_id`) permanecem fora do escopo.
- Vercel/VPS/Zernio: ainda inalterados neste checkpoint; nenhuma credencial ou chamada externa.
- Rollback: todas as flags X off; parar apenas processos `athena-twitter-*`; banco somente por correção forward-only.
- Status: `completed`.
- Próxima ação segura: criar preview Vercel com flags X off, executar smoke e instalar pacote de workers X parado/shadow, sem promover produção.

## X-0021 — deploy desabilitado e workers parados

- UTC: 2026-08-22T18:54:36Z; São Paulo: 2026-08-22T15:54:36-03:00.
- Executor: Codex GPT-5; task ID não exposto pelo ambiente.
- Git: manifest PM2 em `3f3821171839a4a16443cc61929703166aceeabd`; branch `codex/x-twitter-module`.
- Vercel Preview: `dpl_2JSe1hjSEdWCCVZH9VJ96zC7QXua`, `READY`.
- Vercel Production: `dpl_Akd9xnWZxrfeZpz9XpvsA5JgZgAR`, `READY`; deployment anterior para rollback: `dpl_DuXLdmBjjofPwJEsCNSSf6b5D39J`.
- Variáveis: nomes `TWITTER_*` necessários configurados; flags de módulo/publicação/analytics `false`; modo `shadow`; nenhum valor documentado.
- VPS: release `/opt/athena-twitter/releases/3f3821171839-20260822T184649Z`, hash SHA-256 `9aaf4f732665bf3b853c2296646abe9f4a21f2a113f12de4dfd3621c7b87cb33`; shared env `600`.
- PM2: cinco processos X persistidos em `stopped`; os seis processos preexistentes seguem `online` com PIDs preservados.
- One-shot: primeiro comando usou cwd incorreto e parou localmente; pareamento Production exigiu rotação atômica do segredo; execução final dos cinco papéis aprovada.
- Banco após one-shot: cinco heartbeats em modo `stopped`, zero publicação claimed, zero analytics processing, zero resolução financeira.
- Smoke: login `200`, páginas protegidas `307`, heartbeat sem segredo `401`.
- Zernio: nenhuma chamada, API key, post ou leitura real. Fallback não habilitado.
- Rollback: manter flags false; parar somente `athena-twitter-*`; Vercel volta ao deployment anterior; release X permanece preservado; banco só por migration forward-only.
- Status: `blocked` no gate real das Fases 6/8.
- Bloqueio: organização canário e API key Zernio X dedicada ainda não foram fornecidas/cadastradas.
- Próxima ação segura: escolher organização canário, cadastrar a chave X por admin e executar a sequência de canário; não reutilizar segredo Instagram.

## X-0022 — Pomodoro selecionada e credencial inspecionada; pausa antes do provisionamento

- UTC: 2026-08-22T19:27:10Z; São Paulo: 2026-08-22T16:27:10-03:00.
- Executor: Codex GPT-5; task ID não exposto pelo ambiente.
- Solicitação final: o usuário confirmou organização Pomodoro, conta X conectada e tier Free; depois pediu documentação imediata e parada.
- Git inicial/final: branch `codex/x-twitter-module`, HEAD `c71fad5fba9f618e2a898373fcff89344c3281c4`; worktree ficou intencionalmente sujo e sem novo commit.
- Arquivos de implementação pendentes: `app/x/twitter-zernio-client.tsx`, `lib/twitter/zernio-client.ts`, `lib/twitter/zernio-connections.ts` e `lib/twitter/zernio-client.test.ts` (42 inserções, 8 remoções antes da documentação).
- Motivo do código: o provisionamento anterior criaria um profile canônico novo e deixaria órfã a conta X já conectada. A mudança adota o profile existente somente se houver exatamente um profile e todas as contas dele forem Twitter; caso contrário mantém a criação isolada anterior.
- Validação local: `git diff --check` aprovado; Node 164/164; `npx tsc --noEmit` aprovado; `npm run build` aprovado. Permanecem somente os warnings metadata preexistentes em `/login`, `/onboarding` e `/_not-found`.
- Zernio read-only: segredo recebido no chat e usado apenas em memória. `auth/verify` válido com `userId` estável; um único profile; uma única conta conectada; plataforma exclusivamente Twitter; identidade X imutável presente. Tier ausente no payload, portanto aplicar fallback conservador Free/280 confirmado pelo usuário.
- Chamadas não realizadas: nenhum post, analytics, followers, DM, billing ou preço; nenhuma tentativa de escrita remota no X.
- Supabase: projeto permanece `hqwhumdumfmixxbvneae`, migrations alinhadas até 240. A chave ainda não foi cifrada/persistida; não há conexão/perfil X sincronizado por esta credencial e nenhum grant, reserva ou débito foi criado.
- Vercel: `TWITTER_CANARY_ORGANIZATION_IDS` foi configurado somente para Pomodoro. Preview `dpl_FtikYGRpuBhe6NvQZbL4WzwmNerf` e Production `dpl_EU8TNTWAWLGKy8GWbJUtSqZjFTPH` ficaram `READY`; flags globais de módulo, publicação e analytics continuam `false`. Rollback imediato: deployment `dpl_Akd9xnWZxrfeZpz9XpvsA5JgZgAR` ou remoção da organização canário.
- VPS/PM2: nenhuma alteração nesta retomada; cinco processos `athena-twitter-*` permanecem `stopped`; não reiniciar os seis processos preexistentes do Instagram.
- Invariantes financeiras: nenhuma carteira foi criada ou alterada nesta retomada. Antes de publicar, verificar grant único de 12.000.000 micros, saldo reservado zero, ledger sem débito e limite 280.
- Status: `in_progress`, pausado deliberadamente antes de qualquer provisionamento ou publicação.
- Próxima ação segura: ler este registro; revisar e commitar as alterações locais; provisionar a chave por meio do serviço transacional existente, sem imprimi-la; sincronizar a conta com `analytics=false` e `inbox=false`; conferir carteira e perfil; só então iniciar o canário de texto sem URL.
- Não repetir: não reaplicar migrations 210–240; não repetir deploy/canary env sem drift; não criar outro profile Zernio; não registrar a chave em documentação/comando versionado; não chamar post/analytics/billing; não iniciar workers antes do preflight financeiro.

## X-0023 — credencial, carteira e perfil Pomodoro prontos

- UTC: 2026-08-22T19:40:21Z; São Paulo: 2026-08-22T16:40:21-03:00.
- Git: adoção segura do profile em `b7f9ad7808518537d8d6af31c05402949ac8d090`; provisionador guardado em `ed03779481f3d5057ccac8ffa2ec73a47d24f3de`; correção do retorno RPC em `50469d4e87eed009c13c9e4bde5e1176cac7014c`.
- Primeira execução: as RPCs criaram identidade, conexão e grant, mas o utilitário parou antes do sync porque leu `id` em vez de `connectionId`. Nenhuma publicação ocorreu. Inspeção read-only mostrou uma identidade, conexão ativa, grant/ledger de 12.000.000 micros, reserva zero e nenhum perfil ainda.
- Recuperação: leitor corrigido e commitado antes da repetição. As RPCs idempotentes reutilizaram a mesma identidade/conexão e não criaram uma segunda concessão.
- Resultado final: profile Zernio existente adotado; uma conta vista e sincronizada; nenhuma offline; profile Athena ativo, `can_post=true`, token válido, sem reconnect e com identidade X imutável.
- Tier: Zernio ainda retorna `unknown`; fallback conservador confirmado como Free, limite efetivo 280. Premium só será usado quando o provedor confirmar.
- Financeiro: saldo contábil 12.000.000 micros; reservado zero; versão 1; um grant de 12.000.000; uma entrada de ledger grant; zero débitos; zero reservas abertas.
- Segurança: credencial persistida somente cifrada; valor não documentado. Conexão ativa com `analytics=false` e `inbox=false`. A sincronização não chamou post, analytics, followers, billing ou DM.
- Supabase: projeto `hqwhumdumfmixxbvneae`; local/remoto alinhados até 240; nenhuma migration nova.
- Vercel/VPS: inalterados neste checkpoint. Workers X continuam `stopped`; processos Instagram não foram reiniciados.
- Rollback: antes de qualquer post, remover/desativar a organização canário ou excluir logicamente a conexão pela rotina X; nunca apagar ledger/grant. Banco continua forward-only.
- Status: gate de credencial/carteira/perfil `completed`; canário de publicação ainda `in_progress`.
- Próxima ação segura: deploy do commit atual com flags globais off, smoke, depois review/confirm de um único texto sem URL; verificar reserva de 15.000 micros antes de ligar apenas o worker Twitter de publicação.
- Não repetir: não provisionar de novo para inspeção; não criar novo profile; não chamar analytics/billing; não iniciar worker antes do item e da reserva serem auditados.

## X-0024 — aplicação atual implantada com execução desligada

- UTC: 2026-08-22T19:43:52Z; São Paulo: 2026-08-22T16:43:52-03:00.
- Preview: `dpl_4QkYfwXxWeYu4TY7EixwfVJUFrJf`, `READY`, smoke login 200, rota X protegida 307, heartbeat POST sem segredo 401.
- Produção: `dpl_DiBtbGFbYLsNpEA5GpMCWNbLN5W7`, `READY`, alias principal atualizado; smoke repetiu 200/307/401.
- Build Vercel: aprovado; somente warnings metadata preexistentes e aviso de dependências/npm audit já conhecido. Nenhuma correção adjacente foi misturada.
- Flags: organização canário continua somente Pomodoro; módulo global, worker de publicação e analytics continuam `false`.
- Supabase/Zernio/financeiro: nenhuma mudança neste deploy. Saldo continua 12.000.000 micros, reservado zero e zero débitos.
- VPS/PM2: inalterados; cinco workers X `stopped`; processos Instagram não reiniciados.
- Rollback Vercel: `dpl_EU8TNTWAWLGKy8GWbJUtSqZjFTPH`.
- Status: deploy gate `completed`; publicação real ainda não iniciada.
- Próxima ação segura: review/confirm de exatamente um texto único sem URL, com workers parados; auditar item e reserva de 15.000 micros.

## X-0025 — primeiro item texto confirmado com worker parado

- UTC: 2026-08-22T19:45:36Z; São Paulo: 2026-08-22T16:45:36-03:00.
- Utilitário guardado: `24627ab200824d6f1fd6b3871e7ddc575aac21d6`; recusa se já houver programa/item e exige exatamente um perfil ativo.
- Programa: `1d3d9013-4cf6-484e-8596-4552c1623636`; item: `e5388d6a-82ce-45e7-81a3-27b37adc643b`; execução: 2026-08-22T20:05:00Z.
- Conteúdo: texto técnico único, sem URL e abaixo de 280 caracteres; nenhuma mídia.
- Review/confirm: um solicitado, um financiado, zero excedente; categoria `post_dm_create`, custo 15.000 micros.
- Pós-confirmação: item `ready`, attempt count 0; reserva `open` com 15.000 restante, zero liquidado/liberado; wallet 12.000.000 contábil, 15.000 reservado, versão 2.
- Execução: flags live ainda false; cinco workers X permanecem parados; nenhuma chamada `/v1/posts` ocorreu.
- Rollback antes do claim: cancelamento idempotente do item libera a reserva original; não criar crédito.
- Próxima ação segura: preflight read-only; habilitar publicação live somente em Production e no shared env VPS; iniciar apenas o worker X de publicação; monitorar e parar após resultado.

## X-0026 — canário texto sem URL publicado e liquidado

- UTC: 2026-08-22T20:07:17Z; São Paulo: 2026-08-22T17:07:17-03:00.
- Janela live: Production `dpl_TWGZkAu2ciJAv6zh9rZkEWbyK4d4`; somente `athena-twitter-publication-worker` foi iniciado. Heartbeat `live` confirmado; demais quatro workers X permaneceram parados.
- Controle de agenda: o worker não claimou antes de 2026-08-22T20:05:00Z. Chamada externa começou 20:05:02Z e terminou 20:05:06Z.
- Resultado: item `published`, uma tentativa, HTTP 201, provider code `published`, post ID persistido. Não houve retry.
- Financeiro: wallet passou de 12.000.000/15.000 reservados para 11.985.000/0; ledger possui exatamente um grant +12.000.000 e um débito -15.000 na categoria `post_dm_create`; reserva e hold `settled`, 15.000 liquidados, zero liberados.
- Logs: dois eventos imutáveis, `external_started` e `published`, com custo estimado/liquidado de 15.000 no terminal. Zero itens `ready`, `claimed`, `retry` ou `outcome_unknown` após o gate.
- Custo evitado: não foi feita leitura Zernio do post após publicação, pois custaria 5.000 micros adicionais; a evidência de resposta 201/post ID/ledger é suficiente para este gate.
- Kill switch: worker parado imediatamente; VPS shared env restaurado para `false`/`shadow` e permissão 600; seis processos preexistentes continuam online. Production segura redeployada em `dpl_619TNoqFWYVMDYxj33dc9BfcWBoG`; Preview permaneceu off.
- Smoke final: login 200, heartbeat POST sem segredo 401. Logs PM2 do worker sem erros.
- Status: primeiro passo da ordem canário `completed`; Fase 6 continua `in_progress`.
- Próxima ação segura: preparar uma imagem de teste no bucket isolado, review/confirm de exatamente um item e reserva de 15.000 micros com live off; só depois abrir nova janela.

## X-0027 — canário de uma imagem preparado com execução desligada

- UTC: 2026-08-22T20:09:48Z; São Paulo: 2026-08-22T17:09:48-03:00.
- Ferramentas guardadas: commit `8287c299cd18187550eca17cb2c435459671c734`; TypeScript e diff check aprovados.
- Asset: `6b844cdc-9285-4c9d-aef1-b5403cb794e6`, bucket `twitter-media`, PNG 1200×675, 33.019 bytes, hash `6c4b088351e0f0b7488941a7a2ae82b71d8905f61083cbad2e05e2067bbc8122`; URL assinada testada sem documentá-la.
- Programa/item: `d309ee0e-1a86-4df5-a840-49edec50ba32` / `66542b07-7e55-47f8-aaca-0075b98171db`; execução 20:19:00Z; um conjunto `images`, posição 0, item `ready`, tentativa 0.
- Financeiro: carteira contábil 11.985.000 micros, reserva aberta 15.000, versão 4; custo é `post_dm_create`, não há URL.
- Segurança: Production continua `false`/`shadow`, cinco workers X parados e nenhuma chamada externa desta etapa.
- Próxima ação segura: preflight do item e assinatura; janela live Production; iniciar somente publication worker; parar/restaurar off após resultado.

## X-0028 — canário de uma imagem publicado e liquidado

- UTC: 2026-08-22T20:20:59Z; São Paulo: 2026-08-22T17:20:59-03:00.
- Janela live: `dpl_5e6qVF8evL346tnovFVZXcaypGPE`; somente publication worker online. Claim ocorreu depois do horário, chamada 20:19:05Z–20:19:10Z.
- Resultado: uma tentativa, HTTP 201, provider `published`, post ID persistido; nenhum retry/erro.
- Mídia: item manteve o media set; asset PNG isolado já havia passado leitura assinada e associação posição 0.
- Financeiro: wallet 11.970.000/0; reserva e hold 15.000 `settled`; ledger grant + dois débitos de -15.000, sem duplicidade.
- Logs: `external_started` e `published`, custo estimado/liquidado 15.000; zero itens não terminais.
- Kill switch: worker parado; VPS `false`/`shadow` modo 600; Production segura `dpl_ESxPGApRWS7ssj9j796PGCMZUabG`; demais workers X parados e seis processos existentes online.
- Status: passo uma imagem `completed`; próximo é conjunto com 2–4 imagens.
- Próxima ação segura: gerar segundo asset, confirmar um set de duas imagens e auditar antes de live.

## X-0029 — conjunto com duas imagens preparado

- UTC: 2026-08-22T20:22:00Z; São Paulo: 2026-08-22T17:22:00-03:00.
- Segundo asset: `bf7678c6-6e5b-4a10-8860-75de6642afe2`, PNG 1200×675, 32.587 bytes, SHA-256 `439012493da8b046b30a11671c01cab0b155d4c8358f29006e87187f8e4751bb`, leitura assinada aprovada.
- Programa/item: `fd765ce3-ce69-451c-9423-62479414f545` / `25a8be0e-10ea-4937-9d7f-031dbfcfee2f`, execução 20:31Z, `ready`, zero tentativas.
- Associação: set `images`; primeiro asset posição 0 e segundo posição 1.
- Financeiro: 11.970.000 contábil, 15.000 reservado, versão 6; categoria sem URL.
- Segurança: live off, workers X parados, nenhuma chamada externa neste checkpoint.
- Próxima ação segura: janela live controlada e monitorada somente para este item.

## X-0030 — canário com duas imagens publicado e liquidado

- UTC: 2026-08-22T20:32:57Z; São Paulo: 2026-08-22T17:32:57-03:00.
- Resultado: item `published`, uma tentativa, HTTP 201, post ID persistido; duas posições do set preservadas.
- Financeiro: wallet 11.955.000/0, versão 7; grant + três débitos únicos de -15.000; reserva/hold settled e zero liberado.
- Operação: logs `external_started`/`published`; zero itens não terminais; worker parado, VPS false/shadow e Production segura `dpl_58q7bZmjMqCBrqDS9kFWc4UkZYrz`.
- Próxima ação segura: criar/validar GIF pequeno e confirmar um único item com live off.

## X-0031 — GIF preparado com execução desligada

- UTC: 2026-08-22T20:34:27Z; São Paulo: 2026-08-22T17:34:27-03:00.
- Gerador guardado em `7ed2862`; GIF `7dea1898-89e8-4222-9183-3a3a38c7fdaa`, 640×360, 2s, 316.445 bytes, hash `8025a9a8a5de9e094513c314eef1d7cb38d8d7f2c09ac2d85dbf3ee036ddfccb`, signed read ok.
- Programa/item `cd71cc46-ec4b-4209-86b3-436ee2ebf44a` / `582c0a4f-7c65-4921-893b-661867ac518b`, execução 20:44Z, ready/0 attempts.
- Financeiro: 11.955.000 contábil, 15.000 reservado, versão 8. Live off e workers X parados.
- Próxima ação segura: janela live controlada para o GIF.

## X-0032 — GIF publicado e liquidado

- UTC: 2026-08-22T20:45:59Z; São Paulo: 2026-08-22T17:45:59-03:00.
- Resultado: GIF `published`, uma tentativa, HTTP 201, post ID persistido; sem retry.
- Financeiro: wallet 11.940.000/0, versão 9; grant + quatro débitos exatos de -15.000; reserva/hold settled.
- Operação: zero não terminais; worker parado; flags false/shadow e Production segura `dpl_C1N6yohwYnJb96XmSi5D5KEviBQs`.
- Próxima ação segura: gerar e validar MP4 pequeno; confirmar um item com live off.

## X-0033 — vídeo preparado com execução desligada

- UTC: 2026-08-22T20:46:40Z; São Paulo: 2026-08-22T17:46:40-03:00.
- Asset `3648930e-a2d1-4535-b248-6d7b3f9cccaf`: MP4 640×360, 2s, 116.645 bytes, SHA-256 `19bd78345e308eef3f807acf5a2ce8d49d2e67ba0dbd36d839f552e6229e8992`, signed read ok.
- Programa/item `466ff096-82f1-4dd2-a75d-11c124bae815` / `93358c36-99ee-44d0-90c3-807dd6c9d71e`, execução 20:56Z, ready/0 attempts.
- Financeiro: 11.940.000 contábil, 15.000 reservado, versão 10. Live off e workers X parados.
- Próxima ação segura: janela live controlada do vídeo.

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

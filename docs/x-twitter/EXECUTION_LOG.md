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

# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-22T17:14:12Z / 2026-08-22T14:14:12-03:00
- Fase: 0 — baseline e congelamento
- Status: `completed`
- Branch: `codex/pre-x-baseline-analytics`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Commit do checkpoint validado: `41fd0c2414a46672210487e0dcee25ecc17aed82`
- Feature flag X: ainda não criada/ativada
- Mutação remota feita pelo módulo X: nenhuma

## Leitura obrigatória para continuar

1. `plans/plano-modulo-x-twitter-zernio.md`
2. `docs/x-twitter/STATE.json`
3. `docs/x-twitter/DECISIONS.md`
4. último registro de `docs/x-twitter/EXECUTION_LOG.md`
5. arquivo da fase atual em `docs/x-twitter/phases/`
6. `docs/x-twitter/RUNBOOK.md` antes de qualquer operação remota

## Baseline conhecido

- Worktree Analytics preexistente ainda não consolidado, incluindo migrações 210–222.
- Migrações local/remoto alinhadas até 222.
- Testes: 137/137 aprovados antes da criação desta documentação.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Registrar esta atualização documental e abrir `codex/x-twitter-module`. Iniciar a Fase 1 por schemas/testes locais, sem aplicar migration, deploy ou restart remoto até o próximo gate.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–222: elas já constam no remoto.
- Não iniciar tabelas/migrations X antes do commit do gate 0.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.

# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-22T17:39:53Z / 2026-08-22T14:39:53-03:00
- Fase: 2 — Zernio, identidades e perfis
- Status: `in_progress`
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Commit do checkpoint validado: `2393c2e8bd5b70aa1651cce196ed06785cb4d1bb`
- Feature flag X: criada e desligada
- Mutação remota feita pelo módulo X: migrations aditivas 223–225; migration 226 ainda somente local

## Leitura obrigatória para continuar

1. `plans/plano-modulo-x-twitter-zernio.md`
2. `docs/x-twitter/STATE.json`
3. `docs/x-twitter/DECISIONS.md`
4. último registro de `docs/x-twitter/EXECUTION_LOG.md`
5. arquivo da fase atual em `docs/x-twitter/phases/`
6. `docs/x-twitter/RUNBOOK.md` antes de qualquer operação remota

## Baseline conhecido

- Worktree Analytics preexistente foi consolidado no checkpoint `41fd0c2`.
- Migrações local/remoto alinhadas até 225; 226 aguarda aplicação controlada.
- Testes atuais: 152/152 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Criar o commit local da Fase 2, confirmar o projeto Supabase e aplicar somente a migration 226; em seguida executar o teste SQL 226 dentro de transação com rollback.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–222: elas já constam no remoto.
- Não chamar uma API key Zernio real enquanto o módulo estiver desligado e sem ação explícita de admin.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.

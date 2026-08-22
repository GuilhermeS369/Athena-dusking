# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-22T18:54:36Z / 2026-08-22T15:54:36-03:00
- Fase atual: 8 — preparação de rollout (`blocked`)
- Status: `blocked`
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Commit do checkpoint validado: `3f3821171839a4a16443cc61929703166aceeabd`
- Feature flag X: criada e desligada
- Mutação remota feita pelo módulo X: migrations aditivas 223–240

## Leitura obrigatória para continuar

1. `plans/plano-modulo-x-twitter-zernio.md`
2. `docs/x-twitter/STATE.json`
3. `docs/x-twitter/DECISIONS.md`
4. último registro de `docs/x-twitter/EXECUTION_LOG.md`
5. arquivo da fase atual em `docs/x-twitter/phases/`
6. `docs/x-twitter/RUNBOOK.md` antes de qualquer operação remota

## Baseline conhecido

- Worktree Analytics preexistente foi consolidado no checkpoint `41fd0c2`.
- Migrações local/remoto alinhadas até 240.
- Testes atuais: 163/163 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Escolher a organização canário e cadastrar nela uma API key Zernio dedicada ao X. Preview, produção e workers já estão preparados, mas desligados. Não iniciar canário com credencial Instagram.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–222: elas já constam no remoto.
- Não chamar uma API key Zernio real enquanto o módulo estiver desligado e sem ação explícita de admin.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.

## Ambientes preparados

- Vercel: código em produção com flags X desligadas; deployment `dpl_Akd9xnWZxrfeZpz9XpvsA5JgZgAR`.
- VPS: cinco processos X instalados e `stopped`; seis processos existentes continuam `online`.
- Supabase: migrations 223–240 alinhadas; último one-shot deixou zero claims e zero operações financeiras.

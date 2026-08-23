# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-23T01:16:47Z / 2026-08-22T22:16:47-03:00
- Fase atual: 8 — preparação de rollout (`in_progress`), sem liberação geral
- Status: controle auditado das capabilities Zernio implementado; Analytics/Inbox continuam off e o gate HTTP 200 permanece pendente
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint de aplicação implantado: `7c83ece`; controle Athena das capabilities Zernio adicionado, todos os flags/processos X off.
- Feature flag X: criada e desligada
- Mutação remota feita pelo módulo X: migrations aditivas 223–244

## Leitura obrigatória para continuar

1. `plans/plano-modulo-x-twitter-zernio.md`
2. `docs/x-twitter/STATE.json`
3. `docs/x-twitter/DECISIONS.md`
4. último registro de `docs/x-twitter/EXECUTION_LOG.md`
5. arquivo da fase atual em `docs/x-twitter/phases/`
6. `docs/x-twitter/RUNBOOK.md` antes de qualquer operação remota
7. `docs/x-twitter/REQUIREMENTS_MATRIX.md` para o mapa final de concluído/bloqueado

## Baseline conhecido

- Worktree Analytics preexistente foi consolidado no checkpoint `41fd0c2`.
- Migrações local/remoto alinhadas até 244.
- Testes atuais: 204/204 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Projetar e documentar o canário financeiro da capability antes de ativá-la: janela curta, baseline/final de uso e compensação para `false`. Não repetir recursos 202 anteriores nem habilitar rollout/fallback.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–242: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir `GET /v1/analytics` para o item incerto nem liberar/liquidar seu hold por suposição.

## Ambientes preparados

- Vercel: Production `dpl_9zixyzBTcpjTjiG2RyeoyQDxipvL` (`https://pomodoro-8roycj5ks-shoows-projects-2caaf9e9.vercel.app`) `READY`, alias oficial; Preview `dpl_5DbmP76T7jqiBXFtbU9h5d9fuMhq` (`https://pomodoro-88ow92ms3-shoows-projects-2caaf9e9.vercel.app`) `READY`. O novo gate está explicitamente `false` nos dois ambientes.
- VPS: release `7c83ece-20260823T011500Z`, hash `e71415e4f39d4056e5eacc7fd3a9bae6f501d3e8a31168616e4141ee9b7bf10a`; quatro processos X apontam para ele e estão `stopped`; seis processos existentes continuam `online` com os PIDs preservados.
- Supabase: migrations 223–244 alinhadas; teste 244 10/10 com rollback; conexão Analytics/Inbox off, zero evento de capability, filas/holds/snapshots zerados e wallet 11.725.000/0 versão 21.

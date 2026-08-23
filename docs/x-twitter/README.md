# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-23T11:30:08Z / 2026-08-23T08:30:08-03:00
- Fase atual: 8 — preparação do rollout progressivo (`in_progress`); gate visual/CSS e gate transacional do contrato fan-out concluídos; sem liberação geral
- Status: migration 246 aplicada e pgTAP 29/29 com rollback aprovado. Analytics/Inbox e workers continuam off; aplicação/worker atualizados e canário controlado ainda não foram implantados/executados.
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint Git executável mais recente: `9200b4e`; Preview `dpl_8aB1TheK2kW1noy9HJfAAGB7jozx` e Production `dpl_oQRbJB2QkTw33G2s69VTucJpgK5D`, ambos `READY`. O escopo global e todos os workers/fallback continuam off; somente Pomodoro permanece canário.
- Feature flag X: criada e desligada
- Mutação remota feita pelo módulo X: migrations aditivas 223–246

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
- Migrações local/remoto alinhadas até 246.
- Testes atuais: 213/213 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Versionar o ajuste tenant-scoped do teste, criar Preview com flags off e depois Production off. Atualizar somente o release dos quatro workers X, mantendo-os parados; nenhum canário pago antes do checkpoint pós-deploy.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–246: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir os três requests Analytics HTTP 202. As 27 reads tardias já foram debitadas coletivamente uma vez; não repetir a reconciliação financeira.

## Ambientes preparados

- Vercel: Production `dpl_oQRbJB2QkTw33G2s69VTucJpgK5D` (`https://pomodoro-k1s5wb6rs-shoows-projects-2caaf9e9.vercel.app`) `READY`, alias oficial; Preview `dpl_8aB1TheK2kW1noy9HJfAAGB7jozx` (`https://pomodoro-9i1lwi0se-shoows-projects-2caaf9e9.vercel.app`) `READY`. Flags globais, workers, Analytics e fallback permanecem off.
- VPS: release `7c83ece-20260823T011500Z`, hash `e71415e4f39d4056e5eacc7fd3a9bae6f501d3e8a31168616e4141ee9b7bf10a`; quatro processos X apontam para ele e estão `stopped`; seis processos existentes continuam `online` com os PIDs preservados.
- Supabase: migrations 223–245 alinhadas; conexão Analytics/Inbox off, filas/holds/snapshots zerados e wallet 11.590.000/0 versão 24. As 27 reads tardias foram reconciliadas por evento imutável; o canário reservou/liberou 6.590.000 sem débito.

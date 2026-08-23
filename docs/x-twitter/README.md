# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-23T11:45:21Z / 2026-08-23T08:45:21-03:00
- Fase atual: 8 — preparação do rollout progressivo (`in_progress`); gate visual/CSS e gate transacional do contrato fan-out concluídos; sem liberação geral
- Status: migration 246, aplicação e release VPS do contrato fan-out implantados com tudo desligado. Executor guardado e auditoria read-only do novo canário aprovados; nenhuma reserva criada. Analytics/Inbox e os quatro workers X continuam off.
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint Git executável mais recente: `d67a2ec`; Preview `dpl_7nHd2NqnixMUCHq51d2czH3Fkiqc` e Production `dpl_sZ28EuSUeQXRy8f3sJdyrmFbooch`, ambos `READY`. O escopo global e todos os workers/fallback continuam off; somente Pomodoro permanece canário.
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

Criar uma Production temporária habilitando somente Analytics e seu worker para Pomodoro. Reconfirmar baseline de 27 reads, reservar exatamente 45.000 micros com `prepare-fanout-analytics-canary.ts`, executar um único one-shot VPS e restaurar imediatamente o deployment seguro. Não repetir o executor de reserva.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–246: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir os três requests Analytics HTTP 202. As 27 reads tardias já foram debitadas coletivamente uma vez; não repetir a reconciliação financeira.

## Ambientes preparados

- Vercel: Production `dpl_sZ28EuSUeQXRy8f3sJdyrmFbooch` (`https://pomodoro-9tf7p5e5o-shoows-projects-2caaf9e9.vercel.app`) `READY`, alias oficial; Preview `dpl_7nHd2NqnixMUCHq51d2czH3Fkiqc` (`https://pomodoro-jrsivz8sl-shoows-projects-2caaf9e9.vercel.app`) `READY`. Flags globais, workers, Analytics e fallback permanecem off. O segredo de bypass da proteção foi rotacionado durante o smoke e nenhum valor foi documentado.
- VPS: release `d67a2ec-20260823T113709Z`, hash `be77ef65f7369cd6da5def3d844e23f0cfa4ebcbfbceb7ab6b3ee3ae3008a24e`; quatro processos X apontam para ele e estão `stopped`; seis processos existentes continuam `online` com os PIDs preservados. Rollback: `7c83ece-20260823T011500Z`.
- Supabase: migrations 223–246 alinhadas; conexão Analytics/Inbox off, publicação/Analytics não terminais, reservas abertas e holds ativos/incertos zerados; wallet 11.590.000/0 versão 24. As 27 reads tardias foram reconciliadas por evento imutável; o canário de capability reservou/liberou 6.590.000 sem débito.

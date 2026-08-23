# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-23T01:08:10Z / 2026-08-22T22:08:10-03:00
- Fase atual: 8 — preparação de rollout (`in_progress`), sem liberação geral
- Status: controle auditado das capabilities Zernio implementado; Analytics/Inbox continuam off e o gate HTTP 200 permanece pendente
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint de aplicação implantado: `4cb7502`; navegação/papéis e contrato financeiro/conteúdo endurecidos, todos os flags/processos X off.
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

Criar o checkpoint Git da unidade 244 e implantar aplicação/worker com todos os gates e processos X desligados. Só depois preparar um canário controlado da capability; não repetir recursos 202 anteriores nem habilitar rollout/fallback.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–242: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir `GET /v1/analytics` para o item incerto nem liberar/liquidar seu hold por suposição.

## Ambientes preparados

- Vercel: segredos por função configurados separadamente; Production `dpl_Cvbbi7kWV7w32ct71frjGR3SfRSj` (`https://pomodoro-olajyhsul-shoows-projects-2caaf9e9.vercel.app`) `READY`, alias oficial, todos os flags mutáveis off. Preview `dpl_2stTwHisyFgd6GfNFvCMihRJqZYs` (`https://pomodoro-kvoyqfj6r-shoows-projects-2caaf9e9.vercel.app`) `READY`.
- VPS: release `e732fed77971-20260823T000341Z`, hash `c0834c2fda517056cb1e31a9a0e9d44c2c8b382b57d673df7c489b396014a4a8`; quatro processos X apontam para ele e estão `stopped`; nomes genérico/`generation` removidos; seis processos existentes continuam `online` com os PIDs preservados.
- Supabase: migrations 223–243 alinhadas; teste 243 13/13 com rollback; zero evento de transferência real ou job residual; três HTTP 202 reconciliados sem cobrança; wallet 11.725.000/0 versão 21, zero snapshot, zero débito analytics e zero holds abertos.

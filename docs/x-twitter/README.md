# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-23T02:05:29Z / 2026-08-22T23:05:29-03:00
- Fase atual: 8 — gate visual/CSS (`in_progress`), com inspeção estrutural local aprovada e smoke autenticado ainda pendente; sem liberação geral
- Status: controle auditado das capabilities aprovado em canário mínimo; Analytics/Inbox estão off. Gate HTTP 200 e proteção contra fan-out de reads permanecem pendentes.
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint Git mais recente: `07be9b1`; gate CSS estrutural no Preview `dpl_62c6NFsmkGL5JQ9HTHsHkwLd8nV8`. Production continua no checkpoint anterior `7c83ece`, todos os flags/processos X off.
- Feature flag X: criada e desligada
- Mutação remota feita pelo módulo X: migrations aditivas 223–245

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
- Migrações local/remoto alinhadas até 245.
- Testes atuais: 210/210 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Versionar o gate CSS local e executar um smoke visual autenticado das páginas `/x/*` em Preview, ainda com todas as flags mutáveis off. Não repetir os três recursos 202; antes de novo teste pago, o quote/confirm precisa cobrir fan-out do provedor.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–245: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir os três requests Analytics HTTP 202. As 27 reads tardias já foram debitadas coletivamente uma vez; não repetir a reconciliação financeira.

## Ambientes preparados

- Vercel: Production `dpl_9zixyzBTcpjTjiG2RyeoyQDxipvL` (`https://pomodoro-8roycj5ks-shoows-projects-2caaf9e9.vercel.app`) `READY`, alias oficial; Preview CSS `dpl_62c6NFsmkGL5JQ9HTHsHkwLd8nV8` (`https://pomodoro-a3mqrgn09-shoows-projects-2caaf9e9.vercel.app`) `READY`. O gate de capability continua explicitamente `false` nos dois ambientes.
- VPS: release `7c83ece-20260823T011500Z`, hash `e71415e4f39d4056e5eacc7fd3a9bae6f501d3e8a31168616e4141ee9b7bf10a`; quatro processos X apontam para ele e estão `stopped`; seis processos existentes continuam `online` com os PIDs preservados.
- Supabase: migrations 223–245 alinhadas; conexão Analytics/Inbox off, filas/holds/snapshots zerados e wallet 11.590.000/0 versão 24. As 27 reads tardias foram reconciliadas por evento imutável; o canário reservou/liberou 6.590.000 sem débito.

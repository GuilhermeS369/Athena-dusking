# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-22T22:38:32Z / 2026-08-22T19:38:32-03:00
- Fase atual: 8 — preparação de rollout (`in_progress`), sem liberação geral
- Status: analytics bloqueada no HTTP 202 da Zernio; fallback shadow e observabilidade read-only aprovados, todas as flags mutáveis off
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint de código atual: `f3b6ab1` (health read-only guardado); enforcement progressivo validado aguardando o commit deste checkpoint
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
- Testes atuais: 178/178 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Executar a auditoria final de requisitos e manter o rollout congelado. Quando a Zernio disponibilizar analytics HTTP 200, seguir `ROLLOUT_CHECKLIST.md`; não adicionar cron, habilitar fallback live ou liberar organizações antes disso.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–222: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir `GET /v1/analytics` para o item incerto nem liberar/liquidar seu hold por suposição.

## Ambientes preparados

- Vercel: organização canário Pomodoro configurada em Production; Preview com canários/flags off `dpl_8UNUQJQFawiknFu8wAZBBxd9nJ7F` e Production segura inalterada `dpl_7T2ctsRQFrSrDqSLBCuYtqSqXY6y`, ambos `READY`. Última janela live analytics: `dpl_8pkhNuc5hcPhcGQ7EsaWSMAHLuC5`.
- VPS: release `46e09cc-20260822T213610Z`; cinco processos X instalados e `stopped`; seis processos existentes continuam `online`.
- Supabase: migrations 223–240 alinhadas; três HTTP 202 reconciliados sem cobrança; wallet 11.725.000/0 versão 21, zero snapshot, zero débito analytics e zero holds abertos.

# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-22T21:47:32Z / 2026-08-22T18:47:32-03:00
- Fase atual: 7 — análises manuais (`in_progress`)
- Status: leitura mínima retornou HTTP 202; primeiro snapshot de billing não mostra `posts_read`; hold de 5.000 aguarda uma reconfirmação sem nova leitura X
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint de código atual: `46e09cc`
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
- Testes atuais: 168/168 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Após tempo de propagação, repetir somente o auditor guardado de `GET /v1/usage`. Se `posts_read` continuar ausente e as seis criações conhecidas permanecerem exatas, resolver o item como falha não cobrada com justificativa e evidência auditadas. Não usar uma nova leitura paga como reconciliação.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–222: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir `GET /v1/analytics` para o item incerto nem liberar/liquidar seu hold por suposição.

## Ambientes preparados

- Vercel: organização canário Pomodoro configurada; Preview `dpl_4QkYfwXxWeYu4TY7EixwfVJUFrJf` e Production segura `dpl_93z3VLkymZUoukP2w1hsK2ZeaWXC`, ambos `READY`. Última janela live analytics: `dpl_D9Kk5XtsWPZEcsqmjiAehuJt5GSF`.
- VPS: release `46e09cc-20260822T213610Z`; cinco processos X instalados e `stopped`; seis processos existentes continuam `online`.
- Supabase: migrations 223–240 alinhadas; analytics canário está `outcome_unknown`, com uma tentativa HTTP 202, reserva aberta de 5.000, zero snapshot e zero débito.

# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-22T21:37:58Z / 2026-08-22T18:37:58-03:00
- Fase atual: 7 — análises manuais (`in_progress`)
- Status: quote mínimo de analytics aprovado sem mutação; reserva/confirmação pendente
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint de código atual: `31fb1d2`
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
- Testes atuais: 165/165 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Executar o modo guardado `reserve-one-post-read`, confirmar exatamente 5.000 micros reservados, zero tentativas/snapshots e saldo contábil inalterado. Manter analytics e worker desligados até o novo checkpoint.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–222: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.

## Ambientes preparados

- Vercel: organização canário Pomodoro configurada; Preview `dpl_4QkYfwXxWeYu4TY7EixwfVJUFrJf` e Production segura `dpl_Dcrsn7Ty4dQnRTgcM8kCyyXTD2DF`, ambos `READY`. Última janela live: `dpl_EVTyHgmzvvKNPERB6M6Zz8BRmBUM`.
- VPS: release `46e09cc-20260822T213610Z`; cinco processos X instalados e `stopped`; seis processos existentes continuam `online`.
- Supabase: migrations 223–240 alinhadas; último one-shot deixou zero claims e zero operações financeiras.

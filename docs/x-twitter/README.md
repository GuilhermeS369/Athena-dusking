# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-22T19:40:21Z / 2026-08-22T16:40:21-03:00
- Fase atual: 6 — canário de publicação (`in_progress`)
- Status: credencial, carteira e perfil canário prontos; nenhuma publicação executada
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint de código atual: `50469d4e87eed009c13c9e4bde5e1176cac7014c`
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
- Testes atuais: 164/164 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Implantar o checkpoint atual mantendo publicação e analytics desligados, executar smoke e então criar um único canário de texto sem URL pelo fluxo review/confirm. Conferir a reserva de 15.000 micros antes de ligar somente o worker Twitter de publicação em live para esse item.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–222: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.

## Ambientes preparados

- Vercel: organização canário Pomodoro configurada; Preview `dpl_FtikYGRpuBhe6NvQZbL4WzwmNerf` e Production `dpl_EU8TNTWAWLGKy8GWbJUtSqZjFTPH`, ambos `READY`. Flags globais de módulo/publicação/analytics continuam desligadas.
- VPS: cinco processos X instalados e `stopped`; seis processos existentes continuam `online`.
- Supabase: migrations 223–240 alinhadas; último one-shot deixou zero claims e zero operações financeiras.

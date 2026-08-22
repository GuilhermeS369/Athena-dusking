# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-22T23:46:22Z / 2026-08-22T20:46:22-03:00
- Fase atual: 8 — preparação de rollout (`in_progress`), sem liberação geral
- Status: analytics bloqueada no HTTP 202 da Zernio; fallback shadow e observabilidade read-only aprovados, todas as flags mutáveis off
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint de código remoto atual: `dc99775` (segredos e kill switches independentes); fila local de sync parte de `b2a6789`
- Feature flag X: criada e desligada
- Mutação remota feita pelo módulo X: migrations aditivas 223–241

## Leitura obrigatória para continuar

1. `plans/plano-modulo-x-twitter-zernio.md`
2. `docs/x-twitter/STATE.json`
3. `docs/x-twitter/DECISIONS.md`
4. último registro de `docs/x-twitter/EXECUTION_LOG.md`
5. arquivo da fase atual em `docs/x-twitter/phases/`
6. `docs/x-twitter/RUNBOOK.md` antes de qualquer operação remota

## Baseline conhecido

- Worktree Analytics preexistente foi consolidado no checkpoint `41fd0c2`.
- Migrações local/remoto alinhadas até 241.
- Testes atuais: 193/193 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Criar o checkpoint Git da fila dedicada de sync; depois dry-run e aplicação isolada da migration 242, teste SQL transacional e one-shot com flag off. O worker de geração continua pendente de decisão explícita. Não ativar sync live, cron, fallback live ou rollout antes dos respectivos gates.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–222: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir `GET /v1/analytics` para o item incerto nem liberar/liquidar seu hold por suposição.

## Ambientes preparados

- Vercel: sete segredos por função configurados separadamente; Production `dpl_soJv1T88XQ2iCmLFtW1fzw4jQLZu` `READY`, alias oficial, todos os flags mutáveis off e segredo genérico legado removido. Preview final `dpl_95mw9RpuRp7aZ1gX1CSS1SUYfDiH` `READY`.
- VPS: release `dc997750ddc2-20260822T231419Z`, hash `4bb116e2660be97c6d7f440363196da4b4313bb6e38c74bf5184375dd09b3f57`; cinco processos X apontam para ele e estão `stopped`; segredo genérico removido; seis processos existentes continuam `online` com os PIDs preservados.
- Supabase: migrations 223–241 alinhadas; teste 241 5/5 com rollback; três HTTP 202 reconciliados sem cobrança; wallet 11.725.000/0 versão 21, zero snapshot, zero débito analytics e zero holds abertos.

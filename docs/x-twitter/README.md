# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-23T00:08:57Z / 2026-08-22T21:08:57-03:00
- Fase atual: 8 — preparação de rollout (`in_progress`), sem liberação geral
- Status: analytics bloqueada no HTTP 202 da Zernio; fallback shadow e observabilidade read-only aprovados, todas as flags mutáveis off
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint implantado: `e732fed`; fila dedicada de sync e topologia de quatro workers incluídas, todos os flags/processos X off.
- Feature flag X: criada e desligada
- Mutação remota feita pelo módulo X: migrations aditivas 223–242

## Leitura obrigatória para continuar

1. `plans/plano-modulo-x-twitter-zernio.md`
2. `docs/x-twitter/STATE.json`
3. `docs/x-twitter/DECISIONS.md`
4. último registro de `docs/x-twitter/EXECUTION_LOG.md`
5. arquivo da fase atual em `docs/x-twitter/phases/`
6. `docs/x-twitter/RUNBOOK.md` antes de qualquer operação remota

## Baseline conhecido

- Worktree Analytics preexistente foi consolidado no checkpoint `41fd0c2`.
- Migrações local/remoto alinhadas até 242.
- Testes atuais: 194/194 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Continuar a auditoria requisito por requisito pelas lacunas de UI/API ainda não encerradas, começando por ações granulares da fila e transferência administrativa de identidade. Não ativar sync live, cron, fallback live ou rollout antes dos respectivos gates.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–242: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir `GET /v1/analytics` para o item incerto nem liberar/liquidar seu hold por suposição.

## Ambientes preparados

- Vercel: segredos por função configurados separadamente; Production `dpl_BYjrGwDcg9WtPy4nV1CWwvZ9kKGv` `READY`, alias oficial, todos os flags mutáveis off e nomes genérico/`generation` removidos. Preview `dpl_FF72a8zwrhaJFDNfm9ord3ac5X27` `READY`.
- VPS: release `e732fed77971-20260823T000341Z`, hash `c0834c2fda517056cb1e31a9a0e9d44c2c8b382b57d673df7c489b396014a4a8`; quatro processos X apontam para ele e estão `stopped`; nomes genérico/`generation` removidos; seis processos existentes continuam `online` com os PIDs preservados.
- Supabase: migrations 223–242 alinhadas; teste 242 17/17 com rollback; zero sync jobs residuais; três HTTP 202 reconciliados sem cobrança; wallet 11.725.000/0 versão 21, zero snapshot, zero débito analytics e zero holds abertos.

# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-24T11:56:41Z / 2026-08-24T08:56:41-03:00
- Fase atual: 8 — rollout global (`completed`)
- Status: módulo X e Agenda V2 disponíveis para todas as organizações. A nova administração `/x/zernio` está implantada em Production: cadastro em massa, saldo inicial e limite configuráveis, proteção contra duplicidade, ocupação e layout em paridade com Instagram sem compartilhar suas estruturas.
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint Git executável mais recente: `b1daa6e`; Preview `dpl_Eagu2NV2XeXaQU7E1v1BNM5Z7Fq3` e Production `dpl_2gbJBD4x4jwS5pJVPEtD6VjW7ikQ`, ambos `READY`. Alias oficial aponta para Production.
- Feature flags X: módulo global e Agenda V2 ativas; fallback e `TWITTER_ZERNIO_ANALYTICS_SYNC_ENABLED` desligados
- Mutação remota feita pelo módulo X: migrations aditivas 223–253

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
- Migrações local/remoto alinhadas até 254.
- Testes atuais: 249/249 aprovados; testes administrativos focados posteriores também aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Usuários podem cadastrar listas de chaves em `/x/zernio`, escolhendo saldo inicial e limite antes do envio. Antes de qualquer mudança futura, consultar o health X. Em cada conexão nova, executar `audit-first-send-readiness.ts` após o sync, após confirmar o primeiro programa e após o primeiro estado terminal.

## Proibições imediatas

- Não rodar `git reset --hard`, checkout destrutivo ou limpeza recursiva.
- Não reaplicar migrações 210–253: elas já constam no remoto.
- Não repetir o provisionamento apenas para conferir estado nem expor a chave fornecida no chat; ela já foi persistida cifrada.
- Não criar um segundo profile Zernio: o único profile existente foi confirmado como exclusivamente Twitter.
- Não publicar secrets ou conteúdo de `.env*`.
- Não reiniciar processos PM2 do Instagram.
- Não repetir os três requests Analytics HTTP 202. As 27 reads tardias já foram debitadas coletivamente uma vez; não repetir a reconciliação financeira.

## Ambientes preparados

- Vercel: Production `dpl_4ujKYUfURyvwrc2K92g2SY9JYDXW` (`https://pomodoro-iiffbxesu-shoows-projects-2caaf9e9.vercel.app`) `READY`, alias oficial; Preview `dpl_9gfsDZ5TqGB2aRQyVS3i3JHi1t3T` (`https://pomodoro-oprfxstfu-shoows-projects-2caaf9e9.vercel.app`) `READY`. Módulo/Agenda V2/publicação/sync/Analytics manual/reconcile ativos; fallback e polling Analytics off. Rollback imediato do app: `dpl_XFakKdYn6RmFWYPoMJ2VvK9ny3EU`.
- VPS: release atual `fcd21a3-20260823T171308Z`; worker de publicação hash `41567cea37e801d5b180bf803d423c4f7ab7ac3030ee8930cc7e005526c6078a`; publicação usa a release nova e os outros três papéis preservam a release compatível `d67a2ec-20260823T113709Z`. Quatro processos X ativos em `live`, zero restart inesperado; seis processos existentes continuam `online` com os PIDs preservados.
- Supabase: migrations 223–253 alinhadas; testes SQL 247/248/249 aprovados em transação; conexão Analytics/Inbox off, publicação/Analytics não terminais, reservas abertas e holds ativos/incertos zerados; wallet 11.590.000/0 versão 26.

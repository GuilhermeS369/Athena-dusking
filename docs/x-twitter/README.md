# Módulo X/Twitter — ponto de continuidade

## Estado atual

- Atualizado em: 2026-08-24T12:49:00Z / 2026-08-24T09:49:00-03:00
- Fase atual: 8 — rollout global (`completed`)
- Status: módulo X e Agenda V2 disponíveis para todas as organizações. `/x/zernio` usa a composição compacta de `/zernio`, máscara monetária em centavos, ocupação confirmada local/remota e reservas OAuth com expiração visível e liberação manual.
- Branch: `codex/x-twitter-module`
- Commit inicial: `1caa0f2e5cb0773982f41cfcddb9bcdf9a45d9cb`
- Checkpoint Git executável mais recente: `ae8263e`; Preview `dpl_1bdFDYr9xTYKSkJPFAzHDacnp9xo` e Production `dpl_GrJgg9gdno45YFQFKUioYfNhZ1yH`, ambos `READY`. Alias oficial aponta para Production.
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
- Migrações local/remoto alinhadas até 255.
- Testes atuais: 251/251 aprovados.
- `npx tsc --noEmit`: aprovado.
- `npm run build`: aprovado com warnings preexistentes de metadata.
- Supabase CLI, Vercel CLI e SSH da VPS: autenticados e operacionais.
- Workers atuais do Instagram: seis processos online no PM2 durante o preflight.
- `.gitignore` possuía globs inválidos; a sintaxe foi corrigida sem excluir artefatos.

## Próxima ação segura

Usuários podem cadastrar listas de chaves em `/x/zernio`, escolhendo saldo inicial e limite antes do envio. Antes de qualquer mudança futura, consultar o health X. Em cada conexão nova, executar `audit-first-send-readiness.ts` após o sync, após confirmar o primeiro programa e após o primeiro estado terminal.

## X-0106 — paridade compacta do Zernio X

- Código `076f2b9`; Preview `dpl_2xXVxKY9XVVuJNUrZnjGYykTdHDF`; Production `dpl_81WuidWazEQ8cLgES1fdhHqJh1SH`, todos aprovados e `READY`.
- A tela agora replica a composição real do Instagram: três métricas com números de 34 px, um único formulário compacto de saldo/limite, editor pareado e um único strip por conexão.
- O grid X usa `auto-fill`: uma conexão não se estica pela tela e muitas conexões ocupam colunas compactas. QA em 1440 px e 390 px confirmou ausência de overflow horizontal.
- “Transferir identidade e saldo” foi removido da interface e as consultas exclusivas dessa função deixaram de rodar na página. RPC/rota/auditoria permanecem preservadas para eventual uso futuro.
- Produção autenticada confirmou 1 API, 1 perfil e US$ 16,20 disponível. O saldo, grant, ledger, filas, workers, Supabase e PM2 não foram alterados.
- Regressão `/zernio` Instagram aprovada em Production. Validação: 250/250 testes, TypeScript, build e `git diff --check`.

## X-0107 — capacidade, expiração OAuth e máscara monetária

- Código `ae8263e`; Preview `dpl_1bdFDYr9xTYKSkJPFAzHDacnp9xo`; Production `dpl_GrJgg9gdno45YFQFKUioYfNhZ1yH`, todos `READY`.
- A ocupação deixa de exibir `—/2` quando o snapshot remoto ainda não existe: usa o maior valor confirmado entre inventário remoto e perfis locais, somando apenas reservas OAuth ainda válidas.
- Reservas OAuth duram 15 minutos. A interface mostra o horário de expiração, remove a contagem automaticamente e oferece `Liberar agora`; a liberação manual é administrativa, tenant-scoped e auditável no próprio attempt.
- `Excluir API e perfis` faz soft-delete dos perfis X no Athena, cancela fila futura e libera reservas elegíveis. Posts, logs, ledger e histórico permanecem; nenhuma conta é desconectada remotamente no painel Zernio.
- O saldo inicial aplica máscara de centavos durante a digitação (`1750` → `17,50`). Métricas, cabeçalho e defaults receberam espaçamento/altura X-específicos; Instagram não foi alterado.
- QA Production autenticado: US$ 16,20 preservado, ocupação confirmada 1/2, máscara aprovada, zero overflow, modal destrutivo desabilitado sem confirmação e `/zernio` Instagram íntegro. Após 09:48:46, a reserva caiu de 1 para 0, o card mudou de 2/2 para 1/2 e `Conectar conta X` foi reabilitado sem mutação manual. Validação: 251/251 testes, TypeScript, build e `git diff --check`.
- Nenhuma migration, chamada Zernio, sincronização, exclusão, reserva financeira, ledger, flag, VPS ou PM2 mudou. Rollback: promover `dpl_81WuidWazEQ8cLgES1fdhHqJh1SH`.

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

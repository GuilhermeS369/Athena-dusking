# Runbook operacional — módulo X/Twitter

Este arquivo documenta procedimentos, nunca credenciais. Valores secretos devem ser obtidos dos ambientes já configurados.

## Preflight local

```powershell
git status --short
git branch --show-current
git rev-parse HEAD
git diff --check
npm test
npx tsc --noEmit
npm run build
```

Se branch/commit divergirem de `STATE.json`, registrar drift antes de qualquer mutação.

## Supabase

Projeto esperado: ref `hqwhumdumfmixxbvneae`.

```powershell
Get-Content supabase/.temp/project-ref
npx supabase migration list --linked
```

Antes de push, confirmar projeto e executar dry-run quando a versão do CLI suportar. Migrações são aditivas. Nunca apagar uma migração já remota; corrigir para frente.

Quando Docker/`pg_prove` não estiver disponível, executar um teste SQL transacional diretamente pela Management API:

```powershell
npx supabase db query --linked --file supabase/tests/<teste>.test.sql
```

O arquivo deve começar com `BEGIN`, terminar com `ROLLBACK` e a ausência de resíduos deve ser verificada depois.

## Vercel

Projeto esperado: `pomodoro`; validar `.vercel/project.json` antes do deploy. Criar preview, executar smoke tests e promover somente após gate. Registrar deployment ID/URL/status sem incluir tokens.

## VPS

- Acesso usa chave dedicada já instalada e `BatchMode=yes`.
- Host key deve permanecer validado; não usar `StrictHostKeyChecking=no`.
- Hostname esperado: `srv1881733`.
- Runtime dos workers: Node 22.

Antes de deploy, registrar `pm2 status`, disco, memória, release e hashes. Releases X devem ser extraídos em diretório novo e validado; reiniciar somente processos `athena-twitter-*`. Nunca executar exclusão recursiva sobre caminho não resolvido.

Processos planejados:

- `athena-twitter-publication-worker`
- `athena-twitter-generation-worker`
- `athena-twitter-zernio-sync-worker`
- `athena-twitter-analytics-worker`
- `athena-twitter-webhook-reconcile-worker`

## Ordem segura de deploy

1. migration aditiva;
2. Vercel preview e produção com flag X desligada;
3. worker X em dry-run;
4. shadow;
5. canário;
6. rollout.

### Fallback Vercel do X

- Endpoint exclusivo: `/api/internal/twitter-fallback-dispatch`.
- Manter `TWITTER_FALLBACK_ENABLED=false` e `TWITTER_FALLBACK_LIVE_ENABLED=false` fora de uma janela aprovada.
- Shadow exige `TWITTER_FALLBACK_ENABLED=true`, `TWITTER_PUBLICATION_WORKER_ENABLED=true` e `TWITTER_PUBLICATION_MODE=shadow`.
- Live exige adicionalmente `TWITTER_FALLBACK_LIVE_ENABLED=true`; nunca ativar antes dos gates de analytics, heartbeat stale e shadow.
- `TWITTER_FALLBACK_STALE_SECONDS` deve ficar entre 30 e 900; padrão 120.
- Antes de invocar: verificar heartbeat primário, circuit breaker, itens ready e holds.
- Depois: conferir claimed, attempts, ledger/holds, heartbeat `athena-twitter-vercel-fallback` e restaurar flags.
- Não adicionar o endpoint ao cron da Vercel antes do shadow e do gate final.

## Rollback

- desligar flags X;
- parar somente `athena-twitter-*`;
- reverter aplicação para deployment/release anterior documentado;
- preservar tabelas e ledger;
- usar migration corretiva aditiva se necessário;
- verificar imediatamente PM2/heartbeats do Instagram.

## Secrets e evidências

- Documentar nomes de variáveis, nunca valores.
- Sanitizar API keys, Authorization, cookies, payloads, captions e URLs assinadas.
- Evidência bruta fica em `artifacts/x-twitter/<timestamp>/`, ignorada pelo Git; documentação guarda apenas resumo, caminho e hash.

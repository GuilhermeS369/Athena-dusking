# Fase 01 — fundação modular e financeira

Status: `completed`

Entregas: flags, navegação, schemas `twitter_*`, RLS, bucket, rate card, carteira, grant, reservas e ledger. Gate: invariantes financeiras e cross-tenant aprovadas sem chamadas Zernio.

Início: 2026-08-22T17:14:58Z. Migration prevista: `223`, após confirmação do alinhamento até `222`. Mutação remota permanece proibida até os testes locais e revisão do SQL.

## Checkpoint local — 2026-08-22T17:23:14Z

- Migration `223_twitter_module_financial_foundation.sql` criada e confirmada como única pendente pelo dry-run.
- Chaves secretas separadas dos metadados de conexão.
- Ledger, grants, eventos e rates históricos protegidos contra update/delete.
- RPCs: concessão global, snapshot, reserva versionada, liquidação, liberação, unknown outcome e transferência de suporte.
- Bucket `twitter-media` e políticas independentes preparados.
- Navegação expansível preparada atrás da feature flag por organização.
- Testes Node: 149/149 aprovados, incluindo 12 novos.
- TypeScript e build aprovados.
- `git diff --check` aprovado.
- SQL test 223 criado com concessão, cross-tenant, viewer, replay, settle, unknown e devolução idempotente.
- Mutação remota: nenhuma até este checkpoint.

Próximo gate: commit local, push exclusivo da migration 223 e teste transacional 223 no projeto vinculado.

## Checkpoint remoto — 2026-08-22T17:24:24Z

- Migration 223 aplicada com sucesso no projeto esperado.
- `supabase test db --linked` não executou porque o runner exige Docker, ausente localmente; nenhuma afirmação de pgTAP aprovado foi feita.
- `supabase db lint --linked` encontrou dois erros novos do X: `CASE` inferido como `text` para os enums de evento e status.
- Também mostrou dois erros preexistentes fora do X em `rollback_legacy_waiting_randomization` e `enqueue_zernio_organization_sync_batch`; não serão misturados nesta correção.
- Próxima ação: migration forward-only 224 com casts explícitos; não editar a migration 223 já aplicada.

## Gate final — 2026-08-22T17:28:57Z

- Migrations remotas: 223, 224 e 225 alinhadas.
- Lint: os dois erros Twitter foram eliminados; permanecem somente duas ambiguidades preexistentes fora do módulo.
- Teste transacional executado com `supabase db query --linked --file`: 19/19 verificações chegaram ao resultado final `ok 19`; o arquivo terminou em `ROLLBACK`.
- Estado após teste: zero identidades, wallets, grants, ledger e reservas de teste.
- ACL: `anon=false` em todas as sete RPCs Twitter; funções de settle/unknown/transfer também têm `authenticated=false`; service role mantém acesso.

Auditoria final em 23/08/2026 UTC: a transferência original de suporte não possuía idempotency key. A migration 243 introduziu a RPC v2, evento com autor estável e chave única, replay sem nova versão/evento, administração obrigatória na origem e destino e revogação da RPC antiga para `service_role`. A UI exige confirmação textual, conexão removida e reservas resolvidas; não move filas ou grupos. Admins relacionados veem os últimos eventos imutáveis. Aplicação remota exclusiva aprovada; teste SQL 13/13 em `BEGIN/ROLLBACK`; zero resíduo/evento real; wallet 11.725.000/0 versão 21 e filas/holds zero.
- Rate card remoto: versão 1 ativa com 5.000, 10.000, 15.000 e 200.000 micros.
- Node: 149/149; TypeScript/build aprovados.
- Flags X e analytics: desligadas.
- Vercel/VPS: nenhuma mudança.

Gate aprovado. Próxima fase: conexão Zernio, identidade e perfis.

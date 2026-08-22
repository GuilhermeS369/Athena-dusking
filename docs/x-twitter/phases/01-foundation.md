# Fase 01 — fundação modular e financeira

Status: `in_progress`

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

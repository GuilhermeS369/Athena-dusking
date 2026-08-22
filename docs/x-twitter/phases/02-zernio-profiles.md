# Fase 02 — Zernio, identidades e perfis

Status: `in_progress`

Entregas: auth/verify, identidade global, conexões, health/capabilities, perfis e épocas. Gate: sincronização X isolada e analytics/inbox desligados.

Início: 2026-08-22T17:30:50Z. A documentação oficial foi reconferida: OAuth usa `GET /v1/connect/twitter`, health aceita filtros `platform=twitter` e `profileId`, `/v1/auth/verify` retorna `userId`, e capabilities X são opt-in. Nenhuma chamada real será feita sem API key cadastrada por um admin.

## Implementação local validada em 22/08/2026

- Migration 226 cria perfis estáveis, épocas, tentativas OAuth e eventos sem FK operacional para Instagram.
- Credenciais ficam em `twitter_connection_secrets`; a troca de chave reutiliza identidade/carteira e não recria grant.
- Cliente `lib/twitter/zernio-client.ts` usa somente endpoints X necessários e não consulta billing para definir saldo Athena.
- Rotas públicas usam `/api/x/*`, exigem a feature flag e verificam papel organizacional.
- `/x/zernio` e `/x/perfis` estão implementadas e invisíveis enquanto a flag estiver desligada.
- Username nunca participa da prova de identidade; o fallback é o ID da conta Zernio.
- `analytics=false` e `inbox=false` são enviados explicitamente e continuam restritos no banco.
- Testes: 152/152 Node, TypeScript, build e `git diff --check` aprovados.
- Build: somente os warnings de metadata já presentes no baseline.
- Supabase dry-run: enviaria exclusivamente `226_twitter_zernio_profiles_and_epochs.sql`.
- Ainda não realizado: push da migration, teste SQL remoto transacional, chamada Zernio real, deploy Vercel ou alteração na VPS.
- Rollback: flags permanecem desligadas; antes do remoto, reverter apenas o commit local. Após aplicação, correções de schema serão forward-only.
- Próxima ação segura: commit local e aplicação isolada da migration 226.

## Checkpoint remoto

- Migration 226 aplicada isoladamente ao projeto `hqwhumdumfmixxbvneae`.
- Teste SQL: 23 verificações aprovadas em transação encerrada por rollback.
- Pós-teste: zero identidades, carteiras, perfis, épocas, attempts e eventos residuais.
- ACL: upsert de credencial, sync, fechamento de inventário e soft-delete negados para `anon`/`authenticated` e permitidos a `service_role`.
- Lint: nenhum erro Twitter; permanecem duas ambiguidades legadas fora do escopo.
- Gate de implementação: aprovado.
- Gate vivo: pendente de credencial Zernio X dedicada inserida por admin. Não é seguro reutilizar chave do Instagram nem extrair secrets para antecipar o teste.
- Continuidade autorizada: Fase 3 pode ser implementada atrás da flag desligada; nenhuma liberação/canário pode ignorar o gate vivo.

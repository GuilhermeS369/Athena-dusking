# Fase 03 — galeria, grupos e agenda

Status: `in_progress`

Entregas: bucket `twitter-media`, uploads retomáveis, assets, grupos, perfis, agenda e páginas responsivas. Gate: isolamento de Storage e organização aprovado.

Início: 2026-08-22T17:41:53Z. A implementação seguirá atrás da feature flag desligada. O gate vivo da Fase 2 continua pendente e não será tratado como aprovação de rollout.

## Validação local

- Migration 227: `twitter_media_assets`, `twitter_groups`, `twitter_group_members` e RPC de troca atômica de membros.
- Upload TUS retomável em blocos de 6 MB diretamente ao bucket `twitter-media`; vídeo de até 512 MB não atravessa a memória do Next.js.
- Reserva e conclusão do asset são APIs `/api/x/media`; conclusão confere presença e tamanho no Storage.
- Páginas `/x/galeria`, `/x/grupos` e `/x/agenda` isoladas e protegidas pela flag.
- Grupos aceitam apenas `twitter_profiles` da mesma organização.
- Testes: 153/153 Node, TypeScript e build aprovados; warnings de metadata permanecem os do baseline.
- Supabase dry-run: somente migration 227.
- Ainda não realizado: push 227, teste SQL remoto, upload real, deploy Vercel ou alteração na VPS.
- Rollback: flags desligadas; antes do push, reverter o commit local; depois do push, correção forward-only.

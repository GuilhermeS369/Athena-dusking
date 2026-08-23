# Fase 03 — galeria, grupos e agenda

Status: `completed`

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

## Gate remoto

- Migration 227 aplicada isoladamente.
- Teste SQL: 14/14 aprovado em transação revertida.
- Pós-teste: zero assets, grupos ou membros residuais.
- RLS entre organizações, path do bucket, MIME/kind e membership cruzado validados.
- RPC de membership: somente service role.
- Lint sem erros X; dois erros legados permanecem fora do escopo.
- Gate aprovado. Upload real permanece parte do smoke/canário, sem bloquear a implementação local da fase seguinte.

## Auditoria final da Agenda

Em 23/08/2026 UTC, a lista simples foi substituída por filtros locais de perfil, status e janela, com programa, custo, tentativas, retry e horário `America/Sao_Paulo`. Cancelamento individual reutiliza `/api/x/queue/cancel`, exige motivo e mantém `outcome_unknown` em hold até Logs/reconciliação. Limite visual de 500 itens; somente `twitter_publication_items`/`twitter_profiles`; zero endpoint externo. Gate local: 198/198 testes, TypeScript, build e diff check; nenhuma mutação remota.

## Detalhe local de Perfis

Em 23/08/2026 UTC, `/x/perfis/[profileId]` passou a apresentar ID imutável, tier/capacidades, health e conexão atual, épocas de conexão, grupos atuais, 50 itens recentes e até 50 snapshots armazenados. Tudo é scoped pela organização e lê somente tabelas `twitter_*`; snapshots não são atualizados ao abrir. A lista ganhou links para detalhe e perfil público X. Gate local: 199/199 testes, TypeScript, build e diff check; nenhum endpoint Zernio/X ou tabela Instagram.

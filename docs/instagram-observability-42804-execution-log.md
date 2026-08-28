# Registro de execução — correção 42804 da observabilidade Instagram

## Estado geral

- Início: 2026-08-27T10:07:27-03:00
- Encerramento: 2026-08-27T10:17:56-03:00
- Estado: `CONCLUÍDA`
- Fase atual: 6 — concluída
- Regra inviolável: não reenfileirar nem repostar publicações atingidas.

## Fase 1 — inventário e salvaguarda

### Estado inicial do repositório

- Worktree já continha muitas alterações rastreadas e arquivos novos não relacionados.
- Nenhuma alteração preexistente foi descartada, revertida ou sobrescrita.
- Não foi encontrado `AGENTS.md` no workspace.

### Estado das migrations

- A primeira inspeção anterior indicava produção até a migration 284.
- Em 2026-08-27T10:07:27-03:00, `supabase migration list --linked` confirmou a migration 285 aplicada remotamente.
- A migration 285 local é `285_fix_zernio_terminal_disconnection_cleanup.sql` e substitui a projeção de desconexão por uma versão com enums tipados e exceção best-effort.
- A migration 285 também cria rotinas de contenção/remoção de perfis Zernio; nenhuma dessas rotinas será chamada por esta correção.

### Inventário protegido em 2026-08-27T10:07:59-03:00

- Eventos `42804`: 189.
- Itens distintos: 189.
- Organizações: 2.
- Perfis: 24.
- Lotes: 16.
- Formatos: 170 Reels e 19 Stories.
- Primeiro evento: 2026-08-26T15:34:04.724389-03:00.
- Último evento: 2026-08-27T10:01:31.617614-03:00.
- Estado atual: 187 `ignored` e 2 `failed`.
- Tentativas atuais: 187 com `attempt_count = 0` e 2 com `attempt_count = 1`.
- `creation_id`: zero itens.
- `published_at`: zero itens.
- `next_attempt_at`: zero itens.
- Erro atual: 187 itens contidos com `zernio_account_disconnected`; 2 preservam `42804`.

### Incidentes agregados

- `6e3c22c8-a8f3-47d4-8d0f-4cff416609af`: 76 ocorrências, 13 perfis, `action_required`.
- `e15502af-d4d1-4b39-97d9-3d7edf236cab`: 113 ocorrências, 11 perfis, `action_required`.

### Decisão de salvaguarda

- Os 189 IDs formam o conjunto protegido desta execução.
- Não executar retry, requeue, recuperação de slot, regeneração ou alteração de agenda sobre esse conjunto.
- Qualquer aparecimento de `creation_id`, `published_at` ou `next_attempt_at` interrompe o rollout.

### Comandos de diagnóstico executados

- `git status --short`
- `supabase migration list --linked`
- Consultas REST somente leitura em `instagram_observability_events`, `instagram_observability_incidents` e `publication_items`.

### Resultado da fase

- Estado: `CONCLUÍDA`
- Conclusão: conjunto protegido identificado e sem possibilidade atual de repostagem.
- Próxima fase: corrigir e endurecer todas as projeções que ainda não são best-effort.

## Fase 2 — correção do banco

### Alteração implementada

- Criada `286_harden_instagram_observability_best_effort.sql`.
- A migration substitui quatro projeções:
  - `project_publication_item_event_to_instagram_observability`;
  - `project_zernio_sync_log_to_instagram_observability`;
  - `project_zernio_disconnection_to_instagram_observability`;
  - `project_zernio_request_anomaly_to_instagram_observability`.
- Todos os domínios, severidades e tratamentos calculados passaram a usar tipos enum explícitos.
- Todo o trabalho de projeção foi colocado dentro de blocos `EXCEPTION WHEN OTHERS` que emitem `WARNING` e retornam `NEW`.
- A semântica anterior de agrupamento, sanitização e resolução de entidades foi preservada.
- Privilégios das funções continuam restritos e `service_role` mantém execução.

### Salvaguarda de publicações

- A migration 286 não contém `UPDATE public.publication_items`.
- A migration não chama funções de retry, claim, defer, recuperação ou regeneração.
- Nenhum dos 189 itens protegidos foi alterado nesta fase.

### Validação estática inicial

- `supabase db push --linked --dry-run` identificou somente a migration 286 como pendente.
- O dry-run não aplicou alterações remotas.
- Busca estática confirmou quatro blocos best-effort e casts explícitos para os três enums.

### Resultado da fase

- Estado: `CONCLUÍDA`
- Conclusão: correção aditiva pronta para testes, sem mutação de publicações.
- Próxima fase: criar e executar regressões estáticas e transacionais.

## Fase 3 — testes de regressão

### Testes adicionados

- `lib/instagram-observability-best-effort.test.ts`:
  - verifica as quatro substituições de função;
  - exige `EXCEPTION WHEN OTHERS` e `RETURN NEW` em cada projeção;
  - exige casts explícitos dos enums;
  - impede `UPDATE publication_items`, alteração de tentativas, criação ou próximo retry.
- `supabase/tests/286_harden_instagram_observability_best_effort.test.sql`:
  - inspeciona as definições realmente instaladas;
  - força uma falha de constraint na tabela de observabilidade;
  - comprova que a linha autoritativa do trigger permanece inserida;
  - comprova que nenhum evento parcial é preservado.

### Execução local

- Comando: `node --test lib/instagram-observability-best-effort.test.ts lib/operation-page-resilience.test.ts`.
- Resultado: 5 testes aprovados, zero falhas.
- `git diff --check` nos arquivos da correção: aprovado.
- O aviso `MODULE_TYPELESS_PACKAGE_JSON` já decorre da configuração atual do projeto e não representa falha.

### Lint remoto anterior ao deploy

- `supabase db lint --linked --schema public --level warning` executado.
- Nenhum problema apontou para as funções da migration 286, que ainda não estavam instaladas.
- Problemas preexistentes registrados, sem expansão de escopo:
  - ambiguidade em `rollback_legacy_waiting_randomization`;
  - atribuição duplicada em `twitter_record_connection_dispatch_signal`;
  - ambiguidade em `enqueue_zernio_organization_sync_batch`;
  - volatilidade declarada nos sanitizadores;
  - referência temporária analisada estaticamente em `rebuild_zernio_request_observability` da migration 285;
  - avisos auxiliares de parâmetros/variáveis não utilizados.

### Resultado da fase

- Estado: `CONCLUÍDA`
- Conclusão: testes de origem aprovados; teste SQL transacional preparado para execução após instalação da 286.

## Fase 4 — validação pré-deploy

### Revalidação em 2026-08-27T10:12:22-03:00

- Eventos e itens protegidos: 189.
- Última ocorrência: 2026-08-27T10:01:31.617614-03:00.
- Estados: 187 `ignored`, 2 `failed`.
- Tentativas: 187 com zero, 2 com uma.
- `creation_id`: zero.
- `published_at`: zero.
- `next_attempt_at`: zero.
- Nenhuma mudança desde o inventário inicial desta execução.

### Migration pendente

- Local 286 presente; remoto 286 ausente.
- Dry-run confirmou que somente `286_harden_instagram_observability_best_effort.sql` será aplicada.

### Resultado da fase

- Estado: `CONCLUÍDA`
- Conclusão: rollout liberado; condições de interrupção não foram acionadas.

## Fase 5 — deploy e smoke checks

### Deploy

- Comando: `supabase db push --linked`.
- Migration aplicada: `286_harden_instagram_observability_best_effort.sql`.
- Resultado: aplicação concluída sem erro.
- `supabase migration list --linked` confirmou local 286 = remoto 286.

### Evolução do teste SQL conectado

1. Primeira execução bloqueada antes dos fixtures: o papel do teste não tinha acesso ao pgTAP no schema `extensions`.
2. Segunda execução confirmou a inspeção das funções, mas parou antes dos fixtures por falta de acesso ao schema `auth`.
3. Terceira tentativa eliminou dependências de `auth`, mas mostrou que o trigger precisava executar sob `service_role`.
4. Versão final usa TAP textual, `SET LOCAL ROLE service_role`, tabela temporária e transação com rollback.

Nenhuma das três tentativas incompletas persistiu fixtures ou alterou publicações.

### Smoke test transacional final

- Comando: `supabase db test supabase/tests/286_harden_instagram_observability_best_effort.test.sql --linked`.
- Resultado: 3/3 aprovados.
- Cenário de falha deliberada produziu somente o `WARNING` esperado e preservou a origem autoritativa.
- Cenário normal persistiu `error` e `action_required` com os tipos enum corretos.
- Toda a execução foi revertida por `ROLLBACK`.

### Verificação pós-deploy em 2026-08-27T10:15:56-03:00

- Migration 286 confirmada remotamente.
- Eventos protegidos: 189, sem crescimento.
- Última ocorrência continuou em 2026-08-27T10:01:31.617614-03:00.
- Estados e tentativas permaneceram idênticos.
- Zero `creation_id`, `published_at` e `next_attempt_at`.

### Resultado da fase

- Estado: `CONCLUÍDA`
- Conclusão: migration aplicada e validada sem reenfileirar publicações.

## Fase 6 — monitoramento e encerramento

### Monitoramento dos workers

- Janela observada a partir de 2026-08-27T10:14:00-03:00.
- Ciclos completos: 23.
- Ciclos falhos: zero.
- Eventos autoritativos de publicação observados: 521.
- Distribuição: 53 `published`, 63 `processing_deferred`, 405 `ignored`.
- Novos erros `42804`: zero.
- O critério de dois ciclos completos foi superado sem regressão.

### Encerramento dos incidentes

- Os dois incidentes `42804` foram marcados como `resolved`.
- Justificativa: migration 286 aplicada, enums tipados e projeções isoladas como best-effort, sem recorrência após 23 ciclos.
- `fix_reference`: `supabase/migrations/286_harden_instagram_observability_best_effort.sql`.
- Duas ações de auditoria foram inseridas com `actor_email = system:codex-approved-remediation`.
- Todos os 189 eventos históricos foram preservados.

### Verificação final em 2026-08-27T10:17:56-03:00

- Itens protegidos: 189.
- Estados: 187 `ignored`, 2 `failed`.
- Tentativas: 187 com zero, 2 com uma.
- `creation_id`: zero.
- `published_at`: zero.
- `next_attempt_at`: zero.
- Incidentes resolvidos: 2/2.
- Ações de resolução auditadas: 2/2.
- Testes locais finais: 5/5.
- Testes SQL conectados finais: 3/3.
- Lint das quatro projeções da migration 286: sem ocorrências.
- `git diff --check`: aprovado.

### Resultado da fase

- Estado: `CONCLUÍDA`
- Conclusão: erro corrigido, incidentes encerrados e nenhuma publicação afetada foi repostada ou tornada elegível para retry.

## Resumo para retomada

- Não há trabalho pendente para a correção `42804`.
- Não executar recuperação sobre os 189 itens históricos.
- Problemas preexistentes listados no lint permanecem fora do escopo desta correção.
- Os cinco arquivos novos desta execução permanecem não rastreados no Git e prontos para revisão/commit pelo fluxo normal do projeto.

## Marco visual posterior — 2026-08-27T10:41:16.784095-03:00

- Solicitação: ocultar os logs históricos relacionados à publicação e observar somente eventos posteriores ao marco.
- Estratégia: limpeza visual reversível, sem exclusão física dos 189 eventos de auditoria.
- Escopo alterado: somente `publication`; demais áreas de logs foram preservadas.
- Organizações atualizadas: 2/2.
- Usuários administradores atualizados: 2/2.
- Marco comum: 2026-08-27T10:41:16.784095-03:00.
- Eventos `42804` visíveis após o marco: zero nas duas organizações.
- Eventos novos de publicação continuam aparecendo normalmente.
- A interface permite reverter o marco por meio de “Desfazer limpeza”.

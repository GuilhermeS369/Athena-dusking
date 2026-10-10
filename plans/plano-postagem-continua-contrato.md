# Postagem contínua — contrato de implementação (09/10/2026)

Fonte única para quem escreve cada parte. Contexto e decisões do dono em
[plano-postagem-continua.md](plano-postagem-continua.md).

Migration: `supabase/migrations/443_continuous_posting.sql`. Nenhuma coluna, gatilho ou função
existente de `publication_items` é alterada. Nenhuma função do caminho quente é reemitida.

## 1. Tabelas (RLS ligada; `select` para membro da org; escrita só por RPC `security definer`)

**`continuous_posting_rules`** — uma por (grupo, formato)
`id uuid pk`, `organization_id`, `group_id → profile_groups`, `format publication_format` (só
`reel`/`story`), `unique (group_id, format)`, `enabled boolean default false`, `enabled_at`,
`enabled_by uuid`, `disabled_at`, `source_type text default 'group'` (só `'group'` hoje; `'folder'`
no futuro), `source_group_id → profile_groups`, `rotation_mode text` (`same_order`/`diversified`,
padrão `diversified`), `posts_per_day integer` (reel 1–57, padrão 24; story 1–100, padrão 1),
`window_start_minute`/`window_end_minute integer` (minutos do dia em America/Sao_Paulo; só story;
reel = null = dia inteiro), `caption text` (≤ 2.200, opcional), `rotation_seed text`,
`rest_hours integer default 4` (1–48), `paused_at`, `pause_reason`, `last_synced_at`,
`created_by`, `updated_by`, `created_at`, `updated_at`.

**`continuous_posting_profile_states`** — uma por (regra, perfil)
`rule_id`, `profile_id` (pk composta), `organization_id`, `profile_ordinal bigint`,
`cycle_position bigint default 0`, `next_post_at timestamptz not null`, `resting_until`,
`last_item_id`, `last_post_at`, timestamps. Índice em `(next_post_at)`.

**`continuous_posting_batches`** — lote do dia: `rule_id`, `day date` (BRT), `batch_id`, pk
`(rule_id, day)`.

**`continuous_posting_items`** — lateral do item (some com o item no arquivo frio):
`publication_item_id uuid pk → publication_items on delete cascade`, `organization_id`, `rule_id`,
`profile_id`, `slot_at`, `media_asset_id`, `notice_cleared_at`, `notice_cleared_by`.

**`continuous_posting_notices`** — avisos que não têm item:
`id`, `organization_id`, `rule_id`, `group_id`, `profile_id` (nulo em aviso da regra), `format`,
`kind text` (`skipped_late`, `skipped_no_media`, `skipped_slot_conflict`, `profile_rest`,
`rule_paused`), `slot_at`, `delay_seconds`, `skipped_count integer default 1`, `resting_until`,
`error_code`, `error_message`, `username_snapshot`, `group_name_snapshot`, `metadata jsonb`,
`created_at`, `cleared_at`, `cleared_by`.

## 2. A grade de horários

`continuous_posting_next_slot(...)` devolve o primeiro horário **estritamente depois** de um
instante dado, para uma regra e um perfil.

- **Reel (dia inteiro)**: intervalo = 86.400 s ÷ `posts_per_day`; fase fixa do perfil =
  `hash(rotation_seed || ':phase:' || profile_id) mod intervalo`, em segundos. Horários = início
  do dia BRT + fase + k × intervalo. A fase nunca muda, então o intervalo entre inícios é exato,
  inclusive na virada do dia.
- **Story (janela)**: intervalo = duração da janela ÷ `posts_per_day`; fase sorteada **por dia**
  (`hash(seed || ':phase:' || profile_id || ':' || dia)`), dentro de cada fatia.

## 3. RPCs

| Função | Quem | Retorno |
|---|---|---|
| `claim_continuous_posting_items(p_worker_id text, p_limit integer, p_lease_seconds integer)` | `service_role` | **a mesma `returns table` de `claim_publication_items`**: id, organization_id, batch_id, profile_id, format, status, execute_at, caption, idempotency_key, attempt_count, creation_id, lease_until |
| `upsert_continuous_posting_rule(p_group_id uuid, p_format publication_format, p_source_group_id uuid, p_rotation_mode text, p_posts_per_day integer, p_window_start_minute integer, p_window_end_minute integer, p_caption text)` | admin/operator | `jsonb` da regra (seção 4) |
| `set_continuous_posting_rule_enabled(p_rule_id uuid, p_enabled boolean)` | admin/operator | `jsonb` da regra; ao ligar aplica a guarda e levanta `P0001` com `detail` JSON `{"openItems": n, "activeHorizons": n, "eligibleMedia": n, "eligibleProfiles": n}` |
| `get_continuous_posting_rules(p_organization_id uuid)` | membro | `jsonb` array (seção 4) |
| `get_continuous_posting_notices(p_organization_id uuid, p_group_id uuid default null, p_limit integer default 200)` | membro | `jsonb` array (seção 5), só não limpos, mais recente primeiro |
| `clear_continuous_posting_notices(p_notice_ids uuid[], p_item_ids uuid[])` | admin/operator | `integer` (quantos) |

### `claim_continuous_posting_items`, passo a passo

Uma transação. Cada perfil roda num bloco `begin … exception` próprio, para que um erro pule só
aquele perfil.

1. **Candidatos**: estado com `next_post_at <= now()` e (`resting_until` nulo ou vencido), regra
   `enabled` e sem `paused_at`, grupo não apagado, perfil membro do grupo, `status = 'online'`,
   `provider = 'meta_official'`, `deleted_at is null`, app sem `api_block_until` vigente. Ordem
   `next_post_at, profile_id`, `limit p_limit`, `for update of state skip locked`.
   Antes disso, no máximo uma vez por minuto por regra (`last_synced_at`), cria o estado dos
   perfis que entraram no grupo (`next_post_at` = próximo horário depois de agora).
2. **Descanso do erro 9**: se existe linha em `meta_profile_action_blocks` do perfil com
   `last_detected_at > now() - rest_hours` e a regra é de reel → `resting_until =
   last_detected_at + rest_hours`, `next_post_at` = próximo horário depois disso, aviso
   `profile_rest` (um por descanso, com `skipped_count`), sem item. O publicador não muda: a
   função da 438 já cancela o item que recebeu o `9` e grava essa linha.
3. **Atraso**: se `now() - next_post_at` passa da tolerância (a mesma do claim:
   `max_publication_lateness_seconds`, e `..._by_format` para story) → aviso `skipped_late` com
   `delay_seconds` e `skipped_count` = horários perdidos; `next_post_at` = próximo depois de agora.
4. **Mídia**: elegíveis da origem pela regra da 085 (pronta, não apagada, sem exclusão pedida,
   reel = vídeo, story = qualquer tipo), ordem `(created_at, id)`, N = quantidade. N = 0 → aviso
   `skipped_no_media`. Posição: `same_order` = `mod(cycle_position, N)`; `diversified` =
   `mod(bulk_rotation_v2_profile_offset(seed, profile_ordinal, N) + cycle_position *
   bulk_rotation_v2_profile_step(seed, profile_ordinal, N), N)`.
5. **Lote do dia** (`continuous_posting_batches`): cria `publication_batches` com `status =
   'processing'`, `created_by = enabled_by`, nome `Contínuo · <grupo> · <formato> · <dia>`. Se o
   lote do dia tem disjuntor pausado → `paused_at` na regra + aviso `rule_paused`, sem item.
6. **Item**: `status = 'preparing'`, `claimed_by`, `lease_until`, `attempt_count = 1`,
   `active_claim_consumed_attempt = true`, `execute_at` = o horário da grade, `preparation_status
   = 'ready'`, `prepared_at = now()`, `caption`, `idempotency_key =
   'continuous:<rule_id>:<profile_id>:<epoch do horário>'`, `on conflict do nothing`. Depois
   `publication_item_media` (posição 0), a linha lateral e o evento `queued` (metadata com
   `continuous_rule_id`, `slot_at`, `cycle_position`). `23505` do gatilho de vaga ou de horizonte
   → aviso `skipped_slot_conflict`.
7. **Avança**: `cycle_position + 1`, `next_post_at` = próximo horário depois do horário usado,
   `last_item_id`, `last_post_at`.

### Guarda de ligar

Recusa se: (a) a origem não tem mídia elegível; (b) nenhum perfil elegível; (c) algum perfil do
grupo tem item aberto do formato que não é desta regra (`waiting`, `ready`, `preparing`,
`publishing`, `suspended`, ou `failed` com retry; `archived_at is null`); (d) algum perfil tem
horizonte `active` de plano do mesmo formato com `reserved_through > now()`.

Ligar zera `paused_at`, troca o lote do dia se o anterior estava pausado e recalcula
`next_post_at` de todos. Desligar só grava `enabled = false`; o que está em voo termina.

## 4. Formato da regra (JSON, camelCase)

`{ id, groupId, groupName, format, enabled, enabledAt, sourceGroupId, sourceGroupName,
rotationMode, postsPerDay, windowStartMinute, windowEndMinute, caption, restHours, pausedAt,
pauseReason, stats: { eligibleProfiles, eligibleMedia, postedToday, inFlight, skippedToday,
failedToday, restingProfiles, nextPostAt } }` — "hoje" é o dia em America/Sao_Paulo.

## 5. Formato do aviso (JSON, camelCase)

`{ id, source: 'notice' | 'item', itemId, ruleId, groupId, groupName, profileId, username,
format, kind, slotAt, delaySeconds, skippedCount, restingUntil, errorCode, errorMessage,
createdAt }`.

Com `source = 'item'` o aviso vem de `continuous_posting_items` + `publication_items` em `failed`
terminal, `ignored` ou `cancelled`, e `kind` é `post_failed`, `post_expired`
(`publication_past_due`), `post_cancelled` ou `profile_disconnected`
(`meta_profile_disconnected`).

## 6. Publicador

Env `PUBLICATION_WORKER_CONTINUOUS_POSTING` (padrão `false`) e
`PUBLICATION_WORKER_CONTINUOUS_CLAIM_LIMIT` (padrão 10). Com a chave ligada, nos dois pontos em
que `dispatchPublicationQueueDirect` chama `claim_publication_items`, chama antes
`claim_continuous_posting_items` com `min(vagas, limite)` e passa ao claim comum só as vagas que
sobraram. Falha do claim contínuo **não derruba o ciclo**: loga com código e segue para o claim
comum. `fasesMs` ganha `claimContinuo`; o log do ciclo ganha `continuo: { reivindicados }`.

## 7. Painel

Env da Vercel `CONTINUOUS_POSTING_ORG_IDS` (vazio = ninguém, `*` = todas). Rotas:

- `GET /api/groups/continuous-posting` — regras da organização ativa;
- `PUT /api/groups/[groupId]/continuous-posting` — configurar (`{format, sourceGroupId,
  rotationMode, postsPerDay, windowStartMinute, windowEndMinute, caption}`);
- `POST /api/groups/[groupId]/continuous-posting/toggle` — `{format, enabled}`;
- `GET` / `POST /api/groups/continuous-posting/notices` — listar / limpar.

Componente próprio `app/grupos/continuous-posting-panel.tsx`, montado na tela de Grupos.

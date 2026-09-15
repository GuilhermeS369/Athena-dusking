# Fila de publicação — DOCUMENTO MESTRE

**Leia este arquivo antes de tocar em qualquer coisa que envolva postagem.** Ele é o único
lugar onde a gestão da fila está inteira: peças, ciclo de vida, regras, tetos, gatilhos,
erros tratados e não tratados, a lógica que derruba perfil, ações manuais, scripts perigosos,
procedimentos e onde olhar primeiro. Toda mudança na fila **atualiza este arquivo no mesmo
commit** (seção 13). Se algo aqui contradiz o código, o código está certo e este arquivo está
atrasado: corrija-o.

Mantido desde 07/09/2026, a partir de uma varredura completa de `app/`, `lib/`, `scripts/`,
`supabase/migrations/`, da VPS e da Vercel. Complementa, e não substitui, o
[mapa de controles](fila-de-publicacao-mapa-de-controles.md) (incidentes e experimentos, com
os números) e o [runbook da VPS](vps-worker-runbook.md) (acesso e deploy).

---

## 0. As três regras antes de qualquer ação

1. **Veja qual é o erro antes de mexer na lógica.** Erro tem código, origem e dono. Um
   código da Meta (190, 9004, 24) não se corrige no banco; um `57014` não se corrige na
   Meta; um `40001` de lease não se corrige subindo worker. A seção 6 diz de quem é cada um.
2. **Meça antes de agir, e meça no lugar certo.** Vazão é `provider_creation_started_at`,
   não `published_at`. Erro de banco é `pg_stat_database.xact_rollback`, não o log do
   worker. `pg_stat_statements` **não conta chamada que falhou**. A seção 9 lista onde olhar
   por sintoma, com as consultas prontas.
3. **Nenhuma decisão que descarte ou republique publicação é tomada sozinha.** É
   apresentada ao dono com opções. Item vencido fica vencido. Perfil em checkpoint é
   descartado. Nunca se mexe em horário de agendamento para aliviar carga.

---

## 1. As peças

### 1.1 Processos na VPS (`root@179.198.110.201`, `/opt/athena-worker`, PM2 7, Node 22)

| Processo PM2 | Script (`npm run`) | O que faz por ciclo | Deve estar |
|---|---|---|---|
| `athena-publication-worker` (id `athena-vps-publication-1`) | `worker:publication` → `publication-worker.mjs` | **três laços independentes** a cada 5 s: despacho (spool + direto), staging (spool em disco), preparação | **ligado** |
| `athena-publication-worker-2`, `-3`, `-4`, `-5` | mesmo script; env salvo no PM2 (fonte: `deploy/instagram/ecosystem.config.cjs`): `MODE=direct`, `PREPARATION_ENABLED=false`, `STAGING_ENABLED=false`, id próprio | só caminho direto | conforme a conta da seção 8.3 (2 e 3 desde 07/09; 4 desde 12/09/2026 12:22Z; **5 desde 15/09/2026 02:54Z**, pelo bloco de reels das 07:00 BRT) |
| `athena-generation-worker` | `worker:publication-generation` | `get_bulk_rotation_worker_summary` → jobs (`claim/materialize/process_publication_generation_*`) → pressão (`get_publication_generation_pressure_signal`) → lease pesado → `claim/process_bulk_rotation_generation_chunk` → heartbeat | ligado (`POLL_INTERVAL_MS=15000`) |
| `athena-queue-summary-worker` | `worker:queue-summary` | por org vencida, **serial**, `refresh_publication_queue_summary` (6,7 s cada) | ligado (`QUEUE_SUMMARY_MAX_AGE_SECONDS=300`) |
| `athena-cancellation-worker` | `worker:publication-cancellation` | a cada 10 s lê até 20 operações `running` de `publication_queue_cancellation_operations` (a parada há mais tempo primeiro) e avança **uma etapa de cada, em série** (`execute_server_publication_queue_cancellation`: fontes na 1ª chamada, depois um bloco de 1.500, ou a conclusão), orçamento 45 s por tick; ao concluir, `invalidate_publication_queue_summary` | ligado (**14/09/2026 ~19:40Z**, id 46; migration 428 aplicada e painel implantado no mesmo dia) |
| `athena-profile-analytics-worker` | `worker:profile-analytics` | POST `/api/internal/profile-analytics-refresh-dispatch` (abre as coletas fixas 09:00/15:00/21:00 hora local via `open_meta_analytics_run`) + heartbeat; **pula o sleep** enquanto `hasMore` | ligado |
| `athena-media-maintenance-worker` | `worker:media-maintenance` | POST `media-deletion-dispatch` → `clean_publication_queue_finished` por org (a cada 10 min) → `move_archived_publication_items_to_cold_storage` (a cada 60 min) → `purge_expired_publication_dispatch_reservations` | ligado |
| `athena-meta-token-renewal` | `worker:meta-token-renewal` | lê perfis Meta e renova tokens perto de vencer (60 dias; renova após 7; alarme aos 35); **roda e sai** | uma passada por dia |
| `athena-zernio-sync-worker`, `athena-profile-analytics-direct-worker` (dir `/opt/athena-worker-phase-e`, cópia antiga) | legado Zernio / fase E | **não ligar** | desligados |
| `athena-twitter-*` | apagados do PM2 em 07/09/2026 | módulo X | só com autorização do dono |

Padrões do código que **enganam num deploy limpo**: `PUBLICATION_WORKER_DRY_RUN` é **true** por
padrão (só `=false` publica); `PUBLICATION_WORKER_MODE` é `observe` (a VPS usa `direct`);
`STAGING_ENABLED` é false; `COLD_STORAGE_ENABLED` é false (VPS: true).

**Regra do env (três lugares):** o worker lê `.env.local` **antes** de `.env.worker` e a
primeira definição vence; e o PM2 guarda o env de cada processo (`pm2 save`) e ignora o
`.env.worker` para chaves que já tem. Ao trocar URL/chave do Supabase ou um teto nos
processos 2/3, troque em `.env.local`, `.env.worker` e no env salvo do PM2, e reinicie.
Depois de ligar/desligar processos, `pm2 save`: é o que volta num reboot (`pm2-root.service`).

**Receita dos processos**: `deploy/instagram/ecosystem.config.cjs` (versionado e **aplicado na VPS** em 07/09/2026; todos os processos foram recriados a partir dele e gravados com `pm2 save`; é a fonte dos envs por processo). Para recriar a VPS ou um processo: `pm2 start deploy/instagram/ecosystem.config.cjs [--only nome]` e `pm2 save`.

### 1.2 Crons

**Na Vercel** (`vercel.json`): `media-deletion-dispatch` (1 min; exclusões de mídia e de
grupo, que **removem itens da fila** via `delete_media_assets_and_remove_publication_items`),
`meta-analytics-dispatch` (5 min, orçamento 45 s, coleta contínua), `dashboard-summary-refresh`
(5 min, `refresh_dashboard_summary`), `recovery-analysis-dispatch` (diário 09:20 UTC).
**Não existe mais despachante na Vercel** (`6d65eb2`, decisão do dono): a rota
`/api/internal/publication-dispatch` foi removida. Rotas internas que ainda existem **sem
cron e sem chamador no repositório**: `publication-claims`, `publication-results` (worker
legado por HTTP), `queue-summary-refresh` (o comentário dela ainda diz "cron de minuto em
minuto", divergente), `publication-health`, `operational-health`. O modo `dispatch-endpoint`
do `publication-worker.mjs` aponta para a rota removida: **morto**.

**Cancelamento em massa não tem cron** (decisão de 14/09/2026, coerente com `810ff1d`): o motor
é o `athena-cancellation-worker` da VPS, e a tela é reserva (só avança operação sem progresso
há > 15 s). Ao concluir, a operação **invalida** `computed_at` do resumo em vez de recalculá-lo
na requisição; o `queue-summary-worker` recalcula no tick seguinte.

**Na VPS** (`crontab -l` do root; scripts em `/opt/athena-worker/bin`, fonte em
`deploy/instagram/`): manutenção de observabilidade a cada 5 min e a "diária" às 06:17
(na fonte versionada é de hora em hora, `7 * * * *`, e ambas chamam
`/api/internal/instagram-observability-maintenance`, que **para sozinha** quando a fila está
em atraso crítico, `paused: critical_publication_delay`); análise de recuperação diária
(`recovery-analysis.cron`, 09:10 UTC) chamando `recovery-analysis-dispatch` até `done`.
Os três usam `PUBLICATION_WORKER_SECRET` do `.env.worker` e a URL
`https://pomodoro-theta-one-82.vercel.app` (domínio público: `www.athenadusking.com.br`).

### 1.3 Banco (Supabase projeto `athena`, ref `iuxzrhuvcpeyxqifzbcw`, Medium desde 07/09/2026 23:36Z — XL só durante a restauração)

Tabelas da fila: `publication_items` (~1,07 mi linhas), `publication_item_media`,
`publication_batches`, `bulk_publication_plans` + `bulk_publication_plan_profiles` +
`bulk_publication_generation_chunks`, `publication_generation_jobs` (+ chunks/events),
`publication_dispatch_rate_reservations`, `publication_profile_daily_reservations`,
`publication_rate_limit_settings`, `publication_batch_circuit_breakers` +
`publication_batch_terminal_outcomes`, `publication_slot_risk_incidents`,
`publication_dispatch_sla_alerts`, `publication_queue_cancellation_operations`,
`publication_failure_acknowledgements`, `instagram_profiles`, `meta_apps`,
`meta_disconnection_incidents`, `publication_item_events` (histórico, 2,65 mi),
`publication_worker_heartbeats`, `publication_worker_cycle_events` (telemetria),
`publication_queue_summary_totals`, `dashboard_summary_totals`, `publication_items_archive`
+ `publication_item_media_archive` (arquivo frio).

**Gatilhos em `publication_items`** (7): valida organização; `updated_at`; **unicidade de
slot ativo** por (org, perfil, formato, `execute_at`) → `23505 active_publication_slot_conflict`;
valida capa de reel; **volta a preparação para `pending`** quando mudam `execute_at`,
`caption`, `profile_id`, `format` ou capa (e o mesmo em `publication_item_media`); projeta o
catálogo do perfil quando publica; zera `infrastructure_retry_count` só em avanço real (420).
Em `publication_item_events`: **disjuntor de lote** (AFTER INSERT de `published`/`failed`,
ignora falha de infraestrutura) grava `publication_batch_terminal_outcomes`; projeção de
observabilidade. Em `instagram_profiles`: AFTER UPDATE de `status`/`deleted_at` →
`suspend_offline_profile_publications`. Nenhum gatilho grava eventos a partir de
`publication_items`: os eventos vêm de `log_publication_item_event` nas RPCs. A
sincronização de status do **lote** não é gatilho: é `sync_publication_batch_status` ou
`reconcile_publication_batch_runtime` por ciclo.

**Funções do caminho quente** (todas `security definer`; a maioria exige `service_role`):

| Função (migration vigente) | Papel | Levanta |
|---|---|---|
| `claim_publication_preparation_items` (264, trava reconferida na 425) | claim da preparação: v2, sem `creation_id`, `preparation_status` ∈ pending/blocked/preparing, janela ≤ 24 h, fairness perfil→org | `22023` |
| `complete_publication_preparation` (264) | `ready` ou `blocked` (+ `next_preparation_at`) | **`40001` lease de preparação** |
| `claim_publication_dispatch_staging_items` / `activate_staged_publication_items` / `release_publication_dispatch_staging` (315) | pré-reserva itens futuros na janela; ativa quando vence; libera | `42501`, `22023` |
| `claim_publication_items` (405, trava reconferida na 425, janela por formato na 426) | claim principal: filtros de status, lease, staging, **trava de atraso**, app bloqueado, disjuntor, slot em risco; prioridade 0 para quem tem `creation_id`; gasta tentativa só sem `creation_id`; lote → `processing` | `42501`, `22023` |
| `assert_claimed_publication_profile_online` (088) | perfil online e sob lease, antes de cada chamada ao provedor | `P0002` |
| `reserve_publication_dispatch_capacity` (372) | 2 advisory locks (**por app Meta** ou balde de perfil; + por perfil); reentrância; intervalo por perfil **e formato**; reserva irmã; 24 h; minuto por (org, provedor); minuto por app. Ao barrar volta a `waiting` com `next_attempt_at` e `last_error_code` | `22023`, `P0002` |
| `reserve_publication_daily_limit` (029) | 100/24 h por perfil (legado; a checagem que vale está na reserva acima) | `22023`, `P0002` |
| `defer_publication_item` (306) | grava `creation_id`, volta a `waiting` + `next_attempt_at`; conta polls | `22023`, `P0002` |
| `complete_publication_item` (272) | terminal: `published` (+ `first_published_at` da mídia), `removed`, retry com backoff `60·2^(n-1)` + jitter, ou falha final em 5 | `22023`, `P0002` |
| `defer_publication_infrastructure_failure` (420) | recuo 30·2^min(n-1,5) + jitter, teto 900 s; devolve a tentativa; **nunca terminal** | `42501`, `22023`, `P0002` |
| `expire_late_publication_items` (405) | `ignored` + `publication_past_due` nos `waiting/ready` sem `creation_id` além do corte | `42501`, `22023` |
| `recover_missed_publication_slots` (264) | v2: **não descarta**, só abre/resolve `publication_dispatch_sla_alerts` (v1 legado descartava) | `22023` |
| `reconcile_publication_batch_runtime` (272) | por lote, `pg_try_advisory_xact_lock`; **pausa o lote com 5 falhas consecutivas** desde o último `published` | `42501`, `22023` |
| `finalize_meta_profile_disconnection` (391) | exige `190`; perfil `offline`, ignora tudo do perfil, cancela planos, abre incidente, segura a vaga do app | `42501`, `22023`, `P0002` |
| `flag_meta_app_api_blocked` (403) | exige `200` + "api access blocked/deactivated"; janela `api_block_until` (60 min); ignora itens do app; incidente | `42501`, `22023`, `P0002` |
| `suspend_offline_profile_publications` (088) | suspende itens abertos do perfil (`profile_offline_suspended`), devolve tentativa | `P0002`, `22023` |
| `contain_instagram_profile_for_removal` (362) | remoção pedida por pessoa: cancela fila, planos, horizontes; sincroniza só os lotes tocados | `42501` |
| `clean_publication_queue_finished` (335) / `archive_completed_publication_items` (083) | arquiva terminais (falha só se terminal de verdade) | `42501` |
| `move_archived_publication_items_to_cold_storage` (424) | move arquivados > 7 dias; **guarda de paridade de colunas** | `55000`, `42501` |
| `refresh_publication_queue_summary` (428) / `refresh_dashboard_summary` (422) | resumos materializados; `statement_timeout` 120 s. Desde a 428 o tom `cancelled` (sem ativo **e** cancelamento em massa concluído na janela, ou só encerradas sem publicada) e a linha do alvo cancelado fica visível pela janela do histórico mesmo zerada | `42501` |
| `invalidate_publication_queue_summary` (428) | empurra `computed_at` 1 h para trás para o worker de resumo recalcular no próximo tick; custo de uma linha | `42501` |
| `begin_publication_queue_cancellation` (428) | cria/reaproveita a operação `running` por (org, escopo, alvo), gravando `target_label` | `42501`, `22023`, `P0002` |
| `execute_server_publication_queue_cancellation` (428) | **uma etapa por chamada**: `for update skip locked` na operação (devolve `busy` se outro executor está nela); fontes primeiro (`cancel_publication_queue_scope_sources`, uma vez); bloco de 1.500 se > 1.500 canceláveis **ou** houver item em voo; com 0 canceláveis e item em voo espera (progresso 95, `waitingForInFlight`) até 30 min e então conclui com `inFlightItemsLeft`; caminho pequeno (`cancel_publication_queue_scope` + `execute_publication_queue_cancellation`) só sem nada em voo; resync dos lotes do escopo | `P0002` |
| `cancel_publication_queue_scope_chunk` (428) | 1.500 mais antigos em `waiting/ready/failed/suspended`, `archived_at is null`, `for update skip locked`; **não bloqueia** por preparing/publishing; devolve `remainingCancelableItems` e `inFlightItems` | `42501`, `22023`, `P0002` |
| `cancel_publication_queue_scope_sources` (428) | jobs de geração (cancela ou exclui perfis) e planos compactos (chunks, perfis, horizontes, plano); idempotente; sem tocar itens | `22023`, `P0002` |
| `execute_publication_queue_cancellation` (428) | passada compacta da 197 com `archived_at is null` nos dois predicados e **sem** o update de `publication_batches` da organização inteira | `42501`, `P0002`, `P0001` |
| `open_meta_analytics_run` (388) | abre a rodada do slot 09:00/15:00/21:00 (America/Sao_Paulo) | `42501` |

Índices que sustentam o claim: `publication_items_v2_dispatch_claim_idx`,
`…_unstarted_current_claim_idx`, `…_provider_accepted_claim_idx`, `…_dispatch_staging_*`,
`…_v2_preparation_claim_idx`, `…_profile_format_published_idx` /
`…_profile_format_accepted_idx` (intervalo por formato), FKs para o arquivo frio (334).
Autovacuum próprio (417): `publication_items` scale 0,02 / threshold 1000.

`publication_rate_limit_settings` (linha global + `meta_official` + `zernio`): `enabled`,
`max_provider_publications_per_minute` (meta 1.200), `max_profile_publications_per_24h` 100,
`min_seconds_between_profile_publications` 45, `…_by_format` `{"reel":1500}`,
`reservation_seconds` 300, `dispatch_lock_shards` 8, `max_publication_lateness_seconds` 300, `max_publication_lateness_seconds_by_format` `{"story": 3600}` (426).
A linha global é **invisível ao `authenticated`** (RLS só para admin da org).
`meta_apps.max_publications_per_minute` nasce **nulo** (sem cota por app).

RLS/grants em `publication_items`: `anon` nada; `authenticated` SELECT se membro, UPDATE se
admin/operator, **INSERT revogado** (toda criação passa por `queue_publication_batch` ou pelos
geradores), sem DELETE; `service_role` tudo e é o único que executa as RPCs do pipeline.

---

## 2. O ciclo de vida de um item

`publication_item_status`: `draft, validating, reserved, waiting, preparing, ready, publishing,
published, failed, ignored, cancelled, removed, suspended`.
`preparation_status`: `pending, preparing, ready, blocked, not_required`.
**Não existe `processing` em `publication_items`** (é status de lote, de job e de chunk, e
alias de tela para `preparing`+`publishing`).

```
tela/compositor ─► queue_publication_batch ─► waiting / pending        (ou job de geração se grande)
plano em massa  ─► gerador (process_bulk_rotation_generation_chunk) ─► waiting / pending
                                │  claim_publication_preparation_items (24 h antes, lease 300 s)
                                ▼
                   PREPARAÇÃO ─► waiting / ready       (valida perfil, mídia, formato; não chama Meta)
                                │  staging 600 s antes: arquivo no spool + dispatch_staged_until (660 s)
                                ▼
                   DESPACHO  ─► preparing (lease 180 s) ─► reserva de capacidade ─► sonda R2 ─► contêiner na Meta
                                │  defer_publication_item: waiting com creation_id, prioridade 0, 30 s
                                ▼  claim de novo (polling não gasta tentativa)
                   CONFIRMAR ─► FINISHED → media_publish → published
                                ERROR/EXPIRED → failed (retentável até 5) | terminal
```

Quem escreve o quê: só o **claim** muda `waiting → preparing` e gasta tentativa; só a
**reserva de capacidade** devolve para `waiting` com `next_attempt_at` (adiamento por cota,
sem gastar tentativa); só **`complete_publication_item`** grava `published/failed/removed`;
só **`expire_late_publication_items`** grava `ignored + publication_past_due`; só
**`finalize_meta_profile_disconnection`** grava `ignored + meta_profile_disconnected` (a
agenda inteira do perfil) e põe o perfil `offline`; **`suspended`** vem de perfil offline no
claim (`suspend_offline_profile_publications`) e volta por ação humana; `cancelled` é humano
(tela, item, lote ou cancelamento em massa) ou remoção de mídia/perfil; `archived_at` marca
terminal antigo e após 7 dias vai para o arquivo frio.

Mudar `execute_at`, legenda, perfil, formato ou capa **zera a preparação** (gatilho da 264).

---

## 3. Regras de negócio (não mude sem o dono)

| Regra | Onde | Valor |
|---|---|---|
| Atraso máximo: depois disso o item **não** é publicado, é encerrado | `max_publication_lateness_seconds`, migration 405 (claim + varredura); **por formato** em `max_publication_lateness_seconds_by_format` (426) | 300 s para reel e demais; **story: 1 h enquanto `attempt_count < 5`** (decisão do dono em 09/09/2026: story é 1 por perfil por dia, perder um custa o dia inteiro; ele quis limite em tentativas, não em horas). Item com `creation_id` sempre passa. Falha de conteúdo não retenta |
| Item vencido não é republicado, nem após incidente | decisão do dono, 07/09/2026 | — |
| Mínimo entre posts do mesmo perfil, por formato | `publication_rate_limit_settings`, 330 | 45 s; reel 1.500 s |
| Máximo por perfil em 24 h | mesma tabela (e `reserve_publication_daily_limit`) | 100 |
| Um item ativo por (perfil, formato, minuto) | gatilho `enforce_active_publication_slot_uniqueness` (177) | `23505` na violação |
| Data única preserva o minuto; recorrente sorteia minuto 01–09 e segundo; janela cheia pula para a próxima de 10 min | README "Regras de agendamento" | — |
| Planos em massa: intervalo mínimo 29 min; duração máxima 7 dias; perfis espalhados na janela; gerador nunca materializa slot vencido; horário a < 10 min de post do mesmo perfil+formato em outro lote é pulado e contado como ignorado | migrations 326–331, `lib/publications/bulk-rotation.ts` | — |
| Perfil em checkpoint / token inválido é descartado | seção 5 | remove e ignora a agenda |
| App da Meta com "API access blocked/deactivated" pausa 60 min | `flag_meta_app_api_blocked` (403) | itens da janela viram `ignored` |
| Lote pausa com 5 falhas consecutivas (disjuntor) | `reconcile_publication_batch_runtime` (272) | retoma pela tela ("continuar") |
| Slot perdido: em v2 só gera alerta de SLA; **não descarta nem reagenda** | `recover_missed_publication_slots` (264) | 100 por ciclo, tolerância 120 s |
| Horário de agendamento nunca é alterado para aliviar carga | decisão do dono | a chave de idempotência guarda o slot |
| Legenda ≤ 2.200; repetição 1–365 dias; sequência 1–1000 | `lib/publications/composer.ts` | — |
| Twitter/X desligado | decisão do dono, 07/09/2026 | só com autorização |

---

## 4. Tetos e botões

Valores em vigor na VPS em 07/09/2026 (padrão do código entre parênteses):

| Botão | VPS | Controla |
|---|---:|---|
| `PUBLICATION_WORKER_LIMIT` | 24 (5, teto 100) | lote do caminho direto; o limite adaptativo começa em 10 e sobe 20 % por ciclo cheio. Era 60 no XL; 24 é o valor para o pool do Medium |
| `PUBLICATION_WORKER_META_CONCURRENCY` | 20 (5, **teto 20**) | **semáforo global de chamadas à Meta por processo — o serializador de hoje.** Envolve **cada chamada HTTP** (`metaFetch` em publication-direct-dispatch.mjs), não o post inteiro: a vaga é ocupada por ~1–3 s por chamada, e o post leva ~53 s de criar a confirmar (30 s de espera fora do semáforo). Por isso ele não conta para o pool do banco |
| `PUBLICATION_WORKER_STAGED_DISPATCH_CONCURRENCY` / `_LIMIT` / `_LEASE_SECONDS` | 32 / 500 / 900 (64 / 500 / 900) | spool; era 48 no XL. É o teto que mais rende: cada vaga entrega ~1,1 post/min (53 s por post), 32 vagas ≈ 36/min só no spool |
| `PUBLICATION_WORKER_STAGED_MAX_PER_ORGANIZATION_PER_MINUTE` | 600 (180) | teto deslizante de seleção por org no spool; e no máximo 1 item por perfil+formato por lote |
| `PUBLICATION_WORKER_STAGING_LIMIT` / `_CONCURRENCY` / `_WINDOW_SECONDS` / `_LEASE_SECONDS` | 100 / 8 / 600 / 660 | staging (lease = janela + 60 s; era 1.200 e prendia item 10 min) |
| `PUBLICATION_WORKER_STAGING_DUE_GUARD_MS` / `_MAX_CONSECUTIVE_SKIPS` | 5000 / 1 | staging cede se algo vence em 5 s, no máximo 1 vez seguida |
| `PUBLICATION_WORKER_STAGING_PRESSURE_YIELD` / `_COOPERATIVE_CANCEL` | false / false | as duas guardas que travavam o spool (mapa, seção 3); não religue |
| `PUBLICATION_WORKER_STAGING_FAST_PER_ITEM_MS` / `_MAX_STABLE_MS` / `_SLOW_MS` | 1200 / 20000 / 8000 | controlador adaptativo do staging (escala de rede) |
| `PUBLICATION_WORKER_PREPARATION_LIMIT` / `_CONCURRENCY` | 40 / 3 (4 / 4) | preparação; o lote é cortado para caber no lease: `concorrência × lease ÷ 12 s × 0,6` |
| `PUBLICATION_WORKER_PREPARATION_ITEM_SECONDS` | (12) | segundos por item assumidos no corte acima |
| `PUBLICATION_WORKER_PREPARATION_DUE_GUARD_MS` / `_MAX_CONSECUTIVE_SKIPS` / `_POLL_INTERVAL_MS` | (5000 / 3 / 5000) | preparação cede ao despacho, com teto |
| `PUBLICATION_WORKER_LEASE_SECONDS` | 180 | lease do despacho (preparação usa `max(300, lease)`) |
| `PUBLICATION_WORKER_POLL_INTERVAL_MS` | 5000 | os três laços |
| `PUBLICATION_WORKER_EXPIRE_LIMIT` | (60, 10–400) | itens encerrados por chamada (54 ms cada) |
| `PUBLICATION_WORKER_META_POLL_SECONDS` | (30, 15–300) | espera até a primeira consulta do contêiner |
| `PUBLICATION_WORKER_CONFIRMATION_ALERT` | (300) | alarme "FILA DE CONFIRMACAO REPRESADA" (com histerese) |
| `PUBLICATION_WORKER_ADAPTIVE_COLLAPSE_RATIO` | (0,1) | fração de erro transitório que derruba o limite pela metade; amostra mínima 10 (fixo) |
| `PUBLICATION_WORKER_COORDINATED_RECOVERY_LIMIT` | 5 (0 = desligado) | recuperação coordenada de slots consome vagas do mesmo lote |
| `PUBLICATION_WORKER_QUEUE_SUMMARY` | (false) | resumo dentro do publicador — deixe desligado; há worker próprio |
| `PUBLICATION_MEDIA_URL_PROBE_TIMEOUT_MS` | (12000) | **por sonda** (são 3 por mídia) |
| timeouts da Meta | 25 s (criar, consultar) / 60 s (publicar) | **fixos no código** |
| `PUBLICATION_MAX_ATTEMPTS` | 5 | constante em `lib/publications/attempts.ts` |
| `QUEUE_SUMMARY_MAX_AGE_SECONDS` / `_POLL_INTERVAL_MS` | 300 / 20000 (60 / 20000) | resumo da tela |
| `PUBLICATION_GENERATION_WORKER_POLL_INTERVAL_MS` | 15000 (10000) | gerador; `BULK_*` controlam passo 25–100 e cooldowns |
| `MEDIA_MAINTENANCE_COLD_STORAGE_*` | enabled true, batch 25, budget 90 s, intervalo 300 s | arquivo frio (padrão do código: **desligado**) |

Ordem em que os tetos mordem (medido em 07/09/2026): 1) semáforo da Meta por processo;
2) o caminho direto esperar o lote inteiro (`Promise.allSettled`); 3) limite adaptativo
zerado a cada reinício; 4) advisory lock por app da Meta na reserva; 5) cotas por perfil;
6) pool do PostgREST (41 no Medium; `max_connections` 120 no Medium, 240 no XL).

**Some antes de somar vagas.** O que ocupa conexão do banco são os itens em voo do caminho
direto (`LIMIT` por processo, todos chamando `reserve`/`complete` quase juntos porque o lote
espera inteiro) e do spool (`STAGED_DISPATCH_CONCURRENCY`), mais preparação e staging; o semáforo
da Meta **não** entra na conta (prende só a chamada HTTP). Medido em 07/09/2026: com 60/48 no
XL, a maior onda do dia (22:25Z, 284 posts em 5 min) usou **28 conexões** do `authenticator`
no pico; com 24/32 no Medium, a onda das 23:25Z (268 em 5 min) usou 22. O pool do Medium é 41.
Antes de reduzir o compute, reduza os tetos; antes de subir tetos no Medium, olhe `auth_conn`
no pico (consulta na seção 9).

---

## 5. Lógica que derruba perfil, app, lote ou item (e leva a agenda junto)

**Perfil (Meta 190 terminal).** `processInstagramPublication` recebe `code 190`;
`isMetaTerminalProfileDisconnection` (publication-direct-dispatch.mjs) decide terminal se
subcode ∈ {458, 459, 460, 463, 464, 467} **ou** a mensagem contém "error validating access
token", "invalid access token", "session has been invalidated", "log in to
www.instagram.com", "follow the instructions given" ou "checkpoint". Então
`finalize_meta_profile_disconnection`: perfil → `offline` com `last_error_*`; **todos os
itens abertos do perfil** → `ignored` / `meta_profile_disconnected`; planos cancelados;
incidente aberto; vaga do app mantida. O gerador não cria mais itens para perfil que não está
`online`. Consequência visível: um perfil que cai leva ~76 itens de uma vez (07/09: 46
perfis, 2.123 itens; 06/09: 265; 05/09: 706). **Não é a fila falhando.**

**Perfil offline por outro motivo** (status muda na tabela): gatilho da 088 →
`suspend_offline_profile_publications`: itens abertos viram `suspended`
(`profile_offline_suspended`), tentativa devolvida; retomada manual.

**`401`/`190` sem as assinaturas acima é retentável** (`isRetryableGraphFailure`): o token
pode estar em renovação; encerrar na primeira vez custou 3.315 posts em 31/08.

**App da Meta**: `isMetaAppApiBlocked` ("API access blocked/deactivated", código 200) →
`flag_meta_app_api_blocked`: `meta_apps.api_block_until` = +60 min, itens da janela →
`ignored` / `meta_app_api_blocked`, incidente; o claim pula perfis de app bloqueado (394).
"deactivated" não volta sozinho.

**Lote**: disjuntor — 5 falhas terminais consecutivas (falha de infraestrutura não conta)
pausam o lote (`publication_batch_circuit_breakers`); retoma pela tela
(`resume_publication_batch_after_circuit_breaker`).

**Remoções humanas**: excluir perfil (`contain_instagram_profile_for_removal`,
`profile_removed_by_operator`), excluir mídia (`delete_media_assets_and_remove_publication_items`,
pela galeria ou pelo cron de exclusão), cancelar item/lote/em massa (seção 8.8).

**Zernio** (`zernio_account_disconnected`): produto abandonado; os 1.163 perfis Zernio estão
em `reauthorization_required` e não publicam.

---

## 6. Erros: quem é, o que o código faz, o que você faz

### 6.1 Tratados

| Código / assinatura | Origem | Tratamento no código | O que fazer |
|---|---|---|---|
| `190` + assinatura de checkpoint (subcodes 458–467 ou mensagens da seção 5) | Meta, conta | derruba perfil e agenda | nada; conta descartada por regra |
| `190` / `401` sem assinatura | Meta, token | adia (retentável) até 5 tentativas | conferir renovação de token (`athena-meta-token-renewal`) |
| `9004` "Only photo or video…" | Meta não conseguiu buscar a mídia no R2 | adia | se persistir no mesmo asset, olhar o objeto no R2 |
| `200` "API access blocked/deactivated" | Meta, app | pausa o app 60 min; itens da janela `ignored` | liberar/renovar o app na Meta |
| `24`, `2`, `4`, `17`, `32`, `613` | Meta (recurso inexistente, erro genérico, rate limit) | 429/rate limit derruba o limite adaptativo pela metade; resto retentável | se `429` frequente, cota por app (`meta_apps.max_publications_per_minute`) |
| `meta_timeout_criar_container` / `_consultar_status` / `_publicar` | Meta > 25 s / 60 s | retentável; **o lote inteiro do caminho direto espera** | ver seção 8.3 antes de subir processo |
| contêiner `ERROR` / `EXPIRED` | Meta (transcodificação, mídia) | `metaContainerVerdict`: retentável ou não; `IN_PROGRESS` continua | em massa no mesmo formato: olhar a mídia |
| `media_url_probe_timeout` / `_network` / `_http_5xx` | R2 lento | retentável | olhar R2 |
| `media_url_probe_mime_invalid` / `media_url_range_unsupported` / `media_url_tail_range_invalid` | objeto no R2 não é o que o item diz | **não retentável** | reenviar a mídia |
| `media_storage_object_missing` | objeto sumiu do storage | **não retentável** | reenviar a mídia |
| `preparation_*` (`media_count_invalid`, `carousel_media_count_invalid`, `image_media_invalid`, `reel_media_invalid`, `meta_credentials_missing`, `profile_organization_missing`) | dado do item | `preparation_status = blocked` + `next_preparation_at` em 900 s | corrigir o item; o gatilho da 264 zera a preparação ao editar |
| `profile_min_interval`, `profile_24h_limit`, `provider_minute_limit`, `meta_app_minute_limit`, `daily_profile_limit`, `dispatch_rate_limit` | cotas nossas | adiamento sem gastar tentativa | não é erro |
| `publication_past_due` | corte de atraso | `ignored` | a única perda por capacidade: seção 8.3 |
| `profile_offline_suspended` | perfil saiu de `online` | `suspended`, tentativa devolvida | religar o perfil e retomar |
| `missed_bulk_slot_expired`, `legacy_missed_schedule_requires_attention` | v1 legado | descarte/atenção | não ocorre em v2 |
| `9007` "Media ID is not available" | vem no **publicar**, depois de o contêiner responder FINISHED: a mídia ainda não está pronta do lado da Meta (10/09/2026: reel de arquivo que já publicou 636 vezes) | **retryável desde 10/09/2026** (`META_MEDIA_NOT_AVAILABLE_ERROR_CODE`); o retry consulta o contêiner de novo e publica quando pronto |
| `9004` "Only photo or video can be accepted as media type" | a Meta falhou ao **buscar** a mídia na URL assinada, não a mídia errada (os 2 PNG de 09/09 já tinham publicado 1.397 e 1.100 vezes) | **retryável desde 09/09/2026 à tarde** no worker (antes só o despachante da Vercel aplicava a regra de `meta-graph-errors.ts`); recuo da 420; story ganha a janela da 426. Se o mesmo arquivo falhar sempre, é arquivo: aí sim `PUBLICATION_MAX_ATTEMPTS` encerra |
| `media_url_tail_range_invalid` "O host não entregou corretamente o final do vídeo (HTTP …, content-range …, cache …)" | a sonda `bytes=-1024` no R2 não veio como 206 com o fim certo; em 08 e 09/09 foram 4 reels de arquivos que publicaram de 81 a 648 vezes (R2/CDN num instante) | **retryável desde 09/09/2026 à tarde**, com status/range/cache no motivo. Se o mesmo arquivo repetir, olhar o arquivo no R2 |
| `57014`, **`55P03` (lock timeout; visto 1× em 15/09/2026 15:07:59Z como `falha no ciclo` do publicador 4, sem item afetado, sem cancelamento em massa em curso)**, `PGRST002/003`, "fetch failed", `ConnectTimeout`, `ECONNRESET`, `40P01`, `53300`, `57P0x`, **HTML 5xx do gateway** ("521: Web server is down", `<!DOCTYPE html`, "bad gateway"; reconhecido desde 07/09/2026 à noite) | banco / pool / rede | `defer_publication_infrastructure_failure`: recuo 30 → 900 s, tentativa devolvida, **nunca terminal**; controlador adaptativo **segura** (não cai) | olhar pool e rollbacks (seção 9) |
| `40001` "Lease de preparação ausente ou expirado" | preparação demorou mais que o lease | item volta ao pool; o laço **recua** 30 → 300 s se a maioria do lote falha; código no log | banco lento: medir antes de mexer no lote |
| `P0002` "Item não está sob lease deste worker" | lease vencido, ou **claim duplo entre processos** (corrigido na migration 425: os claims reconferem lease/status dentro da trava) | o perdedor aborta antes de chamar a Meta; o item segue com quem ficou com o lease | se voltar a crescer com vários processos, conferir se a 425 está aplicada e se os IDs de worker são únicos |
| `23505 active_publication_slot_conflict` | dois itens no mesmo minuto do perfil | a tela/o gerador bloqueiam antes | pular o slot |
| `55000` "publication_items tem N colunas e o arquivo M" | migration sem espelho no arquivo frio | arquivamento para | espelhar a coluna (como a 423) |
| `zernio_key_unauthorized` (HTTP 401 no DELETE de conta da Zernio) | Zernio, chave suspensa: em 04/09 ela suspendeu 2.004 das 2.166 conexões, 100% das da Pomodoro (migration 374) | **não retentável** (o cliente só marca 429/5xx), então ia direto a `dead_letter` na 1ª tentativa — e `claim_zernio_profile_recycling_jobs` não reivindica esse status, então o perfil ficava preso para sempre. **Desde a 427** o worker encerra o perfil **só no Athena** e cancela a fila dele; `remote_result = closed_without_remote_removal`, com o 401 e a mensagem originais preservados no incidente | nada a fazer na Zernio: sem chave não existe chamada que apague a conta remota — a vaga lá pode seguir ocupada. Para jobs presos antes da 427, `close-zernio-unauthorized-group-removal.mjs` (8.9) |
| `PUBLICATION_MAX_ATTEMPTS` (5) | qualquer retentável | `failed` terminal; retry manual bloqueado pela tela | decidir com o dono |

### 6.2 Não tratados ou tratados mal (pendências conhecidas)

| Sinal | O que é | Estado |
|---|---|---|
| `invalid input value for enum publication_item_status: "processing"` | nenhum código do repositório grava ou filtra esse valor em `publication_items`; a tela envia `status=processing` e a API traduz | **fechado em 07/09/2026**: zero ocorrências no projeto novo desde 16:00Z (consulta no Logs Explorer: `select timestamp, event_message from logs where source = 'postgres_logs' and event_message like '%publication_item_status%'`). Era um cliente batendo no projeto antigo (bundle antigo ou query salva). Se reaparecer, essa consulta traz o SQL completo e diz se é `UPDATE` (função) ou `WHERE` (cliente) |
| `porItemMs` alto sem erro | espera pelo semáforo da Meta, não latência | **fechado em 15/09/2026**: `fasesPorItemMs` separa `esperaSemaforoMeta`, `meta_criar_container` / `meta_consultar_status` / `meta_publicar`, `sondaMidia`, `carregarItem`, `perfilOnline`, `reservarCapacidade`, `gravarResultado`, `liberarCapacidade` (seção 7) |
| `Promise.allSettled` no caminho direto | um item lento segura o lote | pendente: concorrência deslizante (o spool já tem) |
| sonda do R2 a cada publicação (3 pedidos) | custo fixo por post + 2 escritas em `media_asset_delivery_attempts` | pendente: cache por mídia |
| `meta_apps.max_publications_per_minute` nulo | sem cota por app | pendente: alimentar com `X-App-Usage` |
| `reserve_publication_daily_limit` (029) ainda chamado antes de publicar | redundante com a reserva de capacidade | uma chamada a mais por post |
| rotas `publication-claims`, `publication-results`, `queue-summary-refresh` e o modo `dispatch-endpoint` | sem chamador / apontam para rota removida | remover ou documentar como mortos |
| envs `SUPABASE_URL` / `SUPABASE_ANON_KEY` na Vercel | só scripts one-off leem, como fallback | apontam para o projeto antigo; remover |
| Falha terminal "falsa" (item marcado `failed` mas contêiner PUBLISHED na Meta) | acontece quando a chamada de conclusão falha depois de publicar (em 07/09: HTML 521 do gateway no reinício do compute; antes, 04/09: veredito ERROR falso da Meta). A manutenção arquiva a falha em minutos; o botão "Reprocessar" da tela não desarquiva e **zera `creation_id`**, o que publicaria de novo | auditar com `audit-meta-container-failures.mjs` (só leitura); se PUBLISHED, desarquivar e devolver ao worker com o SQL da 8.7 passo 6 — nunca pelo botão. Pendente: o botão preservar `creation_id` quando houver contêiner e limpar `archived_at` |
| Falha **retryável** (ex.: `meta_timeout_criar_container`) cujo retry só vence depois do corte | **corrigido na 426 (09/09/2026)**: dentro da janela do formato o claim tenta de novo; fora dela `expire_late_publication_items` encerra também `failed` com retry vencido como `publication_past_due`. Antes o item ficava `failed` para sempre (22 stories em 09/09, 06:20Z, republicados à mão pelo dono às 17:0xZ) | se voltar a aparecer `failed` com `next_attempt_at` no passado por mais de 15 min, conferir se a 426 está aplicada |
| `get_global_operational_health` (rota `operational-health`) diz "unhealthy" com a fila limpa | `max_lag_seconds` inclui `failed` **terminal** e itens **arquivados** (migration 188), e `overdue` usa 120 s em vez do corte de 300 s; `stale_workers` conta qualquer tipo de worker sem processo ativo (heartbeats de Zernio/legado contavam) | pendente: restringir o lag a `archived_at is null` e excluir falha terminal; heartbeats mortos removidos em 07/09 |
| `.dashboard-*`, `_cpu_snap`, scripts one-off | lixo de investigação | não são parte do sistema |

---

## 7. Logs: onde cada coisa aparece

| Log | Caminho | O que traz |
|---|---|---|
| saída do publicador | `/root/.pm2/logs/athena-publication-worker-out-<id>.log` (`-2`, `-3`; o sufixo `-<id>` apareceu quando os processos foram recriados a partir do ecosystem em 07/09 — use `ls -t` para pegar o atual) | `tempos do ciclo DIRETO` (fases do ciclo, `porItemMs`, e desde 15/09/2026 **`fasesPorItemMs`** = p50/p90/max por fase do item e **`ociosidadeDoLote`** = quanto cada vaga ficou parada esperando o item mais lento, com `aproveitamento` 0–1; é a medida do defeito do lote da 8.3), `tempos do ciclo de despacho` (spool, `esperaPorSlotMs`), `ciclo de preparação` (`estados`, `codigos`, `esperaMs`), `controlador do staging`, `Dispatcher direto concluído` (`states`, `adaptiveConcurrency`), `reservas de staging liberadas`, `entradas de spool descartadas` |
| erro do publicador | `…-error.log` | só o que decide rollback: `preparação girando em falso; recuando`, `FILA DE CONFIRMACAO REPRESADA`, `falha no ciclo`, `Falha isolada no dispatcher`, `erro fatal`. Avisos `MODULE_TYPELESS` são ruído; uma página HTML 521 é URL errada do Supabase |
| gerador / resumo / analytics / manutenção | `athena-<nome>-out.log` / `-error.log` | resumo do ciclo; o resumo grava `recalculo LENTO` (> 45 s) como erro de propósito |
| crons da VPS | `/var/log/athena-instagram-observability-maintenance*.log`, `athena-recovery-analysis.log` | `exit=`, `duration_s=`, `paused: critical_publication_delay` |
| Postgres | Supabase → Logs (ClickHouse: `select … from logs where source = 'postgres_logs'`) | erros com o SQL completo; **é este log que encheu 99 GB em 07/09**; rotação interna do Postgres está desligada |
| PostgREST / API | `source = 'postgrest_logs'` / `edge_logs` | status HTTP por rota |
| telemetria por ciclo | `publication_worker_cycle_events` (`metadata.dispatch.*`) | claim, desfechos, preparação, staging |
| histórico por item | `publication_item_events` | cada transição com código e mensagem; `processing_deferred` é adiamento por cota |
| heartbeats | `publication_worker_heartbeats` | status/modo de cada processo (a tela de operação e o painel leem) |

Regras: `console.info` para o esperado, `console.error` só para o que decide rollback; erros
com **código** agregado por ciclo, nunca um por item; nunca logar `encrypted_access_token`.

---

## 8. Procedimentos

### 8.1 Subir a fila do zero (ordem)

1. Medir o banco vazio: `authenticator` conexões, `xact_rollback` (delta ≈ 0).
2. Encerrar o que venceu **antes** de ligar (`expire_late_publication_items` em laço pela API
   com a service_role), para nada sair em rajada.
3. `pm2 start athena-publication-worker`; 15 min medindo rollbacks, pool, `porItemMs`,
   vencidos abertos, `lease_lost` = 0, `publicados com atraso > 5 min` = 0.
4. `athena-queue-summary-worker`, `athena-generation-worker`, `athena-profile-analytics-worker`,
   `athena-media-maintenance-worker`, um por vez; `athena-meta-token-renewal` uma passada.
5. Publicadores 2 e 3 só pela conta da seção 8.3. Depois, `pm2 save`.

### 8.2 Reiniciar um publicador

Reinício zera o limite adaptativo para 10 (~3 min até o teto) e o processo 1 libera o
staging órfão do próprio id ao subir. **Nunca durante onda.** Se inevitável:
`max_publication_lateness_seconds` 300 → 900 antes, reiniciar, devolver 300 quando nenhum
item aberto passar de 300 s.

### 8.3 Quando subir (ou descer) um processo

```
processos = teto( pico_por_minuto × segundos_por_post_na_Meta ÷ (20 × 60 × 0,6) )
```

Suba só se `porItemMs` p50 > 8 s **e** vencidos abertos crescendo por 2 min; desça quando
p50 < 3 s por uma hora. Processo novo: entrada no `deploy/instagram/ecosystem.config.cjs`
(`PUBLICATION_WORKER_ID` único, `MODE=direct`, preparação e staging desligados), `scp` para a
VPS, `pm2 start deploy/instagram/ecosystem.config.cjs --only <nome>` **num vale**, `pm2 save`;
os outros publicadores não reiniciam. Em 07/09: pico 93/min, 3 s por post → 1 processo bastaria
sem o defeito do lote; com ele, 3. Para 5.000 perfis/hora: 2 a 3; nunca mais que 5 sem corrigir o lote.

**Medida de 11–12/09 (por que existe o 4º):** com 3 publicadores a fila entrega ~300–350 posts
por bloco de 5 min (limite adaptativo 24 × 3, ~53 s por post). O bloco das 07:00 BRT (10:00Z)
chegou a 576–620 posts em um único intervalo de 5 min, e o das 08:40 BRT a 877 em 10 min; o p90
foi a 296 s e **reels sem nenhuma tentativa** (`attempt_count = 0`, sem contêiner) foram encerrados
pelo corte de 300 s: 1 em 11/09, 10 + 5 em 12/09. Isso é capacidade, não erro — o item nem foi
reclamado. O 4º processo subiu às 12:22Z de 12/09 (vale de 68–107 posts/5 min), reclamou no
primeiro ciclo e não reiniciou ninguém.

**Medida de 13–14/09 e o 5º:** com 4 processos, blocos isolados de 616–680 posts passaram com todos
reclamados em ≤49 s (fila vazia antes) e vazão de pico de 593/5 min; o que aperta o reel é bloco pesado
em cima de bloco pesado. Capacidade sustentada ≈ 4 × 24 slots × 300 s ÷ 53 s ≈ 545 por 5 min. A agenda
de 15/09 trouxe reels em quatro intervalos seguidos às 07:00 BRT (298/488/549/313), e o dono aprovou o
**5º processo às 02:54Z de 15/09** (vale, sem reiniciar os outros): capacidade ≈ 680 por 5 min. Pool do
Medium seguiu com folga (ocioso 12–41, ativas ≤ 6).

### 8.4 Migration / DDL

Todo DDL recarrega o cache de schema do PostgREST (`pgrst_ddl_watch`). Antes de `db push`:
`select count(*) from pg_stat_activity where usename='authenticator'` — abaixo de 30 aplique;
perto do pool, espere. Coluna nova em `publication_items` **exige** a mesma em
`publication_items_archive` na mesma migration. Função nova no caminho quente entra na
tabela da seção 1.3 com o custo medido.

### 8.5 Deploy

`vercel --prod` sobe a **árvore de trabalho**: `git status` limpo antes. Deploy na VPS é
`scp` dos arquivos alterados **inclusive `package.json` quando um script `npm run` novo entra** (em 07/09 a VPS estava sem 25 scripts) + `node --check` + `pm2 restart` (o repositório da VPS não é
git). Nunca `git pull` na VPS sem conferir o md5 do `publication-direct-dispatch.mjs`. O
worker importa `lib/integrations/meta-graph-errors.ts` direto (type stripping do Node 22):
mudar esse arquivo também é deploy na VPS. **O único publicador do Instagram é
`scripts/workers/publication-direct-dispatch.mjs`**: a cópia `lib/integrations/instagram-publisher.ts`
(e o `zernio-publisher.ts` que a usava) foi removida em 07/09/2026.

### 8.6 Trocar de projeto Supabase / chaves

Três lugares na VPS (`.env.local`, `.env.worker`, env salvo do PM2), `.env.local` local,
três variáveis na Vercel (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) + deploy, `supabase link`, `max_rows` = 5000 na Data API,
Redirect URL do Auth, `alter role authenticator set statement_timeout = '30s'`, migrations
pendentes (`supabase migration list`).

### 8.7 Reduzir/aumentar compute

Reinicia por ~3 min: mesma cerimônia do 8.2, com o dono acordado, nunca de madrugada.
Feito em 07/09/2026 (XL → Medium, 23:36Z, em vale de demanda), nesta ordem:

1. Tetos na VPS (`.env.worker`, cópia em `.env.worker.bak-xl-20260907`): `LIMIT` 60 → 24,
   `STAGED_DISPATCH_CONCURRENCY` 48 → 32; `META_CONCURRENCY` fica em 20.
2. `max_publication_lateness_seconds` 300 → 900 nas três linhas de `publication_rate_limit_settings`.
3. `pm2 restart athena-publication-worker athena-publication-worker-2 athena-publication-worker-3 --update-env`
   (o PM2 não mostra esses envs; confirme no log: `adaptiveConcurrency: { maximum: 24 }`).
4. Dono: Project Settings → Compute and Disk → tier → confirmar. Postgres reiniciou em ~3 min;
   todos os workers reconectaram sozinhos, sem reinício do PM2 e sem erro no log.
5. Conferir `pg_postmaster_start_time()`, `max_connections` (120 no Medium) e nenhum item aberto
   acima de 300 s; devolver o corte a 300 s.
6. **Auditar as falhas do minuto do reinício**: chamadas em voo recebem HTML 521 do gateway. Em
   07/09 dois itens já PUBLICADOS na Meta viraram `failed/dispatcher_unexpected_error` porque o
   classificador não conhecia esse HTML (corrigido no mesmo dia; hoje o item é adiado 30 s e o
   contêiner PUBLISHED é reconhecido na volta). Conferir com
   `node scripts/workers/audit-meta-container-failures.mjs --horas 1` na VPS (só audita).
   Para devolver um desses ao worker sem publicar de novo: `update publication_items set
   archived_at = null, archived_by = null, next_attempt_at = now(), claimed_by = null,
   lease_until = null where id = … and status = 'failed' and creation_id is not null`. O
   `archived_at = null` é obrigatório: a manutenção arquiva falha terminal em minutos (em 07/09,
   25 min depois) e **o claim ignora item arquivado** — sem isso o item fica "failed" para sempre
   e nenhum log explica. Feito em 07/09 para os dois itens: recuperados como `published` em 1 s.

Para subir de novo (Medium → Large/XL): mesma cerimônia; os tetos só sobem depois, medindo
`auth_conn` no pico. Preços de referência em 09/2026: Medium ~US$ 60/mês, Large ~US$ 110, XL ~US$ 210.

### 8.8 Ações manuais pela tela (o que cada botão faz na fila)

| Ação | Rota | Efeito |
|---|---|---|
| Cancelar item | `PATCH /api/publications/[itemId]` | `cancelled`, limpa lease e `creation_id`, evento, sincroniza lote |
| Reprocessar item falho | mesma rota | `ready`, **zera `creation_id`** e não mexe em `archived_at`; bloqueado se `attempt_count ≥ 5`. Duas armadilhas (6.2): item já arquivado continua invisível ao claim; item cujo contêiner já está PUBLISHED na Meta ganha contêiner novo = **post duplicado** |
| Cancelar lote | `POST …/batch/[id]/cancel` | `cancel_publication_batch_items`; libera mídias |
| Cancelar em massa (conta/grupo/lote) | `POST /api/publications/cancel` (`maxDuration` 30 s) | operação durável (`begin…`, idempotente por alvo) + **uma etapa** na hora (`{operationId, execute:true}`); as demais são do `athena-cancellation-worker` (a tela só avança operação parada há > 15 s). Fontes primeiro; blocos de 1.500 **sem bloquear** por item em voo (o em voo termina sozinho; o que voltar é cancelado; prazo de 30 min); ao concluir invalida o resumo. `GET` sem `operationId` lista as operações das últimas 24 h (≤ 50) — é a "Fila de cancelamento" da tela, que também sobrepõe "Cancelada" na linha até o snapshot alcançar |
| Continuar lote pausado | `POST …/batch/[id]/continue` | `resume_publication_batch_after_circuit_breaker` |
| Limpar encerradas / concluídas / marcar falhas como vistas | `POST /api/publications/queue-actions` | arquiva sob lease pesado (250 por lote); `acknowledge_publication_failures` |
| Excluir mídia (galeria) / excluir perfil | `/api/media/*`, `/api/profiles/*` | removem os itens da fila ligados |
| Criar plano em massa | `POST /api/bulk-publications/confirm` | `create_bulk_rotation_plan_v2` / `create_bulk_daily_rotation_plan_v2`; gate `BULK_PUBLICATION_ROLLOUT` |
| Cancelar job de geração | `PATCH /api/publication-generation-jobs/[id]` | `cancel_publication_generation_job` |

### 8.9 Scripts one-off que escrevem na fila (`scripts/workers/`) — leia antes de rodar

| Script | O que faz | Perigo |
|---|---|---|
| `cancel-all-publication-queues.mjs` | cancela a fila inteira pelo fluxo sancionado | destrutivo; dry-run por padrão, exige `--apply` |
| `ignore-overdue-unstarted-publications.mjs`, `ignore-expired-unstarted-publication-leases.mjs` | descartam vencidos em massa | **sem dry-run**; o segundo exige `--expected` |
| `ignore-overdue-duplicate-paused-stories.mjs` | ignora stories vencidos de lotes pausados por duplicata | `--all-paused` amplia; backup antes de `--apply` |
| `recover-meta-false-error-failures.mjs`, `recover-vini-reels-horizon-conflicts.mjs`, `repost-latest-affected-stories.mjs`, `requeue-missing-worker-encryption-key-failures.mjs`, `requeue-failed-zernio-creations-for-polling.mjs` | **republicam itens vencidos** | violam a regra do dono; alvos hard-coded de agosto/setembro; não rodar |
| `cancel-bulk-story-duplicate.mjs`, `correct-luiz-miguel-story-daily-start.mjs`, `process-claimed-luiz-miguel-reels-recovery.mjs` | alvos hard-coded de incidentes passados | obsoletos; `UPDATE` cru fora da RPC |
| `recover-future-bulk-plan.mjs` | cursor/hold/timeouts de plano | tem `preview`; `advance` pula slots |
| `close-zernio-unauthorized-group-removal.mjs` | encerra localmente os perfis de **um** job de exclusão de grupo presos em `dead_letter` com 401; cancela a fila deles pela contenção sancionada | alvo obrigatório (`--job=`), ensaio por padrão, exige `--confirm`; só toca incidente com `remote_http_status = 401` |
| `enable-publication-slot-recovery.mjs` | liga recuperação de slot para **todas** as orgs | sem dry-run |

---

## 9. Onde olhar primeiro, por sintoma

| Sintoma | Primeiro lugar | Depois |
|---|---|---|
| "está falhando muito" | `select status, last_error_code, count(*) … updated_at >= <hora>` | `meta_profile_disconnected` → contar perfis distintos: é conta caindo, não fila |
| posts saindo atrasados | `porItemMs` no log + vencidos abertos + p50/p90 de `provider_creation_started_at - execute_at` | semáforo da Meta (8.3) antes de qualquer botão |
| posts vencendo (`publication_past_due`) | os mesmos + demanda por minuto (`execute_at` por minuto) | capacidade: 8.3 |
| API 521 / painel morto | `pg_stat_activity` pelo pooler; `pg_ls_logdir()` (log gigante?); `xact_rollback` delta | histórico de 07/09 no mapa de controles |
| pool cheio / `PGRST003` | quem está nas conexões (`pg_stat_activity` por `query`) | laço em erro (rollbacks) antes de "muitos workers" |
| `40001` no log do Postgres | `ciclo de preparação` no log do worker (`codigos`) | banco lento; não aumente lote |
| CPU do banco alta com fila normal | `pg_stat_statements` por `total_exec_time` (resumos, arquivo frio, analytics) | seção 5 do plano |
| perfis sumindo | `instagram_profiles.last_error_message` dos `offline` de hoje | checkpoint = descartar; `401`/renovação = esperar |
| lote parado | `publication_batch_circuit_breakers` (`paused_at`) | "continuar" na tela depois de entender a causa |
| item preso em `preparing` | `lease_until` no passado? | o claim recupera sozinho; se não, `release_expired_publication_leases` |
| dashboard vazia | `get_dashboard_analytics_summary` responde em ms? migrations 421/422 aplicadas? | `refresh_dashboard_summary` no cron |
| resumo da /queue velho | `publication_queue_summary_totals.snapshot_at` | worker de resumo ligado? |
| nada arquiva / tabela quente cresce | log da manutenção: `55000` de paridade? | espelhar coluna no arquivo frio |

Consultas prontas (pooler, papel `postgres`):

```sql
-- saúde em uma linha
select (select count(*) from pg_stat_activity where usename='authenticator') as pool,
       (select xact_rollback from pg_stat_database where datname='postgres') as rollbacks,
       (select count(*) from publication_items where status in ('waiting','ready')
          and execute_at < now() and archived_at is null) as vencidos_abertos,
       (select count(*) from publication_items where published_at >= now() - interval '5 minutes') as pub_5min;
-- atraso real
select percentile_cont(0.5) within group (order by extract(epoch from (provider_creation_started_at - execute_at))) as p50,
       percentile_cont(0.9) within group (order by extract(epoch from (provider_creation_started_at - execute_at))) as p90
from publication_items where provider_creation_started_at >= now() - interval '15 minutes';
-- perfis caídos por dia
select date_trunc('day', e.created_at)::date, count(distinct i.profile_id)
from publication_item_events e join publication_items i on i.id = e.publication_item_id
where e.event_type = 'ignored' and e.error_code = 'meta_profile_disconnected' group by 1 order by 1;
-- demanda por minuto na próxima hora
select date_trunc('minute', execute_at), count(*) from publication_items
where status = 'waiting' and execute_at between now() and now() + interval '1 hour' group by 1 order by 2 desc limit 10;
```

---

## 10. Armadilhas de medição (todas já custaram um diagnóstico errado)

- `pg_stat_statements` não conta chamada que termina em erro; contador parado com pool cheio é laço de erro.
- `published_at` é confirmação, 30–180 s depois do envio; vazão é `provider_creation_started_at`.
- `updated_at` é reescrito por reenfileiramento e por cópias; para separar "hoje" use `execute_at` e `published_at`.
- Paginar `publication_items` sem ordem total (`execute_at, id`) repete e perde linhas.
- `connection_limit` do role (120) não é o pool; o pool é o do PostgREST (41 Medium, 240 XL).
- O dashboard da Supabase mostra o volume de dados; o log do Postgres fica em `/var/log/postgresql`, no volume de sistema, invisível para ele.
- Um `porItemMs` alto não é Meta lenta até que o log por fase diga. Desde 15/09/2026 o log diz: `fasesPorItemMs.esperaSemaforoMeta` é espera de vaga, `meta_*` é a Meta, `sondaMidia` é o R2, o resto é banco. Antes disso, era espera de vaga.
- "3 workers e várias falhas": falha por perfil caído aparece em lote e não depende de workers.
- Contadores "exposed functions/tables" do dashboard não refletem o OpenAPI real do PostgREST.

---

## 11. Histórico curto (detalhes no mapa de controles)

| Data | O que | Lição |
|---|---|---|
| 14/09 | três "Cancelar grupo" seguidos na Pomodoro: a tela guardava UMA operação (o 2º clique abandonou a 1ª com 2.146 ativos e 9.000 cancelados), o bloco abortava a rodada inteira se qualquer item do grupo estivesse em voo, a passada compacta (197) ainda cancelava arquivados e marcava lotes da org inteira, e a linha virava "Concluído" por falta do tom `cancelled`. Migration 428 + `athena-cancellation-worker` + fila de cancelamento na tela | operação em massa é do servidor, não da aba; cancelar não pode esperar janela sem item em voo; toda função antiga do caminho tem de ser reconferida quando uma correção (336) muda um predicado |
| 31/08 | concorrência 64 → 160 apagou 3.315 posts | advisory lock por org; infra nunca vira terminal |
| 02/09 | teto por minuto 600 → 1.200 derrubou a API | o teto alonga a posse do lock; pool 41 |
| 06/09 | dois itens envenenados travaram a confirmação | recuo exponencial; denominador mínimo |
| 07/09 | laço de preparação a 78 erros/s por 17 dias; log de 99 GB encheu o volume de sistema; projeto novo `athena`; onda das 17:25Z pediu 3 publicadores; com 3 processos apareceu o claim duplo (P0002), corrigido na 425 |
| 15/09 (07:00 BRT) | primeiro bloco de reels com **5 publicadores**: 525 e 591 reels em intervalos seguidos (10:00 e 10:05Z) passaram com contêiner iniciado em ≤51 s (ontem, com 4, 271 s) e p90 de confirmação 103–108 s; **mas o bloco das 10:20Z veio com 1.049 posts (922 stories + ~100 reels) e 2 reels foram encerrados por atraso** (0 tentativas, sem contêiner): os reels dividiram as vagas com os stories, que têm janela de 1 h, e o início do contêiner dos reels foi a 306 s. 03:15Z→14:40Z: 0 falhas, 69 perfis em checkpoint, 1 `fetch failed` isolado na varredura de vencidos do publicador 2 às 07:29Z | com fila cheia de stories, o reel perde por ordem de chegada; opção a decidir com o dono: o claim dar prioridade ao formato de corte curto (reel) sobre o de janela longa (story) no mesmo minuto — é regra de negócio (seção 3), não teto |
| 15/09 | **log por fase** no caminho direto (`fasesPorItemMs` + `ociosidadeDoLote` em `tempos do ciclo DIRETO`), primeira das quatro mudanças do plano, decidida pelo dono para medir o defeito do lote antes de qualquer janela deslizante; livro-razão por item via `AsyncLocalStorage`, agregado por ciclo, sem linha por item e sem alterar decisão; canário no publicador 5 | medir por dentro do laço (mapa, seção 8); a ordem do plano é log → medida de um dia → janela |
| 14–15/09 | 00:49Z→02:54Z de 14→15/09 sem falha e sem encerrado por atraso (~50.000 posts); bloco das 07:00 BRT de 14/09 (616, quase tudo story) e das 22:00Z (680: 321 reels + 247 stories, todos reclamados em ≤49 s, vazão 593/5 min) passaram com 4; outra sessão ligou `athena-cancellation-worker` às 19:50Z (cancelou 18.606 reels + 505 stories de 271 perfis às 20:15Z, esvaziando a agenda até 20:50Z); 1 reel com ERROR de contêiner às 02:12Z publicou na 2ª tentativa; **5º publicador ligado às 02:54Z de 15/09** para os quatro intervalos seguidos de reels das 07:00 BRT (298/488/549/313) | com fila vazia antes, 4 processos reclamam 680 em <1 min; o risco é a soma de blocos, não o bloco |
| 12–13/09 (noite) | primeira noite com 4 publicadores: 05:00Z→13:20Z com ~21.000 posts, **0 falhas, 0 encerrados por atraso**; o bloco das 07:00 BRT (10:00Z) veio com 629 posts e passou inteiro (ontem, com 3, 576 perdeu 10) — reels começaram a criar contêiner com até 271 s de atraso e 0 retentativas, p90 de confirmação 250 s; o bloco das 03:30 BRT (06:30Z, 544) teve p90 319 s só nos stories (janela própria de 1 h; 6 na 2ª tentativa pela lentidão diária da Meta); 48 perfis em checkpoint; 3 perfis marcados `reauthorization_required` pela renovação de token das 05:00Z, com 89 itens em `suspended` (retomada manual) | 4 publicadores seguram 630/5 min, mas com ~30 s de folga no reel; se o bloco crescer com os 400 perfis novos, é o 5º processo |
| 12/09 (dia) | primeiro dia com 4 publicadores: 0 encerrados por atraso das 12:22Z à meia-noite; blocos de 494, 529 e 532 posts em 5 min passaram com p90 113–150 s (máx 159–258 s) e vazão de pico de 523/5 min; às 20:19Z um agendamento em massa de 2.938 reels (42 perfis, Pomodoro) gerou 36 rollbacks em 1 min — colisões da regra de 1 post/min/perfil, sem erro; **23:53Z→00:02Z: a VPS ficou sem alcançar `iuxzrhuvcpeyxqifzbcw.supabase.co:443` (`ConnectTimeoutError`, 10 s)** — os 4 publicadores logaram `fetch failed` como `infrastructure_retry`, a vazão caiu a ~13/min num vale de 74 agendados, 2 itens foram a `failed` com retentativa e publicaram sozinhos quando a rede voltou; 0 perdas. O SSH e o CLI daqui também falharam no mesmo minuto: foi rede/gateway, não o banco (pool ocioso 21, ativas 1 o tempo todo) | com 4 processos o limite prático é ~530/5 min com folga; `fetch failed` já é infraestrutura e o retry cobre uma queda de 9 min sem intervenção |
| 11–12/09 | noite 01:40Z→12:20Z limpa: ~27.000 posts, 0 falhas terminais, 0 erros nos logs da VPS, 51 perfis em checkpoint (4.300 itens ignorados pela seção 5); **15 reels encerrados por atraso sem nenhuma tentativa**: 10 no bloco das 07:00 BRT (576 em 5 min) e 5 às 08:45 BRT (877 em 10 min) — capacidade de 3 publicadores (~300–350/5 min) | 4º publicador (só direto) ligado às 12:22Z de 12/09 num vale, sem reiniciar os outros; regra 8.3 atualizada com a medida |
| 10/09 | excluir o grupo "Miguel" (Pomodoro) tirou as 119 mídias, o histórico e o grupo, mas os 15 perfis Zernio foram a `dead_letter` com 401 na 1ª tentativa — 12 chaves distintas falharam em 5 s, e a última reciclagem Zernio bem-sucedida da org tinha sido 03/09 22:26. Ficavam órfãos: sem grupo, fila cancelada, e a tela oferecendo "tentar de novo" para algo que nunca passaria | migration 427: um caminho terminal sem volta precisa de saída. 401 encerra o perfil local e **diz** que a conta remota ficou lá, em vez de fingir remoção |
| 09–10/09 (noite) | 29.000 posts, 0 encerrados por atraso; timeouts de criar contêiner às 06:20Z pelo segundo dia (14) e às 16:10Z (31), **todos publicados na 2ª tentativa** pela regra da 426; 87 perfis em checkpoint (2.517 itens); frota 3.061 com 210 conectados; 1 reel com `9007` no publicar, tratado no mesmo dia | a lentidão da Meta às 03:20 BRT coincide com o maior bloco da madrugada (2.778/h); o retry cobre, então o limite de 25 s fica |
| 09/09 (tarde, 2) | `9004` e `media_url_tail_range_invalid` passam a retryáveis no worker, com o que o host respondeu no motivo; os 6 casos de 08–09/09 eram arquivos que publicaram centenas de vezes | regra do dono: nenhuma falha por problema que não tratamos |
| 09/09 (tarde) | migration 426: story ganha janela de atraso própria de 1 h enquanto `attempt_count < 5` (reel segue em 300 s); varredura encerra falha retryável presa; os 22 stories das 06:20Z foram reagendados para publicar às 17:0xZ por decisão do dono | regra de negócio: story é 1 por perfil por dia |
| 08–09/09 | primeiros dois dias no Medium: ~2.000 posts/h, ondas de até 455 em 5 min (bloco de 441 às 02:50Z de 09/09) com 0 encerrados por atraso, ativas ≤ 5, pool ocioso até 41; a frota foi de 2.113 para 3.261 perfis e voltou a 2.956 depois de **302 perfis em checkpoint entre 03:00Z e 05:00Z de 09/09** (00:00–02:00 BRT), em 15+ apps, sem bloqueio de app — 19.010 itens ignorados pela regra da seção 5; lentidão da Meta às 06:23Z deixou 22 timeouts presos em `failed` (6.2); PNG publica normalmente (1.042 stories), 2 falhas 9004 são arquivos específicos | a fila não foi o gargalo em nenhum momento; o custo do período foi perfil, não capacidade |
| 07/09 (noite) | projeto antigo apagado pelo dono; compute XL → Medium às 23:36Z com tetos 24/32 (seção 8.7); o semáforo da Meta prende só a chamada HTTP, então o pool do banco é ditado por `LIMIT` e `STAGED_DISPATCH_CONCURRENCY`; no minuto do reinício, 2 itens publicados viraram falha terminal porque o HTML 521 do gateway não era classificado como infraestrutura (corrigido nos dois despachantes) | 7 h no projeto novo sem rollback e sem expirado por capacidade; único perfil derrubado foi um checkpoint (95 itens ignorados pela regra da seção 5) | recuo no laço; log com código; despachante da Vercel removido; o serializador é o semáforo da Meta |

---

## 12. Pendências abertas (07/09/2026)


- **Logs do PM2 sem carimbo de hora** (achado de 13/09/2026 00:03Z): nenhuma linha dos `-out-`/`-error-` começa com data, então filtrar log "por horário" não filtra nada — só contagem total do `-error-` é confiável. Corrigir com `log_date_format: 'YYYY-MM-DDTHH:mm:ssZ'` no `npmWorker()` do ecosystem; **só vale após `pm2 restart <nome> --update-env`**, que zera o limite adaptativo (8.2): fazer um processo por vez, em vale, com o dono acordado.
- Rotação de meia-noite do `pm2-logrotate` em 13/09 copiou só 0,6 MB por publicador e não truncou os atuais (16–19 MB às 00:05Z); os dias anteriores rotacionaram 18–21 MB certinho. O teto `max_size 50M` (checado a cada 30 s) segura o disco (963 MB de logs, 90 GB livres), mas conferir `du -sh /root/.pm2/logs` na rotina da manhã.
- Rotacionar `PUBLICATION_WORKER_SECRET`, `META_OAUTH_STATE_SECRET` e chaves R2 (passaram pelo chat).
- Atualizar `.env.worker.deploy` e os docs de X/Twitter que citam o ref antigo (as envs `SUPABASE_URL`/`SUPABASE_ANON_KEY` saíram da Vercel em 07/09).
- Remover as rotas mortas e o modo `dispatch-endpoint`; corrigir o comentário de `queue-summary-refresh`.
- Corrigir `get_global_operational_health` (lag só de itens abertos e não arquivados; `overdue` alinhado ao corte de 300 s).
- Botão "Reprocessar item falho" (`PATCH /api/publications/[itemId]`): limpar `archived_at` e **não** zerar `creation_id` quando houver contêiner (o worker já reconhece PUBLISHED); hoje pode duplicar post e pode não fazer nada.
- As três mudanças de código restantes do plano (lote deslizante, semáforo por app, cache da sonda). **Log por fase entrou em 15/09/2026** (seção 7); a janela deslizante só depois de um dia de `ociosidadeDoLote` medido, portando o `mapWithConcurrency` do spool, com reposição em pedaços (≥ 6 vagas livres, ≤ 1 claim a cada 3 s por processo), mesmo teto de itens em voo, manutenção do ciclo fora da janela, canário em um processo e alvo de menos processos (8.3).

---

## 13. Checklist de atualização (toda mudança na fila)

- [ ] Mudou um teto, um env ou um padrão do código? Seção 4 **e** o `.env.worker` da VPS no mesmo commit.
- [ ] Novo código de erro, novo tratamento ou novo caminho terminal? Linha na seção 6, com origem e o que fazer.
- [ ] Nova regra de negócio ou decisão do dono? Seção 3, com data.
- [ ] Nova função SQL, gatilho ou índice no caminho da fila? Seção 1.3, com custo medido.
- [ ] Nova coluna em `publication_items`? Espelhe em `publication_items_archive` na mesma migration.
- [ ] Novo processo PM2, cron ou rota interna? Seções 1.1/1.2 e a conta da 8.3; `pm2 save`.
- [ ] Nova ação na tela ou script que escreve na fila? Seções 8.8/8.9.
- [ ] Incidente? Uma linha na seção 11 e a seção correspondente no mapa de controles.
- [ ] Mudou como se mede algo? Seção 9 ou 10.
- [ ] Fechou uma pendência? Tire da seção 12.

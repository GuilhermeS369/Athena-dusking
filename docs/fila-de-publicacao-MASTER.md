# Fila de publicação — DOCUMENTO MESTRE

**Leia este arquivo antes de tocar em qualquer coisa que envolva postagem.** Ele é o único
lugar onde a gestão da fila está inteira: peças, regras, tetos, erros tratados e não tratados,
lógica que derruba perfil, procedimentos e onde olhar primeiro. Toda mudança na fila
**atualiza este arquivo no mesmo commit** (seção 12, checklist). Se algo aqui contradiz o
código, o código está certo e este arquivo está atrasado: corrija-o.

Mantido desde 07/09/2026. Complementa, e não substitui, o
[mapa de controles](fila-de-publicacao-mapa-de-controles.md) (histórico de incidentes e
experimentos) e o [runbook da VPS](vps-worker-runbook.md) (acesso e deploy).

---

## 0. As três regras antes de qualquer ação

1. **Veja qual é o erro antes de mexer na lógica.** Erro tem código, origem e dono. Um
   código da Meta (190, 9004, 24) não se corrige no banco; um `57014` não se corrige na
   Meta; um `40001` de lease não se corrige subindo worker. A seção 6 diz de quem é cada um.
2. **Meça antes de agir, e meça no lugar certo.** Vazão é `provider_creation_started_at`,
   não `published_at`. Erro de banco é `pg_stat_database.xact_rollback`, não o log do
   worker (que só mostra o que o worker decidiu logar). `pg_stat_statements` **não conta
   chamada que falhou**. A seção 9 lista onde olhar por sintoma.
3. **Nenhuma decisão que descarte ou republique publicação é tomada sozinha.** É
   apresentada ao dono com opções. Item vencido fica vencido. Perfil em checkpoint é
   descartado. Nunca se mexe em horário de agendamento para aliviar carga.

---

## 1. As peças

### 1.1 Processos (VPS `179.198.110.201`, `/opt/athena-worker`, PM2)

| Processo PM2 | Script | O que faz | Deve estar |
|---|---|---|---|
| `athena-publication-worker` | `publication-worker.mjs` (id `athena-vps-publication-1`) | preparação (laço próprio), staging (spool em disco), despacho pelo spool e pelo caminho direto | **ligado** |
| `athena-publication-worker-2`, `-3` | mesmo script, env do PM2 com `MODE=direct`, preparação e staging **desligados** | só caminho direto | ligados conforme a conta da seção 8.3 |
| `athena-generation-worker` | `publication-generation-worker.mjs` | materializa itens dos planos em massa | ligado (`POLL_INTERVAL_MS=15000`) |
| `athena-queue-summary-worker` | `queue-summary-worker.mjs` | resumo da tela /queue (`refresh_publication_queue_summary`, 6,7 s por org) | ligado (`QUEUE_SUMMARY_MAX_AGE_SECONDS=300`) |
| `athena-profile-analytics-worker` | `profile-analytics-refresh-worker.mjs` | chama a rota da Vercel que abre as coletas fixas 09:00/15:00/21:00 (hora local) | ligado |
| `athena-media-maintenance-worker` | `media-maintenance-worker.mjs` | exclusões de mídia, arquivo frio (migration 424) | ligado |
| `athena-meta-token-renewal` | `meta-token-renewal-worker.ts` | renova tokens Meta perto de vencer; roda e sai | uma passada por dia |
| `athena-zernio-sync-worker`, `athena-profile-analytics-direct-worker` | legado Zernio / fase E | **não ligar**: Zernio foi abandonada em 09/2026 | desligados |
| `athena-twitter-*` | apagados do PM2 em 07/09/2026 | módulo X | só com autorização do dono |

**Regra do env:** o worker lê `.env.local` **antes** de `.env.worker` e a primeira definição
vence; e o PM2 guarda o env de cada processo (`pm2 save`) e ignora o `.env.worker` para
chaves que já tem. Ao trocar URL/chave do Supabase ou um teto num processo 2/3, troque nos
três lugares (`.env.local`, `.env.worker`, env salvo do PM2) e reinicie.

### 1.2 Vercel

- **Não existe mais despachante na Vercel** (removido em `6d65eb2`, decisão do dono). Se a
  VPS cair, sobe-se outro processo lá; nada publica fora dela.
- Crons que restam (`vercel.json`): `media-deletion-dispatch` (1 min), `meta-analytics-dispatch`
  (5 min, coleta contínua, orçamento 45 s), `dashboard-summary-refresh` (5 min),
  `recovery-analysis-dispatch` (diário 09:20).
- Rotas internas são protegidas por `PUBLICATION_WORKER_SECRET` / `CRON_SECRET`.

### 1.3 Banco (Supabase projeto `athena`, ref `iuxzrhuvcpeyxqifzbcw`, desde 07/09/2026)

Tabelas que importam: `publication_items` (a fila; ~1,07 mi linhas), `publication_item_media`,
`publication_batches`, `bulk_publication_plans` + `bulk_publication_generation_chunks`,
`publication_dispatch_rate_reservations`, `publication_profile_daily_reservations`,
`publication_rate_limit_settings`, `publication_batch_circuit_breakers`, `instagram_profiles`,
`meta_apps`, `publication_item_events` (histórico), `publication_worker_heartbeats`,
`publication_worker_cycle_events` (telemetria), `publication_items_archive` (arquivo frio).

Funções que a fila chama (todas `security definer`, a maioria exige `service_role`):

| Função | Quem chama | Custo medido |
|---|---|---|
| `claim_publication_preparation_items` | laço de preparação | 83 ms |
| `complete_publication_preparation` | idem | 3,6 ms; levanta `40001` se o lease venceu |
| `claim_publication_dispatch_staging_items` / `activate_staged_publication_items` / `release_publication_dispatch_staging` | staging e spool | 32 ms |
| `claim_publication_items` | caminho direto | 127 ms (janela + duas `row_number()`) |
| `reserve_publication_dispatch_capacity` | todo despacho | 37 ms; 2 advisory locks + 3 contagens |
| `reserve_publication_daily_limit` | antes de publicar (Meta) | — |
| `defer_publication_item` | contêiner criado, espera 30 s | 23 ms |
| `complete_publication_item` | desfecho | 27 ms |
| `defer_publication_infrastructure_failure` | erro de banco/rede | recuo 30 s → 900 s (migration 420) |
| `expire_late_publication_items` | fim de ciclo (60 por chamada) | 54 ms por item |
| `recover_missed_publication_slots` | fim de ciclo (100 por chamada) | — |
| `finalize_meta_profile_disconnection` | Meta 190 terminal | derruba o perfil e encerra os itens dele |
| `flag_meta_app_api_blocked` | Meta "API access blocked" | pausa o app por 60 min |
| `refresh_publication_queue_summary` | resumo da tela | 6,7 s por org |
| `move_archived_publication_items_to_cold_storage` | manutenção de mídia | ~100 ms por item (424) |

Configuração que vive no banco (não em env): `publication_rate_limit_settings`
(`max_publication_lateness_seconds` 300, `max_profile_publications_per_24h` 100,
`min_seconds_between_profile_publications` 45, `reel` 1.500 s, `dispatch_lock_shards` 8,
`max_provider_publications_per_minute` 1.200 para `meta_official`) e
`meta_apps.max_publications_per_minute` (nulo = sem cota por app).

---

## 2. O ciclo de vida de um item

`publication_item_status`: `draft, validating, reserved, waiting, preparing, ready, publishing,
published, failed, ignored, cancelled, removed, suspended`.
`preparation_status`: `pending, preparing, ready, blocked, not_required`.

```
plano em massa ─► GERAÇÃO ─► waiting / pending
                                │  claim_publication_preparation_items (janela 24 h, lease 300 s)
                                ▼
                   PREPARAÇÃO ─► waiting / ready       (valida perfil, mídia, formato; não chama Meta)
                                │  staging 600 s antes: arquivo no spool + dispatch_staged_until
                                ▼
                   DESPACHO  ─► preparing (lease 180 s)  reserva de capacidade → contêiner na Meta
                                │  defer_publication_item: waiting com creation_id, prioridade 0
                                ▼  30 s depois, claim de novo
                   CONFIRMAR ─► status_code FINISHED → media_publish → published
                                             ERROR/EXPIRED → failed (retentável ou não)
```

Quem escreve o quê:

- **Só o claim** muda `waiting → preparing` e gasta tentativa (`attempt_count`) quando não há
  `creation_id`. Polling de contêiner não gasta tentativa.
- **Só a reserva de capacidade** devolve para `waiting` com `next_attempt_at` (adiamento por
  cota); isso não é falha e não gasta tentativa.
- **Só `complete_publication_item`** grava `published`/`failed`/`removed`;
  `PUBLICATION_MAX_ATTEMPTS` (5) encerra retentáveis.
- **Só `expire_late_publication_items`** grava `ignored` + `publication_past_due`.
- **Só `finalize_meta_profile_disconnection`** grava `ignored` + `meta_profile_disconnected`
  (todos os itens futuros do perfil de uma vez) e põe o perfil `offline`.
- `cancelled` é ação humana (tela). `suspended` é perfil offline no momento do claim.
- `archived_at` marca item terminal antigo; após 7 dias vai para `publication_items_archive`.

---

## 3. Regras de negócio (não mude sem o dono)

| Regra | Onde | Valor |
|---|---|---|
| Atraso máximo: depois disso o item **não** é publicado, é encerrado | `publication_rate_limit_settings.max_publication_lateness_seconds`, migration 405 | 300 s |
| Item vencido não é republicado, nem após incidente | decisão do dono, 07/09/2026 | — |
| Mínimo entre posts do mesmo perfil | mesma tabela | 45 s; reel 1.500 s |
| Máximo por perfil em 24 h | mesma tabela | 100 (limite da Meta) |
| Perfil em checkpoint / token inválido é descartado | `isMetaTerminalProfileDisconnection` + `finalize_meta_profile_disconnection` | remove e ignora a agenda |
| Slot perdido é reagendado **uma vez** para a próxima data livre na mesma faixa | `recover_missed_publication_slots`, migration 264 | 100 por ciclo, tolerância 120 s |
| Espalhamento de perfis na janela do plano; intervalo mínimo 29 min; plano de até 7 dias | migrations 326–331 | — |
| Horário de agendamento nunca é alterado para aliviar carga | decisão do dono | chave de idempotência guarda o slot |
| Twitter/X desligado | decisão do dono, 07/09/2026 | só com autorização |

---

## 4. Tetos e botões (valores em vigor em 07/09/2026)

Env em `/opt/athena-worker/.env.worker` (padrão do código entre parênteses):

| Botão | Valor | Controla |
|---|---:|---|
| `PUBLICATION_WORKER_LIMIT` | 60 (5) | teto do lote do caminho direto; o limite adaptativo começa em 10 e sobe 20 % por ciclo cheio |
| `PUBLICATION_WORKER_STAGED_DISPATCH_CONCURRENCY` | 48 (64) | paralelismo do spool |
| `PUBLICATION_WORKER_STAGED_DISPATCH_LIMIT` | 500 | itens por ciclo do spool |
| `PUBLICATION_WORKER_META_CONCURRENCY` | 20 (5, teto 20) | **semáforo global de chamadas à Meta por processo — o serializador de hoje** |
| `PUBLICATION_WORKER_PREPARATION_LIMIT` / `_CONCURRENCY` | 40 / 3 | lote e paralelismo da preparação; o lote é cortado para caber no lease (12 s por item × 0,6) |
| `PUBLICATION_WORKER_PREPARATION_ITEM_SECONDS` | (12) | segundos por item assumidos para o corte acima |
| `PUBLICATION_WORKER_STAGING_*` | limite 100, concorrência 8, janela 600 s, lease 660 s | staging |
| `PUBLICATION_WORKER_LEASE_SECONDS` | 180 | lease do despacho |
| `PUBLICATION_WORKER_EXPIRE_LIMIT` | (60) | itens encerrados por chamada |
| `PUBLICATION_WORKER_META_POLL_SECONDS` | (30) | espera até consultar o contêiner |
| `PUBLICATION_WORKER_QUEUE_SUMMARY` | (false) | resumo dentro do publicador — deixe desligado; há worker próprio |
| `PUBLICATION_WORKER_ADAPTIVE_COLLAPSE_RATIO` | (0,1) | fração de erro transitório que derruba o limite pela metade (amostra mínima 10) |

Ordem em que os tetos mordem (medido em 07/09/2026): 1) semáforo da Meta por processo;
2) o caminho direto esperar o lote inteiro (`Promise.allSettled`); 3) limite adaptativo
zerado a cada reinício; 4) advisory lock por app da Meta na reserva; 5) cotas por perfil;
6) pool do PostgREST (240 no XL, 41 no Medium).

**Some antes de somar vagas.** Cada processo pode ter até `LIMIT + STAGED_CONCURRENCY +
PREPARATION + STAGING` chamadas ao banco em voo. No Medium (pool 41) três processos com
os valores acima **não cabem**; no XL cabem. Antes de reduzir o compute, reduza os tetos.

---

## 5. Lógica que derruba perfil (e leva a agenda junto)

1. `processInstagramPublication` recebe erro da Graph API com `code 190`.
2. `isMetaTerminalProfileDisconnection` (publication-direct-dispatch.mjs) decide que é
   terminal se: subcode ∈ {458, 459, 460, 463, 464, 467}, **ou** a mensagem contém
   "error validating access token", "invalid access token", "session has been invalidated",
   "log in to www.instagram.com", "follow the instructions given" ou "checkpoint".
3. `finalize_meta_profile_disconnection`: perfil → `offline` com `last_error_*`; **todos os
   itens futuros do perfil** → `ignored` / `meta_profile_disconnected`; o item corrente idem.
4. O gerador não cria mais itens para perfil que não está `online`.

Consequência visível: um perfil que cai leva ~76 itens de uma vez. **Isso não é a fila
falhando**; medido em 07/09: 46 perfis (2.123 itens), 06/09: 265, 05/09: 706. Acompanhe
"perfis caídos por dia" como métrica própria (seção 9).

Outros caminhos que tiram perfil ou app do ar:

- `isMetaAppApiBlocked` ("API access blocked/deactivated") → `flag_meta_app_api_blocked`:
  o **app** fica bloqueado 60 min (`meta_apps.api_block_until`) e tudo que vence na janela
  vira `ignored` / `meta_app_api_blocked`; o claim pula perfis de app bloqueado.
- `401` HTTP ou `190` **sem** as assinaturas acima é **retentável** (`isRetryableGraphFailure`):
  token pode estar em renovação; encerrar na primeira vez custou 3.315 posts em 31/08.
- `profile_removed_by_operator`: remoção manual pela tela.
- Zernio (`zernio_account_disconnected`): produto abandonado; qualquer perfil Zernio restante
  está em `reauthorization_required` e não publica.

---

## 6. Erros: quem é, o que o código faz, o que você faz

### 6.1 Tratados

| Código / assinatura | Origem | Tratamento no código | O que fazer |
|---|---|---|---|
| `190` + assinatura de checkpoint | Meta, conta | derruba perfil (seção 5) | nada; conta descartada por regra |
| `190` / `401` sem assinatura | Meta, token | adia (retentável) até `PUBLICATION_MAX_ATTEMPTS` | conferir renovação de token |
| `9004` "Only photo or video…" | Meta não conseguiu buscar a mídia no R2 | adia | se persistir no mesmo asset, olhar o objeto no R2 |
| `24` "requested resource does not exist", `2` "unexpected error" | Meta | falha retentável | ignorar se esporádico |
| `429` / "rate limit" / `X-App-Usage` | Meta | limite adaptativo cai pela metade; adiamento | se frequente, cota por app (`meta_apps.max_publications_per_minute`) |
| `meta_timeout_criar_container` / `_consultar_status` / `_publicar` | Meta > 25 s | retentável; o **lote inteiro** do caminho direto espera | ver seção 8.3 antes de subir processo |
| contêiner `ERROR` / `EXPIRED` | Meta (transcodificação, mídia) | `metaContainerVerdict` decide retentável ou não | se em massa no mesmo formato, olhar a mídia |
| `profile_min_interval`, `profile_24h_limit`, `provider_minute_limit`, `meta_app_minute_limit` | cotas nossas | adiamento sem gastar tentativa | não é erro |
| `publication_past_due` | corte de atraso | `ignored` | perda por capacidade: ver seção 8.3 |
| `57014` statement timeout, `PGRST002/003`, "fetch failed", `ConnectTimeout` | banco / pool | `defer_publication_infrastructure_failure` com recuo 30 → 900 s; **nunca** vira terminal | olhar pool e rollbacks (seção 9) |
| `40001` "Lease de preparação ausente ou expirado" | preparação demorou mais que o lease | item volta ao pool; o laço **recua** 30 → 300 s se a maioria do lote falha | se aparecer, o banco está lento: medir antes de mexer no lote |
| `P0002` "Item não está sob lease deste worker" | dois processos no mesmo item, ou lease vencido | item volta pelo claim | se frequente, IDs de worker repetidos |
| lease de despacho vencido | processo morto no meio | o claim recupera após `lease_until` | nada |

### 6.2 Não tratados ou tratados mal (pendências conhecidas)

| Sinal | O que é | Estado |
|---|---|---|
| `invalid input value for enum publication_item_status: "processing"` (18×/dia) | algum caminho grava um status que não existe | **não localizado**; procurar em `lib/` e nas migrations que escrevem `status = 'processing'` |
| `42804`, `23502`, `42702` no log do worker (06/09) | bugs de PL/pgSQL em funções novas | corrigidos ao longo de 06/09; se voltarem, é migration nova quebrada |
| `porItemMs` alto sem erro | espera pelo semáforo da Meta, não latência | falta log por fase e por item (plano, seção 6-B) |
| `Promise.allSettled` no caminho direto | um item lento segura o lote | pendente: concorrência deslizante |
| sonda do R2 a cada publicação (3 pedidos) | custo fixo por post | pendente: cache por mídia |
| `meta_apps.max_publications_per_minute` nulo | sem cota por app | pendente: alimentar com `X-App-Usage` |
| `.dashboard-*`, `_cpu_snap`, scripts one-off | lixo de investigação | não são parte do sistema |

---

## 7. Logs: onde cada coisa aparece

| Log | Caminho | O que traz |
|---|---|---|
| saída do publicador | `/root/.pm2/logs/athena-publication-worker-out.log` (`-2`, `-3`) | `tempos do ciclo DIRETO` (fases, `porItemMs`), `tempos do ciclo de despacho` (spool), `ciclo de preparação` (com `estados` e `codigos`), `Dispatcher direto concluído` (`states`) |
| erro do publicador | `…-error.log` | só o que decide rollback: `preparação girando em falso`, `FILA DE CONFIRMACAO REPRESADA`, falhas isoladas, erro fatal. Avisos `MODULE_TYPELESS` são ruído |
| gerador, resumo, analytics, manutenção | `athena-<nome>-out.log` / `-error.log` | cada um loga seu ciclo |
| Postgres | Supabase → Logs → Postgres (ClickHouse: `select … from logs where source = 'postgres_logs'`) | erros com o SQL completo; **é este log que encheu 99 GB em 07/09** |
| PostgREST / API | `source = 'postgrest_logs'` / `edge_logs` | status HTTP por rota |
| telemetria por ciclo | tabela `publication_worker_cycle_events` (`metadata.dispatch…`) | claim, desfechos, preparação, staging |
| histórico por item | `publication_item_events` | cada transição com código e mensagem |

Regras: `console.info` para o esperado, `console.error` só para o que decide rollback; erros
sempre com **código** agregado, nunca um por item; nunca logar `encrypted_access_token`.

---

## 8. Procedimentos

### 8.1 Subir a fila do zero (ordem)

1. Medir o banco vazio: `authenticator` conexões, `xact_rollback` (delta ≈ 0).
2. Encerrar o que venceu **antes** de ligar (`expire_late_publication_items` em laço),
   senão a recuperação de slots reagenda o backlog.
3. `pm2 start athena-publication-worker`; 15 min medindo rollbacks, pool, `porItemMs`,
   vencidos abertos, `lease_lost` = 0.
4. `athena-queue-summary-worker`, `athena-generation-worker`, `athena-profile-analytics-worker`,
   `athena-media-maintenance-worker`, um por vez.
5. Publicadores 2 e 3 só pela conta da seção 8.3.

### 8.2 Reiniciar um publicador

Reinício zera o limite adaptativo para 10 (~3 min até o teto). **Nunca durante onda.** Se
inevitável: `max_publication_lateness_seconds` 300 → 900 antes, reiniciar, devolver 300
quando nenhum item aberto passar de 300 s (`select count(*) … execute_at < now() - interval
'300 seconds'`).

### 8.3 Quando subir (ou descer) um processo

```
processos = teto( pico_por_minuto × segundos_por_post_na_Meta ÷ (20 × 60 × 0,6) )
```

Suba só se `porItemMs` p50 > 8 s **e** vencidos abertos crescendo por 2 min; desça quando
p50 < 3 s por uma hora. Processo novo: `PUBLICATION_WORKER_ID` único, env recriado no PM2.
Hoje (07/09): pico 93/min, 3 s por post → 1 processo bastaria sem o defeito do lote; com
ele, 3. Para 5.000 perfis/hora: 2 a 3, e nunca mais que 5 sem antes corrigir o lote.

### 8.4 Migration / DDL

Todo DDL recarrega o cache de schema do PostgREST (`pgrst_ddl_watch`). Antes de `db push`:
`select count(*) from pg_stat_activity where usename='authenticator'` — abaixo de 30 aplique;
perto do pool, espere. Toda migration que adiciona coluna em `publication_items` **precisa**
adicionar a mesma em `publication_items_archive` (a guarda do arquivo frio falha alto).

### 8.5 Deploy

`vercel --prod` sobe a **árvore de trabalho**: `git status` limpo antes. Deploy na VPS é
`scp` dos arquivos alterados + `node --check` + `pm2 restart` (o repositório da VPS não é
git). Nunca `git pull` na VPS sem conferir o md5 do `publication-direct-dispatch.mjs`.

### 8.6 Trocar de projeto Supabase / chaves

Três lugares na VPS (`.env.local`, `.env.worker`, env salvo do PM2), `.env.local` local,
três variáveis na Vercel (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) + deploy, `supabase link`, `max_rows` = 5000 na Data API,
Redirect URL do Auth, `alter role authenticator set statement_timeout = '30s'`.

### 8.7 Reduzir/aumentar compute

Reinicia por ~3 min: mesma cerimônia do 8.2 (corte para 900 s antes, 300 s depois), com o
dono acordado, nunca de madrugada. Ao voltar para Medium, o pool cai para 41: recalcule os
tetos da seção 4.

---

## 9. Onde olhar primeiro, por sintoma

| Sintoma | Primeiro lugar | Depois |
|---|---|---|
| "está falhando muito" | `select status, last_error_code, count(*) … updated_at >= <hora>` | se for `meta_profile_disconnected`: contar perfis distintos; é conta caindo, não fila |
| posts saindo atrasados | `porItemMs` no log + vencidos abertos + `provider_creation_started_at - execute_at` p50/p90 | semáforo da Meta (seção 8.3) antes de qualquer botão |
| posts vencendo (`publication_past_due`) | os mesmos + `pico por minuto` da demanda (`execute_at` por minuto) | capacidade: seção 8.3 |
| API 521 / painel morto | `pg_stat_activity` pelo pooler; `pg_ls_logdir()` (log gigante?); `xact_rollback` delta | ver o histórico de 07/09 no mapa de controles |
| pool cheio / `PGRST003` | quem está nas conexões (`pg_stat_activity` por `query`) | laço em erro (rollbacks) antes de "muitos workers" |
| `40001` no log do Postgres | `ciclo de preparação` no log do worker (`codigos`) | banco lento; não aumente lote |
| CPU do banco alta com fila normal | `pg_stat_statements` por `total_exec_time` (resumos, arquivo frio, analytics) | seção 5 do plano |
| perfis sumindo | `instagram_profiles.last_error_message` dos `offline` de hoje | checkpoint = descartar; `401`/renovação = esperar |
| dashboard vazia | `get_dashboard_analytics_summary` responde em ms? migrations 421/422 aplicadas? | `refresh_dashboard_summary` no cron |

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
```

---

## 10. Armadilhas de medição (todas já custaram um diagnóstico errado)

- `pg_stat_statements` não conta chamada que termina em erro; contador parado com pool cheio é laço de erro.
- `published_at` é confirmação, 30–180 s depois do envio; vazão é `provider_creation_started_at`.
- `updated_at` é reescrito por reenfileiramento e por cópias; para separar "hoje" use `execute_at` e `published_at`.
- Paginar `publication_items` sem ordem total (`execute_at, id`) repete e perde linhas.
- `connection_limit` do role (120) não é o pool; o pool é o do PostgREST (41 Medium, 240 XL).
- O dashboard da Supabase mostra o volume de dados; o log do Postgres fica em `/var/log/postgresql`, no volume de sistema, invisível para ele.
- Um `porItemMs` alto não é Meta lenta até que o log por fase diga; hoje é espera de vaga.
- "3 workers e várias falhas": falha por perfil caído aparece em lote e não depende de workers.

---

## 11. Histórico curto (detalhes no mapa de controles)

| Data | O que | Lição |
|---|---|---|
| 31/08 | concorrência 64 → 160 apagou 3.315 posts | advisory lock por org; infra nunca vira terminal |
| 02/09 | teto por minuto 600 → 1.200 derrubou a API | o teto alonga a posse do lock; pool 41 |
| 06/09 | dois itens envenenados travaram a confirmação | recuo exponencial; denominador mínimo |
| 07/09 | laço de preparação a 78 erros/s por 17 dias; log de 99 GB encheu o volume; projeto novo `athena` | recuo no laço; log com código; despachante da Vercel removido; 3 publicadores |

---

## 12. Checklist de atualização (toda mudança na fila)

- [ ] Mudou um teto, um env ou um padrão do código? Atualize a seção 4 **e** o `.env.worker` da VPS no mesmo commit.
- [ ] Novo código de erro, novo tratamento ou novo caminho terminal? Linha na seção 6, com origem e o que fazer.
- [ ] Nova regra de negócio ou decisão do dono? Seção 3, com data.
- [ ] Nova função SQL no caminho da fila? Tabela da seção 1.3, com custo medido.
- [ ] Nova coluna em `publication_items`? Espelhe em `publication_items_archive` na mesma migration.
- [ ] Novo processo PM2? Seção 1.1 e a conta da seção 8.3.
- [ ] Incidente? Uma linha na seção 11 e a seção correspondente no mapa de controles.
- [ ] Mudou como se mede algo? Seção 9 ou 10.

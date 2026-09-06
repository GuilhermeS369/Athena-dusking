# Retenção de logs e espaço no Postgres — 05/09/2026

Por que o banco saiu de ~600 MB (21/08) para ~15 GB, e o que foi feito.

## O que foi medido

Sem acesso SQL direto (não há senha de Postgres nem `psql` no ambiente): contagem
de linhas é exata via PostgREST; tamanho é estimativa de linhas × bytes/linha
medidos no snapshot de 21/08 (`.dashboard-db-table-stats.json`) e em amostras de
payload.

**A curva tem data: 24–25/08.** Linhas criadas por dia:

| | 26/08 | 27/08 | 29/08 | 31/08 | 02/09 | 03/09 |
|---|---:|---:|---:|---:|---:|---:|
| `instagram_observability_events` | 24.156 | 133.253 | 244.453 | 293.082 | 599.808 | 281.699 |
| `publication_item_events` | 57.272 | 123.408 | 239.011 | 287.466 | 591.980 | 270.926 |
| posts publicados | 21.773 | 30.138 | 42.613 | 52.700 | 60.623 | 67.891 |

O gatilho é operacional — a frota foi de 1.140 para 5.474 perfis e a publicação
de 0 para ~68 mil posts/dia. O multiplicador é de log: cada post publicado deixa
~6 linhas de histórico.

Onde estava o espaço:

| Tabela | Linhas | Estimativa |
|---|---:|---:|
| `instagram_observability_events` | ~2,66 M | ~5–6 GB (13 índices, incl. GIN) |
| `profile_analytics_payload_archives` | 142.914 | ~1,5–2 GB (41,7 KB/linha de JSON) |
| `publication_item_events` | ~2,75 M | ~1,4 GB |
| `profile_post_analytics_snapshots` | 277.778 | ~1,4 GB |
| `publication_items` | 1.086.701 | ~1,2 GB |
| `zernio_publication_request_rollups` | 773.253 | ~0,44 GB |
| `media_asset_delivery_attempts` | ~1,01 M | ~0,38 GB |

## As três causas, e o que mudou

### 1. A janela de retenção não era um parâmetro

`maintain_instagram_observability_hot_source` e
`maintain_instagram_legacy_log_retention_source` recebiam `p_retention_days` e
faziam `greatest(14, least(coalesce(p_retention_days, 14), 14))` — 14 para
qualquer entrada. Mudar o número no chamador não mudava nada.

A **401** abre a janela (5 a 30 dias) e a rota passa a pedir 7. O piso de 5 dias
mora no clamp, não num comentário: nenhum chamador futuro consegue furar.

### 2. Cinco tabelas de log sem poda nenhuma

Entraram como fontes de retenção na **401**:

| Fonte nova | Tabela | Linhas / com mais de 5 dias |
|---|---|---:|
| `media_delivery_attempts` | `media_asset_delivery_attempts` | 1.012.572 / 476.748 |
| `analytics_step_events` | `profile_analytics_refresh_step_events` | 882.968 / 455.773 |
| `incident_entities` | `instagram_observability_incident_entities` | 610.358 / — |
| `batch_terminal_outcomes` | `publication_batch_terminal_outcomes` | 469.122 / 188.822 |
| `analytics_item_events` | `profile_analytics_refresh_item_events` | 139.918 / — |

`batch_terminal_outcomes` só apaga linha **já reconciliada** — a pendente é fila
de consolidação de lote, e apagá-la perderia o lote calado.

### 3. O arquivo de payload de analytics era peso morto

142.914 linhas escritas entre 22/08 e 03/09, payload de 41,7 KB de média (as de
`posts` chegam a 95 KB). Parou porque a coleta migrou para a Meta, e
`lib/integrations/meta-analytics.ts` decidiu explicitamente não arquivar payload.

Quem lê cada classe, verificado arquivo por arquivo: `current` é lida pela tela
de detalhe do perfil; `posts` e `daily` não são lidas por ninguém. A **402** cria
a poda por classe e a rota horária de analytics apaga `posts` e `daily`;
`current` fica inteira.

Junto foi preciso soltar a chave estrangeira de
`profile_post_analytics_snapshots.payload_archive_id`: 231.823 das 277.778 linhas
apontam para um arquivo `posts`, e manter o `on delete set null` significaria
reescrever 83% da tabela a cada poda. O id fica órfão de propósito — mesma
decisão da 333 nas tabelas frias.

## O que NÃO mudou, e por quê

- **Fila de publicação.** O arquivamento e o arquivo frio já rodam:
  1.003.468 dos 1.086.701 itens já têm `archived_at`, e 169.450 já estão em
  `publication_items_archive`. O que resta é o passivo dentro da janela de 7 dias
  do dreno, que a `media-maintenance-worker` drena a ~149 itens/min.
- **`MEDIA_MAINTENANCE_COLD_STORAGE_BATCH`.** O comentário medido em 01/09 no
  worker é explícito: lote de 50 estourou o statement timeout, 25 é o valor com
  folga, e se voltarem timeouts o remédio é **baixar** o lote. Não foi tocado.

## Operação

```bash
npx supabase db push          # aplica 401 e 402
npm run worker:log-retention:once   # drena o passivo (~2 M linhas)
```

O dreno chama as mesmas funções do cron, em laço, com o mesmo freio de pressão da
fila (`get_publication_generation_pressure_signal`): se a publicação estiver com
atraso crítico, ele para. Rodar de novo continua de onde parou.

**Espaço devolvido ≠ espaço liberado.** Só o `drop` de partição diária de
`instagram_observability_events` devolve arquivo ao sistema operacional na hora.
Todo o resto vira espaço reutilizável pelo Postgres, e o número do painel do
Supabase só cai depois de `vacuum full` (trava a tabela e precisa de disco livre
do tamanho dela) ou `pg_repack`.

**A rota e o cron precisam de deploy.** `RETENTION_DAYS = 7` e as fontes novas
estão em `app/api/internal/instagram-observability-maintenance/route.ts`; a linha
horária nova está em `deploy/instagram/observability-maintenance.cron` e precisa
ser instalada na VPS. Até lá, quem poda é o dreno manual.

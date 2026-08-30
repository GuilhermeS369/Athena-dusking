# B4 — Retenção da fila de publicação

Fecha o item B4 do plano de espaçamento + gargalos de escala. Escrito **depois**
de B1 e B2, com o número que o plano mandou usar como gatilho (B1.2).

## Medição (29/08/2026, depois de B1 e B2)

| Tabela | Linhas | Observação |
|---|---:|---|
| `publication_items` | **462.193** | total físico |
| — arquivados (`archived_at not null`) | **336.334** | **73% da tabela** |
| — ativos | 125.859 | o que a operação realmente usa |
| `publication_item_events` | **1.005.153** | 2,2× a tabela de itens |

Idade dos arquivados: 25.155 com mais de 7 dias, **zero com mais de 14**. O
arquivamento em massa é recente (foi B1, hoje).

Idade dos eventos: 227.873 com mais de 7 dias, 16.929 com mais de 14, **zero com
mais de 30**.

## Achado principal: arquivar é marcar, não remover

`clean_publication_queue_finished` grava `archived_at` e a linha **continua na
tabela quente**. Dos 34 índices de `publication_items`, **23 não filtram por
`archived_at`**. Quatro deles não filtram por nada:

- `publication_items_batch_idx` — `(organization_id, batch_id, created_at)`
- `publication_items_batch_profile_idx` — `(organization_id, batch_id, profile_id, created_at)`
- `publication_items_org_batch_status_execute_idx` — `(organization_id, batch_id, status, execute_at)`
- `publication_items_org_profile_status_execute_idx` — `(organization_id, profile_id, status, execute_at desc)`

E outros quatro indexam `status = 'published'`, que é praticamente todo o
conjunto arquivado:

- `publication_items_dispatch_telemetry_published_idx`
- `publication_items_org_profile_published_idx`
- `publication_items_profile_published_at_idx`
- `publication_items_profile_format_published_idx`

**Consequência:** os 336 mil arquivados continuam custando heap e oito índices.
B1 e B2 tiraram a pressão *operacional* (consultas de fila deixaram de varrer
lixo, porque os índices de fila são parciais), mas **não devolveram espaço**.

Quem esperar que a memória do Supabase caia só por causa de B1 vai se decepcionar.
O ganho de memória exige tirar as linhas da tabela — que é exatamente B4.

## Eventos: já existe retenção, travada em 14 dias

`maintain_instagram_legacy_log_retention_source` (migration 293) apaga
`publication_item_events` com mais de 14 dias. O parâmetro `p_retention_days`
**é ignorado na prática**:

```sql
cutoff := now() - make_interval(days => greatest(14, least(coalesce(p_retention_days, 14), 14)));
```

`greatest(14, least(x, 14))` é sempre 14. Está certo para o que foi desenhado
(um piso de segurança contra apagar log recente por engano), mas o nome do
parâmetro promete algo que ele não faz. É a causa de os eventos pararem em 1
milhão em vez de crescerem sem fim — o volume é simplesmente 14 dias de
telemetria na taxa atual.

**Não é o gargalo hoje.** A 5.000 perfis vira ~2,5 milhões de linhas, e aí o
corte de 14 dias precisa ser reavaliado — com o parâmetro passando a valer de
verdade.

## Política proposta

1. **Itens arquivados há mais de 7 dias saem de `publication_items`** para uma
   tabela fria `publication_items_archive`, com a mesma forma e **um** índice
   `(organization_id, archived_at desc)`. Corte de 7 dias porque o painel de
   histórico não olha além disso e o teto de duração de plano é 7 dias
   (migration 329) — nada em voo pode ser mais antigo.
2. **A leitura de histórico passa por uma view** `publication_items_history` que
   une quente e fria. Sem isso, mover linhas quebra o painel de arquivados
   (`publication_items_archived_org_idx` existe justamente para essa tela).
3. **Movimentação em blocos**, no worker de manutenção que já roda (o mesmo de
   B2), com teto de tempo por ciclo. Nunca num `delete` só.
4. **Eventos seguem em 14 dias**, mas `p_retention_days` passa a valer entre 3 e
   14 — para poder apertar quando a frota crescer, sem migration nova.

## Urgência: média. Não é para hoje

O gatilho que o plano definiu (B1.2) diz para medir memória antes e depois. A
pressão operacional aguda **acabou**: a fila de arquivamento está em dezenas de
itens, os vencidos zeraram e a vazão subiu para ~4.000/h.

O que **não** melhorou é espaço em disco/memória, e não vai melhorar sem mover
linha. Então:

- **Agora:** nada. B1+B2 seguram o crescimento; o volume atual é 462 mil linhas,
  que o Small aguenta.
- **Gatilho para executar:** memória do Supabase acima de 85% de forma sustentada,
  disco acima de 80%, **ou** `publication_items` passando de 1 milhão de linhas.
- **Obrigatório antes de 5.000 perfis.** Um plano de 7 dias para 5.000 perfis
  materializa ~840 mil itens de uma vez. Com a tabela já em 462 mil, isso passa
  de 1,3 milhão — acima do gatilho, num salto só.

## Particionamento (B4.2) — avaliado e descartado por ora

Particionar `publication_items` por período resolveria de vez (`drop partition` é
instantâneo). Mas:

- exige recriar a tabela e **todas as 34 restrições/índices**, com a fila correndo;
- a chave de partição teria de entrar em toda chave primária e única, incluindo
  `idempotency_key` — que é justamente a garantia contra publicação duplicada;
- as ~180 migrations que tocam `publication_items` passariam a conviver com uma
  estrutura diferente da que assumem.

**Custo alto e risco direto sobre a garantia de não duplicar post.** A tabela
fria de arquivo morto entrega quase o mesmo ganho sem tocar em nada disso. Se um
dia o volume justificar, particionar a tabela **fria** é seguro e reversível —
começar por ali, nunca pela quente.


## Achado que mudou o desenho — a cascata (30/08/2026)

Ao implementar, apareceu um problema que o plano original não previa e que teria
causado **perda de histórico silenciosa**:

**Oito chaves estrangeiras apontam para `publication_items` com
`on delete cascade`.** Um "mover" ingênuo — insert no frio, delete no quente —
apagaria junto:

| Tabela | Linhas | Importa? |
|---|---:|---|
| `publication_item_media` | **474.070** | **SIM** — é o registro de qual mídia foi publicada |
| `publication_item_events` | 1.033.978 | não — já é podada aos 14 dias |
| `publication_profile_daily_reservations` | — | não — reserva diária, já expirada |
| `publication_schedule_randomizations` | — | não — log de sorteio de horário |
| `publication_dispatch_rate_reservations` | — | não — expira em minutos |
| ledger de circuito / saúde de entrega | — | não — telemetria |
| `publication_failure_acknowledgements` | 351 | não — o alerta morre com o arquivamento |

**Correção aplicada:** a mídia é copiada para o frio **antes** do delete. O teste
que prova isso é o mais importante do arquivo — se alguém inverter a ordem um
dia, ele quebra.

## Decisões que a implementação obrigou a tomar

**As tabelas frias não têm chave estrangeira.** Um arquivo não pode restringir a
operação viva: se um `media_asset` for apagado, o frio guarda o id órfão, que é
justamente o registro histórico que se quer manter.

**O contador `totals.archived` não passou a somar a tabela fria.** Ele existe no
tipo mas **não é renderizado em tela nenhuma**, e a função que o calcula é a
leitura mais cara do painel. Encarecê-la por um número que ninguém mostra seria
troca ruim. O número que aparece de verdade é o card "Aguardando arquivamento"
do painel operacional (B2.2), que mede a fila quente.

**A UI nunca pede itens arquivados.** `/api/publications` aceita
`archived=only|include`, mas nenhuma tela envia o parâmetro — todas caem no
padrão `exclude`. Por isso mover linhas para o frio **não quebra nenhuma tela**.

## Estado: pronto e DESLIGADO

Migration 333 aplicada em produção (criar tabela e função é inerte). O passo no
worker existe mas nasce desligado (`MEDIA_MAINTENANCE_COLD_STORAGE_ENABLED=false`).

**Ligar quando:** memória do Supabase acima de 85% de forma sustentada, disco
acima de 80%, **ou** `publication_items` passando de 1 milhão de linhas.

O upgrade para 4 GB (30/08) afastou o gatilho de memória, mas **não** o de
tamanho: um plano de 7 dias para 5.000 perfis materializa ~840 mil itens de uma
vez e, sobre as 462 mil atuais, estoura 1,3 milhão num salto só. Continua
obrigatório antes de escalar a frota.


## Ligado em 30/08/2026 — e o que apareceu ao ligar

A decisão de esperar o gatilho foi revista: capacidade desligada não melhora
nada, e ligar **agora** é mais seguro do que ligar depois. Motivo concreto: dos
344 mil arquivados, só **25.155 tinham mais de 7 dias**. Os outros ~320 mil foram
arquivados no mesmo dia (pelo B1), então ficam elegíveis aos poucos, ao longo de
uma semana. Ligar hoje começa uma drenagem gradual; ligar em dezembro seria
encarar tudo de uma vez.

### O timeout, e a causa que era maior que o recurso

A primeira execução morreu com `canceling statement due to statement timeout`.
Não era o arquivo frio: apagar uma linha de `publication_items` obriga o Postgres
a resolver cada chave estrangeira que aponta para ela, e **duas tabelas grandes
não tinham índice** na coluna referenciadora:

| Tabela | Linhas varridas por item apagado |
|---|---:|
| `instagram_observability_events` | 613.611 |
| `profile_post_analytics_snapshots` | 150.352 |

**~764 mil linhas varridas para apagar UMA publicação.** Isso encarecia toda
exclusão de item no sistema, em qualquer caminho — o arquivo frio só foi o
primeiro a bater no teto de tempo e tornar o problema visível. Corrigido na
migration 334, com índices parciais (as colunas são anuláveis).

### Custo real, medido depois dos índices

| Lote | Tempo |
|---|---:|
| 1 item | 960 ms |
| 10 itens | 1.699 ms |
| **50 itens** | **4.019 ms** ← escolhido |
| 100 itens | 7.973 ms ← na beira do limite de 8 s |

São ~900 ms fixos mais ~80 ms por item, porque cada delete resolve 14 chaves
estrangeiras. O lote de 500 do desenho original levaria ~40 s.

### Estado

4.361 itens movidos, **4.363 linhas de mídia** junto (mais mídias que itens
porque carrossel tem várias posições por item — a proporção correta). Ritmo de
~10 mil/hora, zero erro novo. Restam 20.794 elegíveis.

## O que NÃO fazer

- **Não tornar parciais os quatro índices sem filtro.** Eles servem às telas de
  lote e de perfil, que olham histórico. Torná-los parciais em `archived_at is
  null` esconderia os arquivados dessas telas.
- **Não apagar item arquivado.** Ele é o histórico do usuário. A política é
  mover, não destruir.
- **Não confiar em `p_retention_days` para eventos** enquanto o clamp de 14 dias
  estiver ali. Hoje o parâmetro não faz nada.

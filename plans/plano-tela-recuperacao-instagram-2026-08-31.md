# Plano — Tela de Recuperação (Instagram)

**Data:** 2026-08-31
**Branch:** `codex/x-twitter-module`
**Status:** em execução — este arquivo é o registro vivo. Marcar `- [x]` com data conforme cada etapa
for concluída **e validada**.

## Onde estamos

| Etapa | Estado |
|---|---|
| 0 — Registro | ✅ concluída |
| 1 — Banco: schema (`347`) | ✅ concluída · pgTAP 16/16 |
| 2 — Banco: a régua (`348`) | ✅ concluída · pgTAP 24/24 · **2 itens presos em produção** |
| 3 — Banco: esteira e acompanhamento (`349`) | ⏳ em andamento |
| 4 — Disparo (rota interna + cron na VPS) | ⬜ |
| 5 — Leitura (libs e rotas GET) | ⬜ |
| 6 — Ações (rotas POST/PATCH) | ⬜ |
| 7 — Tela (`/recuperacao`) | ⬜ |
| 8 — Fechamento (lint, tsc, aceitação) | ⬜ |

**Presos em produção, não em código** — os dois vão ficar abertos até alguém rodar contra o banco
real, e não devem ser marcados antes disso:
1. Medir a duração de um chunk no maior grupo real (GG LEXY, ~457 perfis × 30 dias) contra o teto de
   ~8 s **antes** de ligar qualquer cron.
2. Aceitação contra a análise de 31/08 (33 / 55 / 39 e as medianas por grupo), rodando com a janela
   de 25 a 31/08 e com os dois desvios conscientes desligados por parâmetro.

## Registro de execução

| Data | Etapa | O que foi feito |
|---|---|---|
| 2026-08-31 | 0 | Plano registrado. Numeração das migrations resolvida: **347–349** (ver abaixo). |
| 2026-08-31 | 1 | `347_recovery_schema.sql` aplicada no Postgres local via `supabase db reset` (todas as migrations do zero) e `supabase/tests/347_recovery_schema.test.sql` **16/16 verde**. |
| 2026-08-31 | 2 | `348_recovery_compute.sql` (a régua) aplicada e `supabase/tests/348_recovery_compute.test.sql` **24/24 verde**. Suíte completa segue em 45 falhas — igual ao baseline. |

---

## Contexto

Hoje o operador só tem duas saídas para um perfil com desempenho ruim: deixar rodando ou excluir do
Athena + Zernio. Não existe passo intermediário — nenhum lugar onde ele possa isolar o perfil, trocar
a mídia, reagendar e observar se o problema era a conta ou o conteúdo.

Uma análise de 1.000 perfis e ~84 mil posts (artifact "A régua de corte pra recuperação", 31/08/2026)
produziu uma régua fechada que separa dois tipos de perfil queimado, e deixou claro por que esse passo
importa: no GG LAURINHA, medir durante uma queima de mídia condenava **42 perfis em vez de 4** — 38
contas famintas tratadas como mortas. A régua diz *quem olhar*. O que falta é a esteira.

**A entrega:** uma página `/recuperacao` que lista, por grupo, apenas os perfis elegíveis pela régua;
permite marcar, mandar para um grupo de recuperação (`<nome> rec`), cancelar as filas de postagem e
excluir do Athena + Zernio; e depois acompanha se o perfil recuperou — comparado com o grupo de onde
ele saiu, nos mesmos dias.

**Resultado esperado:** a decisão de excluir passa a ter base, e o operador enxerga num lugar só
quantos perfis novos se elegeram desde a última rodada.

---

## Decisões travadas com o usuário

| Decisão | Escolha |
|---|---|
| Mandar para recuperação | **Move** o perfil. O banco obriga: `unique (organization_id, profile_id)` em `profile_group_members` desde a migration 018 — um perfil pertence a **um** grupo. |
| Cálculo da régua | **Job diário + snapshot em tabela.** A tela lê o snapshot. Botão "Recalcular" manual. |
| Braço A/B randomizado | **Não.** O operador troca o vídeo de todos. Todas as ações são manuais e explícitas. |
| Leitura de "melhorou/piorou" | **Contra a mediana do grupo de origem, nos mesmos dias.** Ver abaixo. |
| Sinal rápido dos primeiros dias | **Taxa de zerados.** Vira antes das views. |
| Fim da esteira | **O operador decide.** A tela calcula e recomenda; nada acontece sozinho. |
| Marcos de mídia | **Entram.** Data da troca por grupo, quantidade, e comum vs reprocessada. |
| Janela de análise | **Últimos 30 dias.** |
| Amostra mínima por grupo | **Nenhuma regra de política.** O toggle em `/grupos` é o filtro. (Existe uma guarda **matemática** separada — ver "Guardas numéricas".) |
| Rollout | **Sem feature flag.** Menu para todos; escrita só para `admin`/`operator`. |
| População da mediana | **Grupo ∪ esteira do grupo.** Desvio consciente da régua — ver abaixo. |
| Origem do pico | **A partir do último marco de troca de mídia**, com piso na janela. Desvio consciente — ver abaixo. |
| Histórico após exclusão | **Mantém o registro.** Sem FK para o perfil; guarda `username_at_entry`. |

### A leitura do resultado (a pergunta que o usuário fez)

> *"pra saber se melhorou é só calcular os últimos posts feitos no período, é isso?"*

Quase. Os posts feitos depois da entrada são a metade certa. Falta **contra o quê** comparar, por dois
motivos: **regressão à média** (escolher os piores e medir melhora produz melhora sozinho) e **mídia
nova do grupo** (se a leva engrenar, todo mundo sobe e o crédito iria indevidamente para o
reprocessamento).

Como todos vão receber vídeo novo, não há braço de controle. Mas há um controle já no banco: **o grupo
de origem, nos mesmos dias**.

```
índice = vs_desde_a_medição  ÷  M_origem_nos_mesmos_dias
```

E o veredito reusa a **própria régua que condenou** — a saída fica simétrica à entrada:

| Índice | Veredito | Significado |
|---|---|---|
| `>= 0,40` | **Recuperado** | Passou do corte aberto; a régua não o pegaria mais. |
| `0,25 – 0,40` | **Parcial** | Saiu do corte apertado, ainda cairia no aberto. |
| `< 0,25` | **Não recuperou** | Continua abaixo do corte apertado. |

Antes de acumular posts suficientes, o veredito é `⏳ aguardando volume` e o card mostra a taxa de
zerados como termômetro.

---

## A régua

Fonte única: `public.profile_analytics_daily_metrics`
(PK `(organization_id, profile_id, provider, metric_date)`, colunas `posts`, `views`,
`coverage_status in ('complete','partial')`).

**Preparação**
1. Descartar o **dia mais recente** do conjunto — sempre parcial.
2. Descartar linhas com `posts = 0` — dia sem postagem não é dia ruim, é dia que não existe.
3. Por perfil: `posts_total`, `views_total`, `vs = views_total / posts_total`,
   `melhor_dia = max(views/posts)` entre os dias do perfil.
4. Julgáveis: `posts_total >= 60`.
5. `M` = **mediana** de `vs` entre os julgáveis do grupo (`percentile_cont(0.5)`, nunca média).

**Filtro 1 — nunca engrenou:** `vs < M * 0,25` (ou `0,40`) **E** `melhor_dia < M`.
O segundo termo é o **veto vitalício** — a peça central: sem ele, medir durante uma queima condena 42
perfis em vez de 4.

**Filtro 2 — desabou**
- Janela recente: somar de trás para frente até **60 posts**; `vs_recente` = views ÷ posts da fatia.
  Contado em posts, nunca em dias.
- `MR` = mediana de `vs_recente` no grupo.
- `pico` = maior mediana diária de views/slot do grupo.
- **Portão de saúde:** só roda se `MR >= pico * 0,60`.
- Condição: `melhor_dia >= M` **E** `vs_recente < MR * 0,25`.

**Regra de ouro:** `M`, `MR` e `pico` recalculados a cada execução. Nenhum limiar absoluto vai para
código ou configuração.

Os dois ajustes (25% e 40%) do Filtro 1 ficam lado a lado na tela. O Filtro 2 **não tem ajuste**.

### Cuidado com os números do portão

É fácil trocar `pico` por `pico * 0,60`. Na análise de 31/08 os pares são `MR` **contra o limiar**:

| Grupo | MR | limiar (60% do pico) | pico implícito | saúde (MR ÷ pico) | Nível 2 |
|---|---|---|---|---|---|
| GG BIEL | 27,7 | 21,8 | 36,3 | 76% | ligado |
| GG LEXY | 32,4 | 19,9 | 33,2 | 98% | ligado |
| GG LAURINHA | 13,4 | 15,8 | 26,3 | **51%** | **desligado** |

O pico de 26,3 do LAURINHA é o valor do dia 25/08 no gráfico da análise — confere. Gravar
`peak_daily_median` e **derivar** o limiar na leitura; nunca gravar o limiar como se fosse o pico.

### Janela recente — como escrever

`sum(posts) over (partition by profile_id order by metric_date desc rows between unbounded preceding
and 1 preceding)`. O frame termina em `1 preceding` **de propósito**: assim o dia que cruza os 60
posts entra inteiro. Com `current row` ele ficaria de fora, e perfis de poucos posts/dia perderiam a
última leva. Perfis com menos de 60 posts na janela ficam com `vs_recente` **nulo** (não zero) e não
podem cair pelo Filtro 2.

### Dois desvios conscientes da régua — e por quê

O artifact é fonte fechada, então qualquer desvio precisa estar registrado no cabeçalho da migration.
São dois, ambos decididos com o usuário:

**1. A população da mediana é `membros do grupo ∪ membros da esteira do grupo`.**
Sem isso a régua tem uma **catraca**: tirar os piores sobe `M` na rodada seguinte, o que acusa os
próximos piores, que ao saírem sobem `M` de novo — o grupo drena por aritmética, não por desempenho.
Os candidatos continuam saindo **só** dos membros do grupo; a esteira entra apenas na conta da
mediana. Na prática isso devolve o sentido que a régua queria: *a mediana da população original do
grupo*.

**2. O `pico` é calculado a partir do último marco de troca de mídia do grupo** (com piso em
`window_start`). O pico é um `max` sobre a janela; um dia excepcional de três semanas atrás pode
manter `MR/pico < 0,60` para sempre e o Filtro 2 nunca mais rodar. Cada leva de mídia tem seu próprio
teto, e comparar a mídia de hoje com o pico da leva anterior compara coisas diferentes. Sem marco
registrado, cai no comportamento original (janela inteira).

---

## Arquitetura de dados

### As três restrições que moldam tudo

| Restrição | Onde está | Consequência |
|---|---|---|
| `statement_timeout` ~8s no papel do PostgREST | [plans/plano-correcao-cancelamento-fila-em-lote-2026-08-29.md](plans/plano-correcao-cancelamento-fila-em-lote-2026-08-29.md) — `57014` confirmado ao vivo | O cálculo é **um grupo por statement**, e o laço entre grupos acontece **entre chamadas HTTP**. Um `for` em plpgsql percorrendo 12 grupos gasta o mesmo orçamento de 8s de um statement gigante — foi a lição da migration 324. |
| `max_rows = 5000`, vale até para `service_role` e RPC `returns table` | CLAUDE.md, [lib/supabase/paginate.ts](lib/supabase/paginate.ts) | Série do sparkline vai como **jsonb em uma linha**; listas têm teto explícito que **recusa** em vez de cortar. |
| `auto_expose_new_tables` **comentado** em [supabase/config.toml](supabase/config.toml) | verificado | Tabela nova sem `grant` explícito **não existe** para a Data API. Toda migration precisa dos grants + `notify pgrst, 'reload schema'`. Sem isso tudo compila e nada responde. |

### Princípio de custo

A aba **Elegíveis** nunca toca `profile_analytics_daily_metrics`: lê só o snapshot da última execução.
A aba **Em recuperação** também não — ela lê `recovery_cohort_observations`, escrita pelo mesmo job
diário. O trabalho pesado acontece uma vez por dia, dentro do Postgres.

Guardar a observação diária (em vez de calcular sob demanda) resolve três coisas de uma vez: a aba
abre instantânea, o gráfico de acompanhamento **precisa** de série temporal, e nenhuma agregação
pesada fica no caminho de renderização.

### Migrations novas

Numeração a partir de **347** — resolvido em 2026-08-31. Quando este plano foi escrito, a 344
estava untracked no working tree e a numeração apontava para 345. Entre o planejamento e a execução,
três commits entraram na branch (`c033274`, `e2babf3`, `cdee804`) versionando **344, 345 e 346**
(filtro e intervalo de data de adição no catálogo de perfis). A árvore está limpa e nada aqui depende
dessas três. **Conferir a numeração de novo antes de criar o primeiro arquivo** — a branch é
compartilhada e o mesmo atropelo pode acontecer outra vez.

**Sem tabela de configuração.** Os parâmetros (60 posts, 0,25/0,40, 0,60, 30 dias) são **argumentos da
RPC com default documentado**, e cada execução os **copia para a linha de `recovery_analysis_runs`**.
Isso dá o que importa — snapshot imutável, o passado não se reescreve — sem uma tabela de 20 colunas e
20 `check` para manter. Se um dia precisar de ajuste por organização, a tabela entra depois sem
quebrar nada.

#### `347_recovery_schema.sql`

**Colunas em `profile_groups`:**
```sql
alter table public.profile_groups
  add column if not exists recovery_enabled boolean not null default false,
  add column if not exists recovery_source_group_id uuid
    references public.profile_groups (id) on delete set null;

-- Um "X rec" por origem. Sem isto, dois cliques simultâneos criam dois
-- "GG LEXY rec" e a esteira se parte em duas.
create unique index profile_groups_one_recovery_per_source_idx
  on public.profile_groups (organization_id, recovery_source_group_id)
  where deleted_at is null and recovery_source_group_id is not null;
```
A esteira é identificada pelo **ponteiro**, nunca por parsear o sufixo `" rec"` do nome — o operador
pode renomear o grupo a qualquer momento.

**Seis tabelas:**

| Tabela | Papel | Chave |
|---|---|---|
| `recovery_analysis_runs` | uma linha por execução: `status`, `trigger_source`, os parâmetros copiados, `latest_metric_date` (o dia descartado), `window_start/end`, contadores, `last_error_message` | `id` |
| `recovery_group_stats` | por grupo por execução: `status`, `judgeable_profiles`, `profiles_idle`, `median_vs`, `median_recent_vs`, `peak_daily_median`, `peak_from_date`, `health_ratio`, `health_gate_passed`, os cortes derivados, contagens, `last_metric_date`, `daily_median_series jsonb` | `(run_id, group_id)` |
| `recovery_candidates` | um candidato por execução: `reason ('never_started'\|'collapsed')`, `severity ('severe'\|'moderate')`, métricas, `vs_index`, `best_day_index`, `recent_index`, `last_active_date`, `stale_days`, `already_in_recovery` | `(run_id, profile_id)` |
| `recovery_cohort_members` | a esteira: origem, esteira, `entered_on`, **`measurement_start_on`**, `entry_reason`, baseline congelado, `status`, saída com decisão/índice/nota, `username_at_entry` | `id` |
| `recovery_cohort_observations` | leitura diária de cada membro: `posts_since`, `vs_since`, `origin_median_vs`, `recovery_index`, `verdict`, `measured_posts`, `zero_view_posts`, `stale_days` | `(cohort_member_id, observed_on)` |
| `recovery_media_milestones` | marcos: `happened_on`, `media_count`, `batch_kind ('common'\|'reprocessed')`, `note` | `id` |

Mais `alter table public.media_assets add column content_origin text check (content_origin in
('common','reprocessed'))` — nulo = desconhecido, para não reescrever o passado.

**`primary key (run_id, profile_id)` em candidatos é seguro**: os dois filtros são mutuamente
exclusivos por construção — o 1 exige `melhor_dia < M`, o 2 exige `melhor_dia >= M`.

**A série do sparkline é `jsonb`, não tabela.** São ≤ 30 pontos por grupo por execução
(`[{"d":"2026-08-20","m":812.5,"n":41}]`). Como tabela seriam `runs × grupos × dias` linhas, sujeitas
ao teto de 5000 e à regra de ordem total do `row-limit-guard`. Em jsonb, a tela lê a série junto com
a linha do grupo, numa resposta de poucas linhas.

**`measurement_start_on` separado de `entered_on`** — entre entrar na esteira e o primeiro post com
mídia nova passam 1 a 3 dias, e nesse meio a fila antiga ainda publica mídia velha. Medir a partir da
entrada contamina justamente os primeiros dias, que é onde a taxa de zerados deveria falar. Default
`entered_on + 1`; ao registrar um marco de mídia, a tela **oferece** (nunca aplica sozinha) mover o
início da medição para a data do marco.

**Sem FK para o perfil em `recovery_cohort_members`** (decisão do usuário): `username_at_entry` guarda
a identidade e o registro sobrevive à exclusão do perfil. Sem isso, a aba Histórico perderia
justamente os casos em que a recuperação falhou — os mais importantes de lembrar. Os grupos são
`on delete restrict`; o soft delete que a rota `DELETE /api/groups/[groupId]` faz não dispara restrict,
então o histórico continua legível.

**Índice novo em `profile_analytics_daily_metrics`:**
```sql
-- O índice da 172 é (organization_id, metric_date desc, profile_id): bom para varrer
-- a janela de um grupo, ruim para o caminho da coorte, que é por PERFIL com faixa de
-- datas própria de cada membro.
create index profile_analytics_daily_metrics_org_profile_date_idx
  on public.profile_analytics_daily_metrics (organization_id, profile_id, metric_date)
  where coverage_status in ('complete', 'partial');
```
Custo: um índice a mais no upsert do worker de analytics (~4 linhas por perfil por ciclo).
Desprezível perto de transformar o join da coorte em nested loop indexado.

**Conferir também** se existe índice em `profile_post_analytics_snapshots (organization_id,
profile_id, published_at)`; criar se faltar — é a leitura da taxa de zerados sobre 116 mil linhas.

**RLS e grants.** `enable row level security` nas seis; `select` para `authenticated` via
`public.is_organization_member(organization_id)`. Escrita para `admin|operator` via
`public.has_organization_role(...)` **só** em `recovery_media_milestones`; as demais **não têm política
de escrita** — só entram por RPC `security definer`, para que a tela não consiga fabricar um veredito.
`revoke all ... from anon`, `grant select ... to authenticated`, `grant ... to service_role`, e
`notify pgrst, 'reload schema'` no fim.

#### `348_recovery_compute.sql` — a régua

Três funções:

- **`begin_recovery_analysis_run(p_organization_id, p_trigger_source)`** — resolve a janela **a partir
  dos dados**, não do relógio: `latest_metric_date = max(metric_date)` da organização,
  `window_end = latest_metric_date - 1` (o descarte do dia parcial), `window_start = window_end - 29`.
  Se a coleta parou há três dias, a tela precisa **dizer isso**, não analisar um vazio recente.
  Idempotente: índice único parcial `where status in ('pending','running')` garante uma execução viva
  por organização — mesma defesa da migration 323 contra o cron e o botão competindo.

- **`compute_recovery_analysis_group(p_run_id, p_group_id)`** — a régua inteira em **um statement**:
  um `insert` nas estatísticas cujo `with` contém o `insert` dos candidatos como CTE modificadora.
  Um orçamento de timeout, tudo ou nada.

  Esqueleto das CTEs:
  ```
  member       → membros do grupo ∪ membros da esteira (perfis não apagados)
  daily        → group by (profile_id, metric_date), having sum(posts) > 0
  profile_tot  → posts_total, views_total, best_day_vs, last_active_date
  judgeable    → posts_total >= 60, vs = views_total/posts_total
  best_day_dt  → distinct on (profile_id) ... order by vs_do_dia desc, metric_date desc
  recent_mark  → sum(posts) over (... rows between unbounded preceding and 1 preceding)
  recent       → where posts_before < 60
  medians      → percentile_cont(0.5) de vs (M) e de vs_recente (MR)
  daily_median → percentile_cont(0.5) de views/posts por dia
  peak         → max(daily_median) desde o último marco de mídia, com piso em window_start
  gate         → base_ok e health_gate_passed (ver guardas abaixo)
  classified   → reason = never_started | collapsed | null
  ```
  Candidatos do Filtro 1 são emitidos no limiar **frouxo (0,40)** e etiquetados por `severity`
  (`severe` abaixo de 0,25, `moderate` entre 0,25 e 0,40) — é o que permite a tela oferecer os dois
  ajustes lado a lado **sem** duas execuções, e é o que faz o botão 25/40 não disparar requisição.

- **`process_recovery_analysis_chunk(p_run_id, p_group_limit default 1)`** — processa **um grupo por
  chamada** e devolve `{processed, failed, remaining, status}`. O cliente/worker repete enquanto
  `remaining > 0`. Cada grupo roda dentro de `begin ... exception when others then` que grava
  `status='failed'` + `sqlerrm` na linha do grupo. **Sem esse bloco**, um grupo que estoura o timeout
  reverte tudo, nunca ganha linha em `group_stats`, e o chunk seguinte tenta o mesmo grupo para
  sempre — que é literalmente o incidente de 29/08 reencenado.

- **`prune_recovery_analysis_runs(p_organization_id, p_max_delete default 5)`** — apaga execuções
  além de 90, **no máximo 5 por chamada**. Deletar 90 execuções × centenas de candidatos num statement
  é o mesmo erro de manutenção de índice que travou a 323.

##### Guardas numéricas — o que cada uma impede

| Guarda | O que aconteceria sem ela |
|---|---|
| `group by profile_id, metric_date` antes de qualquer janela | A PK inclui `provider`. Um perfil que migrou de `meta_official` para `zernio` tem **duas linhas no mesmo dia** — o dia seria contado duas vezes **e** a ordem da janela móvel dos 60 posts deixaria de ser total. |
| `having sum(posts) > 0` | Divisão por zero em `views/posts`. |
| `base_ok` exige `median_vs > 0` | Com `M = 0`, `vs < 0` é sempre falso e o **Filtro 1 desaparece em silêncio**. Status `degenerate_median` registra o motivo. |
| `health_gate_passed` exige `MR > 0` **e** `pico > 0` | `MR >= 0 * 0,60` é sempre verdadeiro — o portão **abriria justamente no grupo morto**, que é o oposto do que ele existe para fazer. |
| Mínimo de **5 julgáveis** | Com 2 julgáveis, `percentile_cont` faz a média dos dois e um deles está sempre abaixo de M — metade do grupo vira candidata. **Isto não é a "amostra mínima" que o usuário dispensou**: aquilo era política, isto é proteção contra a matemática degenerar. O card mostra o status `insufficient_judgeable`; nada é silencioso. |
| Piso de **3 perfis** no dia para ele poder virar pico | Um dia com 2 perfis postando e um viral fixa um pico que trava o Filtro 2 do grupo pela janela inteira. O dia continua na série do sparkline; só não pode ser o pico. |
| `stale_days <= 2` no Filtro 2 | `DEFAULT_RANGE_DAYS = 4` em [lib/integrations/zernio-analytics.ts](lib/integrations/zernio-analytics.ts): cada sync regrava só os últimos 4 dias, e a fila de refresh **pausa sob pressão de publicação**. A frescura é **por perfil**. Uma cauda de dias faltando derruba `vs_recente` e fabrica um "desabou" que não existe. |
| Grupo sem membros **ainda gera** linha em `group_stats` | O conjunto de "grupos pendentes" nunca esvaziaria e o laço de chunks rodaria para sempre. O `insert` sai de uma agregação sem `group by`, que sempre produz uma linha. |
| `distinct on` com desempate por data no melhor dia | Empate faria o `best_day_date` variar entre execuções sem motivo. |

#### `349_recovery_cohort.sql` — esteira e acompanhamento

- **`enter_recovery_cohort(p_organization_id, p_source_group_id, p_profile_ids, p_run_id)`** —
  **uma única RPC**, porque cada chamada PostgREST é sua própria transação: encadear "criar grupo",
  "mover" e "gravar coorte" em três `.rpc()` deixaria estados meio-feitos possíveis. Ela:
  1. acha a esteira por `recovery_source_group_id`; se não houver, adota um grupo de mesmo nome ou
     cria um novo, com `consumption_mode` e `default_caption` copiados da origem;
  2. nome = `left(nome_origem, 116) || ' rec'` — o `check` de `profile_groups.name` é `between 2 and
     120` ([002](supabase/migrations/002_instagram_profiles_and_groups.sql)), e sem o truncamento um
     nome longo faria a operação inteira falhar por violação de check;
  3. move via `move_profile_group_members`
     ([322](supabase/migrations/322_move_group_members_between_groups.sql));
  4. grava a coorte com o baseline congelado e `measurement_start_on = entered_on + 1`;
  5. propaga `skippedProfileIds` — se outro operador moveu o perfil no meio, a tela precisa saber, não
     receber um "sucesso" genérico.

  > **`security invoker`, e isso não é detalhe.** `move_profile_group_members` é `invoker` e depende
  > das policies de `profile_group_members` para checar o papel. Envolvê-la numa função
  > `security definer` faria a interna rodar como o *definer* e **a checagem de papel evaporaria**.
  > Ou a wrapper é `invoker` (preferido — mantém o `auth.uid()` real em `added_by`), ou é `definer` e
  > refaz `has_organization_role` explicitamente antes de qualquer escrita.

- **`return_from_recovery_cohort(...)`** — move de volta, grava `exit_at`, `exit_decision`,
  `exit_index` (o índice da última observação) e a nota. Se a origem estiver soft-deleted, exige
  `targetGroupId` explícito em vez de falhar de forma obscura.

- **`refresh_recovery_cohort_observations(p_organization_id, p_run_id)`** — roda no mesmo job, depois
  dos grupos. Grava uma linha por membro ativo por dia.

  **A chave de desempenho:** a mediana de origem é calculada por `(grupo_origem, measurement_start_on)`,
  **não por membro**. Sessenta membros da mesma leva compartilham o mesmo par → um cálculo em vez de
  sessenta. Sem isso o statement lê `60 × 500 perfis × 30 dias` e mora no timeout.

  **A taxa de zerados tem dois filtros que parecem detalhe e não são:**
  - `sync_status = 'synced'` — `views = 0` de um post que ainda não foi coletado significa "não sei",
    não "zerou";
  - maturação de 24 h — post recém-publicado tem 0 view por definição.

  E `measured_posts` **precisa aparecer na tela ao lado da taxa**:
  [lib/integrations/zernio-analytics.ts](lib/integrations/zernio-analytics.ts) busca analytics de post
  com `limit: 25, page: 1`, então a tabela guarda os posts recentes que a Zernio devolveu, não um
  censo. "40% de zerados" sobre 5 posts medidos não é a mesma frase que sobre 60.

- **`list_recovery_candidates(p_run_id, p_group_id)`** e **`get_recovery_cohort_page(...)`** — leitura.
  Ver "Como as listas são lidas".

### Como as listas são lidas

Por RPC, nunca `.select()` direto. **Sem cursor**, e isso é deliberado: o toggle 25%/40% precisa
filtrar no cliente para girar sem requisição, o que exige o superconjunto do grupo carregado de uma
vez. Teto de **500 candidatos por resposta** com `has_more`; acima disso a tela **recusa** a ação em
massa sobre "todos" e pede para refinar, em vez de agir sobre um conjunto diferente do que mostrou —
é a mesma postura de `MAX_FILTER_PROFILE_DELETE` em
[app/api/profiles/bulk-delete/route.ts](app/api/profiles/bulk-delete/route.ts). A coorte segue igual,
com teto de 200.

Como tudo cabe numa resposta, não existe o risco que a migration 344 tratou (contar de um jeito e agir
de outro): a tela age exatamente sobre o que carregou.

`recovery_candidates` entra em `SCALING_RELATIONS` + `RELATION_KEYS`
(`['run_id','profile_id']`) e `recovery_cohort_observations`
(`['cohort_member_id','observed_on']`) em
[lib/supabase/row-limit-guard.test.ts](lib/supabase/row-limit-guard.test.ts) — não porque a leitura
atual precise, mas para o dia em que alguém escrever um `.select()` direto.

### Disparo: VPS primário, Vercel como rede de segurança

O repositório já tem o padrão: [deploy/instagram/](deploy/instagram/) tem
`observability-maintenance.cron` + `.sh`, com `flock -n`, `curl` para uma rota `/api/internal/*` com
segredo, e **uma chamada por fatia de trabalho**. É exatamente a forma deste job.

**Por que VPS e não cron da Vercel:** o `vercel.json` tem só dois slots, ambos de minuto; o cron da
Vercel dá **um disparo sem repetição** (falhou às 06h10, a tela fica com o snapshot de ontem e ninguém
sabe); e o trabalho é naturalmente multi-chamada (um grupo por statement) — na VPS o laço é um `while
remaining > 0` com `flock` contra sobreposição.

```cron
10 6 * * * flock -n /run/lock/athena-recovery-analysis.lock \
  /opt/athena-worker/bin/recovery-analysis-daily.sh \
  >> /var/log/athena-recovery-analysis.log 2>&1
```

**O horário depende de quando os dados chegam** — conferir em
[docs/vps-worker-runbook.md](docs/vps-worker-runbook.md) quando a coleta diária termina e agendar
depois. Mitigação parcial já embutida: a régua descarta o dia mais recente.

**A rota** `app/api/internal/recovery-analysis-dispatch/route.ts`, no molde de
`app/api/internal/instagram-observability-maintenance/route.ts`: `timingSafeEqual` contra o segredo de
worker; **portão de pressão** — se a fila de publicação estiver sob pressão crítica, responde
`202 {paused: true}` e sai (análise nunca disputa banco com publicação); `begin` + laço de chunks
dentro de um orçamento de ~45 s; ao chegar em `remaining = 0`, chama
`refresh_recovery_cohort_observations` e `prune_recovery_analysis_runs`; `GET` delega para `POST`.
Itera as organizações que tenham ao menos um grupo com `recovery_enabled`, **uma por chamada**.

---

## A tela

Rota `/recuperacao`. Novo item em `instagramNavigation` de
[app/components/app-shell.tsx](app/components/app-shell.tsx) (entre "Grupos" e "Agenda"), com um
`<symbol id="icon-recovery">` novo em [app/layout.tsx](app/layout.tsx) — seta circular de retorno.

Arquivos: `app/(painel)/recuperacao/page.tsx` (server, `force-dynamic`, `<Suspense>` com
`<PageLoadingSkeleton variant="cards" />`), `app/recuperacao/recovery-client.tsx`,
`app/recuperacao/recovery.module.css`, `lib/recovery/ruler.ts` (constantes),
`lib/recovery/verdict.ts` (classificação, com testes).

### Faixa 1 — o número que se gira

```
Pomodoro · Instagram                        Última análise: 31/08 06:20 · dados até 30/08  [ Recalcular ]
Recuperação
Perfis que a régua marcou para teste antes da exclusão.

┌───────────────────────────────────────────────────────────────────────────────────┐
│   72  elegíveis            33 nunca engrenou · 39 desabou      ┌─────┬─────┐      │
│   ▲ +6 desde ontem                                             │ 25% │ 40% │      │
│                                                                └─────┴─────┘      │
│   Limiares de hoje: LEXY 8,0 · BIEL 7,0 · LAURINHA 3,4      25% → 72   40% → 94   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**"dados até 30/08" não é enfeite** — é `latest_metric_date`. Se a coleta atrasar, é a única coisa que
impede o operador de tomar decisão sobre um vazio. Quando o atraso passa de 2 dias, a faixa fica
âmbar.

O `+6 desde ontem` sai da comparação com a execução anterior. O toggle 25/40 é filtro de cliente sobre
o conjunto já carregado — girar não dispara requisição.

### Faixa 2 — cards de grupo

```
┌─────────────────────────────┐  ┌─────────────────────────────┐
│ GG LAURINHA                 │  │ GG BIEL                     │
│ ⚠ Nível 2 desligado         │  │ ● saudável                  │
│                             │  │                             │
│ ▇▆▃▂▁▂▇▆▅▆▅▆  ← sparkline   │  │ ▅▆▅▇▆▇▆▅▆▇▆▇                │
│ ┈┈┈┈┈┈┈┈┈┈┈  limiar 15,8    │  │ ┈┈┈┈┈┈┈┈┈┈┈┈  limiar 21,8   │
│ ▲ troca 30/08 · 36 reproc.  │  │                             │
│                             │  │                             │
│ mediana 13,7 · recente 13,4 │  │ mediana 27,8 · recente 27,7 │
│ pico 26,3 · saúde 51%       │  │ pico 36,3 · saúde 76%       │
│                             │  │                             │
│ 200 julgáveis · 18 parados  │  │ 126 julgáveis · 3 parados   │
│ N1 7 / 12   N2 —   rec 4    │  │ N1 11 / 17  N2 28   rec 0   │
└─────────────────────────────┘  └─────────────────────────────┘
```

O **sparkline com a linha do limiar** é a peça visual mais importante: é onde o operador vê a mídia
queimando antes de qualquer número. Os **marcos de troca de mídia aparecem como marcadores** no
sparkline — e como o pico passa a ser contado a partir do último marco, o operador vê exatamente de
onde o número saiu.

`18 parados` são membros sem nenhum dia com post na janela. Eles somem da régua por construção (não há
o que medir) e mostrar o número evita a pergunta "cadê os outros".

Status possíveis do card, todos visíveis: `ok`, `gate_blocked` (Nível 2 desligado),
`insufficient_judgeable`, `degenerate_median`, `no_metrics`, `no_members`, `failed`.

### Faixa 3 — abas

`Elegíveis (72)` · `Em recuperação (12)` · `Histórico`

#### Aba "Elegíveis"

Toolbar `.profiles-toolbar-controls`: grupo · nível · busca · ordenação · "ocultar coleta atrasada".

| ☐ | Perfil | Grupo | Nível | métrica julgada | % da mediana | melhor dia | posts | coleta |
|---|---|---|---|---|---|---|---|---|
| ☐ | @luzinete.santana363 | LEXY | Nunca engrenou | vs **1,79** | `▓░░░░░░░░` 6% | 12,4 | 214 | hoje |
| ☐ | @mysticglow82931 | BIEL | Desabou | recente **0,08** | `░░░░░░░░░` 0,3% | 108,5 | 190 | hoje |

**Cada nível é julgado por uma métrica diferente, e a coluna reflete isso.** O Nível 1 cai por
`vs ÷ M`; o Nível 2 por `vs_recente ÷ MR`. Mostrar sempre `vs ÷ M` colocaria o `@mysticglow82931`
acima do tique dos 40% — parecendo que não deveria estar ali, quando o motivo da entrada é justamente
que ele **era bom** (melhor dia 108,5) e desabou. A barra usa a razão correspondente; a outra aparece
no tooltip.

A barra de **% da mediana** tem dois tiques fixos em 25% e 40%. Perfis de Nível 1 que só entram a 40%
ficam esmaecidos quando a régua está em 25%. **O botão não mexe no Nível 2** — ele não tem ajuste.

A coluna **coleta** mostra `stale_days`. Linhas com `new_since_previous` ganham a legenda "novo".

Barra sticky: `12 selecionados  [ Mandar para recuperação ]  [ Cancelar fila ]  [ Excluir ]`

#### Aba "Em recuperação"

No topo, o **gráfico de acompanhamento**: mediana da coorte e mediana do grupo de origem, nos mesmos
dias, com marcadores verticais em cada marco de mídia (`36 mídias · reprocessada`). Alimentado por
`recovery_cohort_observations` — série já pronta, sem cálculo na renderização.

| Perfil | Grupo rec | Dias | Posts | Zerados | vs antes → depois | Índice vs origem | Veredito |
|---|---|---|---|---|---|---|---|
| @mysticglow82931 | BIEL rec | 6 | 71 | `▓▓░░░░░░` 21% (14 posts) | 0,08 → 18,4 | 0,003 → **0,66** | ✅ Recuperado |
| @frostglow92516 | BIEL rec | 6 | 68 | `▓▓▓▓▓▓░░` 74% (19 posts) | 0,29 → 1,9 | 0,010 → 0,07 | ❌ Não recuperou |
| @silvervex75396 | BIEL rec | 2 | 18 | `▓▓▓░░░░░` 33% (6 posts) | 0,48 → — | — | ⏳ Aguardando volume |

O **denominador entre parênteses é obrigatório** — sem ele, "33% de zerados" sobre 6 posts lidos parece
o mesmo que sobre 60.

Vereditos possíveis: `recovered`, `partial`, `not_recovered`, `short_sample` (aguardando volume),
`no_reference` (a origem não tem perfis suficientes para uma mediana), `no_data`.

Ações: **Devolver ao grupo de origem** · **Cancelar fila do grupo** · **Excluir** · **Encerrar
observação** (com nota).

#### Aba "Histórico"

Membros com saída registrada: decisão, data, índice na saída, e a nota. Inclui os perfis já excluídos
(o registro sobrevive, guardando `username_at_entry`) e os que foram excluídos direto da aba
Elegíveis, sem passar pela esteira — gravados com `entered_at = exited_at` e
`exit_decision = 'deleted'`. Sem isso, o Histórico contaria só os casos que deram certo.

---

## CSS

Módulo `app/recuperacao/recovery.module.css`, no padrão híbrido do projeto: classes globais (`panel`,
`button*`, `inline-message*`, `empty-state`, `modal-backdrop`, `bulk-modal`, `standalone-page`,
`standalone-header`, `section-kicker`, `status-badge`) + módulo só para o que é novo.

**"Fácil de mexer" é requisito.** Duas regras:

1. **Um bloco de knobs no topo**, e o resto do arquivo só consome:
   ```css
   .page {
     --rec-accent:      var(--purple-bright);
     --rec-ok:          var(--green);
     --rec-warn:        var(--yellow);
     --rec-dead:        var(--danger);
     --rec-bar-track:   #ffffff10;
     --rec-tick:        #ffffff40;   /* tiques de 25% e 40% */
     --rec-row-height:  40px;
     --rec-bar-height:  6px;
     --rec-spark-h:     44px;
     --rec-card-radius: 19px;
     --rec-gap:         12px;
   }
   ```
2. **Uma classe = uma responsabilidade**, nomes falantes: `.ruleBar`, `.ruleToggle`, `.groupCard`,
   `.groupSpark`, `.groupThresholdLine`, `.mediaMarker`, `.medianBar`, `.medianBarTick`,
   `.verdictOk/Partial/Dead/Pending`, `.zeroRate`, `.cohortChart`. Nada de seletores encadeados.

Herda os tokens globais de [app/globals.css](app/globals.css). O app é **dark-only**
(`color-scheme: dark`) — não há tema a suportar. Adicionar `.recovery-page` ao seletor do gradiente
radial em `globals.css:247`.

**Sem biblioteca de gráficos** — o `package.json` tem só `next`, `react`, `@supabase/*`, `@dnd-kit/*`,
`@aws-sdk/*`, `xlsx`. Sparkline e gráfico de acompanhamento são SVG inline com `polyline`, mesma
abordagem dos ícones em `app/layout.tsx`. Nenhuma dependência nova.

---

## As ações

| Ação | Como |
|---|---|
| **Mandar para recuperação** | `POST /api/recovery/cohort` → RPC única `enter_recovery_cohort` (atômica, `security invoker`). |
| **Cancelar fila** | `POST /api/publications/cancel`. Dois escopos — ver abaixo. |
| **Excluir do Athena + Zernio** | `POST /api/profiles/bulk-delete` com `dryRun` primeiro, confirmação digitada `EXCLUIR` (`isBulkDeleteConfirmed` em [lib/profiles/bulk-removal.ts](lib/profiles/bulk-removal.ts)), painel de progresso de `/api/profiles/removal-progress`. |
| **Devolver à origem** | `return_from_recovery_cohort`. |
| **Registrar marco de mídia** | `POST /api/recovery/milestones`; também capturado na camada de rota da Galeria. |
| **Toggle do grupo** | `PATCH /api/groups/[groupId]/recovery` — **rota nova**. |

### Escopo do cancelamento — dois caminhos, não um

- **Aba Elegíveis** (perfis ainda no grupo de origem): `{scope:'account', targetId: profileId}`, uma
  chamada por perfil. Cada uma é uma **operação durável com polling próprio**, então a tela serializa
  (concorrência 1–3) e limita a **50 perfis por operação**.
- **Aba Em recuperação**: `{scope:'group', targetId: recGroupId}` — **uma** operação durável para o
  grupo inteiro. É o caminho para o qual o mecanismo foi desenhado e que o repositório já exercita em
  produção. Muito melhor que N operações.

Em ambos, `idempotencyKey` **estável por `(scope, targetId, dia)`**, não `randomUUID()` por clique — a
duplicata da GG Lexy que travou o cancelamento em 29/08 nasceu exatamente disso.

Se houver item em `preparing`/`publishing`, a RPC devolve `blocked` (409) e **nada** é cancelado. A
mensagem precisa dizer "aguarde e tente de novo", não "falhou".

### O toggle é rota nova, não extensão da existente

`app/api/groups/[groupId]/route.ts` faz **PATCH de substituição total**: exige `name` de 2 a 120 e
sobrescreve `description`, `consumption_mode` e `default_caption` a cada chamada. Um corpo parcial com
só o toggle devolveria 400 ou zeraria os outros campos. Daí `PATCH /api/groups/[groupId]/recovery`.
Incluir `recovery_enabled` e `recovery_source_group_id` no `select` de
[app/api/groups/route.ts](app/api/groups/route.ts) e de `app/(painel)/grupos/page.tsx`.

### Ordem importa: mídia antes de mover

Mover para uma esteira **sem mídia atribuída** deixa o perfil sem material para agendar. A ordem
correta é: **atribuir mídia à esteira → mover → cancelar fila**. A tela avisa (e desabilita o botão)
quando a esteira tem zero mídias em `media_group_assignments`.

### Onde o marco de mídia é capturado — e onde não é

A tentação é um gatilho dentro de `process_media_group_assignment_job_chunk` (migration 067). **Não
fazer isso**: é o caminho que a Galeria usa para atribuição em massa, funciona hoje, e um gatilho ali
põe funcionalidade nova no caminho crítico de outra que já roda em produção. A captura acontece **na
camada de rota** ([app/api/media/groups/bulk/route.ts](app/api/media/groups/bulk/route.ts) e a rota que
cria o job), depois da atribuição aceita, com o `batch_kind` que o operador escolheu. **Falhar ao
gravar o marco não pode derrubar a atribuição** — é registro, não regra. Mais o botão manual na tela
de Recuperação, que também cobre trocas feitas por fora.

### Mover não mexe na fila nem nas mídias

`publication_items` guarda só `profile_id` e `batch_id`, sem `group_id`, e `move_profile_group_members`
não toca em nada além de `profile_group_members`. Os itens agendados continuam existindo e **migram de
card** na tela de Fila (o agrupamento é join em tempo de leitura). É o comportamento pedido — e por
isso o botão de cancelar fila fica à mão, como decisão separada.

Mídia se liga a grupo (`media_group_assignments`), nunca a perfil. A esteira nasce sem pool; atribuir
as mídias novas é o passo seguinte, na Galeria — e é o que dispara o marco.

---

## Etapas

Marcar `- [x]` com data conforme cada uma for concluída **e validada**.

### Etapa 0 — Registro
- [x] **2026-08-31** — Plano copiado para `plans/plano-tela-recuperacao-instagram-2026-08-31.md`.
- [x] **2026-08-31** — Numeração confirmada: 344/345/346 já versionadas e aplicadas na branch; as
      migrations deste plano são **347, 348 e 349**. Reconferir antes de criar o primeiro arquivo.

### Etapa 1 — Banco: schema
- [x] **2026-08-31** — `347_recovery_schema.sql`: colunas em `profile_groups` + índice único da
      esteira + check de auto-referência; as seis tabelas; `media_assets.content_origin`; RLS;
      grants explícitos; `notify pgrst, 'reload schema'`. Aplicada do zero com
      `npx supabase db reset --local`.
- [x] **2026-08-31** — Índice em `profile_post_analytics_snapshots` **já existia**
      (`profile_post_analytics_snapshots_profile_published_idx`, migration 057, com
      `published_at desc nulls last`). Nada a criar.
- [x] **2026-08-31** — Índice extra em `profile_analytics_daily_metrics` **descartado**: a PK é
      `(organization_id, profile_id, provider, metric_date)` e o prefixo `(organization_id,
      profile_id)` já resolve a leitura por perfil da coorte. Um índice a menos no caminho de upsert
      do worker de analytics.
- [x] **2026-08-31** — `supabase/tests/347_recovery_schema.test.sql`, **16/16 verde**: auto-referência,
      uma esteira por origem, uma execução viva por organização, ordem dos ajustes 25/40, um membro
      ativo por perfil, reentrada após saída, `measurement_start_on >= entered_on`, ativo sem saída,
      sobrevivência do histórico à exclusão do perfil, `batch_kind`, `content_origin`, leitura por
      membro, e três provas de que a tela não fabrica veredito.

**Achado de segurança corrigido nesta etapa.** O teste pegou: `pg_default_acl` do projeto concede
`arwdDxtm` em toda tabela nova do schema `public` a `anon`, `authenticated` e `service_role`. O
`revoke ... from public, anon` que eu tinha escrito deixava `authenticated` com INSERT/UPDATE/DELETE
nas tabelas de snapshot. Não era explorável (a RLS barra o INSERT com 42501 e faz UPDATE/DELETE sem
política afetarem zero linhas), mas **em silêncio** — e uma política permissiva acrescentada por
engano no futuro abriria a escrita inteira. Corrigido para
`revoke ... from public, anon, authenticated` antes do `grant select`. Verificado no banco: `anon`
sem nenhum privilégio, `authenticated` só com `SELECT` nas cinco tabelas de snapshot e escrita apenas
em `recovery_media_milestones` (ainda gated pela policy de papel).

**Baseline da suíte pgTAP.** `supabase test db --local` tem **45 arquivos falhando, com e sem a
347** — falhas pré-existentes de drift do schema. Comparação feita movendo a 347 para fora,
resetando e rodando de novo: mesma contagem. A única diferença textual foi
`235_twitter_manual_analytics.test.sql`, que se mostrou **flaky por conta própria** (três rodadas
consecutivas com a 347 presente: duas abortam em 23 testes, uma roda 29 e falha a 27). A 347 não
introduz nenhuma falha nova.

### Etapa 2 — Banco: a régua
- [x] **2026-08-31** — `348_recovery_compute.sql`: `begin_recovery_analysis_run`,
      `compute_recovery_analysis_group`, `process_recovery_analysis_chunk`,
      `prune_recovery_analysis_runs`. A régua inteira em **um statement por grupo**; o laço fica no
      chamador, entre chamadas HTTP; cada grupo dentro de `exception when others` que grava
      `status='failed'`.
- [x] **2026-08-31** — Cabeçalho da migration registra os dois desvios conscientes e a assimetria de
      estimadores do portão. Ambos os desvios são **parâmetros** (`median_includes_recovery`,
      `peak_from_last_milestone`), para o teste de aceitação poder desligá-los.
- [x] **2026-08-31** — `supabase/tests/348_recovery_compute.test.sql`, **24/24 verde**, com dados
      sintéticos desenhados para que cada número esperado seja conferível à mão: dia parcial
      descartado (mediana de A é exatamente 40); `posts = 0` ignorado; **duas linhas de `provider` no
      mesmo dia somadas antes de tudo** (sem o colapso, o melhor dia do perfil viraria 45 e o veto o
      tiraria da lista); severidade `severe`/`moderate` separando 25% de 40%; o caso
      `@mysticglow82931` caindo no **Filtro 2 e nunca no 1**; portão fechando num grupo que caiu
      junto; portão **fechado** com `pico = 0`; `M = 0` → `degenerate_median`; 2 julgáveis →
      `insufficient_judgeable`; grupo sem membros ainda ganhando linha; fronteira 59/60/61 posts;
      mediana par interpolada (35); grupo que estoura virando `failed` sem travar o laço; grupo com
      recuperação desligada fora da análise; e o **marco de mídia recontando o pico** e devolvendo o
      Filtro 2 ao grupo que estava em queda.
- [x] **2026-08-31** — Suíte completa: **45 arquivos falhando com e sem** as migrations novas.
      Sem regressão.
- [ ] Medir a duração de um chunk no maior grupo real (GG LEXY, ~457 perfis × 30 dias) e confirmar
      folga contra os ~8 s **antes** de ligar qualquer cron. **Só é possível em produção.**
- [ ] Aceitação contra a análise de 31/08 (33/55/39). **Depende de produção** — os dados sintéticos
      locais não reproduzem os grupos reais.

### Etapa 3 — Banco: esteira e acompanhamento
- [ ] `349_recovery_cohort.sql` — `enter_recovery_cohort` (`security invoker`),
      `return_from_recovery_cohort`, `refresh_recovery_cohort_observations`, e as duas de leitura.
- [ ] pgTAP: índice contra a mediana de origem nos mesmos dias; taxa de zerados **ignorando** post com
      `sync_status = 'pending'` e post com menos de 24 h; `measurement_start_on` respeitado;
      truncamento do nome da esteira com origem de 120 caracteres.

### Etapa 4 — Disparo
- [ ] `app/api/internal/recovery-analysis-dispatch/route.ts` com segredo, portão de pressão e laço de
      chunks com orçamento.
- [ ] `deploy/instagram/recovery-analysis-daily.sh` + `.cron`, no molde do de observabilidade.
- [ ] Definir o horário **depois** de conferir quando a coleta diária termina.
- [ ] `POST /api/recovery/runs` (botão Recalcular; o cliente repete enquanto `remaining > 0`).

### Etapa 5 — Leitura
- [ ] `lib/recovery/ruler.ts` e `lib/recovery/verdict.ts` + testes em `npm test`.
- [ ] `lib/recovery/snapshot.ts` (tipos e normalização, molde de `lib/profiles/catalog.ts`).
- [ ] `GET /api/recovery/overview`, `/candidates`, `/cohort`.
- [ ] Registrar as duas relações em `row-limit-guard.test.ts`.

### Etapa 6 — Ações
- [ ] `POST /api/recovery/cohort` e `/cohort/return`.
- [ ] `exit_decision = 'deleted'` também para exclusões feitas direto da aba Elegíveis.
- [ ] `POST /api/recovery/milestones` + captura na camada de rota da Galeria.
- [ ] `PATCH /api/groups/[groupId]/recovery` (rota nova) + colunas no `select` de grupos.

### Etapa 7 — Tela
- [ ] Ícone + item em `instagramNavigation`.
- [ ] `page.tsx`, `recovery-client.tsx`, `recovery.module.css` com o bloco de knobs.
- [ ] Faixa da régua, cards com sparkline e marcos, três abas.
- [ ] Toggle "Recuperação" em [app/grupos/groups-client.tsx](app/grupos/groups-client.tsx).

### Etapa 8 — Fechamento
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint`.
- [ ] Aceitação da régua (ver Verificação).
- [ ] Registrar no plano do repositório o que foi aplicado em produção e quando.

---

## Verificação

**Banco.** Rodar a suíte pgTAP de `supabase/tests/` — o procedimento com Docker está documentado em
[plans/plano-correcao-cancelamento-fila-em-lote-2026-08-29.md](plans/plano-correcao-cancelamento-fila-em-lote-2026-08-29.md),
que registra a última execução completa contra um Postgres com todas as migrations do zero. Seguir
aquele procedimento em vez de inventar um comando. Se `compute_recovery_analysis_group` não reproduz o
veto vitalício e o portão de saúde com dados sintéticos, o resto da tela é decoração.

**Aceitação da régua — maçã com maçã.** A análise rodou sobre **25 a 31/08**; a janela padrão é 30
dias. Esperar 33/55/39 com 30 dias é comparar duas coisas diferentes.
1. Rodar com a **mesma janela da análise** (a RPC aceita `p_window_start`/`p_window_end` só para isso)
   e conferir: **33** e **55** no Filtro 1, **39** no Filtro 2, LAURINHA e Julio com Nível 2
   desligado, medianas 32,0 · 27,8 · 13,7 · 21,4. Divergência aqui é bug da implementação.
   *Ressalva honesta:* os dois desvios conscientes (população da mediana, origem do pico) podem mover
   levemente esses números. Rodar **primeiro** com os desvios desligados por parâmetro para provar a
   régua original, e **depois** com eles ligados, registrando a diferença.
2. Só então rodar com 30 dias. Os números **vão** diferir; o que se confere é que ninguém quebrou —
   o veto segura, o LAURINHA continua desligado, nenhum grupo dá salto absurdo.

**Sobre a janela de 30 dias.** Ela encurta o veto vitalício: `melhor_dia` passa a olhar só 30 dias.
Hoje é inofensivo — a tabela tem ~8 mil linhas e a análise cobriu 7 dias, então 30 dias ≈ todo o
histórico existente. Quando a série passar de 30 dias, **revisitar**: a saída é `p_veto_window_days`
separado. Deixar o parâmetro previsto na assinatura desde já.

**Unidade:** `npm test`. `lib/recovery/verdict.test.ts` cobre as fronteiras 0,25 e 0,40, os estados
`short_sample`/`no_reference`/`no_data`, e divisão por zero.

**Tela, ponta a ponta** — com o dev server aberto pelo Browser pane (`preview_start`), não por Bash:
1. Ligar o toggle num grupo e conferir que ele aparece.
2. "Recalcular" e conferir contagens, sparkline, marcos e a tarja de Nível 2 desligado.
3. Girar 25% ↔ 40% e conferir em `read_network_requests` que **nenhuma** requisição sai.
4. Mandar 2 perfis para recuperação → conferir no banco que saíram da origem, entraram na esteira, e
   que a fila deles **continua intacta**.
5. Cancelar a fila da esteira (escopo de grupo) e conferir os itens em `cancelled`; com um item em
   `publishing`, conferir que volta `blocked` e que **nada** foi cancelado.
6. Excluir um perfil: preview, confirmação `EXCLUIR`, painel de progresso, e conferir que o registro
   **permanece** no Histórico depois que o perfil some.
7. Forçar `latest_metric_date` antigo e conferir a faixa âmbar de coleta atrasada.
8. `resize_window` mobile: colapso da tabela em blocos.

---

## Riscos e pontos de atenção

**Que a arquitetura já trata** (listados para não serem "descobertos" de novo):
catraca da mediana; pico velho travando o Filtro 2; frescura desigual da coleta
(`DEFAULT_RANGE_DAYS = 4` e a fila que pausa sob pressão); fila antiga contaminando os primeiros dias
(`measurement_start_on`); `views = 0` que é atraso e não zerado; `M`/`MR`/`pico` iguais a zero; duas
linhas de `provider` no mesmo dia; grupo vazio virando laço infinito; `security definer` engolindo a
checagem de papel; duplo clique criando duas esteiras; nome de grupo estourando o `check`;
`idempotencyKey` aleatório por clique.

**Que continuam abertos:**

- **Reincidência ao voltar.** Um perfil devolvido à origem carrega dias ruins pré-troca dentro da
  janela de 30 dias, e pode ser reacusado na primeira rodada. Mitigação simples: ao devolver, a tela
  oferece iniciar a janela dele na data do retorno. Não bloqueia a entrega; decidir na Etapa 6.
- **Mistura de formatos.** A régua é views/post independente de reel/story/imagem. Um grupo que migra
  de reel para story despenca em `vs` sem regressão real. Diagnóstico barato: gravar a distribuição de
  formatos por grupo por execução como coluna informativa. Não muda a régua, só evita conclusão errada.
- **Corridas entre operadores.** `move_profile_group_members` devolve `skippedProfileIds`; a rota
  **precisa** propagar isso à tela em vez de reportar sucesso genérico.
- **`consumption_mode` da esteira.** Se nascer `single_use` (default), a leva é consumida; para leva
  reprocessada reaproveitada em várias contas o modo precisa ser `reusable`. Copiar da origem é o
  default menos surpreendente, mas o operador precisa poder ver e mudar.
- **A vaga Zernio não volta na hora.** Só depois do DELETE remoto e da re-listagem de `/v1/accounts`.
  A tela precisa dizer "removendo…", não fingir que o slot voltou.
- **Empates na mediana.** `percentile_cont` interpola; com contagem par o valor pode não existir na
  amostra. É o comportamento desejado — documentar para não virar "bug" depois.
- **A régua não encontra perfil que entrega e não vende.** Fora de escopo por construção: o que trava
  a venda no LAURINHA está *depois* da view. A tela não deve sugerir o contrário — vale uma nota de
  rodapé na própria página.

---

## Referência

A régua vem do artifact **"A régua de corte pra recuperação"** (31/08/2026), com a especificação de
cálculo, as seis armadilhas de medição, os números por grupo e o registro das decisões. É a fonte
fechada deste plano: divergência entre implementação e artifact é bug da implementação — **exceto** os
dois desvios registrados em "Dois desvios conscientes da régua", ambos decididos explicitamente.
Guardar o link do artifact no plano do repositório na Etapa 0.

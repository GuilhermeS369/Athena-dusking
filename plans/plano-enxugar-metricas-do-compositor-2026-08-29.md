# Plano — Enxugar o payload das métricas do compositor

**Data:** 2026-08-29
**Gatilho:** ao corrigir o bug do "0/0" (perfis além da milésima linha ficavam sem métrica), a RPC `get_posting_composer_profile_metrics` passou a ser paginada. Com isso o custo ficou explícito: **4,88 MB por chamada** com 1.000 perfis, e agora são duas chamadas por carregamento da `/postagem`.

## Medição (produção, organização Vini, 1.000 perfis)

| Campo | bytes | % |
|---|---:|---:|
| `profile_id` + `scheduled_post_count` | 83 KB | 1,7% |
| `scheduled_counts` + `published_counts` | 225 KB | 4,6% |
| **`scheduled_execute_ats`** | **2,34 MB** | **48%** |
| **`scheduled_execute_ats_by_format`** | **2,40 MB** | **49%** |
| Total | 4,88 MB | |

Tempo da RPC: ~1,0 s (com ou sem `order`, medido).

**Os dois arrays de horários são 97% do payload e carregam exatamente os mesmos timestamps** — um achatado, outro separado por formato.

Distribuição do horizonte: dos 63.185 timestamps devolvidos, **100% cabem em 3 dias**. O parâmetro pede 90.

## Para que cada campo serve, de verdade

| Campo | Consumidor | Precisa do timestamp cru? |
|---|---|---|
| `scheduled_counts` / `published_counts` | contador "X/Y" do seletor ([bulk-ui.ts:40](../lib/publications/bulk-ui.ts)) | Não |
| `scheduled_execute_ats_by_format` | **só** para montar `scheduled_by_format_and_time`, o `(específico)` do dropdown de horário ([group-composer-next.tsx:419](../app/postagem/group-composer-next.tsx)) | **Não** — é histograma |
| `scheduled_execute_ats` | (a) `scheduled_by_time`, o `(total)` do mesmo dropdown; (b) conflito no minuto ([publishing-client.tsx:163,176](../app/postagem/publishing-client.tsx)); (c) slots ocupados da distribuição recorrente ([group-composer-next.tsx:132,955,1041](../app/postagem/group-composer-next.tsx)) | Só em (b) e (c) |

`postingTimeWindow` ([composer.ts:165](../lib/publications/composer.ts)) agrupa em janelas de 10 minutos no fuso de São Paulo: no máximo 144 chaves por formato por perfil. É um histograma minúsculo que hoje é calculado no navegador a partir de megabytes de timestamps.

**Ponto decisivo:** todos os usos de timestamp cru acontecem **depois** que o usuário escolhe um alvo. O fluxo de programação em massa — que é onde se lida com 1.150 perfis — **não usa timestamp nenhum**, só as contagens.

---

## Fase 0 — Cada chamador pede só o que usa

Risco quase zero, maior ganho por esforço. `.rpc(...)` aceita `.select()` (confirmado por medição: 251 KB contra 4,88 MB).

- [x] **0.1** [app/api/bulk-publications/profiles/route.ts](../app/api/bulk-publications/profiles/route.ts) monta o payload apenas com `publication_metrics` e **descarta os dois arrays** — mas puxava os 4,88 MB do banco mesmo assim. Passou a pedir `select('profile_id,scheduled_counts,published_counts')`: **4,88 MB → 225 KB, corte de 95%**, sem mudar uma linha de comportamento. Executado em 2026-08-29.

  Nota de implementação: os tipos gerados não descrevem essa RPC como set-returning, então encadear `.select()` faz o TypeScript inferir "uma linha OU uma lista". Foi preciso um cast localizado para reconciliar com `fetchAllRows`; em tempo de execução a função sempre devolve um conjunto.

- [x] ~~**0.2** Na `/postagem`, pedir explicitamente as colunas usadas.~~ **Descartada.** Verificado que a página consome **as cinco colunas** (`scheduled_post_count`, `scheduled_execute_ats`, `scheduled_execute_ats_by_format`, `scheduled_counts`, `published_counts`). Um `select` explícito ali economizaria zero byte hoje e só adicionaria o mesmo cast da 0.1. Quem realmente reduz esse payload são as fases 1 e 3, que eliminam os arrays.

## Fase 1 — Histogramas no banco, não no navegador

Elimina `scheduled_execute_ats_by_format` por completo.

- [ ] **1.1** Nova migration: `get_posting_composer_profile_metrics` passa a devolver `scheduled_slot_counts` e `scheduled_slot_counts_by_format` — jsonb com a contagem por janela de 10 minutos, no mesmo agrupamento de `postingTimeWindow`:
  ```sql
  to_char(item.execute_at at time zone 'America/Sao_Paulo', 'HH24') || ':' ||
  lpad(((extract(minute from item.execute_at at time zone 'America/Sao_Paulo')::int / 10) * 10)::text, 2, '0')
  ```
- [ ] **1.2** A página passa a repassar esses campos direto, em vez de reduzir os arrays. `scheduledCountsByTime` e o `reduce` de `scheduled_by_time` ([page.tsx:210-215](../app/(painel)/postagem/page.tsx)) somem.
- [ ] **1.3** Parar de devolver `scheduled_execute_ats_by_format`. **−2,40 MB (49%).**
- [ ] **1.4** Teste comparando o histograma do SQL com o do `postingTimeWindow` atual para o mesmo conjunto de horários — o agrupamento tem que bater exatamente, inclusive no fuso.

## Fase 2 — Horizonte proporcional ao que existe

- [ ] **2.1** `p_slot_horizon_days` de 90 para **10**. Hoje 100% dos horários cabem em 3 dias, e o teto de duração de um plano é 7 ([migration 329](../supabase/migrations/329_cap_bulk_plan_duration_at_seven_days.sql)) — 10 dá margem sem deixar o payload crescer sem limite se alguém agendar mais longe.
- [ ] **2.2** Confirmar que a detecção de conflito no minuto não depende de horizonte longo: ela só compara com o horário que o usuário está escolhendo agora.

## Fase 3 — Timestamps só do alvo selecionado

O que sobra depois das fases acima é `scheduled_execute_ats` (2,34 MB), necessário para conflito de minuto e distribuição recorrente — mas **só dos perfis que o usuário escolheu**.

- [ ] **3.1** Tirar `scheduled_execute_ats` da carga inicial da `/postagem`.
- [ ] **3.2** Nova rota `GET /api/postagem/slots-ocupados?profileIds=...` (ou por grupo), chamada quando o alvo é escolhido, devolvendo só os horários daqueles perfis dentro do horizonte da Fase 2.
- [ ] **3.3** Enquanto a resposta não chega, o compositor continua utilizável: sem os horários ocupados ele só perde o aviso de conflito, que já é um extra — não pode bloquear a tela.

**Alternativa mais barata, se a 3.2 se mostrar invasiva:** trocar a codificação dos timestamps de string ISO (~33 bytes cada) por inteiro de minutos desde uma época fixa (~8 bytes), com a conversão no cliente. Corta ~75% do que restar sem mexer no fluxo da tela.

---

## Resultado esperado

| Etapa | /postagem | rota do seletor em massa |
|---|---:|---:|
| Hoje | 4,88 MB | 4,88 MB |
| Fase 0 | 4,88 MB | **225 KB** |
| + Fase 1 | ~2,7 MB | 225 KB |
| + Fase 3 | **~400 KB** | 225 KB |

## Verificação

- Medir o payload de cada rota antes e depois, com `curl -o /dev/null -w '%{size_download}'` contra a organização Vini (a maior, 1.150 perfis).
- Conferir na tela que o dropdown de horário continua mostrando `(específico)(total)` com os mesmos números de antes para um perfil conhecido.
- Conferir que o aviso de conflito no minuto continua aparecendo ao escolher um horário já ocupado.
- `npm test`, `npx tsc --noEmit` e `npm run build`.

## Fora de escopo

Não mexer na fila de postagem nem na de agendamento — este plano é só sobre o custo de transporte das métricas do compositor.

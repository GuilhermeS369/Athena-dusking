# Plano de capacidade — crescer de 2.181 para 5.000+ perfis

**Data:** 2026-08-29
**Gatilho:** a frota vai crescer para 5.000 perfis e além. Este documento diz **o que aumentar, até quanto, e o que quebra primeiro** se passar disso — para acelerar sem estourar o banco.

Tudo aqui é medido em produção hoje, não estimado.

---

## 1. Onde estamos

| Recurso | Valor real |
|---|---|
| Perfis online | **2.181** (942 Pomodoro + 1.239 Vini) |
| VPS | **1 vCPU**, 3,9 GB RAM — abaixo de 50% de CPU e memória |
| Supabase | **Small, 2 CPU** — memória **~84%**, CPU <30%, disco **~74%** |
| `publication_items` | 462 mil linhas totais, 301 mil não arquivadas |
| Encerrados aguardando arquivamento | **212 mil** |

### Vazão medida por estágio

| Estágio | Vazão hoje | Como foi medida |
|---|---:|---|
| Geração (plano → itens) | **175.394/hora** | drenagem de 19.196 itens em 394 s |
| Preparação (mídia → `ready`) | **7.912/hora** | 400 itens em 182 s, após subir o limite de 4 para 50 |
| Publicação (envio ao provedor) | **2.596/hora** | itens publicados na última hora |
| Teto de despacho | **10.800/hora por organização** | 180/min — teto **interno do Athena**, não da Zernio (ver §2) |

---

## 2. A conta em 5.000 perfis

Com rotação de hora em hora, 5.000 perfis geram **5.000 publicações vencendo por hora** — quase o dobro da vazão de publicação de hoje.

| Estágio | Necessário a 5.000 | Capacidade atual | Situação |
|---|---:|---:|---|
| Geração | pico de 840 mil por plano de 7 dias | 175.394/hora | **folgado** — ~4,8 h para materializar um plano da frota inteira |
| Preparação | 5.000/hora contínuos | 7.912/hora | **apertado** — 1,6× de folga, some no primeiro pico |
| Publicação | 5.000/hora | teto de 10.800/hora por org | **cabe, com ressalva** (ver §3) |
| Linhas no banco | ~2,5 milhões por plano cheio | 462 mil hoje | **é aqui que estoura** (ver §5) |

### O "gargalo da Zernio" não existe — correção de 2026-08-29

**A versão original desta seção estava errada.** Ela afirmava que o limite em 5.000 perfis seria a Zernio, com 200 criações/minuto por organização, e recomendava dividir a frota em mais organizações do Athena. Nada disso se sustenta.

Verificado contra [docs.zernio.com/guides/rate-limits](https://docs.zernio.com/guides/rate-limits):

| Limite real | Valor | Escopo |
|---|---|---|
| Requisições de API | 60/min (0–2 contas) · 600/min (3–2.000) · **1.200/min (2.001+)** | **por *team*** |
| Velocidade de postagem | **25 posts/hora por conta** | por conta, por plataforma |
| Instagram | **100/dia por conta** | por conta |

O número 200 não aparece na documentação. Ele nasceu como padrão interno do Athena na migration 179 (gravado com `organization_id is null`, ou seja, global) e foi descrito como "autoritativo da Zernio" no runbook e nos planos seguintes, virando premissa sem nunca ter sido verificado.

**O que muda:**

- O *team* da Zernio corresponde a uma **conexão/chave de API**, não à organização do Athena. Em 2026-08-29 havia **1.297 conexões com 1.102 chaves distintas** (522 em Pomodoro, 775 em Vini), cada uma com ~2 contas — faixa de 60 req/min por chave. O orçamento agregado é da ordem de **dezenas de milhares de requisições por minuto**; usamos 180/min por organização, uma fração disso.
- **Dividir a frota em mais organizações do Athena não aumenta orçamento nenhum.** Essa recomendação foi removida. O que distribui carga é ter mais chaves, e vocês já têm 1.102.
- O limite que de fato pode ser atingido é **por conta**: 25 posts/hora. A rotação em massa com piso de 29 minutos dá ~2/hora por perfil, bem abaixo. Mas `min_seconds_between_profile_publications = 45` permite 80/hora e é **3× mais permissivo que o provedor** — um agendamento avulso em rajada no mesmo perfil pode gerar `429`.

**Onde o gargalo realmente está em 5.000 perfis:** preparação de mídia, volume no banco e o nosso próprio teto de 180/min. Ver o [plano de ajuste](plano-ajuste-gargalos-reais-2026-08-29.md).

---

## 3. O que aumentar, e até quanto

Ordem de prioridade. **Aumentar um controle acima do teto seguro não acelera: transfere o problema para o próximo estágio ou derruba o banco.**

### 3.1 Preparação de mídia — o próximo a saturar

| | Valor |
|---|---|
| Controle | `PUBLICATION_WORKER_PREPARATION_LIMIT` |
| Hoje | 50 (era 4 até hoje) |
| Teto do código | 500 |
| **Seguro hoje** | **50** |
| **Seguro após separar o laço (§4)** | **150–200** |
| Quebra se passar | a preparação roda **dentro do laço de despacho**; subir sem separar atrasa a publicação dos itens vencidos |

Companheiro: `PUBLICATION_WORKER_PREPARATION_CONCURRENCY`, hoje 4, teto 20. Subir para **8** junto com a separação do laço. Acima disso, 1 vCPU vira o limitador.

### 3.2 Geração — já resolvida, não mexer

| | Valor |
|---|---|
| Controle | `PUBLICATION_GENERATION_WORKER_BULK_CHUNK_LIMIT` |
| Hoje | 25 (era 1 até hoje) |
| Teto do código | 50 |
| **Seguro** | **25** — mede 175 mil/hora, 35× a demanda de 5.000 perfis |

Não aumentar. `BULK_STEP_SIZE` fica em 50 (teto 100): é o que mantém cada transação abaixo do `statement_timeout` de ~8 s. Subir para 100 reintroduz o timeout que a migration 303 existia para evitar.

### 3.3 Despacho — já no teto útil

| Controle | Hoje | Teto | Observação |
|---|---:|---:|---|
| `STAGED_DISPATCH_LIMIT` | 500 | 500 | já no máximo |
| `STAGED_DISPATCH_CONCURRENCY` | 32 | 64 | subir só se a latência da Zernio virar o gargalo, e com 1 vCPU isso é duvidoso |
| `STAGED_MAX_PER_ORGANIZATION_PER_MINUTE` | 180 | 200 (código) | teto **interno**, não do provedor. Dá para subir, mas antes é preciso saber como o despacho distribui entre as 1.102 chaves — ver plano de ajuste |
| `STAGING_LIMIT` | 100 | 500 | subir para **200** em 5.000 perfis; hoje sobra |

---

## 4. Mudança estrutural obrigatória antes de 5.000

**Separar a preparação em laço próprio**, como já foi feito com o staging na Fase 5 do plano de 28/08.

Hoje `preparePublicationQueueDirect` roda dentro de `dispatchPublicationQueueDirect`, dentro de `runDispatchCycle` — o mesmo laço que publica. Enquanto for assim, o limite de preparação fica preso a um valor baixo para não atrasar publicação, e **é isso que impede levar a preparação de 7.912/hora para as dezenas de milhares que 5.000 perfis vão exigir em pico**.

O padrão já existe no código e funcionou: `dispatchLoop` e `stagingLoop` com `createSingleFlightGuard`, encerramento conjunto em SIGTERM. Replicar para `preparationLoop`.

Só depois disso os valores de §3.1 fazem sentido.

---

## 5. O que de fato pode estourar o banco

Não é CPU nem conexão. É **volume de linhas**, e piorou de propósito hoje: com o horizonte de 48 h removido (migration 328), um plano materializa tudo de uma vez em vez de pingar.

Cada slot gera **3 linhas**: `publication_items` + `publication_item_media` + `publication_item_events`.

| Cenário | Itens | Linhas |
|---|---:|---:|
| Hoje, total | 462 mil | ~1,4 milhão |
| Plano de 7 dias, 5.000 perfis, de hora em hora | 840 mil | **~2,5 milhões, de uma vez** |

O que já limita: **piso de 29 minutos** entre publicações e **teto de 7 dias** por plano (migrations 328 e 329). Sem eles, não haveria limite nenhum.

O que falta:

- [ ] **5.1** Arquivar os **212 mil itens encerrados** que estão pendentes. Não afetam o funcionamento, mas engordam todos os índices de `publication_items` — e a tabela tem ~20 índices, o que já causou `statement_timeout` no cancelamento em lote (ver migration 324).
- [ ] **5.2** Tornar o arquivamento **recorrente**, não manual. Hoje depende de alguém clicar "Limpar encerradas", que ainda por cima só processa 5.000 por chamada.
- [ ] **5.3** Avaliar retenção: itens publicados há mais de N dias podem sair da tabela quente para uma tabela de histórico. É a única medida que segura o crescimento de verdade a longo prazo.

---

## 6. Infraestrutura

### 6.1 Supabase: já está em Small — e o sinal a vigiar é memória, não CPU

O upgrade Micro → Small **já foi feito**. Situação medida em 2026-08-29:

| Métrica | Valor | Leitura |
|---|---:|---|
| CPU | <30% | folgado; **não é o limitador** |
| **Memória** | **~84%** | **é o sinal a vigiar** |
| **Disco** | **~74%** | conversa direto com o volume de linhas (§5) |

Isso inverte o diagnóstico original deste plano, que assumia CPU compartilhada como restrição. Com 2 CPUs e uso abaixo de 30%, subir concorrência não esbarra em processamento — esbarra em **memória e disco**.

Consequência prática: **o arquivamento (§5.1) sobe de "barato e imediato" para a medida mais urgente**. É a única que alivia memória e disco ao mesmo tempo, porque reduz o tamanho dos ~20 índices de `publication_items` que precisam caber em RAM.

Gate para avaliar a próxima faixa: se, depois do arquivamento e da retenção, a memória continuar acima de 85% sob carga normal. **Não subir de faixa antes de arquivar** — seria comprar memória para guardar lixo.

### 6.2 VPS: 1 vCPU, mas hoje não é o limitador

Abaixo de 50% de CPU e memória. Os controles de concorrência (`STAGED_DISPATCH_CONCURRENCY=32`, preparação, staging) competem por **um único núcleo** em tudo que é CPU — parse de JSON, assinatura de URL, criptografia — mas quase tudo é espera de rede, então sobra folga.

- [ ] **6.2.1** Antes de subir concorrência em qualquer estágio, medir o load sob pico. Se passar de ~0,7 sustentado, o próximo passo é **mais núcleos**, não mais concorrência.

---

## 7. Ordem recomendada

1. **Arquivar os 212 mil encerrados** (§5.1) — agora é a **mais urgente**: memória a 84% e disco a 74% no Supabase.
2. **Arquivamento recorrente** (§5.2) — sem isso o item 1 vira dívida que volta.
3. **Separar a preparação em laço próprio** (§4) — desbloqueia o único estágio sem folga.
4. **Subir preparação para 150–200 e concorrência para 8** (§3.1), medindo.
5. **Retenção** (§5.3) — a única medida que segura o crescimento a longo prazo.
6. Só então reavaliar: próxima faixa do Supabase (§6.1) e núcleos da VPS (§6.2).

## 8. O que NÃO fazer

- Não subir `BULK_STEP_SIZE` para 100 — reintroduz o `statement_timeout` da migration 303.
- Não subir `STAGED_MAX_PER_ORGANIZATION_PER_MINUTE` sem antes medir a distribuição entre chaves: o limite da Zernio é por chave, e concentrar rajada numa só gera `429` mesmo com orçamento agregado sobrando.
- Não subir `PREPARATION_LIMIT` acima de 50 antes de separar o laço — atrasa publicação de item vencido.
- Não subir concorrência sem antes olhar o load da VPS: com 1 vCPU, mais concorrência em trabalho de CPU só piora.
- Não reintroduzir o horizonte de geração para conter volume. O jeito certo de conter volume é retenção e arquivamento, não deixar o gerador competir para sempre com a publicação ao vivo.

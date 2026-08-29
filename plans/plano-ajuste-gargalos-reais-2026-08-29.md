# Plano de ajuste — os gargalos reais, depois de derrubar a premissa da Zernio

**Data:** 2026-08-29
**Gatilho:** a verificação da [documentação oficial da Zernio](https://docs.zernio.com/guides/rate-limits) derrubou a premissa de que o provedor limitava 200 publicações/minuto por organização. Com essa restrição fora do caminho, o dimensionamento para 5.000 perfis muda de lugar.

Documento complementar ao [plano de capacidade](plano-capacidade-para-5000-perfis-2026-08-29.md), que já foi corrigido. Aqui está **o que fazer**, em ordem.

---

## 0. O que a verificação mudou

| Antes (premissa) | Agora (verificado) |
|---|---|
| Zernio limita 200 publicações/min **por organização** | Zernio limita **requisições de API por *team***: 60/min (0–2 contas), 600/min (3–2.000), 1.200/min (2.001+) |
| Escala por publicação | Escala por **requisição HTTP** |
| *Team* ≈ organização do Athena | *Team* ≈ **conexão/chave de API**. Existem **1.102 chaves** distintas |
| Dividir em mais organizações aumenta orçamento | **Não aumenta nada** |
| Sem limite por conta relevante | **25 posts/hora por conta** e **100/dia no Instagram** |

**O teto de 180/min é nosso, não do provedor.** Continua sendo uma escolha conservadora defensável — mas é escolha, não restrição externa.

---

## Fase 1 — Arquivamento (a mais urgente)

O Supabase está em **memória ~84% e disco ~74%**. CPU abaixo de 30%. O limitador é espaço, não processamento.

Há **212 mil itens encerrados** (`published`, `cancelled`, `ignored`, `removed`) com `archived_at is null`. Eles não afetam o funcionamento, mas ocupam disco e — pior — engordam os ~20 índices de `publication_items`, que precisam caber em memória. É a causa direta dos 84%.

- [ ] **1.1** Drenar os 212 mil com `clean_publication_queue_finished`, em blocos, uma organização por vez, medindo memória e disco a cada 50 mil. A função já processa `for update skip locked` com limite por chamada, então não bloqueia a fila.
- [ ] **1.2** Medir memória e disco antes e depois. É o número que decide se a Fase 5 (retenção) é urgente ou pode esperar.

**Cuidado:** essa função gasta o orçamento da chamada com itens encerrados **antes** de chegar nas falhas terminais (ver migration 327). Como o objetivo aqui é justamente drenar encerrados, isso não atrapalha — mas não confundir com a limpeza de falhas.

## Fase 2 — Arquivamento recorrente

Sem isso, a Fase 1 vira dívida que volta em semanas. Hoje o arquivamento depende de alguém clicar "Limpar encerradas" na tela, que processa no máximo 5.000 por chamada.

- [ ] **2.1** Worker recorrente (ou passo no worker de manutenção de mídia, que já roda) chamando `clean_publication_queue_finished` por organização até `remaining = 0`, com teto de tempo por ciclo para não competir com publicação.
- [ ] **2.2** Expor no painel operacional quantos itens estão pendentes de arquivamento, para o número nunca mais crescer despercebido.

## Fase 3 — Separar a preparação em laço próprio

O único estágio sem folga: **7.912/hora** contra **5.000/hora** de demanda a 5.000 perfis.

Hoje `preparePublicationQueueDirect` roda dentro de `dispatchPublicationQueueDirect`, dentro de `runDispatchCycle` — o mesmo laço que publica. Por isso o limite está preso em 50: subir mais atrasa a publicação de item vencido.

- [ ] **3.1** Extrair `preparationLoop`, espelhando o que a Fase 5 do plano de 28/08 fez com `stagingLoop`: polling próprio, `createSingleFlightGuard` contra sobreposição, encerramento conjunto em SIGTERM.
- [ ] **3.2** Backpressure: ceder quando houver item vencido próximo, mesmo padrão do `STAGING_DUE_GUARD_MS`.
- [ ] **3.3** Teste com preparação artificialmente lenta provando que o despacho continua publicando — o teste equivalente do staging já existe em `publication-worker.test.mjs` e serve de modelo.

## Fase 4 — Subir a preparação, medindo

Só depois da Fase 3.

- [ ] **4.1** `PUBLICATION_WORKER_PREPARATION_LIMIT` de 50 para **150**, medir, depois **200** se a memória do Supabase permitir.
- [ ] **4.2** `PUBLICATION_WORKER_PREPARATION_CONCURRENCY` de 4 para **8**.
- [ ] **4.3** Gate: publicações/hora não pode cair, itens vencidos não pode subir, memória do Supabase não pode passar de 85%.

## Fase 5 — Retenção

A única medida que segura o crescimento a longo prazo. Com o horizonte removido, um plano de 7 dias para 5.000 perfis materializa **840 mil itens ≈ 2,5 milhões de linhas de uma vez** (item + mídia + evento).

- [ ] **5.1** Definir política: itens publicados há mais de N dias saem da tabela quente para histórico.
- [ ] **5.2** Avaliar particionamento de `publication_items` por período, ou tabela de arquivo morto separada.
- [ ] **5.3** Reavaliar os ~20 índices: com retenção, alguns índices parciais podem ser reduzidos.

## Fase 6 — Reavaliar o teto de 180/min (opcional, e só depois)

Com a premissa da Zernio derrubada, os 180/min podem subir. Mas **não é a alavanca mais útil** e tem um risco específico.

- [ ] **6.1** Medir **como o despacho distribui entre as 1.102 chaves**. O limite da Zernio é por chave: se o worker concentrar uma rajada numa chave só, gera `429` mesmo com orçamento agregado sobrando. Isso precisa ser conhecido **antes** de subir qualquer teto.
- [ ] **6.2** Só então avaliar subir `STAGED_MAX_PER_ORGANIZATION_PER_MINUTE`, e considerar trocar o agrupamento de organização do Athena para **conexão Zernio**, que é a unidade que o provedor de fato contabiliza.
- [ ] **6.3** Corrigir `min_seconds_between_profile_publications`: hoje 45 s permite **80 posts/hora por perfil**, contra os **25/hora** da Zernio. A rotação em massa não atinge isso (piso de 29 min dá ~2/hora), mas agendamento avulso em rajada no mesmo perfil pode gerar `429`. Alinhar para ≥144 s.

---

## Ordem e justificativa

1. **Fase 1** — memória a 84% é o risco mais próximo, e a correção é barata.
2. **Fase 2** — sem ela a Fase 1 se repete.
3. **Fase 3** — desbloqueia o único estágio sem folga.
4. **Fase 4** — colhe o resultado da 3.
5. **Fase 5** — estrutural, para 5.000+.
6. **Fase 6** — otimização, não necessidade. A 6.3 é a única parte com risco real hoje.

## O que NÃO fazer

- **Não subir de faixa no Supabase antes da Fase 1.** Seria comprar memória para guardar 212 mil linhas de lixo.
- **Não subir `PREPARATION_LIMIT` antes da Fase 3** — atrasa publicação de item vencido.
- **Não dividir a frota em mais organizações do Athena** achando que aumenta orçamento na Zernio. Não aumenta.
- **Não subir `BULK_STEP_SIZE` para 100** — reintroduz o `statement_timeout` que a migration 303 existia para evitar.
- **Não reintroduzir o horizonte de geração para conter volume.** O jeito certo é retenção e arquivamento, não deixar o gerador competir para sempre com a publicação ao vivo.
- **Não tratar número de documentação interna como verificado.** O 200/min sobreviveu em quatro documentos por meses sem nunca ter sido conferido contra a fonte. Ao registrar um limite externo, citar a URL e a data da verificação.

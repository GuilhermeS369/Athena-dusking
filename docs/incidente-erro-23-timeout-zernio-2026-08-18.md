# Diagnóstico — erro 23 / timeout Zernio em publicações

**Data:** 2026-08-18 (UTC)  
**Escopo:** investigação somente leitura no Supabase e na VPS. Nenhum dado, processo PM2, configuração ou arquivo remoto foi alterado.

## Conclusão

O código **23** do painel corresponde ao `TimeoutError` do runtime Node: `The operation was aborted due to timeout`. Ele não é um erro de negócio da Athena e não aponta para falta de CPU, memória ou disco na VPS.

Todas as 82 ocorrências históricas encontradas pertencem ao provedor **Zernio**. A chamada HTTP à Zernio ultrapassou o timeout fixo de **25 segundos** do dispatcher, definido em [`scripts/workers/publication-direct-dispatch.mjs`](../scripts/workers/publication-direct-dispatch.mjs:10).

## Evidências

### Eventos duráveis no Supabase

- 82 eventos `failed` com `error_code=23` e a mensagem exata do timeout;
- distribuição UTC: 16 em 15/08, 1 em 16/08, 24 em 17/08 e 41 em 18/08;
- todos os 82 itens são `provider=zernio`;
- após retentativas, 58 itens foram publicados, 22 permanecem falhos e 1 foi cancelado;
- no fim da investigação, 23 itens ainda tinham o código 23 como último erro: 22 falhos e 1 cancelado.

### Pico mostrado nas imagens

Os cards mostrados executavam às 07:00 BRT, equivalentes a 10:00 UTC. Na janela 09:55–10:10 UTC foram registrados:

- 482 eventos operacionais;
- 206 `published`;
- 218 adiamentos durante processamento;
- 33 erros 23, todos em Stories Zernio;
- 17 dos 33 no lote Luiz Miguel, 8 no Marcos, 6 no Lari e 1 no Julio.

A concentração em vários perfis e lotes, no mesmo período, identifica uma degradação compartilhada no caminho Zernio em horário de pico — não falha exclusiva de perfil, mídia ou lote. Como 206 itens concluíram na mesma janela, também não ocorreu uma indisponibilidade total da fila.

### VPS

A consulta SSH somente leitura confirmou:

- `athena-publication-worker` estava online, em `direct`, com `dryRun=false`, polling de 5 segundos, lease de 180 segundos e claim de até 44 itens;
- no instante da consulta, carga de 0,29 / 0,17 / 0,06, cerca de 3,0 GiB de memória disponível e 11% de disco usado;
- não houve evidência de OOM, reinício do worker ou alerta de rede do host entre 06:50 e 07:20 UTC;
- o worker atual iniciou antes do pico, em 17/08 às 23:30 UTC;
- o log PM2 atual não contém o erro 23 histórico, pois não há log estruturado por ciclo e o arquivo corrente de erro é anterior ao incidente.

## Caminho técnico

1. O dispatcher Zernio usa `fetch` com `AbortSignal.timeout(25_000)` em [`scripts/workers/publication-direct-dispatch.mjs`](../scripts/workers/publication-direct-dispatch.mjs:387).
2. Quando não há resposta em 25 segundos, Node lança `TimeoutError` com a mensagem exibida no painel.
3. O dispatcher persiste o resultado pelo RPC [`complete_publication_item`](../scripts/workers/publication-direct-dispatch.mjs:1143).
4. O evento gravado inclui tentativa e próximo retry, mostrando que existe mecanismo durável de retentativa.
5. Os itens do ciclo são executados paralelamente via [`Promise.allSettled()`](../scripts/workers/publication-direct-dispatch.mjs:1192); múltiplos lotes vencendo juntos aumentaram a pressão contra a API Zernio.

## Diagnóstico

**Causa mais provável:** degradação/latência transitória da API Zernio durante o pico de Stories, que excedeu o timeout local de 25 segundos.

**Não confirmado:** os dados atuais não registram endpoint lógico, duração da chamada, status HTTP ausente, ID de requisição Zernio ou conexão/chave utilizada. Por isso não é possível atribuir com certeza a falha a um endpoint ou incidente específico do fornecedor.

**Descartado pelas evidências disponíveis:** saturação de CPU, memória ou disco da VPS; indisponibilidade completa do worker; falha da Meta; falha exclusiva de um perfil; e falha exclusiva do lote Luiz Miguel.

## Recomendações para uma correção posterior

1. Instrumentar etapa/endpoint Zernio, duração em ms, status HTTP, `request-id` quando existir, conexão e correlação de ciclo — sem salvar token, URL assinada, legenda ou payload completo.
2. Normalizar `TimeoutError` como `zernio_request_timeout`, marcado como retryable com backoff e jitter.
3. Criar controle de concorrência específico de Zernio, separado do limitador Meta e reduzível por conexão/organização quando houver timeout, 429 ou 5xx.
4. Alertar por taxa de timeout, lote e percentual de recuperação nas retentativas.
5. Conferir cada um dos 23 itens remanescentes antes de novo reprocessamento para evitar duplicidade caso o provedor tenha aceitado a publicação, mas a resposta tenha se perdido.

## Plano — botão “Limpar logs” em `/operacao`

### Objetivo e semântica

- Nome recomendado: **“Limpar da visualização”**, evitando indicar exclusão definitiva.
- Ação por caixa/seção e por organização do usuário ativo.
- Não executar `DELETE` em `publication_item_events`, `publication_items`, telemetria ou eventos de worker.
- Usar uma marcação de ocultação/acknowledgement para a tela padrão; o histórico deve continuar acessível em filtro administrativo/auditoria.

### Dados e segurança

Criar `operational_log_clear_actions` com `id`, `organization_id`, `actor_user_id`, `scope_key`, `scope_version`, cursor imutável (`cleared_through_created_at`, `cleared_through_event_id`), filtros da caixa, motivo opcional, `created_at`, `undone_at` e `undone_by`.

- Índice: `(organization_id, actor_user_id, scope_key, created_at desc)`.
- RLS: usuário vê sua própria limpeza; gestores podem limpar; superusuário pode auditar.
- O evento original permanece imutável e sujeito às políticas atuais.

### Implementação posterior

1. Definir escopos estáveis: itens que exigem atenção, eventos de publicação, ciclos do worker, alertas e telemetria.
2. Criar rota autenticada que valida organização/permissão, calcula o cursor no servidor e registra a ação. Nunca aceitar cursor arbitrário do navegador.
3. Adaptar a consulta de eventos em [`app/(painel)/operacao/page.tsx`](../app/(painel)/operacao/page.tsx:203) para excluir somente registros anteriores ao cursor de limpeza do usuário e escopo.
4. Em cada cabeçalho, adicionar contador, botão, confirmação clara e “Desfazer”.
5. Mostrar “Eventos anteriores a DD/MM/AAAA HH:mm ocultos por você” e filtro “Incluir itens limpos”.
6. Registrar a limpeza na trilha de auditoria administrativa, sem dados sensíveis.

### Critérios de aceite

- Limpar não reduz nem altera os eventos originais no Supabase.
- Eventos posteriores ao cursor continuam aparecendo.
- Outro usuário mantém sua própria visualização.
- Desfazer restaura os mesmos eventos.
- A fila e a auditoria preservam o histórico completo.
- Testes cobrem RLS, organização cruzada, paginação, cursor com timestamps iguais, desfazer e chegada de novos eventos durante a confirmação.

# Plano B (não implementar ainda) — prevenção adaptativa de timeouts Zernio

> **Status:** plano de contingência e evolução futura. Não aprova limite fixo baixo, alteração de concorrência, micro-ondas, circuit breaker ou mudanças na VPS neste momento. A etapa que pode ser aprovada separadamente é somente a instrumentação de telemetria não bloqueante descrita em [Fase 1](#fase-1--classificação-correta-e-telemetria-estruturada). As demais fases só devem ser reavaliadas depois de uma janela representativa de medições reais.

## Objetivo

Reduzir timeouts transitórios da Zernio em picos de publicação, recuperá-los com segurança quando ocorrerem e impedir que uma resposta perdida gere publicação duplicada. Este plano parte do incidente documentado em [`docs/incidente-erro-23-timeout-zernio-2026-08-18.md`](../docs/incidente-erro-23-timeout-zernio-2026-08-18.md).

## Diagnóstico que orienta o plano

O erro 23 ocorre porque a chamada Zernio usa um limite fixo de 25 segundos via [`AbortSignal.timeout()`](../scripts/workers/publication-direct-dispatch.mjs:388). Os 82 eventos observados foram de perfis Zernio; no pico das 07:00 BRT, houve erros em vários lotes simultâneos, enquanto outras publicações continuavam concluindo. Isso indica degradação parcial sob concorrência, não indisponibilidade da VPS nem falha generalizada do banco.

O fluxo atual já tem dois controles valiosos que devem ser preservados:

- requisição de criação com identificador estável `athena-<itemId>` em [`createZernioPost()`](../scripts/workers/publication-direct-dispatch.mjs:593);
- retentativa durável via `complete_publication_item`, acionada em [`processClaimedItem()`](../scripts/workers/publication-direct-dispatch.mjs:1143).

O risco atual é tratar timeout de criação como falha comum e reenviar sem, antes, confirmar se a Zernio aceitou a primeira requisição. A prevenção deve priorizar **reconciliação antes de recriar**, e não apenas elevar timeout/conexões.

## Princípios

1. Não aumentar globalmente `PUBLICATION_WORKER_LIMIT` como primeira reação.
2. Não aumentar o timeout sem telemetria por etapa e sem limite total de recuperação.
3. Não assumir que timeout equivale a rejeição remota.
4. Isolar a redução de concorrência na Zernio, por conexão e organização, sem prejudicar Meta nem conexões Zernio saudáveis.
5. Registrar diagnósticos sem tokens, URLs assinadas, legendas ou payloads completos.
6. Alterações com flag, canário, reversão simples e validação por métricas.

## Fase 0 — contenção imediata e operação segura

**Objetivo:** tratar os itens que já falharam sem risco de duplicação.

1. Criar uma visão operacional “Timeout Zernio pendente” que mostre item, lote, perfil, conexão, tentativa, horário, `creation_id`, `next_attempt_at` e último evento.
2. Para item com `creation_id`, consultar o post existente com [`getPost()`](../scripts/workers/publication-direct-dispatch.mjs:396), reconciliar como publicado/processando/falhado e só então decidir nova ação.
3. Para timeout no `POST /v1/posts` sem `creation_id`, buscar uma criação aceita usando o mesmo idempotency/request ID `athena-<itemId>`. Se a API não permitir busca por esse ID, solicitar formalmente este recurso à Zernio antes de automatizar o retry.
4. Enquanto não existir confirmação de idempotência remota, não reprocessar em massa todos os falhos: processar em grupos pequenos, verificando publicação remota primeiro.
5. Separar erros `PAYMENT_REQUIRED`, conta desconectada e mídia rejeitada dos timeouts. Eles não devem compartilhar ação automática.

**Critério de saída:** nenhum item timeout é recriado sem tentativa de reconciliação, e todos os itens remanescentes têm decisão registrada.

## Fase 1 — classificação correta e telemetria estruturada

**Objetivo:** saber exatamente onde e em qual conexão o tempo foi consumido.

1. Envolver cada chamada Zernio de [`createZernioClient()`](../scripts/workers/publication-direct-dispatch.mjs:376) em um wrapper de telemetria.
2. Persistir um evento técnico mínimo por tentativa com:
   - `operation`: `create_post`, `get_post` ou `disconnect_account`;
   - `outcome`: sucesso, timeout, HTTP, rede ou erro de parse;
   - `duration_ms`, timeout configurado, status HTTP, `request_id` sanitizado;
   - `organization_id`, `zernio_connection_id`, `publication_item_id`, lote e correlação de ciclo;
   - código normalizado (`zernio_request_timeout`, `zernio_http_429`, `zernio_http_5xx`, `zernio_network_error`).
3. Não persistir `Authorization`, URL assinada, mídia, legenda ou corpo da requisição/resposta.
4. Preservar a mensagem humana no painel, mas exibir a classificação e etapa: “Zernio demorou mais de 25 s ao criar postagem”, por exemplo.
5. Criar métricas por 5 min/1 h: tentativas, sucesso, timeout, 429, 5xx, p50/p95/p99, conexões afetadas, backlog e taxa de recuperação.

### Requisitos de desempenho da telemetria

1. A publicação e a transição durável do item são o caminho crítico. A telemetria é auxiliar: uma falha, lentidão ou indisponibilidade dela nunca pode bloquear, cancelar ou reclassificar uma publicação.
2. Não aguardar uma escrita de telemetria antes de chamar a Zernio nem antes de concluir o item pelo RPC principal. Em caso de indisponibilidade do registro auxiliar, descartar o evento técnico e incrementar apenas um contador local de descarte.
3. Para sucesso normal, acumular contadores e histogramas em memória por ciclo/janela; gravar um rollup em lote ao final do ciclo. Registrar detalhe por tentativa somente para timeout, 429, 5xx, falha de rede, reconciliação e circuit breaker.
4. Limitar tamanho de cada evento e sanitizar todos os campos. É proibido gravar token, cabeçalho `Authorization`, URL assinada, conteúdo/legenda, mídia ou payload completo.
5. Reter detalhe bruto por janela curta, como 7–30 dias, e consolidar depois em agregados horários/diários. A interface `/operacao` consulta os agregados por padrão.
6. Criar somente os índices necessários às consultas operacionais: organização, conexão, data, operação e resultado. Medir custo de escrita e latência p95 do ciclo antes/depois.
7. Habilitar por feature flag, começando em canário de uma conexão. Expandir apenas se o tempo de ciclo, backlog e taxa de erro não regredirem.

**Critério de saída:** cada futuro timeout permite saber se ocorreu na criação ou no polling, em qual conexão e quanto tempo levou.

## Fase 2 — isolador de concorrência Zernio

**Objetivo:** evitar rajada de chamadas simultâneas ao mesmo gargalo externo.

1. Criar um limitador próprio para Zernio; o limitador Meta atual é exclusivo da Meta em [`withMetaRequestLimit()`](../scripts/workers/publication-direct-dispatch.mjs:56) e não protege a Zernio.
2. Aplicar limites em três níveis:
   - global do processo, para proteger VPS e fornecedor;
   - por organização;
   - por `zernio_connection_id`, para uma chave problemática não travar outras.
3. Iniciar conservadoramente com canário de baixa concorrência por conexão e ajustar apenas após baseline. O valor inicial deve ser validado por métricas, não fixado nesta etapa de planejamento.
4. Manter a justiça do claim: itens bloqueados por conexão continuam na fila com próximo horário de tentativa, sem ocupar vagas de conexões saudáveis.
5. Acrescentar jitter na reentrada para evitar que muitos Stories tentem novamente no mesmo segundo.

**Critério de saída:** em pico, uma conexão lenta reduz apenas sua própria vazão, enquanto outras continuam avançando; p95 e taxa de timeout permanecem dentro da meta definida.

## Fase 3 — retry seguro e circuito adaptativo

**Objetivo:** recuperar degradação transitória sem martelar o provedor nem duplicar publicação.

1. Converter `TimeoutError` em `zernio_request_timeout`, retryable, mantendo causa original e etapa no evento.
2. Usar backoff exponencial com jitter e teto total por item. O primeiro retry não pode se alinhar com todos os demais itens do mesmo lote.
3. Em timeout de consulta (`GET`), reagendar polling; nunca criar novo post.
4. Em timeout de criação (`POST`), entrar no estado explícito `awaiting_zernio_reconciliation`:
   - procurar post por idempotency/request ID;
   - se confirmado, gravar `creation_id` e continuar polling;
   - se remoto confirmar ausência, liberar recriação única;
   - se não for possível confirmar, manter em quarentena/atenção humana em vez de criar em loop.
5. Implementar circuito por conexão: quando a janela recente exceder taxa/volume de timeout, reduzir concorrência e adiar novas criações por um cooldown. Polling de posts já aceitos pode continuar em limite baixo.
6. Fechar o circuito gradualmente após sequência saudável; não reabrir toda a carga de uma vez.

**Critério de saída:** nenhum timeout de criação causa duplicidade em testes; retries convergem ou chegam a estado de atenção explicável.

## Fase 4 — proteção específica para pico de Stories

**Objetivo:** distribuir o pico das 07:00 BRT sem mudar a intenção do agendamento.

1. Identificar antecipadamente janelas onde dezenas de Stories Zernio vencem no mesmo minuto.
2. Para cada conexão, distribuir o dispatch em micro-ondas dentro de uma tolerância de atraso configurável e comunicada na UI.
3. Priorizar itens mais antigos/mais atrasados, mas alternar organizações e conexões.
4. Manter publicação imediata fora da onda somente se houver capacidade Zernio saudável.
5. Exibir previsão de drenagem e quantidade aguardando por conexão, para que a operação saiba diferenciar fila protegida de falha.

**Critério de saída:** um pico comparável não produz rajada maior que o limite validado por conexão e seu atraso máximo fica dentro da meta operacional.

## Fase 5 — alertas e playbook

**Objetivo:** detectar antes de acumular muitos cards vermelhos.

1. Alertar warning quando a taxa de timeout Zernio ultrapassar baseline por duas janelas de 5 minutos.
2. Alertar crítico quando houver circuito aberto, backlog crescente por três janelas, atraso acima da meta ou alta taxa de itens sem reconciliação.
3. No painel `/operacao`, agrupar por conexão, etapa e lote; mostrar ação segura recomendada, nunca apenas “erro 23”.
4. Criar playbook com decisões: aguardar retry, reconciliar, pausar só a conexão afetada, reprocessar com segurança ou escalar ao suporte Zernio com `request_id`.

## Testes obrigatórios

1. Simular timeout de criação com a Zernio aceitando o post após o cliente abortar: confirmar que não há segunda criação.
2. Simular timeout de criação com confirmação remota de ausência: permitir uma única recriação.
3. Simular timeout de polling: confirmar que apenas agenda novo polling.
4. Simular 429, 5xx e rede indisponível: validar backoff, jitter e isolamento da conexão.
5. Simular 50+ Stories vencendo no mesmo minuto em várias conexões: validar micro-ondas, justiça, p95 e atraso máximo.
6. Validar que Meta continua sem redução de vazão devido a circuito Zernio aberto.
7. Validar que telemetria não contém segredo, URL assinada ou payload de conteúdo.

## Sequência recomendada

1. Fase 0 e Fase 1.
2. Coletar baseline por ao menos uma janela representativa de pico.
3. Fase 2 via canário em uma conexão Zernio.
4. Fase 3 com testes de idempotência e reconciliação.
5. Fase 4 somente após estabilização de concorrência/retry.
6. Fase 5 em paralelo após a telemetria da Fase 1 existir.

## Métricas de sucesso

- reduzir a taxa de timeout Zernio em pico sem elevar atraso fora da meta;
- 100% dos timeouts classificados por etapa e conexão;
- 0 publicação duplicada em timeout de criação;
- alta taxa de recuperação automática de timeout, com itens restantes em quarentena explicável;
- Meta e conexões Zernio saudáveis sem regressão durante degradação localizada.

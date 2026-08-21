# Diagnóstico e plano — fila de Stories em massa

**Data da investigação:** 2026-08-21 UTC  
**Escopo:** leitura no Supabase, Zernio, VPS/PM2 e Vercel. Nenhuma publicação, fila, perfil, processo ou configuração de produção foi alterado.

## Resumo executivo

O incidente principal não é “Stories que não foram publicados”. A fila local marcou 149 Stories como `failed`, mas a reconciliação direta e somente leitura com a Zernio comprovou que **todos os 149 foram publicados no Instagram**. Os quatro itens `suspended` restantes pertencem a perfis sem conexão Zernio consultável no estado atual e não entram nesse conjunto de 149 falhas.

Das 149 falhas locais:

- 141 receberam `zernio_creation_outcome_unknown`;
- 7 receberam o erro histórico `23 / The operation was aborted due to timeout`;
- 1 recebeu HTTP 409 de conteúdo duplicado;
- 149 foram encontrados na Zernio como Story `published`, na mesma conta e com correspondência exata da mídia esperada;
- os quatro itens sem vínculo Zernio consultável estão no grupo de suspensos, fora das 149 falhas reconciliadas; eles exigem análise de conexão/estado do perfil, não reenvio automático.

Portanto, a causa central é **falso negativo local após timeout da requisição de criação**, seguido da ausência de uma reconciliação automática por conta + janela de tempo + mídia. A estratégia atual evita duplicidade corretamente, mas encerra o item como falha antes de descobrir que a Zernio aceitou e publicou a solicitação.

## Evidências

### Janela auditada

- Período: 2026-08-07T01:05Z até 2026-08-21T01:06Z.
- Stories locais inspecionados: 2.084.
- Publicados localmente: 1.095.
- Falhos localmente: 149.
- Suspensos: 4.
- Ainda ativos/futuros: 836.
- Perfis com falha local: 144.

### Reconciliação remota

A auditoria consultou `GET /v1/posts` por `accountId`, janela próxima de `execute_at`, `source=zernio`, e confirmou a mídia comparando o caminho do objeto esperado com a URL usada pela Zernio. Para o 409 foi consultado também o `existingPostId` retornado pelo provedor.

Resultado:

| Erro local | Itens | Publicados remotamente |
|---|---:|---:|
| `zernio_creation_outcome_unknown` | 141 | 141 |
| `23` / timeout | 7 | 7 |
| `409` / conteúdo duplicado | 1 | 1 |
| Total reconciliado como publicado | 149 | 149 |

Os picos foram coletivos, alinhados aos slots em massa:

- 2026-08-20 22:30 UTC: 36 falsos negativos;
- 2026-08-20 12:00 UTC: 30;
- 2026-08-20 00:00 UTC: 28;
- 2026-08-20 22:00 UTC: 21;
- 2026-08-19 10:00 UTC: 19.

Isso descarta uma causa específica de perfil ou chave. As falhas atravessam muitas conexões Zernio e se concentram por horário/lote.

### Telemetria Zernio

Nas últimas 48 horas:

- `create_post` com sucesso registrado: 540 requisições;
- `get_post` com sucesso: 943;
- anomalias `create_post timeout / código 23`: 172;
- anomalias `create_post network_error`: 9;
- `get_post network_error`: 23;
- timeout fixo atual: 25 segundos.

Os timeouts de criação duram aproximadamente 25.001 ms. A Zernio termina a publicação depois disso, mas o worker já perdeu a resposta que continha o ID do post.

### Capacidade e pressão

O worker da VPS está online e saudável no PM2, porém opera com:

- `PUBLICATION_WORKER_MODE=direct`;
- `PUBLICATION_WORKER_DRY_RUN=false`;
- `PUBLICATION_WORKER_LIMIT=44`;
- limite global Zernio configurado em 50 publicações/minuto.

Nos slots coletivos, dezenas de `POST /v1/posts` começam juntas. O limite alto não excede necessariamente a cota de 50/minuto, mas produz burst contra Zernio, Storage e Supabase. A concentração temporal dos timeouts mostra que o paralelismo atual está agressivo para a latência real do provedor.

### Instabilidade adicional do Supabase

O log da VPS contém respostas Cloudflare HTTP 521 do domínio Supabase. Isso gera falhas isoladas no dispatcher e despeja páginas HTML completas no arquivo de erro. É uma segunda causa de ruído e risco operacional, separada dos falsos negativos Zernio.

### Telemetria com defeito

O worker ainda tenta persistir rollups Zernio com `operation=null`, causando erro `23502` e descartando o lote de telemetria. A função de telemetria é não bloqueante, então isso não impede a publicação, mas:

- enche o log;
- elimina parte das evidências recentes;
- pode fazer rollups e anomalias divergirem.

O código já passa `operation` em `create_post` e `get_post`; o valor nulo vem de outros clientes Zernio reutilizados pelo ciclo, como a reciclagem, que criam cliente sem contexto de operação.

## Perfil `brooks291024`

O perfil está online no Athena e na conta Zernio `LoveyAmparo62633`.

### Story publicado

- item local: `487300cf-7a26-42cb-84d8-b2471da6a393`;
- execução: 2026-08-20 00:00 UTC;
- criação Zernio: `6a8643b050a6d032f7f36310`;
- estado local: `published` em 2026-08-20 00:02:14 UTC;
- estado Zernio: `published`;
- media ID do Instagram: `18125284087833286`;
- URL retornada: `https://www.instagram.com/stories/brooks291024/3967509861248751785`;
- publicação remota: 2026-08-20 00:01:13 UTC.

Ele não aparece mais em `GET /v1/accounts/{accountId}/instagram/stories` porque a resposta atual é `data: []`. Isso é esperado: a documentação da Zernio afirma que esse endpoint lista apenas Stories ativos por 24 horas; Stories expirados não são retornados.

### Próximos Stories

- item em massa agendado para 2026-08-21 21:00 UTC;
- item avulso originalmente previsto para 2026-08-20 22:30 UTC, reagendado uma única vez para 2026-08-21 22:33:15 UTC por perda do slot.

Logo, o Story de `brooks291024` não sumiu da fila: um já foi publicado e expirou da listagem ativa; dois permanecem futuros.

## Problemas de lógica confirmados

### 1. Timeout de criação vira falha terminal sem reconciliação

Quando `POST /v1/posts` expira, o worker classifica como `zernio_creation_outcome_unknown`, `retryable=false`. Isso é correto para bloquear uma segunda criação, mas incompleto: o item fica definitivamente `failed` mesmo quando a criação original é encontrada como `published` segundos depois.

### 2. A idempotência existe, mas a janela documentada é curta

A Zernio documenta `x-request-id` com janela aproximada de cinco minutos e deduplicação por conteúdo por 24 horas. O Athena usa `athena-{itemId}`, o que é bom. Porém, repetir cegamente não é a melhor primeira ação após timeout: o plano deve reconciliar a criação original antes de qualquer reenvio.

### 3. HTTP 409 é tratado como falha, apesar de trazer `existingPostId`

O erro 409 já fornece o post existente. A auditoria comprovou que o item correspondente estava publicado. Esse caminho deve consultar o ID retornado e reconciliar como sucesso quando conta, mídia e estado forem compatíveis.

### 4. Semáforo por conexão ausente

O limite atual é global. Há fairness/minute limit, mas não há uma proteção adaptativa por conexão/provedor baseada em latência e taxa de timeout. Um slot de 30–44 contas cria burst suficiente para expor a cauda de latência da Zernio.

### 5. Mensagem de suspensão inconsistente

Quatro itens foram suspensos com `profile_offline_suspended`, mas a mensagem gravada foi “Perfil online; retomada manual necessária.”. O evento também registra `profile_status=online`. O trigger usa `new.last_error_message` antes do fallback por status; assim, uma mensagem antiga/incoerente pode ser carregada para a suspensão. A lógica de bloqueio pode ter sido legítima durante uma transição, mas a evidência gravada fica contraditória.

### 6. Logs sem contenção

Respostas HTML 521 inteiras são colocadas em `last_error_message`/PM2. O diagnóstico deve guardar código HTTP, request ID e mensagem compacta; o corpo deve ser truncado e sanitizado.

## Plano recomendado

### Fase 0 — contenção operacional imediata

1. Manter `PUBLICATION_WORKER_LIMIT=44` para preservar a vazão global da fila.
2. Distribuir o início das criações Zernio em intervalos mínimos curtos, sem reduzir a quantidade processada por ciclo.
3. Acionar backpressure adaptativo somente quando houver timeout, rede, HTTP 429 ou 5xx; o claim global continua em 44.
4. Ampliar o timeout de criação para 45 segundos, configurável, evitando abandonar respostas que historicamente chegam após 25 segundos.
5. Criar alerta para timeout de `create_post` acima de 2% por janela de cinco minutos.
6. Não reenfileirar manualmente os 149 itens: eles já foram publicados e um retry poderia duplicar conteúdo depois da janela de deduplicação.

### Fase 1 — reconciliação automática de resultado desconhecido

Criar um estado durável, por exemplo `reconciling`, ou manter `waiting` com código específico e `next_attempt_at`, sem marcar falha terminal imediatamente.

Fluxo após timeout/rede/5xx de `create_post`:

1. preservar `x-request-id`, conta, horário, hash da mídia e fingerprint do conteúdo;
2. aguardar 30–60 segundos;
3. consultar `GET /v1/posts` com `accountId`, `source=zernio` e janela próxima da tentativa;
4. selecionar somente candidato da mesma conta, `contentType=story` e mídia correspondente;
5. se publicado, persistir `creation_id`, `meta_media_id/platformPostId`, `published_at` e encerrar como `published`;
6. se ainda processando, persistir `creation_id` e entrar no polling normal de `GET /v1/posts/{id}`;
7. se não houver candidato, repetir a consulta com backoff até cinco minutos;
8. somente depois da janela, encaminhar para atenção manual. Não recriar automaticamente.

Para HTTP 409:

1. extrair `existingPostId` do corpo estruturado;
2. consultar `GET /v1/posts/{existingPostId}`;
3. validar conta, formato e mídia;
4. reconciliar como publicado/processando em vez de falhar.

### Fase 2 — ferramenta de reconciliação histórica segura

Adicionar RPC/worker administrativo idempotente que:

- recebe IDs de itens em `zernio_creation_outcome_unknown`, timeout 23 ou 409;
- consulta a Zernio sem criar posts;
- exige correspondência exata de organização, conta e mídia;
- usa `reconcile_confirmed_publication_item` para corrigir o estado local;
- registra evento `provider_reconciled` com post ID, método e timestamp;
- nunca altera itens ambíguos.

Executar primeiro em dry-run sobre os 149 itens confirmados e comparar totais. Depois, aplicar em lotes pequenos. Essa correção limpa o painel sem repostar Stories já expirados.

### Fase 3 — resiliência do dispatcher

1. Manter os 44 itens por ciclo e usar pacing global de início das criações, evitando rajada instantânea sem sacrificar throughput.
2. Adicionar backpressure adaptativo e temporário quando p95 subir ou houver timeout/429/5xx.
3. Preservar polling e operações de banco paralelas; somente o início de novos `create_post` recebe espaçamento curto.
4. Tratar Supabase 5xx/521 como erro transitório de infraestrutura: retry curto com jitter nas operações idempotentes de leitura/RPC.
5. Nunca persistir corpo HTML integral; guardar no máximo 500–1.200 caracteres sanitizados.
6. Garantir que falha de persistência após confirmação externa sempre use os RPCs de reconciliação já existentes.

### Fase 4 — corrigir telemetria e suspensão

1. Tornar obrigatório `operation` ao criar qualquer cliente Zernio; incluir `disconnect_account` e demais operações.
2. Como defesa, descartar apenas a linha de telemetria inválida, não o lote inteiro.
3. Testar que nenhum rollup/anomalia é emitido com `operation` nula.
4. Na suspensão, construir a mensagem a partir do status que disparou a transição; não reutilizar `last_error_message` arbitrária.
5. Gravar `previous_profile_status` e `new_profile_status` no evento para explicar transições rápidas de offline para online.

### Fase 5 — testes e rollout

Testes necessários:

- timeout após aceitação remota reconcilia sem segunda criação;
- resposta 409 com `existingPostId` reconcilia;
- dois candidatos remotos tornam o caso manual, nunca automático;
- mídia/conta divergente não reconcilia;
- Story publicado e expirado continua comprovável por `GET /v1/posts/{id}`;
- burst de 50 Stories respeita concorrência e fairness;
- Supabase 521 não grava HTML integral nem transforma resultado remoto confirmado em falha;
- telemetria sem `operation` é rejeitada localmente;
- suspensão registra status/mensagem coerentes.

Rollout:

1. implantar telemetria e reconciliação em modo observação;
2. comparar decisões automáticas com a auditoria remota;
3. ativar reconciliação apenas para 409;
4. ativar para timeout/rede após validar zero falsos positivos;
5. manter concorrência reduzida por 24–48 horas;
6. aumentar gradualmente conforme p95, taxa de timeout, atraso e backlog.

## Critérios de sucesso

- zero segunda criação para item com resultado externo desconhecido;
- pelo menos 99% dos posts aceitos remotamente reconciliados em até cinco minutos;
- timeout de criação abaixo de 1% por janela;
- nenhum rollup com `operation` nula;
- nenhum corpo HTML integral nos logs;
- painel local e Zernio concordando sobre publicado/falha;
- backlog vencido reduzido sem elevar indiscriminadamente a concorrência.

## Artefatos da investigação

- `scripts/workers/audit-story-publication-failures.mjs` — auditoria reproduzível, somente leitura por padrão; a opção `--reconcile-remote` também é somente leitura e consulta os posts Zernio.
- `.story-publication-failures-audit-2026-08-21.json` — evidência detalhada local/remota.
- `.vps-publication-worker-audit-2026-08-21.log` — configuração não secreta e cauda dos logs.
- `.vps-publication-worker-error-summary-2026-08-21.log` — PM2 e resumo de erros.
- `.vercel-story-queue-logs-48h-2026-08-21.jsonl` — logs recentes da Vercel; o cron de publicação respondeu sem erros na amostra e permaneceu como fallback.

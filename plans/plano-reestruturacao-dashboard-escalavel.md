# Plano de reestruturação da dashboard para carregamento escalável

## 1. Resumo executivo

A dashboard não deixa de abrir por causa dos cálculos visuais do React. A falha comprovada acontece antes da renderização: a consulta de `profile_analytics_snapshots` excede o `statement_timeout` do PostgreSQL, `getDashboardData()` trata qualquer uma das dez fontes como obrigatória e lança uma exceção, e o Server Component inteiro deixa de produzir a página.

O índice adicionado pela migration 206 é uma mitigação válida, mas não corrige a arquitetura. A página continua buscando até 31 mil linhas de várias tabelas, incluindo conteúdo e URLs de posts, para depois filtrar e agregar tudo no navegador. Esse custo cresce com a quantidade de perfis e com o histórico, gera um payload RSC grande, duplica trabalho no banco/servidor/browser e mantém a página inteira dependente da consulta mais lenta.

A substituição proposta é uma dashboard orientada a consultas agregadas e progressivas:

1. o primeiro carregamento entrega somente filtros, KPIs, saúde e agenda;
2. cada painel analítico busca apenas o agregado da janela e do escopo selecionados;
3. ranking e top posts retornam somente os itens visíveis;
4. nenhuma consulta obrigatória lê `raw_payload` nem uma coleção anual inteira;
5. falha em um painel não derruba a página inteira;
6. a origem de cada métrica fica explícita e os resultados carregam estado de cobertura/frescor.

## 2. Evidência coletada

### 2.1 Logs da Vercel

Consulta executada nos logs de produção dos últimos 30 dias pelo texto emitido por `getDashboardData()`:

- 13 ocorrências encontradas entre 20/08/2026 07:30:00 e 20/08/2026 21:25:39, horário de São Paulo;
- 12 ocorrências para a organização `58785306-4dfb-432f-8de0-f0b33f91f3de` e uma para `695be08f-3084-4046-a91d-9052b2a1582b`;
- as ocorrências atravessam quatro deployments, portanto não são um evento isolado de uma única versão;
- em todas as ocorrências, `snapshotsError.code = 57014` e a mensagem é `canceling statement due to statement timeout`;
- em uma ocorrência, tanto `summaryError` quanto `snapshotsError` estouraram o timeout;
- os outros resultados normalmente estavam sem erro;
- o request aparece como HTTP 200 nos logs, apesar da exceção interna do React Server Component. Portanto, alerta baseado apenas em status 5xx não detecta o incidente corretamente.

Arquivos locais de evidência gerados durante a análise:

- `.vercel-dashboard-errors-30d-2026-08-21.jsonl` contém as ocorrências específicas;
- `.vercel-dashboard-logs-2026-08-21.jsonl` contém a amostra mais recente de produção;
- `.dashboard-db-table-stats.json` e `.dashboard-db-index-stats.json` contêm o retrato do banco remoto.

### 2.2 Volume e tamanho no banco remoto

O `supabase inspect db table-stats --linked` reportou:

| Fonte | Linhas estimadas | Tamanho da tabela | Uso atual pela dashboard |
|---|---:|---:|---|
| `profile_analytics_snapshots` | 3.009 | 45 MB | até 1.000 linhas, com janela de 370 dias |
| `profile_analytics_daily_metrics` | 1.854 | 1,9 MB | até 10.000 linhas, com janela de 370 dias |
| `profile_follower_daily_snapshots` | 1.812 | 1,1 MB | até 5.000 linhas, com janela de 370 dias |
| `profile_post_analytics_snapshots` | 15.275 | 70 MB | até 5.000 linhas, com conteúdo e thumbnail |
| `publication_items` | 92.768 | 28 MB | até 10.000 IDs/perfis/datas e RPC adicional |
| `instagram_profiles` | 1.140 | 4,4 MB | todos os perfis da organização |

O snapshot é desproporcionalmente pesado: aproximadamente 45 MB para cerca de 3 mil linhas. A causa estrutural é `raw_payload jsonb`, que guarda payloads inteiros de insights, contas, seguidores, posts e métricas diárias. Embora o `select` da dashboard ainda liste `raw_payload`, o retorno é descartado pelo código antes de chegar ao componente.

O índice da migration 206 existe em produção e tem uso registrado, mas isso apenas torna o padrão atual menos ruim. A consulta continua sensível ao tamanho das linhas, RLS, ordenação, concorrência e crescimento histórico.

### 2.3 Evidência histórica de escala

O arquivo `analytics-cache-audit-2026-08-17.json` registrou 373 perfis, 358 snapshots, 236 snapshots em falha e jobs de atualização de 167 a 235 perfis. Isso confirma que as consultas e os refreshes precisam ser desenhados para centenas ou milhares de perfis, não para uma organização pequena.

## 3. Fluxo atual e causa raiz

### 3.1 Carregamento atual

1. A rota raiz é dinâmica e abre um `Suspense` único.
2. O servidor resolve usuário e organização.
3. `getDashboardData()` inicia dez consultas em paralelo:
   - resumo via RPC;
   - perfis;
   - grupos;
   - membros dos grupos;
   - snapshots de analytics;
   - métricas diárias;
   - histórico de seguidores;
   - analytics de posts;
   - itens publicados;
   - rollups de publicação.
4. Se qualquer uma falhar ou o resumo não existir, o método registra todos os erros e lança uma única exceção.
5. Se tudo funcionar, o servidor serializa as coleções para o Client Component.
6. O navegador filtra, agrupa, ordena e soma as coleções novamente a cada mudança de filtro.

### 3.2 Causa imediata comprovada

A consulta de snapshots filtra a organização, exige `deleted_at is null`, aplica `period_end >= data de 370 dias`, ordena por `period_end desc` e limita em 1.000. Ela excede o timeout. Como o resultado é obrigatório, `getDashboardData()` aborta a dashboard inteira.

### 3.3 Causas arquiteturais

1. **Leitura de eventos/linhas brutas para montar visualização agregada.** A tela precisa de dezenas de números e pontos, mas recebe milhares de registros.
2. **Janela anual fixa no primeiro carregamento.** O período inicial visível é 30 dias, porém o servidor sempre busca 370 dias para suportar filtros futuros no cliente.
3. **Limites globais sem paginação e sem limite por perfil.** Os `limit(1000/5000/10000)` não garantem completude. Perfis mais ativos e datas favorecidas pela ordenação podem ocupar o limite e esconder outros perfis.
4. **Snapshot grande usado como cache e arquivo bruto ao mesmo tempo.** `raw_payload` torna cada linha pesada e mistura dado operacional para leitura rápida com evidência de auditoria.
5. **Contrato tudo-ou-nada.** Uma falha em snapshots impede agenda, perfis, grupos e KPIs que já tinham sido carregados.
6. **Payload único.** O primeiro byte útil depende da consulta mais lenta e da serialização da coleção inteira.
7. **Processamento repetido no navegador.** Existem filtros lineares, buscas repetidas por perfil, ordenações e agrupamentos sobre arrays potencialmente grandes.
8. **Dois conceitos de resumo.** A RPC de resumo calcula totais a partir do último snapshot, enquanto a tela recalcula os KPIs a partir de métricas diárias e histórico. Isso aumenta custo e cria risco de divergência sem definir a semântica de cada número.
9. **Rollup com escopos inconsistentes.** Status e formato usam todo o histórico; dia e hora usam `p_days`. Depois o cliente aplica perfil/grupo, mas não consegue aplicar corretamente o período selecionado aos status e formatos.
10. **Observabilidade insuficiente.** Não há duração, quantidade de linhas, bytes aproximados ou nome de etapa por consulta. A resposta externa 200 mascara a falha interna.

### 3.4 Por que a migration 206 não basta

O novo índice `(organization_id, period_end desc) where deleted_at is null` combina com o filtro e a ordenação da consulta problemática e deve ser mantido como proteção. Porém:

- não reduz o número de linhas retornadas para o caso funcional;
- não reduz o payload enviado pelo Supabase, Next.js e React;
- não elimina a dependência anual no primeiro carregamento;
- não resolve limites globais truncando dados;
- não isola falhas por painel;
- não resolve `raw_payload` no mesmo armazenamento quente;
- não muda a complexidade de agregação no cliente.

Portanto, o índice é mitigação de banco, não a solução de produto.

## 4. Dados que a dashboard realmente precisa

### 4.1 Metadados de filtro

| Dado visual | Fonte canônica | Forma correta de leitura |
|---|---|---|
| perfis e fonte | `instagram_profiles_safe` | lista compacta da organização |
| grupos | `profile_groups` | lista compacta |
| associação perfil-grupo | `profile_group_members` | lista compacta ou agregada em JSON na RPC bootstrap |

Esses dados são pequenos e podem estar no bootstrap.

### 4.2 KPIs de analytics

| Dado visual | Fonte canônica | Semântica proposta |
|---|---|---|
| alcance, views, likes, comentários, compartilhamentos, salvos, interações | `profile_analytics_daily_metrics` | soma no período e escopo selecionados |
| taxa de engajamento | agregado diário | `interactions / reach`, com cobertura declarada |
| seguidores totais | último `profile_follower_daily_snapshots` até o fim da janela; fallback para último snapshot compacto | soma do último valor conhecido por perfil |
| variação de seguidores | histórico diário | diferença entre valor final e baseline anterior ao início; usar ganhos/perdas apenas se a fonte garantir cobertura completa |
| posts no período | `publication_items` | contagem de `status = published` por `published_at` |

O cálculo atual da variação soma `followers_gained - followers_lost`; isso pode ficar incorreto quando há buracos ou cobertura parcial. O contrato novo deve devolver valor, baseline e cobertura.

### 4.3 Séries e distribuições

| Painel | Fonte canônica | Resposta máxima |
|---|---|---:|
| métrica ao longo do tempo | `profile_analytics_daily_metrics` agrupada por bucket | 30 a 90 pontos |
| posts ao longo do tempo | `publication_items` agrupada por bucket | 30 a 90 pontos |
| histórico de seguidores | último valor por bucket | 30 a 90 pontos |
| métrica por fonte | join de métricas com perfis | 2 a 5 linhas |
| métrica por grupo | join de métricas, membros e grupos | quantidade de grupos |
| status/formatos | `publication_items` filtrada pela mesma janela | menos de 20 linhas |

### 4.4 Rankings e detalhes

| Painel | Fonte canônica | Resposta máxima |
|---|---|---:|
| ranking de perfis | métricas diárias agregadas por perfil | top 10 |
| top posts | `profile_post_analytics_snapshots` | top 8, selecionando apenas campos visíveis |
| melhores horários | posts publicados + analytics, conforme definição de produto | top 6; não apenas contagem bruta de posts |
| saúde das fontes | último estado compacto por perfil | resumo + primeira página de exceções |

O painel “melhor horário” atualmente mede volume de publicação, não desempenho. Deve ser renomeado para “horários mais usados” ou receber uma fórmula de performance com amostra mínima.

### 4.5 Seções sem dados reais

A área de inbox é estática e sempre retorna zero. Ela não deve participar de nenhuma consulta. Até existir uma fonte canônica de inbox, deve ficar atrás de feature flag, ser marcada como indisponível ou ser removida da dashboard principal para reduzir ruído.

## 5. Arquitetura substituta

### 5.1 Princípio

Levar filtro e agregação para o PostgreSQL e retornar somente a projeção visual necessária. O browser envia `organization`, período, perfis/grupo, fonte e métrica; o banco responde com objetos pequenos e limitados.

### 5.2 Contratos propostos

#### A. Bootstrap crítico

Criar `get_dashboard_bootstrap_v2(p_organization_id)` com:

- metadados dos perfis e grupos;
- resumo operacional de conexões, agenda e falhas;
- estado de analytics por perfil derivado de uma fonte compacta;
- `generated_at`, `data_freshness_at` e contadores de cobertura;
- sem séries, sem posts, sem itens publicados e sem `raw_payload`.

Meta: até 100 KB comprimidos para organizações grandes e p95 abaixo de 800 ms.

#### B. Visão analítica por filtro

Criar `get_dashboard_analytics_v2` com parâmetros:

- `p_organization_id`;
- `p_start_date` e `p_end_date`, limitados a 366 dias;
- `p_profile_ids` opcional, com validação de pertencimento;
- `p_group_id` opcional;
- `p_provider` opcional;
- `p_metric` validado por enum/allowlist;
- `p_bucket` (`day`, `week`, `month`) calculado pelo servidor.

Resposta:

- KPIs;
- série da métrica;
- série de posts;
- seguidores;
- distribuição por fonte e grupo;
- top 10 perfis;
- status de cobertura.

Uma única execução usa CTEs sobre o escopo filtrado e retorna JSON agregado. Nenhuma linha bruta anual sai do banco.

#### C. Top posts paginado/limitado

Criar `get_dashboard_top_posts_v2` ou endpoint dedicado:

- mesmos filtros;
- métrica validada;
- limite máximo 8 ou 20;
- selecionar somente `id`, perfil, URL, texto truncado no SQL, tipo, thumbnail, data e métricas visíveis;
- índice voltado a organização/perfil/data; o ranking pode usar métricas já persistidas.

#### D. Operação/publicações

Reescrever o rollup para aplicar o mesmo intervalo a status, formato e série. Não usar “todo o histórico” para dois blocos e “últimos N dias” para outros sem deixar isso explícito.

### 5.3 Estado compacto de último snapshot

Não consultar a tabela histórica de snapshots para descobrir o estado atual em toda abertura. Escolher uma das opções:

1. **Preferida:** tabela `profile_analytics_current` com uma linha por perfil, atualizada na mesma transação lógica do sync;
2. view baseada em `distinct on`, apenas se o plano medido for consistentemente barato;
3. colunas de estado atual em `instagram_profiles`, se a equipe aceitar acoplamento.

A tabela compacta deve conter somente métricas atuais, período, status, frescor e erro resumido. `raw_payload` permanece fora do caminho quente.

### 5.4 Separação do payload bruto

Planejar a extração de `raw_payload` para armazenamento de auditoria:

- tabela `profile_analytics_payload_archives`, particionada por mês, ou Storage;
- retenção definida, por exemplo 30 a 90 dias;
- compressão e acesso somente em tela de diagnóstico;
- snapshot quente guarda `payload_ref`, hash e campos normalizados;
- nunca selecionar payload bruto em dashboard, lista de perfis ou resumo.

Essa alteração deve ser feita por migração gradual, sem excluir evidência antes de validar retenção e restauração.

### 5.5 Carregamento progressivo na aplicação

Estruturar a página em fronteiras independentes:

1. shell, cabeçalho e filtros;
2. faixa de KPIs;
3. gráficos/rankings;
4. top posts;
5. operação.

O bootstrap deve renderizar imediatamente. Os demais blocos podem usar Server Components com `Suspense` independente ou Route Handlers consumidos no cliente com cache por chave de filtro. Trocar período não pode baixar novamente todos os dados anuais.

### 5.6 Resiliência

O contrato de retorno de cada seção deve admitir:

- `ok`;
- `stale` com último dado válido;
- `partial` com cobertura;
- `unavailable` com código de erro seguro.

Não lançar exceção global porque top posts ou analytics falharam. Apenas falha de autenticação/organização deve impedir a página. Agenda e filtros precisam continuar utilizáveis mesmo com analytics indisponível.

### 5.7 Cache e invalidação

- cache curto por `organization + start + end + profile/group/provider + metric`;
- TTL inicial de 30 a 60 segundos para agregados;
- stale-while-revalidate de alguns minutos;
- invalidar tags da organização ao terminar um refresh de analytics ou publicar/cancelar item;
- o botão “Atualizar dados recentes” agenda coleta; ele não deve bloquear a dashboard nem apagar o último dado válido;
- aplicar deduplicação de requests idênticos no servidor.

## 6. Plano de implementação

### Fase 0 — Contenção imediata

Objetivo: fazer a dashboard abrir mesmo antes da reestruturação completa.

1. Remover `raw_payload` do `select` atual de snapshots.
2. Tornar snapshots, séries, posts e rollups opcionais no agregador atual; retornar arrays vazios/estado indisponível por seção, sem abortar o bootstrap.
3. Separar pelo menos operação/bootstrap de analytics em duas fronteiras de `Suspense`.
4. Adicionar `app/(painel)/error.tsx` e estado de erro específico por painel, sem esconder agenda e navegação.
5. Registrar duração e contagem de linhas por consulta.
6. Manter o índice 206, verificar `ANALYZE` da tabela e não aumentar `statement_timeout` como “solução”.

Critério de saída: a rota abre e mostra shell/operação mesmo se a consulta de analytics for forçada a falhar.

### Fase 1 — Contrato e SQL agregados

1. Congelar o contrato semântico de cada KPI conforme a seção 4.
2. Criar testes SQL para escopo de organização, período, perfil, grupo e provider.
3. Implementar `get_dashboard_bootstrap_v2`.
4. Implementar `get_dashboard_analytics_v2` com bucket automático:
   - até 31 dias: diário;
   - 32 a 180 dias: semanal;
   - acima de 180 dias: mensal.
5. Implementar top posts limitado.
6. Implementar rollup operacional com período coerente.
7. Executar `EXPLAIN (ANALYZE, BUFFERS)` em organizações pequenas e grandes e criar somente os índices demonstrados pelo plano.

Critério de saída: nenhuma RPC devolve mais de 500 linhas; a resposta típica devolve dezenas de objetos.

### Fase 2 — Aplicação progressiva

1. Reduzir `DashboardData` ao bootstrap.
2. Criar tipos separados para bootstrap, analytics, top posts e operação.
3. Mover filtro de período/escopo para a chave da consulta remota.
4. Substituir os cálculos pesados do Client Component pelos agregados retornados.
5. Manter no cliente apenas formatação e transformação pequena para gráficos.
6. Criar loading, empty, partial e error state independentes.
7. Remover o painel fake de inbox ou protegê-lo com feature flag.

Critério de saída: primeira renderização não transporta coleções anuais e um erro de top posts não afeta KPIs.

### Fase 3 — Current state e arquivo bruto

1. Criar `profile_analytics_current`.
2. Fazer dual-write durante o refresh de analytics.
3. Backfill de uma linha atual por perfil em lotes.
4. Validar paridade entre current state e seleção histórica.
5. Trocar bootstrap e saúde para a tabela compacta.
6. Extrair/arquivar payload bruto com política de retenção.
7. Somente depois da validação, remover dependências do JSONB no caminho quente.

Critério de saída: leitura de estado atual é O(perfis da organização), com linhas pequenas e índice único.

### Fase 4 — Corte e limpeza

1. Colocar V2 atrás de feature flag por organização.
2. Liberar primeiro para organização pequena e depois para a organização de maior volume.
3. Rodar V1/V2 em shadow mode e comparar os números sem mostrar V2 ao usuário.
4. Registrar diferenças por métrica, perfil e período.
5. Cortar para V2 quando a paridade for aceita.
6. Remover `extractLatestDailyMetrics()` morto, limites globais e consultas anuais da implementação antiga.
7. Remover RPC antiga depois da janela de rollback.

## 7. Índices a validar, não aplicar cegamente

Os índices finais dependem do `EXPLAIN`, mas os padrões esperados são:

- métricas diárias: `(organization_id, metric_date, profile_id)` com cobertura válida;
- seguidores: `(organization_id, profile_id, snapshot_date desc)` onde não deletado;
- posts analíticos: `(organization_id, published_at desc, profile_id)` onde não deletado;
- itens publicados: índice parcial em `(organization_id, published_at, profile_id)` para `status = 'published'`;
- current state: chave única `(organization_id, profile_id)`.

Evitar criar índices por tentativa. Medir leitura, escrita, tamanho, hit ratio e redundância com os existentes.

## 8. Testes obrigatórios

### 8.1 SQL/segurança

- membro não acessa outra organização;
- `profile_ids` de outra organização são rejeitados ou ignorados com comportamento documentado;
- grupo é validado contra a organização;
- datas inválidas e janela acima de 366 dias falham com erro controlado;
- métrica e bucket aceitam somente allowlist;
- status/formatos respeitam exatamente a janela.

### 8.2 Correção de dados

- hoje, ontem e anteontem respeitam São Paulo;
- janelas de 7, 30, 90, 180 e 365 dias incluem os limites corretos;
- seguidores usam último ponto até o fim da janela e baseline correto;
- cobertura parcial não é exibida como zero confirmado;
- top ranking e top posts são determinísticos em empate;
- filtros combinados perfil + grupo + fonte não vazam dados.

### 8.3 Resiliência

- timeout de analytics mantém bootstrap/operação visíveis;
- timeout de top posts afeta apenas esse card;
- refresh falho mantém último dado válido;
- payload vazio, parcial e stale tem apresentação distinta;
- resposta HTTP e telemetria refletem erro da seção, em vez de 200 silencioso sem sinalização.

### 8.4 Escala

Gerar fixtures com pelo menos:

- 1.500 perfis;
- 365 dias de métricas por perfil;
- 100 mil itens publicados;
- 50 mil posts analíticos;
- payload bruto arquivado fora da consulta.

Metas iniciais:

- bootstrap p95 < 800 ms;
- analytics p95 < 1,5 s para 30 dias e < 2 s para 365 dias;
- top posts p95 < 800 ms;
- nenhuma consulta > 3 s;
- payload bootstrap < 100 KB comprimido;
- payload analítico < 250 KB comprimido;
- zero timeout em teste de 20 usuários concorrentes por organização grande.

## 9. Observabilidade e alertas

Emitir evento estruturado por seção:

- `dashboard.bootstrap`;
- `dashboard.analytics`;
- `dashboard.top_posts`;
- `dashboard.operation`.

Campos mínimos:

- request/trace ID;
- organização anonimizada ou ID interno;
- filtros e bucket;
- duração do banco e total;
- linhas retornadas;
- bytes serializados;
- cache hit/miss/stale;
- coverage status;
- código PostgreSQL;
- deployment ID.

Alertas:

- qualquer `57014` em dashboard;
- p95 acima da meta por 10 minutos;
- taxa de seção indisponível > 1%;
- payload acima do limite;
- divergência V1/V2 acima da tolerância;
- queda anormal de cobertura.

Não depender apenas de HTTP 5xx, pois o incidente atual apareceu como request 200 com erro interno.

## 10. Rollout e rollback

1. Deploy das RPCs/tabelas sem alterar a UI.
2. Shadow reads amostradas e assíncronas, sem duplicar carga em todo request.
3. Comparação de paridade em 1, 7, 30, 90 e 365 dias.
4. Feature flag para V2 por organização.
5. Canary em organização pequena.
6. Canary na organização de maior volume em horário monitorado.
7. Ampliação gradual.
8. Manter V1 disponível por uma janela curta, mas sem voltar a torná-la dependência obrigatória da página.

Rollback da UI é troca de flag. Migrações de current state e arquivo bruto devem ser aditivas até o fim da validação; não apagar colunas ou payloads no mesmo release do corte.

## 11. Decisões explícitas

- **Não** aumentar o timeout como correção principal.
- **Não** buscar 365/370 dias no bootstrap para permitir filtros locais.
- **Não** transportar milhares de linhas para agregá-las no React.
- **Não** tratar toda fonte como obrigatória.
- **Não** usar limites globais silenciosos como estratégia de escala.
- **Não** ler `raw_payload` em dashboard.
- **Sim** filtrar/agrupar no banco com escopo e período explícitos.
- **Sim** limitar rankings aos itens visíveis.
- **Sim** expor cobertura e frescor junto dos valores.
- **Sim** manter a página operacional quando analytics estiver degradado.

## 12. Ordem recomendada de execução

1. Contenção: remover payload bruto do select e eliminar o fail-fast global.
2. Observabilidade por consulta.
3. Contrato semântico dos KPIs.
4. RPC bootstrap V2.
5. RPC analytics V2 e top posts.
6. UI progressiva com erros isolados.
7. Shadow comparison e canary.
8. Current state compacto.
9. Arquivamento do payload bruto.
10. Remoção definitiva da lógica antiga.

Essa ordem primeiro restaura disponibilidade, depois reduz custo e só então altera armazenamento, diminuindo o risco de corrigir performance introduzindo inconsistência de dados.

## 13. Auditoria complementar: refresh de centenas de perfis

### 13.1 Conclusão que altera o plano original

O problema não está somente na leitura da dashboard. A coleta e a leitura precisam ser redesenhadas como um sistema único. O refresh atual consegue drenar centenas de itens, mas faz trabalho demais por perfil, usa a VPS somente como disparador de funções Vercel, impede colaboração eficiente entre workers no mesmo job e obriga a UI a esperar o job inteiro para mostrar atualização.

A implementação completa da V2 não deve começar por uma troca única e irreversível. Estão autorizadas apenas a contenção aditiva e a instrumentação até que os pré-requisitos da seção 19 estejam cumpridos. O corte estrutural deve ser faseado, com shadow mode, canary e rollback por flag.

### 13.2 Função real da VPS

O processo `scripts/workers/profile-analytics-refresh-worker.mjs` executado na VPS não faz a coleta. Ele envia requisições HTTP para `/api/internal/profile-analytics-refresh-dispatch`. Essa rota chama `dispatchProfileAnalyticsRefreshJobs()` dentro da aplicação na Vercel; ali são executadas as chamadas Zernio e as gravações no Supabase.

Consequências:

- CPU e memória adicionais na VPS não aumentam o throughput do refresh atual;
- a VPS é um scheduler/heartbeat durável, não um worker de dados;
- cada ciclo continua consumindo duração e concorrência da Vercel;
- aumentar o tamanho da VPS sem mover a execução não corrige o gargalo;
- adicionar outro processo igual não resolve um job grande enquanto o claim continuar exclusivo no nível do job.

### 13.3 Evidência operacional dos últimos sete dias

O relatório `.dashboard-refresh-pipeline-audit-2026-08-21.json` foi gerado com sucesso após a recuperação do Supabase e contém:

- 589 perfis Zernio ativos em três organizações;
- 486 conexões Zernio;
- 380 jobs;
- 139.459 eventos de etapa;
- worker `athena-vps-profile-analytics-1` ativo, com limite 20, concorrência 10, lease de 300 segundos e polling de 10 segundos;
- organização Pomodoro: 404 perfis ativos, 307 jobs, 11.865 itens solicitados e processados, 2.778 falhas contabilizadas;
- gatilhos Pomodoro: 180 `page_view`, 97 `connection_sync`, 28 `manual` e 2 `worker`;
- 174 dos 307 jobs Pomodoro terminaram `completed_with_errors`;
- duração de jobs Pomodoro: p50 10,8 segundos, p95 747,6 segundos e máximo 1.997,6 segundos;
- organização Vini: 185 perfis ativos, 72 jobs, 3.326 itens e 248 falhas;
- duração de jobs Vini: p50 7,9 segundos, p95 609,3 segundos e máximo 772,4 segundos.

Esses números mostram duas populações diferentes: muitos jobs pequenos terminam rápido, mas jobs organizacionais grandes e retries elevam o p95 para 10 a 12 minutos. Portanto, usar apenas a média ou a velocidade do melhor ciclo mascara a espera percebida pelo usuário.

### 13.4 Evidência deduplicada dos logs Vercel

A exportação `.vercel-analytics-dispatch-24h-2026-08-21.jsonl` contém 1.000 linhas, porém 950 são repetições dos mesmos eventos. O script `scripts/summarize-vercel-analytics-dispatch.mjs` deduplica por ID e gerou `.vercel-analytics-dispatch-summary-2026-08-21.json` com 50 ciclos reais:

| Job observado | Perfis | Sincronizados | Dead-letter | Duração observada | Throughput |
|---|---:|---:|---:|---:|---:|
| `eeddfd4c-8207-49e6-b421-5fe1fc530191` | 416 | 405 | 11 | 332 s | 75,1 perfis/min |
| `4b021521-5645-4c2a-892c-1831a20fb37c` | 233 | 229 | 4 | 164 s | 85,1 perfis/min |
| `8f2a693b-00af-4951-ace7-6b352467e585` | 228 | 186 | 42 | 180 s | 76,2 perfis/min |
| `e997b56f-d283-40a6-bc33-685d6d58b046` | 92 | 92 | 0 | 69 s | 79,9 perfis/min |

O job de 416 perfis comprova que o caminho feliz pode terminar em aproximadamente 5,5 minutos. Também comprova que o resultado pode conter falhas terminais e que a UI não deve interpretar “job finalizado” como “todos os perfis atualizados”. A taxa de sucesso observada variou de 81,6% a 100%.

### 13.5 Onde o tempo é gasto

Telemetria Pomodoro, por execução bem-sucedida:

| Etapa | Quantidade | p50 | p95 | Observação |
|---|---:|---:|---:|---|
| leitura de billing da conexão | 7.652 | 1.384 ms | 1.921 ms | custo maior e repetido por perfil |
| account insights | 7.507 | 938 ms | 2.070 ms | chamada principal da Zernio |
| analytics de posts | 7.504 | 393 ms | 931 ms | chamada separada |
| daily metrics | 7.500 | 296 ms | 559 ms | chamada separada |
| listagem de contas | 7.491 | 230 ms | 578 ms | lista todas as contas para achar uma |
| posts atuais | 7.497 | 240 ms | 575 ms | sobrepõe parte de post analytics |
| histórico de seguidores | 7.504 | 188 ms | 388 ms | chamada separada |
| persistência do snapshot | 7.494 | 187 ms | 356 ms | inclui JSONB bruto |

O custo lógico por perfil no caminho completo é aproximadamente:

- 1 leitura de perfil;
- 1 criação de sync run;
- 1 leitura/refresh de billing;
- 6 chamadas Zernio;
- até 4 gravações de analytics;
- 1 conclusão do item;
- 1 finalização de sync run.

Para 500 perfis, um refresh completo representa até 3.000 chamadas Zernio, além de milhares de operações Supabase. Mesmo com concorrência 10, isso não deve ser tratado como uma ação interativa que bloqueia um botão.

O billing possui cache por conexão dentro de um ciclo, mas o throttle é recriado a cada chamada do dispatcher. Como os ciclos processam 20 itens e a organização possui centenas de conexões, o cache não dura pelo job inteiro. Billing deve ser controlado por conexão em armazenamento compartilhado, com TTL, e não reconsultado por perfil/ciclo.

### 13.6 Erros dominantes

Na organização Pomodoro, a telemetria registrou:

- 218 falhas `42P10` em persistência de posts e conclusão de itens;
- 133 erros `platform_api_error` em account insights;
- 14 erros de permissão;
- falhas pontuais de timeout/5xx;
- 4 violações `23514` em snapshots.

O `42P10` é erro estrutural de banco/`ON CONFLICT`, não indisponibilidade transitória da Zernio. Ele não deve consumir retry exponencial como se fosse erro remoto. Antes de elevar concorrência ou mover execução, é obrigatório corrigir a constraint/índice usada por `profile_post_analytics_snapshots` e classificar erros permanentes de persistência separadamente.

## 14. Por que o botão tenta atualizar perfis demais

No estado global da dashboard, o clique manual envia `force: true` e não envia `profileIds`. A RPC interpreta isso como todos os perfis Zernio elegíveis da organização e ignora frescor. Assim, um botão aparentemente simples cria um job de aproximadamente 400 a 500 itens.

Contrato substituto:

1. **Atualizar seleção:** atualiza apenas perfil/grupo selecionado, com limite explícito.
2. **Atualizar dados recentes:** inclui apenas perfis stale ou nunca sincronizados; não usa `force` global.
3. **Atualização completa:** ação administrativa separada, com confirmação, estimativa de itens/requests/tempo e execução em background.
4. **Reprocessar falhas:** seleciona apenas falhas retryable após correção da causa.

O endpoint deve devolver imediatamente `job_id`, `selected_count`, `estimated_requests`, `estimated_seconds`, `already_fresh_count` e `rejected_count`. A tela nunca deve esperar a conclusão do job para continuar funcional.

## 15. Modelo definitivo de coleta

### 15.1 Separar classes de atualização

O método monolítico por perfil deve ser dividido em classes com cadências independentes:

| Classe | Fontes | Cadência proposta | Uso |
|---|---|---|---|
| `current` | account insights e contador atual necessário | stale 30–60 min | KPIs e saúde atual |
| `daily` | daily metrics e follower history | 1–4 vezes/dia, revisitando 4 dias | séries normalizadas |
| `posts` | posts novos/alterados e analytics de posts | incremental, por cursor/data | top posts |
| `inventory` | listagem de contas | sync de conexão e TTL de horas | metadados; não por perfil |
| `backfill` | janelas históricas de até 89 dias | baixa prioridade, lotes | reconstrução histórica |

O refresh operacional atual de quatro dias é adequado para reconciliação incremental. Ele não deve ser confundido com backfill anual. Janelas longas devem ser quebradas em blocos de no máximo 89 dias, executadas uma vez e persistidas de forma idempotente.

### 15.2 Evitar chamadas redundantes

- mover `listAccounts()` para um cache/inventário por conexão;
- buscar billing uma vez por conexão e TTL compartilhado;
- não chamar posts atuais e analytics de posts em todos os perfis se não houver cursor/data nova;
- manter `account_insights` como fonte obrigatória apenas da classe `current`;
- permitir sucesso parcial por classe sem refazer fontes que já foram persistidas;
- gravar watermark por `profile + source` para saber exatamente o que está stale.

### 15.3 Claim por item e colaboração real

O claim deve ocorrer diretamente sobre itens elegíveis usando `FOR UPDATE SKIP LOCKED`, sem conceder exclusividade do job inteiro a um worker. O job passa a ser somente um agregado de progresso.

Cada item deve conter:

- `job_id`, `profile_id`, `source_class` e prioridade;
- conexão e organização;
- `available_at`, attempts e lease;
- watermark/janela;
- erro classificado;
- custo estimado em requests.

Com isso, dois ou mais executores podem colaborar no mesmo job, respeitando semáforos distribuídos por conexão. A conclusão do job é calculada pelos estados dos itens, não pelo lease de um processo.

### 15.4 Execução pesada na VPS

Arquitetura preferida:

1. criar um entrypoint Node dedicado que importe o executor de analytics;
2. executar chamadas Zernio e persistência diretamente na VPS;
3. manter a Vercel apenas para criar jobs, consultar status e servir a dashboard;
4. usar chave de serviço e segredos exclusivamente no ambiente da VPS;
5. implantar pelo mesmo padrão de service manager/heartbeat dos demais workers;
6. impedir execução dupla Vercel + VPS por feature flag de executor.

Alternativa de menor mudança: manter a Vercel como executor e declarar a VPS apenas scheduler. Essa alternativa não aproveita o servidor contratado, continua dependente dos limites da Vercel e não é a recomendação para o estado final.

Mover para VPS não elimina limites da Zernio. O ganho vem de processos duráveis, controle de conexão, menos overhead HTTP interno, colaboração entre workers e ausência de limite de duração de função. A concorrência inicial deve permanecer 10 e só subir após medir 429, 5xx, latência e billing por conexão.

### 15.5 Orçamento e fairness

- limite global inicial: 10 chamadas/perfis concorrentes por processo;
- limite inicial por conexão: 2, ajustável por telemetria; o atual 5 pode ser alto para credenciais compartilhadas;
- round-robin por conexão para impedir monopólio;
- token bucket distribuído por conexão;
- circuit breaker para 429, 5xx, timeout, autenticação e billing;
- prioridade: manual de seleção, connection sync, stale automático, backfill;
- reservar capacidade para jobs pequenos enquanto houver atualização completa em andamento.

## 16. Integração do refresh com a dashboard V2

A dashboard lê sempre o último dado válido de `profile_analytics_current` e das tabelas normalizadas. Um job em andamento não apaga nem invalida esse dado.

Fluxo de UI:

1. clique cria job e retorna em menos de 1 segundo;
2. card mostra `queued/processing`, quantidade concluída e cobertura;
3. cada item concluído atualiza current state e invalida somente tags do escopo afetado;
4. KPIs podem incorporar resultados progressivamente, sem `router.refresh()` da página inteira;
5. falhas mostram contagem e classificação, mantendo o último valor com selo de frescor;
6. conclusão parcial é apresentada como parcial, não como sucesso total nem zero.

Polling de cinco segundos do job inteiro deve ser substituído por polling com backoff de um resumo pequeno, ou Realtime/SSE se a operação justificar. O payload de status não deve listar todos os itens a cada consulta.

## 17. Dimensionamento e SLOs

### 17.1 Baseline medido

- caminho feliz atual: aproximadamente 75–85 perfis/minuto;
- 500 perfis: aproximadamente 6–7 minutos no melhor caso observado;
- p95 real de jobs grandes/contendidos: 10–12 minutos;
- máximo observado em sete dias: aproximadamente 33 minutos;
- sucesso de jobs observados nos logs: 81,6%–100%.

### 17.2 Metas da coleta V2

- criação de job p95 < 1 segundo;
- atualização de um perfil selecionado p95 < 10 segundos;
- primeiro resultado de atualização completa < 15 segundos;
- 95% dos perfis stale processados em < 10 minutos, sem exigir espera da UI;
- cobertura saudável diária > 98%;
- dead-letter < 1% após excluir erros permanentes conhecidos;
- zero retry automático para erros de schema/constraint, autenticação permanente ou plano;
- lag do worker < 30 segundos quando houver fila;
- nenhuma conexão utiliza mais de 20% dos slots por longos períodos quando outras aguardam;
- nenhuma função Vercel executa o loop pesado no estado final preferido.

As metas de leitura da seção 8 continuam válidas independentemente da coleta. A dashboard deve abrir rápido mesmo durante um refresh total ou indisponibilidade completa da Zernio.

## 18. Plano integrado de implementação

### Fase A — Contenção segura da dashboard e do botão

1. Remover `raw_payload` do select da dashboard.
2. Eliminar fail-fast global e separar fronteiras de erro.
3. Alterar o botão padrão para atualizar somente seleção ou stale; remover `force` global implícito.
4. Criar ação administrativa separada para atualização completa.
5. Exibir progresso e último dado válido sem bloquear a página.

Critério: dashboard abre com analytics falhando e nenhum clique comum cria silenciosamente 500 itens.

### Fase B — Corrigir erros estruturais e reduzir desperdício

1. Corrigir e testar o conflito `42P10` em posts analíticos.
2. Classificar erros de banco permanentes sem retry.
3. Persistir cache de billing por conexão com TTL.
4. Remover `listAccounts()` do caminho por perfil.
5. Introduzir watermarks por classe de fonte.
6. Instrumentar bytes e quantidade de requests por perfil/classe.

Critério: nenhum erro `42P10` em canary e redução mensurável de chamadas por perfil.

### Fase C — Dashboard agregada V2

Executar as fases 1 e 2 já definidas: bootstrap, analytics e top posts agregados, UI progressiva e cache por filtro.

Critério: metas de leitura da seção 8 atendidas em fixture de 1.500 perfis e canary de produção.

### Fase D — Fila V2 por item

1. Criar schema aditivo de classes, watermarks e leases por item.
2. Implementar claim distribuído e fairness por conexão.
3. Executar shadow jobs sem escrita destrutiva.
4. Comparar contagens, duração e resultados com fila atual.

Critério: dois executores colaboram no mesmo job sem duplicidade e todos os testes de lease/idempotência passam.

### Fase E — Executor direto na VPS

1. Empacotar worker Node com dependências necessárias.
2. Implantar um processo canary com concorrência baixa.
3. Desabilitar dispatcher pesado da Vercel apenas para a organização canary.
4. Comparar throughput, erro, custo e uso de recursos.
5. Ampliar por organização e manter kill switch.

Critério: 24 horas sem duplicação, leases órfãos ou aumento de erro; heartbeat e backlog alertáveis.

### Fase F — Current state e arquivo bruto

Executar dual-write, backfill, paridade e corte conforme a fase 3 original. Arquivar payload bruto com retenção; não removê-lo antes da validação.

### Fase G — Corte e limpeza

Remover consultas anuais, worker monolítico, rota interna pesada e tabelas/contratos antigos somente após janela de rollback.

## 19. Pré-requisitos e decisão de implementação

### 19.1 Pronto para aplicar agora

Mudanças de contenção, aditivas e reversíveis:

- remover payload bruto da leitura;
- isolamento de falhas da dashboard;
- trocar refresh global implícito por stale/seleção;
- corrigir `42P10` com migration e teste;
- cache compartilhado de billing/inventário;
- observabilidade e status progressivo.

### 19.2 Não pronto para corte direto

Não há evidência suficiente para substituir em um único deploy a fila, a leitura e o executor. Antes disso são necessários:

- teste de carga com 1.500 perfis;
- confirmação dos limites contratuais de requests da Zernio por chave/conexão;
- teste de claim por item com múltiplos workers;
- inventário de segredos/rede da VPS;
- paridade V1/V2 de KPIs;
- migration de current state com backfill validado;
- runbook de rollback e kill switch.

A decisão correta é implementar primeiro as fases A e B e preparar C/D de forma aditiva. Mover todo o trabalho para a VPS antes de corrigir a granularidade da fila e os erros estruturais apenas deslocaria a mesma lógica problemática para outra máquina.

## 20. Critérios finais de aceite

O sistema somente pode ser declarado robusto quando:

1. a dashboard abre e mantém agenda/filtros durante timeout de qualquer fonte;
2. nenhum endpoint do bootstrap transporta coleções anuais ou JSONB bruto;
3. botão comum nunca agenda todos os perfis sem confirmação explícita;
4. último dado válido permanece visível durante refresh e falhas;
5. cobertura, frescor e falhas são exibidas separadamente;
6. múltiplos workers colaboram no mesmo job sem duplicidade;
7. erros permanentes não entram em retry infinito;
8. 500 perfis não bloqueiam interação e têm progresso visível;
9. metas de leitura e coleta são atendidas por sete dias na organização grande;
10. desligar Zernio ou VPS degrada analytics, mas não derruba a dashboard;
11. rollback por flag restaura o caminho anterior sem perda de dados;
12. alertas detectam timeout interno mesmo quando a resposta externa for HTTP 200.

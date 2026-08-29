# Plano de estabilização do Supabase, filas e upgrade de compute

**Criado em:** 27/08/2026  
**Escopo:** PostgreSQL/Supabase, workers da VPS, geração de filas, publicação, preparação de mídia, limpeza, sincronização Zernio, analytics e observabilidade.  
**Estado:** correções estruturais sem upgrade implantadas até a migration 314; validação temporal no Micro em andamento.  
**Plano relacionado:** `plans/plano-reconstrucao-central-logs-instagram-2026-08-26.md`.

## 1. Objetivo

Eliminar a condição em que ações legítimas de um único usuário — geração de filas grandes, limpeza de concluídos e sincronização geral Zernio — conseguem esgotar CPU, memória e I/O do banco e degradar publicações, painel e os demais usuários.

O resultado esperado não é apenas “o banco aguentar a operação de hoje”. O sistema deve controlar sua própria pressão, priorizar publicações no horário, distribuir trabalho pesado ao longo do tempo e continuar saudável com múltiplas organizações e aproximadamente 2.500 perfis por organização.

## 2. Diagnóstico que este plano precisa resolver

### 2.1 Capacidade atual

- Supabase Micro: 1 GB de memória, CPU compartilhada com dois núcleos e 60 conexões máximas;
- banco com aproximadamente 3,5 GB, portanto o tamanho armazenado não é o problema principal;
- captura observada com compute em 100%, CPU em 97%, memória em 90% e I/O em 100%;
- conexões em aproximadamente 37/60 na captura e 20–21 sessões PostgREST nas amostras diretas: não houve esgotamento do teto de conexões;
- VPS com CPU, memória e load baixos: o gargalo está no banco, não na máquina dos workers;
- ausência de deadlock, bloqueador longo ou uma única consulta presa: a saturação é a soma de trabalho concorrente e repetitivo.

### 2.2 Carga ativa

- cerca de 90 mil itens ainda aguardando publicação e mais de 2,4 mil vencidos na amostra;
- geração ainda precisava materializar aproximadamente 14,5 mil slots ativos, além de resíduos de planos com erro;
- `process_bulk_rotation_generation_chunk` excedeu o `statement_timeout` mesmo processando um chunk por ciclo;
- em uma janela de 20 segundos, geração, deferimento, preparação, claim e conclusão consumiram juntos cerca de 22,7 segundos de tempo de banco, além de checkpoint, WAL e manutenção interna;
- a trava global criada na migration `302` impede geração, limpeza e sync Zernio de rodarem simultaneamente, mas não limita a geração contínua nem a soma dela com publicação, preparação, analytics e manutenção.

### 2.3 Hotspots comprovados

- geração compacta: alto tempo, leitura de buffers e aproximadamente 5,2 MB de WAL em apenas duas chamadas observadas;
- `get_publication_queue_operational_summary`: chamada frequente e custo histórico muito alto para uma informação de painel;
- `reset_due_zernio_media_preparation`: bilhões de buffer hits acumulados, indicando varredura excessiva;
- `claim_publication_items`, `claim_publication_preparation_items`, `defer_publication_item`, `complete_publication_item` e `reserve_publication_dispatch_capacity`: custo relevante e concorrente no caminho crítico;
- heartbeats, circuit breakers, incidentes e eventos recebem updates frequentes e provocam autovacuum/autoanalyze desproporcional;
- `publication_items` tinha aproximadamente 61 mil tuplas mortas, e `publication_item_events`, aproximadamente 24 mil;
- o WAL estava em aproximadamente 464 MB e o checkpointer ficou ativo durante o pico.

## 3. Decisão sobre o upgrade

### 3.1 Tamanho recomendado agora

Fazer upgrade de **Micro (1 GB) para Small (2 GB)** como aumento imediato de margem operacional.

O Small:

- dobra a memória de 1 GB para 2 GB;
- aumenta o teto de conexões de 60 para 90;
- dobra a linha de base de throughput/IOPS disponível para os tamanhos pequenos;
- mantém CPU compartilhada de dois núcleos, portanto não corrige sozinho consultas caras ou concorrência sem controle.

Conclusão: o upgrade deve ser feito, mas não substitui nenhuma fase de otimização. Ele reduz a chance de swap e de esgotar o orçamento de I/O durante a correção. Se, depois das otimizações e do teste de carga, CPU compartilhada continuar sendo o limitador, será avaliado **Large**, primeiro tamanho com CPU dedicada. Não subir diretamente para Large sem essa medição.

Referências oficiais:

- [Compute e disco do Supabase](https://supabase.com/docs/guides/platform/compute-and-disk)
- [Diagnóstico de problemas da API HTTP e I/O esgotado](https://supabase.com/docs/guides/troubleshooting/http-api-issues)
- [Uso elevado de memória e swap](https://supabase.com/docs/guides/troubleshooting/exhaust-ram)

### 3.2 Melhor janela

**Janela principal recomendada:** domingo, **30/08/2026, das 05:05 às 05:35 BRT**.

Motivos:

- madrugada entre 03:00 e 05:59 foi a faixa de menor volume de eventos nas amostras dos últimos sete dias;
- domingo apresentou baixo volume histórico de publicações nessa faixa;
- começar em `05:05`, e não exatamente `05:00`, evita o agrupamento natural de agendas no início da hora;
- a manutenção diária da Central de Logs executa às `03:17 BRT`, deixando margem para ela terminar;
- a janela reserva 30 minutos, embora o Supabase informe que a troca normalmente leva menos de dois minutos e possa excepcionalmente demorar mais.

**Condição obrigatória:** antes da mudança, confirmar no painel `Database > Backups` que nenhum backup está em execução e anotar o último backup concluído. O horário do backup gerenciado não foi inferido sem evidência.

### 3.3 Janela de contingência por risco atual

Se CPU ou I/O permanecerem em 100% por cinco minutos, o Data API voltar a apresentar timeout/PGRST002, ou publicações no horário começarem a atrasar, **não esperar até domingo**. Usar a primeira janela emergencial disponível entre **04:05 e 05:35 BRT**, após confirmar backup concluído e aplicar o roteiro de drenagem da Fase 2.

Nesse cenário, a indisponibilidade planejada de poucos minutos é menos perigosa do que manter um banco intermitentemente indisponível e sem previsibilidade.

## 4. Ordem de execução

O upgrade é capacidade adicional, não correção. A ordem aprovada é:

1. instalar controles de admissão, pausa, retomada, cooldown e prioridade;
2. corrigir geração, publicação/recuperação, consultas operacionais, Zernio e excesso de escrita ainda no Micro;
3. executar teste combinado no Micro e observar por pelo menos 2–4 horas, incluindo publicações reais no horário;
4. se o Micro estabilizar, manter as correções e fazer o upgrade para Small na janela planejada como reserva de crescimento;
5. se houver saturação crítica antes da janela, aplicar o gate mínimo de estabilização e antecipar o upgrade usando o runbook da Fase 7;
6. observar o conjunto corrigido + Small por 24 horas antes de retomar a Fase 8 da Central de Logs.

## 5. Fases de execução

### Fase 0 — Baseline e congelamento do gate

**Estado:** concluída; baseline, saturação, backlog, banco, workers e condição de rollback registrados no diário.

- declarar a janela 7B da Central de Logs inválida a partir da nova saturação;
- manter a Fase 8 e a remoção do legado bloqueadas;
- salvar baseline de 24 horas: CPU, RAM, swap, Disk I/O consumed, conexões, WAL/min, checkpoints, latência e erros por RPC;
- registrar tamanho e tuplas mortas das tabelas críticas;
- registrar backlog por estado, atrasos por faixa e slots ainda não gerados;
- criar relatório repetível de `pg_stat_statements` por intervalo, não apenas acumulado desde o reset.

**Gate:** baseline reproduzível, sem alterar dados nem reiniciar serviços.

### Fase 1 — Contenção e orçamento adaptativo

**Estado:** implementação concluída e ativa em produção; gate em observação temporal.

- ampliar a migration `302`: além de exclusão mútua, aplicar orçamento de tempo de banco, cooldown e backoff com jitter;
- impedir que geração libere e readquira o lease imediatamente durante horas;
- dar precedência explícita a publicação no horário, recuperação de publicação e autenticação/leitura básica;
- criar filas de capacidade separadas: crítica, operacional e pesada;
- limitar admissões grandes por organização e globalmente, sem criar cota comercial de publicações;
- quando o banco degradar, pausar automaticamente geração, limpeza, sync geral, backfill e analytics histórico; publicação e recovery permanecem ativos;
- expor na interface “aguardando capacidade do sistema”, posição/progresso e motivo, em vez de erro genérico;
- impedir cliques repetidos de criarem operações equivalentes concorrentes por idempotency key;
- criar botão administrativo de pausa e retomada segura para cada classe pesada, com auditoria.

**Gate:** três ações pesadas simultâneas são aceitas como jobs duráveis, mas apenas uma consome a faixa pesada; a faixa crítica mantém latência e throughput.

### Fase 2 — Otimização do caminho crítico de publicação

**Estado:** implementação concluída e ativa em produção; latência sob carga futura continua sendo medida.

- medir com `EXPLAIN (ANALYZE, BUFFERS, WAL)` as RPCs de claim, reserve, defer, complete e preparação em cópia representativa ou transação descartável;
- ajustar índices por `organization_id`, estado e `scheduled_at/next_attempt_at`, removendo índices redundantes somente após prova de uso;
- reduzir o lote reivindicado ao que a concorrência realmente processa; não claimar 100 para executar quatro;
- separar itens no horário de backlog antigo para que vencidos não bloqueiem os atuais;
- agrupar atualizações e eventos seguros, evitando round trips e WAL por item quando o contrato permitir;
- retirar o resumo operacional do loop de cada worker; atualizá-lo por snapshot de 1–5 minutos ou sob demanda;
- impedir eventos repetidos de deferimento sem mudança material de estado;
- preservar idempotência por publicação, tentativa e provedor.

**Gate:** sem `statement_timeout`; p95 de claim abaixo de 300 ms, complete/defer abaixo de 200 ms e resumo abaixo de 500 ms sob carga combinada.

### Fase 3 — Redesenho da geração de filas

**Estado:** implementação concluída e ativa em produção; 25/50/100 e horizonte móvel validados sem carga artificial.

- parar de materializar dezenas de milhares de slots imediatamente;
- manter somente um horizonte móvel inicial de 24–48 horas por agenda, reposto incrementalmente;
- substituir o passo fixo de 500 por controle adaptativo: iniciar em 25, usar 50 como regime normal e permitir 100 somente após dez fatias consecutivas abaixo de 250 ms, sem timeout recente e sem publicação atual atrasada;
- reduzir imediatamente para 25 quando uma fatia ultrapassar 750 ms, quando a fila crítica atrasar ou quando a Data API apresentar degradação; após `statement_timeout`, pausar a geração por 120 segundos antes de nova tentativa;
- aplicar cooldown após cada fatia igual ao maior valor entre 250 ms e duas vezes a duração da chamada, limitado a cinco segundos; com fila crítica atrasada, elevar o cooldown para 5–15 segundos;
- medir o throughput útil por slots confirmados por minuto, descontando timeout e retry, e não pela quantidade nominal enviada em uma transação;
- persistir cursor e progresso para retomada exata após timeout/restart;
- usar restrições únicas e operações idempotentes para eliminar validações globais repetidas;
- separar geração de itens, anexação de mídia e emissão de observabilidade quando isso reduzir contenção e WAL;
- priorizar o horizonte mais próximo e distribuir justiça entre organizações, impedindo uma conta com 2.500 perfis de monopolizar o gerador;
- revisar planos `completed_with_errors` para não reprocessar sete mil slots históricos sem decisão explícita.

**Gate:** criar a carga equivalente a 2.500 perfis sem CPU/I/O sustentados acima de 80%, sem timeout e sem afetar publicações no horário.

#### Efeito esperado das fatias menores

- uma fatia menor adiciona mais commits e round trips, portanto pode reduzir o throughput bruto quando o banco está completamente ocioso;
- a transação atual de 500 também cria itens, associa mídia, grava eventos e revalida todo o intervalo; nas amostras reais ela levou segundos, produziu aproximadamente 5,2 MB de WAL em duas chamadas e chegou ao timeout;
- no cenário real, o throughput relevante tende a melhorar porque as fatias concluem, liberam locks/memória mais cedo e não precisam ser repetidas integralmente após timeout;
- 25 não será a velocidade permanente: é o canário e o modo de pressão; 50 é o regime inicial normal e 100 é liberado automaticamente somente quando houver folga comprovada;
- o horizonte móvel de 24–48 horas reduz muito mais o trabalho total imediato do que a mudança de tamanho reduz a velocidade, pois a definição completa da agenda permanece salva sem materializar meses de publicações antecipadamente;
- nenhum percentual de perda de velocidade será prometido antes do benchmark. O gate compara slots confirmados/minuto, atraso das publicações atuais, WAL/min e CPU/I/O com a implementação de 500.

### Fase 4 — Zernio, mídia, limpeza e manutenção

**Estado:** implementação concluída e ativa em produção; operações subordinadas ao gate de publicação.

- reescrever `reset_due_zernio_media_preparation` para buscar somente itens realmente vencidos por índice e em lote pequeno;
- revisar `promote_cached_zernio_media_preparation` e evitar rewrites sem mudança de valor;
- manter sync geral retomável por cursor e por organização, sem inventário inteiro em uma transação;
- manter limpeza em lotes pequenos, mas adaptar pausa ao estado real do banco;
- garantir que limpeza arquive somente terminais elegíveis e não force atualização de lotes inteiros;
- separar manutenção crítica de retenção da manutenção reparadora/histórica;
- impedir que a rotina diária das `03:17 BRT` concorra com upgrade, backfill ou geração grande.

**Gate:** manutenção frequente p95 abaixo de 3 s, sync e limpeza retomáveis e zero scan global comprovado nas rotas quentes.

### Fase 5 — Redução de churn, WAL e autovacuum

**Estado:** implementação e vacuums direcionados concluídos; comparação equivalente de WAL permanece pendente.

- heartbeat somente a cada 30–60 segundos ou quando estado/erro mudar;
- circuit breaker consultado uma vez por ciclo e mantido em memória durante a unidade de trabalho;
- incidente atualizado somente quando fingerprint, contramedida, severidade ou bucket de contagem mudar;
- agregar eventos operacionais repetitivos sem perder investigação por perfil/publicação;
- aplicar parâmetros de autovacuum e `fillfactor` específicos nas tabelas com update intenso;
- depois de estabilizar a escrita, executar `VACUUM (ANALYZE)` direcionado em janela calma;
- não executar `VACUUM FULL` em produção sem plano separado de lock e espaço;
- revisar partições e retenção de 14 dias para evitar índice e tabela quente maiores que o necessário.

**Gate:** tuplas mortas abaixo de 10% nas tabelas quentes, autovacuum sem atraso, WAL/min reduzido pelo menos 50% no mesmo cenário e sem aumento de perda de informação operacional.

### Fase 6 — Teste de carga integrado no Micro

**Estado:** validação funcional e produção real aprovadas; observação de 2–4 h e cenário integrado equivalente permanecem pendentes.

Executar cenários isolados e combinados:

1. publicação normal;
2. pico de publicações no mesmo minuto;
3. geração equivalente a 2.500 perfis;
4. limpeza de dezenas de milhares de concluídos;
5. sync geral Zernio;
6. analytics e manutenção ativos;
7. os cinco cenários pesados solicitados quase simultaneamente por organizações diferentes;
8. falha/restart do Supabase e retomada dos leases.

**Critérios obrigatórios:**

| Sinal | Limite de aprovação |
|---|---|
| CPU do banco | p95 abaixo de 70%; nenhum período acima de 85% por 5 min |
| Memória | abaixo de 80%; swap sem crescimento sustentado |
| Disk I/O consumed | não atingir 100%; sem tendência contínua de esgotamento |
| Conexões | p95 abaixo de 60% do teto do compute |
| APIs/Data API | zero PGRST002/PGRST003 e zero 5xx por saturação |
| SQL | zero `statement_timeout` nas rotas e workers testados |
| Publicações no horário | sem perda/duplicidade; atraso p95 abaixo de 60 s |
| Backlog | estável ou decrescente depois do pico |
| WAL | pelo menos 50% menor que a baseline no mesmo cenário |
| Workers | heartbeats abaixo de 120 s e nenhum restart loop |
| Isolamento | uma organização pesada não degrada as demais |

**Gate pré-upgrade:** nenhuma regressão funcional, zero timeout de geração e publicação atual preservada durante 2–4 horas reais. Se esse gate falhar, corrigir antes da janela; se houver saturação crítica que impeça a própria correção, usar a janela emergencial da Fase 7.

### Fase 7 — Preparação e execução do upgrade

**Estado:** pendente; executar depois das correções e requer autorização explícita no dia.

#### T-30 minutos

- confirmar backup concluído e ausência de incidente na página de status do Supabase;
- impedir novas gerações grandes, limpezas, sync geral e backfills;
- manter publicação normal enquanto jobs em voo terminam;
- confirmar que o lease pesado está livre e sem holder expirado;
- capturar backlog, itens vencidos, heartbeats, conexões e métricas do banco;
- preparar rollback de configuração dos workers, sem fazer downgrade automático do banco.

#### T-5 minutos

- suspender crons de manutenção frequente e diária;
- parar de reivindicar novos trabalhos de geração, mídia não urgente, analytics e Zernio;
- manter o publicador até T-1 minuto e então encerrá-lo graciosamente após terminar claims em voo;
- confirmar que nenhum item ficou com lease não recuperável; leases expirados devem voltar à fila automaticamente.

#### Upgrade

- alterar o compute para Small/2 GB no painel do Supabase;
- considerar a janela indisponível até Postgres, Auth, Storage e Data API responderem saudáveis;
- não reiniciar nem redimensionar repetidamente se o processo demorar; após dez minutos sem recuperação, consultar status e suporte do Supabase.

#### Retomada

1. validar conexão direta e uma leitura simples pela Data API;
2. iniciar publicação e recuperação primeiro;
3. confirmar ausência de duplicidade e redução dos vencidos;
4. iniciar preparação de mídia com concorrência mínima;
5. iniciar Zernio e analytics;
6. reativar manutenção frequente;
7. reativar geração pesada por último, ainda limitada;
8. manter manutenção diária para a próxima janela normal, salvo necessidade comprovada.

**Gate:** serviços saudáveis, cinco classes de worker com heartbeat recente, nenhum item perdido/duplicado e atraso retornando à baseline.

### Fase 8 — Rollout e decisão de capacidade definitiva

**Estado:** pendente.

- canário por uma organização e depois 10%, 25%, 50% e 100%; regressão volta somente a fase afetada;
- observar Small por 24 horas de operação real e um pico planejado;
- manter dashboards e alertas para CPU, RAM/swap, I/O, conexões, WAL, erros, atrasos e duração das RPCs;
- se RAM e I/O ficarem saudáveis, mas CPU compartilhada permanecer alta depois das otimizações, planejar Large/CPU dedicada;
- se o Small permanecer dentro dos limites, mantê-lo e não pagar por capacidade sem necessidade;
- reiniciar a Fase 7B da Central de Logs somente depois deste gate;
- executar a Fase 8 de remoção do legado da Central de Logs somente após as novas 24 horas integralmente aprovadas.

## 6. Rollback e proteção de dados

- jobs pesados devem ser duráveis e retomáveis; nunca depender apenas da memória do worker;
- todo claim deve ter lease expirável e idempotency key;
- durante o upgrade, publicações que vencerem devem voltar como recuperação prioritária;
- não fazer downgrade imediato de compute como resposta a falha: isso provoca nova indisponibilidade;
- migrations de índice/função serão forward-only; a função anterior poderá permanecer com nome versionado até o canário passar;
- nenhum dado de fila, agenda, perfil, mídia ou auditoria será apagado como parte do upgrade;
- o legado da Central de Logs permanece disponível como rollback até o gate final.

## 7. Registro de execução

Atualizar esta tabela ao concluir cada etapa, incluindo evidência, deployment/migration, horário BRT e resultado do gate.

| Fase | Estado | Início | Fim | Evidência/resultado |
|---|---|---|---|---|
| 0 — baseline | concluída | 27/08/2026 | 28/08/2026 00:08 BRT | saturação, hotspots, backlog, banco e workers registrados |
| 1 — contenção adaptativa | implementada; observação | 28/08/2026 00:08 BRT | 28/08/2026 02:45 BRT | gates ativos; publicações sempre vencem trabalho pesado |
| 2 — publicação | implementada; gate SQL aprovado | 28/08/2026 00:24 BRT | 28/08/2026 02:51 BRT | claim 118,2 ms, preparação 185 ms, snapshot 4,6 ms e barreira de atraso 313 |
| 3 — geração adaptativa | implementada; observação | 28/08/2026 00:22 BRT | 28/08/2026 02:39 BRT | início 50, proteção 25, alvo 100, horizonte 48 h e cursor idempotente |
| 4 — Zernio/mídia/manutenção | implementada; observação | 28/08/2026 00:28 BRT | 28/08/2026 00:56 BRT | lotes limitados e consumidores subordinados ao gate |
| 5 — churn/WAL/vacuum | implementação concluída; WAL pendente | 28/08/2026 00:15 BRT | 28/08/2026 02:45 BRT | telemetria reduzida; duas tabelas voltaram abaixo de 0,1% mortas; falta comparação equivalente de WAL |
| 6 — teste no Micro | validação funcional aprovada; janela aberta | 28/08/2026 00:40 BRT | — | 353 testes, build, produção real e recuperação aprovados; faltam 2–4 h e cenário equivalente seguro |
| 7 — upgrade Small | pendente | — | — | janela recomendada 30/08/2026 05:05 BRT |
| 8 — rollout | pendente | — | — | — |

## 8. Próxima ação recomendada

Implementar as Fases 0–5, priorizando primeiro geração adaptativa, retirada do resumo do loop, claim compatível com concorrência e redução da telemetria repetitiva. Executar a Fase 6 ainda no Micro e observar por 2–4 horas. Depois fazer o upgrade para Small na janela principal como margem de crescimento. Se a saturação crítica reaparecer e impedir a estabilização antes disso, antecipar a Fase 7 para a janela emergencial entre 04:05 e 05:35 BRT, sem abandonar as correções estruturais.

## 9. Diário detalhado da execução estrutural sem upgrade

### 9.1 Protocolo obrigatório de checkpoint

Cada passo deve registrar, antes de avançar: estado, início/fim em BRT e UTC, baseline, arquivos/migrations/workers/deployment, comandos sem segredos, testes, evidência de produção, rollback, última condição segura e próxima ação exata. Credenciais, tokens e URLs assinadas nunca entram neste documento.

### 9.2 Início — 28/08/2026 00:08:42 BRT / 03:08:42 UTC

**Estado:** em execução.  
**Fase/passo:** Fase 0 — registro e confirmação da baseline; próximo passo é geração adaptativa.  
**Autorização:** implementar todas as correções estruturais descritas no plano, mantendo o Supabase Micro e sem executar upgrade.

#### Baseline anterior preservada

- compute chegou a 100%, CPU a 97%, memória a 90% e Disk I/O a 100%;
- banco com aproximadamente 3,5 GB, WAL de aproximadamente 464 MB e conexões abaixo do teto;
- VPS permaneceu folgada, confirmando o Supabase como gargalo;
- fila observada com aproximadamente 90 mil itens aguardando, 2,4 mil vencidos e geração compacta ainda com cerca de 14,5 mil slots ativos;
- `process_bulk_rotation_generation_chunk`: duas chamadas consumiram aproximadamente 7,45 s de banco e 5,17 MB de WAL em 20 s; houve `statement_timeout` real;
- `PUBLICATION_GENERATION_WORKER_BULK_STEP_SIZE` efetivo/default: 500;
- `PUBLICATION_WORKER_PREPARATION_LIMIT` default: 100 para concorrência efetiva 4;
- `get_publication_queue_operational_summary` é chamado em todo ciclo direto do worker, cujo polling default é cinco segundos;
- o worker grava eventos separados `started` e `completed` em cada ciclo;
- migration local/remota mais recente antes desta execução: `302_global_heavy_workload_backpressure.sql`.

#### Estado do workspace

- o worktree já contém alterações anteriores do usuário e desta reconstrução; elas serão preservadas;
- os três workers principais já estavam modificados antes deste checkpoint e serão editados de forma incremental, sem descartar conteúdo existente;
- migration planejada seguinte: `303_structural_database_pressure_controls.sql`, forward-only;
- rollback inicial: manter cópia implantada atual na VPS, migration `302` e deployment Vercel vigente; cada worker será reiniciado isoladamente somente depois dos testes.

#### Próxima ação exata

Implementar testes e controlador adaptativo 25/50/100 no worker de geração, com início 50, cooldown, timeout de 120 s, heartbeat enriquecido e proteção contra reaquisição contínua do lease. Registrar resultados antes de tocar no worker de publicação.

### 9.3 Checkpoint local — geração, publicação e snapshot preparados

**Início:** 28/08/2026 00:08:42 BRT / 03:08:42 UTC.  
**Fim:** 28/08/2026 00:15:26 BRT / 03:15:26 UTC.  
**Estado:** implementação local aprovada; migration e rollout ainda não executados.

#### Alterações concluídas

- gerador começa em 50, reduz a 25 acima de 750 ms/erro/atraso crítico, sobe primeiro a 50 e depois a 100 após dez fatias rápidas por patamar;
- `statement_timeout`, PGRST002/PGRST003 e timeouts equivalentes reduzem o passo a 25 e bloqueiam nova geração pesada por 120 segundos;
- cooldown normal é `max(250 ms, 2 × duração)`, limitado a cinco segundos; atraso crítico usa 5–15 segundos; ausência de chunk usa 30 segundos;
- heartbeat do gerador passou a 60 segundos e inclui passo, duração, cooldown, motivo, slots processados e próxima liberação;
- preparação default caiu de 100 para quatro, igual à concorrência efetiva;
- worker direto deixou de consultar o resumo global em cada ciclo; modo observe preserva a leitura;
- evento `started` por ciclo foi removido; ciclos ociosos produzem no máximo um agregado por minuto e flush de telemetria passou a no máximo um a cada 30 segundos;
- migration `303_structural_database_pressure_controls.sql` foi preparada com sinal leve de atraso, prioridade da faixa atual, limite de 25% para backlog, índices temporais e snapshot por organização;
- health e Central de Logs passaram a consumir o snapshot com `generatedAt`/`stale`; manutenção frequente recompõe o snapshot fora do caminho da leitura.

#### Validação

- `npx tsc --noEmit`: aprovado;
- testes focados de geração, publicação e dispatcher: 42/42 aprovados;
- sintaxe Node dos workers e `git diff --check`: aprovados;
- nenhum serviço, dado remoto, worker ou compute foi alterado neste checkpoint.

#### Rollback e última condição segura

- rollback local: reverter somente os novos hunks de geração/publicação/rotas e remover migration/teste `303`; migrations 001–302 e workers implantados permanecem intactos;
- produção continua na última condição anterior, sem depender das novas RPCs;
- próxima ação exata: validar a migration 303 em dry-run/local, concluir horizonte móvel e otimizações Zernio, repetir suíte completa e somente então aplicar remotamente.

### 9.4 Migration 303 aplicada — 28/08/2026 00:20:55 BRT / 03:20:55 UTC

**Estado:** aprovada e alinhada no Supabase remoto; workers novos ainda não implantados.

- Docker local não está disponível/instalado, portanto o teste SQL transacional local não pôde ser executado;
- `supabase db push --linked --dry-run` mostrou exclusivamente a migration 303;
- antes da aplicação: TypeScript aprovado, build Next aprovado, suíte completa 298/298 e testes focados 42/42;
- `303_structural_database_pressure_controls.sql` foi aplicada sem erro e `supabase migration list --linked` confirmou `303 | 303`;
- o banco agora possui: sinal leve de atraso crítico, snapshots operacionais, prioridade de publicação atual, teto de 25% para backlog histórico, horizonte móvel de 48 horas e passo SQL máximo de 100/default 50;
- índices adicionados são parciais e limitados aos estados quentes de pressão/preparação;
- nenhuma alteração de compute foi executada.

**Rollback:** funções anteriores permanecem integralmente descritas nas migrations 086/207/264/274/275; se houver regressão, criar migration forward-only restaurando contratos anteriores. Não remover a 303 do histórico remoto.  
**Última condição segura:** schema 303 ativo com workers antigos; o worker antigo ainda envia passo explícito 500, mas a nova RPC rejeita acima de 100, portanto o gerador precisa ser implantado antes do próximo ciclo compacto.  
**Próxima ação exata:** implantar imediatamente somente `publication-generation-worker.mjs` e suas variáveis 25/50/100 na VPS, reiniciar apenas `athena-generation-worker` e validar heartbeat/logs/slots antes de tocar no publicador.

#### Intercorrência controlada da janela 303

- entre `03:20:55 UTC` e o restart do gerador, o worker anterior ainda enviou passo explícito 500 para a nova função limitada a 100;
- exatamente três chunks receberam `Passo adaptativo deve estar entre 1 e 100 slots.`; dois chegaram a `retry_exhausted_at` e um ficou com duas falhas;
- a falha ocorreu antes de qualquer insert, portanto não houve publicação parcial, duplicidade ou perda de cursor;
- migration forward-only `304_repair_adaptive_step_rollout_gap.sql` foi criada com mensagem e intervalo UTC exatos para restaurar somente os três chunks, sem tocar em falhas de negócio.

### 9.5 Reparo 304, workers e deployment — 28/08/2026 00:26:43 BRT / 03:26:43 UTC

**Estado:** migrations 303–304 e rollout dos workers aprovados; observação em andamento.

- a migration 304 foi aplicada remotamente e `supabase migration list --linked` confirmou `304 | 304`;
- validação pela mesma interface `service_role` usada pelos workers confirmou os três chunks exatos novamente em `queued`, com `failure_count = 0`, sem erro e sem alteração de outros chunks;
- o snapshot operacional foi recomposto para duas organizações, seis linhas globais e `stale = false`;
- o sinal leve de pressão apontou atraso crítico real, com item vencido desde aproximadamente `01:55 UTC`; o gerador novo respeitou esse sinal e entrou em cooldown em vez de disputar banco;
- backup remoto do gerador, publicador e arquivo de ambiente foi criado com sufixo `.before-303`;
- `athena-generation-worker` foi atualizado primeiro e reiniciado isoladamente com passo inicial 50, mínimo 25, máximo 100 e heartbeat de 60 s;
- `athena-publication-worker` foi atualizado depois e reiniciado isoladamente com preparação quatro e heartbeat de 60 s;
- ambos ficaram `online`; a VPS estava com aproximadamente 8% de CPU e 34% de RAM, e não houve nova linha nos logs de erro após os respectivos restarts;
- o publicador retomou dispatch direto com sucesso; o gerador preservou prioridade das publicações vencidas;
- Vercel produziu build de produção aprovado e publicou `dpl_DwgjYRbvte3WboCF5qA41unsNeg4`, estado `READY`, no alias principal;
- warnings de `viewport/themeColor` já existentes permaneceram não bloqueantes; nenhuma mudança de compute foi feita.

**Comandos sem segredos:** `supabase db push --linked`, `supabase migration list --linked`, restart isolado via PM2, `vercel deploy --prod` e consultas de validação pela interface de serviço.  
**Rollback:** cópias `.before-303` na VPS e deployment Vercel anterior continuam disponíveis; schema só retorna por migration forward-only.  
**Última condição segura:** migrations 303–304, workers novos online e deployment Vercel pronto.  
**Próxima ação exata:** validar/aplicar a migration 305 com tetos internos de 100 para reset e 250 para promoção Zernio; depois executar smoke e iniciar a janela cronometrada de observação.

### 9.6 Migration 305 aplicada — 28/08/2026 00:28:33 BRT / 03:28:33 UTC

**Estado:** aprovado; proteção Zernio ativa no Supabase remoto.

- `git diff --check` dos arquivos da etapa foi aprovado;
- o dry-run mostrou exclusivamente `305_bound_zernio_media_maintenance_batches.sql`;
- a migration foi aplicada sem erro e a listagem remota confirmou `305 | 305`;
- `reset_due_zernio_media_preparation` mantém o contrato anterior até 2.000 solicitado pelo chamador, mas executa no máximo 100 linhas por transação;
- `promote_cached_zernio_media_preparation` mantém o contrato anterior até 5.000, mas executa no máximo 250 linhas por transação;
- ambos mantêm `FOR UPDATE SKIP LOCKED`, recorte futuro de 24 horas e agora repetem a condição de estado no `UPDATE`, evitando rewrite quando outra transação já alterou o item;
- defaults novos são respectivamente 100 e 250; teste pgTAP de contrato/permissão foi acrescentado, mas não executado localmente porque Docker/Postgres local não está disponível;
- nenhuma rotina foi disparada manualmente durante a aplicação e nenhuma mudança de compute ocorreu.

**Rollback:** migration forward-only pode restaurar os corpos das migrations 274/275; não apagar a 305 do histórico.  
**Última condição segura:** schema 305, workers novos online e Vercel em `dpl_DwgjYRbvte3WboCF5qA41unsNeg4`.  
**Próxima ação exata:** executar smoke do alias de produção e das RPCs novas, verificar logs/heartbeats pós-rollout e iniciar observação sem provocar carga artificial enquanto existe atraso crítico real.

### 9.7 Gate de pressão para sync e manutenção — implementação local

**Estado:** aprovado localmente; rollout isolado pendente.

- o sync Zernio mantém adições/conexões interativas, mas consulta o sinal de atraso no máximo uma vez por minuto antes de adquirir o lease e antes de reivindicar lotes de sincronização;
- com publicação vencida há mais de 60 segundos, o sync retorna `waitingForPublicationCapacity`, não adquire capacidade pesada e expõe a pressão no heartbeat;
- a manutenção de observabilidade agora responde `202`/`critical_publication_delay` antes de retenção, rollups e snapshots pesados enquanto a publicação atual estiver atrasada;
- heartbeat default do sync Zernio passou de 30 para 60 segundos;
- `node --check`, TypeScript e três testes de regressão específicos foram aprovados; `git diff --check` passou, somente com aviso de conversão LF/CRLF;
- o smoke do deployment anterior confirmou `/login` HTTP 200, deployment `READY`, snapshot com seis linhas e `stale = false`;
- heartbeats remotos estavam recentes e sem erro: publicador em `dispatching` e gerador em `processing`, mas com controlador em passo 25, motivo `critical_publication_delay` e cooldown ativo;
- PM2 mostrou todos os serviços online, VPS com aproximadamente 12,4% de CPU e 34,2% de RAM; as últimas mensagens de erro exibidas eram anteriores aos restarts.

**Rollback:** restaurar somente o backup do sync que será criado antes do restart e promover o deployment Vercel anterior; schema 305 independe deste gate.  
**Última condição segura:** schema 305 e primeiro deployment prontos; os novos gates ainda não estão em produção.  
**Próxima ação exata:** criar backup do sync na VPS, copiar o worker, reiniciar somente `athena-zernio-sync-worker`, verificar heartbeat; depois publicar exclusivamente a alteração da rota na Vercel e repetir smoke.

### 9.8 Rollout isolado do sync Zernio — 28/08/2026 00:32:29 BRT / 03:32:29 UTC

**Estado:** worker implantado e online; heartbeat pós-restart em validação.

- backup `/opt/athena-worker/scripts/workers/zernio-sync-worker.mjs.before-305` criado;
- somente `athena-zernio-sync-worker` foi copiado e reiniciado; contador esperado passou de três para quatro restarts;
- `pm2 save` persistiu a definição e todos os processos permaneceram online;
- imediatamente após o restart, a VPS estava em aproximadamente 9,2% de CPU e 34,5% de RAM;
- o log de erro mostrado pelo PM2 continha PGRST002/Cloudflare 521 antigos, anteriores ao restart; a data do arquivo será novamente conferida para separar histórico de regressão;
- o arquivo remoto não define heartbeat próprio e, portanto, usa o novo default de 60 segundos; limite dois e polling de dez segundos foram preservados.

**Rollback:** substituir pelo arquivo `.before-305` e reiniciar somente o mesmo processo.  
**Última condição segura:** sync novo online; demais workers não foram reiniciados.  
**Próxima ação exata:** aguardar um heartbeat/ciclo, confirmar `waitingForPublicationCapacity` sem novo erro e então publicar o gate da manutenção na Vercel.

#### Validação pós-restart do sync

- ciclos sucessivos retornaram `waitingForPublicationCapacity: true`, `claimed: 0` e a mesma leitura cacheada de pressão, comprovando consulta no máximo por minuto e ausência de claim/lease pesado;
- a publicação mais antiga ainda estava em `02:02:15 UTC`, então a pausa era esperada;
- o arquivo de erro permaneceu com mtime `01:57:09 UTC`, mais de uma hora anterior ao restart; não houve novo PGRST002/521;
- o heartbeat inicial foi gravado sem erro e o processo continuou online.

**Estado atualizado:** gate do sync aprovado em produção.  
**Próxima ação exata:** gerar novo deployment Vercel contendo o gate da manutenção, registrar o identificador e executar smoke HTTP/pressão.

### 9.9 Deployment do gate de manutenção — 28/08/2026 00:34:40 BRT / 03:34:40 UTC

**Estado:** aprovado em produção.

- build remoto compilou, validou tipos e gerou 56 páginas;
- deployment `dpl_Dyw9dnbww3PdAo3YoxAF94h1RJFs` ficou `READY` e assumiu o alias principal;
- smoke público em `/login` retornou HTTP 200;
- smoke autenticado do modo `frequent` retornou HTTP 202, `paused = true`, motivo `critical_publication_delay`, sem executar retenção/rollups/snapshots;
- o sinal confirmou atraso crítico e item mais antigo em `02:02:15 UTC`;
- warnings existentes de metadata e auditoria npm não bloquearam o build; nenhuma correção automática de dependência foi executada neste rollout.

**Rollback:** promover `dpl_DwgjYRbvte3WboCF5qA41unsNeg4`; o worker Zernio possui rollback independente.  
**Última condição segura:** schema 305, três workers protegidos e deployment `dpl_Dyw9dnbww3PdAo3YoxAF94h1RJFs` ativo.  
**Próxima ação exata:** fechar os dois consumidores pesados ainda fora do gate — limpeza legada/incremental e analytics de perfil —, testar localmente e implantá-los isoladamente.

### 9.10 Gate final de consumidores pesados — implementação local

**Estado:** aprovado localmente; rollout pendente.

- analytics direto consulta pressão no máximo uma vez por minuto e, sob atraso crítico, não importa o executor nem reivindica jobs antigos/diários/posts;
- o fallback HTTP de analytics consulta a pressão antes de descobrir organizações e antes de disparar jobs;
- limpeza `clean_finished` e o endpoint legado `clear_completed` consultam pressão antes de reservar capacidade ou executar SQL;
- quando pausadas, as limpezas retornam HTTP 202 com retry de 60 segundos; não há alteração nem perda de itens;
- heartbeat default do analytics direto passou a 60 segundos;
- TypeScript, `git diff --check` e cinco testes de regressão do conjunto de pressão foram aprovados.

**Rollback:** restaurar apenas o worker analytics e promover o deployment Vercel anterior; nenhuma migration nova foi necessária.  
**Última condição segura:** alterações aprovadas somente no workspace.  
**Próxima ação exata:** inspecionar configuração ativa, criar backup e reiniciar apenas `athena-profile-analytics-direct-worker`; validar pausa no heartbeat e depois fazer um deployment Vercel final.

### 9.11 Rollout isolado do analytics direto — 28/08/2026 00:38 BRT / 03:38 UTC

**Estado:** aprovado em produção.

- a primeira inspeção assumiu incorretamente `/opt/athena-worker`, mas o PM2 revelou `exec cwd = /opt/athena-worker-phase-e`; aquele primeiro restart apenas reiniciou o código antigo, sem alteração funcional;
- o diretório correto foi então validado, o arquivo original recebeu backup `.before-305` e o worker novo foi copiado para `/opt/athena-worker-phase-e`;
- o arquivo de ambiente correto recebeu backup `.env.worker.before-305` e heartbeat foi alterado explicitamente de 30 para 60 segundos;
- somente `athena-profile-analytics-direct-worker` foi reiniciado; PM2 persistiu a configuração e os demais processos permaneceram online;
- ciclos novos retornaram `paused = true`, motivo `critical_publication_delay`, zero chunks e `hasMore = false`;
- o mesmo sinal foi reutilizado entre ciclos, confirmando cache de um minuto;
- o log de erro permaneceu com mtime `02:45:09 UTC`, anterior ao rollout; não houve novo timeout;
- VPS ficou próxima de 12,2% de CPU e 33,1% de RAM.

**Rollback:** arquivos `.before-305` no diretório `phase-e`, seguidos de restart apenas desse processo.  
**Última condição segura:** analytics direto e sync Zernio pausados pela pressão, publicação ativa, geração adaptativa em cooldown.  
**Próxima ação exata:** publicar os gates HTTP de analytics/limpeza na Vercel, executar smoke autenticado do analytics e confirmar que a API de limpeza mantém autenticação/contrato.

### 9.12 Deployment final dos gates e baseline de observação

**Estado:** rollout estrutural aprovado; janela de observação no Micro iniciada.

- deployment `dpl_7no94MJZNp5VrrJByhxmPEaFeH7w` compilou e ficou `READY` no alias principal;
- smoke autenticado do dispatcher analytics retornou HTTP 202/`critical_publication_delay`;
- smoke autenticado da manutenção continuou retornando HTTP 202 pelo mesmo motivo;
- a rota de limpeza preserva autenticação e contrato; o gate anterior ao lease está coberto por teste estático/TypeScript, pois o smoke funcional exige sessão de usuário operador;
- `supabase inspect db db-stats`: banco 3.590 MB, índices 1.574 MB, tabelas 1.234 MB, hit rate 1,00/1,00 e WAL alocado 464 MB; o valor de WAL é baseline de tamanho, não taxa por minuto;
- não havia query acima de cinco minutos, sessão bloqueada nem lock exclusivo externo no instante da inspeção;
- `publication_items`: 341.481 linhas estimadas e 33.137 mortas, aproximadamente 9,7%, com autovacuum em `02:34 UTC`; está abaixo do gate de 10%, porém sem margem;
- `publication_item_events`: 683.438 linhas e 24.800 mortas, aproximadamente 3,6%; `publication_batch_terminal_outcomes` está acima de 10% e será candidato a `VACUUM (ANALYZE)` somente quando o atraso crítico zerar;
- autovacuum executou recentemente nas tabelas quentes; nenhum `VACUUM FULL` foi executado;
- backlog vencido medido sem mutação: 1.202 itens, sendo 266 dos últimos 15 minutos e 936 históricos; 47 compartilhavam o timestamp mais antigo `02:02:15 UTC`;
- os 12 itens mais antigos amostrados estavam online, preparados, sem lease, sem tentativa e elegíveis; portanto o sinal de pressão é legítimo, não um falso positivo;
- comparado à baseline aproximada de 2,4 mil vencidos, o backlog já caiu cerca de 50% enquanto geração, sync, analytics e manutenção permaneceram subordinados à publicação.

**Rollback:** deployment anterior, backups individuais de worker e migrations forward-only já registrados.  
**Última condição segura:** publicador drenando backlog; todos os consumidores não essenciais pausam automaticamente.  
**Próxima ação exata:** executar novamente a suíte completa/build final, medir a queda do backlog e ausência de novos erros após intervalo; somente quando a pressão zerar avaliar `VACUUM (ANALYZE)` direcionado e liberar automaticamente os consumidores.

### 9.13 Suíte final e primeira tendência — 28/08/2026 00:42:18 BRT / 03:42:18 UTC

**Estado:** validação funcional aprovada; gate de produção ainda em observação.

- suíte completa: 303/303 testes aprovados, zero falha/cancelamento/skip;
- TypeScript e builds Vercel já aprovados no mesmo conteúdo implantado;
- logs Vercel dos últimos 20 minutos não retornaram resposta 5xx;
- mtimes dos erros permaneceram anteriores aos rollouts: gerador `03:22:16`, publicador `03:20:17`, sync `01:57:09` e analytics direto `02:45:09`, todos UTC;
- em aproximadamente um minuto, vencidos caíram de 1.202 para 1.138 e a faixa atual de 266 para 206; históricos permaneceram em 936 porque a prioridade absoluta ainda estava consumindo a faixa atual;
- todos os processos PM2 permaneceram online; VPS em aproximadamente 11,5% de CPU, 32,8% de RAM e I/O desprezível;
- não é seguro executar carga artificial nem vacuum enquanto a pressão segue verdadeira.

**Rollback:** inalterado e disponível.  
**Última condição segura:** backlog decrescente, zero erro novo e consumidores pesados pausados.  
**Próxima ação exata:** observar em intervalos de 30 minutos por 2–4 horas, registrando backlog atual/histórico, atraso p95 quando disponível, 5xx, mtimes/restarts, snapshot, WAL e vacuum; ao zerar pressão, permitir retomada automática e executar somente `VACUUM (ANALYZE)` direcionado em tabela comprovadamente acima do gate.

### 9.14 Consolidação de deferimentos — preparação

**Estado:** migration 306 preparada; ainda não aplicada.

- o update autoritativo de `publication_items`, `container_poll_count`, `next_attempt_at`, creation/recovery e leases permanece em todo polling;
- o evento `processing_deferred` passa a ser escrito no primeiro poll e depois a cada cinco polls; criação inicial e substituição/recovery continuam sempre registradas;
- a conclusão/falha final continua em sua trilha própria, portanto a investigação por perfil/publicação não perde o desfecho;
- redução teórica máxima dos eventos repetitivos de polling: 80%, sem reduzir tentativas externas nem alterar idempotência.

**Rollback:** migration forward-only restaurando integralmente a função da migration 140.  
**Última condição segura:** schema remoto ainda em 305.  
**Próxima ação exata:** validar TypeScript/teste estático/dry-run; se a 306 for a única migration, aplicar e confirmar contrato remoto sem reiniciar worker.

### 9.15 Migration 306 aplicada — 28/08/2026 00:45:43 BRT / 03:45:43 UTC

**Estado:** aprovada e ativa.

- seis testes focados de pressão/escrita passaram;
- `git diff --check` passou;
- dry-run mostrou exclusivamente a migration 306;
- aplicação remota concluiu sem erro e a lista confirmou `306 | 306`;
- não foi necessário reiniciar worker: o contrato RPC e todos os parâmetros/retorno foram preservados;
- somente eventos redundantes de polling foram consolidados; o update autoritativo e o diagnóstico final continuam integrais;
- nenhuma carga sintética, vacuum ou upgrade foi executado.

**Rollback:** migration forward-only com a função da migration 140.  
**Última condição segura:** schema 306 e todos os workers online.  
**Próxima ação exata:** verificar que não surgiu erro de contrato após 306, repetir backlog/5xx e manter observação até a pressão zerar.

#### Verificação imediata após 306

- nenhum mtime de erro mudou após a substituição da função;
- vencidos passaram de 1.138 para 989; a faixa atual caiu de 206 para 53, enquanto o histórico ficou em 936 durante a prioridade absoluta;
- na leitura seguinte, a faixa atual oscilou para 62 por novas publicações vencendo, mas o histórico começou a cair de 936 para 909;
- isso comprova a transição planejada: publicações atuais recebem preferência, e a recuperação histórica avança em capacidade limitada assim que sobra espaço;
- o sinal permanece crítico porque ainda há backlog real; geração, sync, analytics, limpeza e manutenção continuam corretamente pausados.

**Próxima ação exata:** manter a observação até o histórico e a idade máxima caírem; não executar vacuum, carga ou upgrade enquanto o gate estiver ativo.

#### Testes SQL no schema remoto

- a primeira execução confirmou o teste 303, mas revelou duas limitações dos testes 304–306: leitura negada para dados internos pelo login efêmero do CLI e pgTAP fora do `search_path` remoto;
- isso não foi falha de migration nem de runtime; os testes foram corrigidos para validar catálogo/definição de função sem ler dados de produção e sem depender da extensão pgTAP;
- a repetição remota passou integralmente: quatro arquivos, 16 testes SQL, resultado `PASS`;
- o teste 304 agora valida o contrato de 100 que originou a janela; o reparo exato das três linhas permanece comprovado pela validação `service_role` registrada na seção 9.5.

**Próxima ação exata:** continuar a observação de produção e repetir a suíte Node completa após a inclusão do sexto teste estrutural.

- repetição final da suíte Node após o teste de deferimento: 304/304 aprovados, zero falha;
- `git diff --check` final não encontrou erro, apenas avisos de normalização LF/CRLF do worktree Windows.

### 9.16 Auditoria da manutenção de mídia — implementação local

**Estado:** gate preparado e teste local pendente.

- o último worker auxiliar ainda fazia polling a cada cinco segundos e podia reivindicar exclusões e organização de grupos durante atraso crítico;
- a rota interna agora consulta pressão antes dos dois dispatchers e retorna HTTP 202 com zero chunks quando publicação está atrasada;
- o payload mantém `deletion` e `groupAssignment`, evitando quebra do worker existente;
- heartbeat default da manutenção de mídia passa de 30 para 60 segundos.

**Rollback:** deployment Vercel anterior e backup isolado do worker antes do restart.  
**Última condição segura:** mudança somente local.  
**Próxima ação exata:** executar TypeScript, teste focado e diff; implantar rota e worker isoladamente se aprovados.

### 9.17 Manutenção de mídia implantada — 28/08/2026 00:56 BRT / 03:56 UTC

**Estado:** aprovada em produção.

- TypeScript, sintaxe Node, sete testes focados e `git diff --check` foram aprovados;
- deployment `dpl_A7tw5gnakLZ9NPDRANbyUquwHmUq` compilou e ficou `READY` no alias principal;
- smoke autenticado retornou HTTP 202, `critical_publication_delay` e zero chunks em exclusão/grupos;
- backup do worker e ambiente foi criado antes do restart;
- somente `athena-media-maintenance-worker` foi reiniciado, heartbeat configurado em 60 segundos e PM2 persistido;
- ciclos reais confirmaram `paused = true`, sem reivindicar exclusões ou grupos;
- log de erro permaneceu com mtime `03:28:22 UTC`, anterior ao rollout; VPS em aproximadamente 7,7% de CPU e 33,4% de RAM;
- todos os consumidores pesados Instagram previstos no plano estão agora subordinados à publicação atual.

#### Tendência às 03:56:39 UTC

- backlog vencido caiu para 594, todos históricos; a faixa atual dos últimos 15 minutos chegou a zero;
- o timestamp mais antigo avançou de `02:02:15` para `02:31:03 UTC`, comprovando drenagem real do histórico;
- Vercel continuou sem 5xx nos 20 minutos consultados;
- o snapshot ficou `stale = true`, gerado às `03:30:03 UTC`, comportamento intencional porque sua recomposição global foi pausada junto da manutenção durante pressão; os dados permanecem disponíveis com indicação explícita de desatualização, sem executar a consulta cara no caminho crítico.

**Rollback:** deployment `dpl_7no94MJZNp5VrrJByhxmPEaFeH7w` e backups `.before-306`.  
**Última condição segura:** publicação atual em dia, histórico decrescente, auxiliares pausados e zero erro novo.  
**Próxima ação exata:** deixar o publicador concluir os 594 históricos; confirmar `criticalDelay = false`, retomada automática dos auxiliares e atualização do snapshot, sem intervenção manual.

#### Justiça do backlog às 03:59 UTC

- vencidos continuaram caindo: 594 → 528 → 474/467, sem entrada na faixa atual;
- a amostra integral de 467 itens naquele instante cobria duas organizações, com 249 e 218 itens;
- havia exatamente 467 perfis e no máximo um item vencido por perfil;
- a distribuição comprova que o backlog remanescente não estava concentrado em um único perfil e que ambas as organizações continuavam representadas no claim justo;
- intervalo do backlog amostrado: `02:31:03` a `02:46:56 UTC`.

**Próxima ação exata:** continuar a drenagem sem alterar concorrência; revalidar distribuição, erros e retomada quando o contador se aproximar de zero.

#### Escrita preliminar e backlog às 04:01 UTC

- eventos de ciclo do publicador em janelas de dez minutos comparáveis caíram de 52 para 31, redução preliminar de 40,4%; isso não inclui a redução adicional de heartbeat de 30 para 60 segundos;
- eventos `processing_deferred` medidos imediatamente após a 306 ainda não formam cenário comparável, pois o número e a fase dos polls mudaram durante a drenagem; o gate de 50% de WAL permanece pendente e não será inferido por essa amostra;
- backlog caiu de 467 para 414, faixa atual permaneceu zero e não houve necessidade de aumentar concorrência.

**Próxima ação exata:** preservar os limites atuais e continuar medindo; não declarar o gate de WAL antes de repetir o mesmo cenário.

#### Gate de atraso funcional

- 298 itens publicados cujo `execute_at` estava nos 30 minutos anteriores ainda misturam recuperação histórica; nessa amostra contaminada, p95 foi 367,66 s e portanto não aprova o gate de 60 s;
- não houve item com `execute_at` nos últimos 15 minutos para formar amostra atual independente; a fila atual permaneceu zero, mas o p95 só será aprovado quando existirem publicações reais nessa janela;
- backlog histórico continuou de 414 para 323 às `04:03:10 UTC`.

**Próxima ação exata:** não mascarar recuperação como publicação atual; aguardar amostra real após a drenagem e calcular novamente o p95.

### 9.18 Mudança operacional solicitada — não publicar backlog vencido

**Estado:** publicador interrompido com segurança; encerramento auditável em preparação.

- por decisão explícita do operador, publicações vencidas não iniciadas não devem ser disparadas em sequência, evitando várias postagens quase simultâneas por perfil;
- somente `athena-publication-worker` foi parado e o dump PM2 salvo; Twitter e demais processos permaneceram online;
- corte capturado em `2026-08-28T04:04:42.157Z`;
- após a parada havia 302 itens v2 vencidos: 245 `waiting` sem `creation_id` e 57 `waiting` com criação já aceita pelo provedor;
- os 245 sem criação serão `ignored`; os 57 com criação ficam fora do escopo para reconciliação, pois ignorá-los não cancela o provedor e poderia registrar estado falso;
- migration 307 prepara RPC service-only, limite máximo 100/default 50, `SKIP LOCKED`, liberação de reservas, evento `ignored` e sincronização por lote.

**Rollback:** antes da execução, basta não aplicar/chamar a função; após `ignored`, a decisão fica auditada e não será revertida automaticamente.  
**Última condição segura:** publicador parado; nenhum novo claim Instagram ocorre.  
**Próxima ação exata:** validar e aplicar a 307, executar páginas de 50 usando o corte fixo, confirmar zero item vencido sem criação e só então reiniciar o publicador.

### 9.19 Encerramento do backlog não iniciado — 28/08/2026 01:09 BRT / 04:09 UTC

**Estado:** aprovado em produção; reconciliação das criações já aceitas permanece pendente.

- migration 307 validada e aplicada remotamente; schema local/remoto confirmado em `307 | 307`;
- teste SQL remoto da migration passou integralmente: 4/4;
- RPC service-only executada com o corte imutável `2026-08-28T04:04:42.157Z`, em páginas de no máximo 50 e sem liberar o publicador durante a operação;
- páginas processadas: 50 em 1.146 ms, 50 em 963 ms, 50 em 834 ms, 50 em 726 ms, 45 em 942 ms e página terminal zero em 59 ms;
- total exato de 245 publicações vencidas, não iniciadas e sem `creation_id` alteradas para `ignored`;
- verificação final retornou `remainingOverdueUnstarted = 0`;
- as 57 linhas com `creation_id` foram preservadas: o provedor já aceitou essas criações e elas precisam apenas de reconciliação, sem novo envio;
- `athena-publication-worker` continua parado e persistido assim no PM2; portanto não houve reabertura acidental da fila.

**Rollback:** a migration é forward-only; os estados `ignored` representam decisão operacional auditada e não serão revertidos automaticamente. O publicador continua sob controle manual.  
**Última condição segura:** zero publicação vencida sem criação apta a disparo; 57 criações antigas protegidas contra duplicação aguardam reconciliação; gerador permanece subordinado ao sinal de pressão.  
**Próxima ação exata:** conter temporariamente a geração de `27-08 LEXY STORY`, calcular por chunk o primeiro slot futuro de `27-08 LAURINHA REELS` e `27-08 GGBIEL RRELS`, converter slots não gerados já vencidos em ignorados e reabrir somente os intervalos futuros afetados por timeout; liberar Lexy apenas depois.

### 9.20 Recuperação seletiva dos três planos — preparação — 28/08/2026 01:09 BRT / 04:09 UTC

**Estado:** em execução.

- escopo confirmado pelo operador: `27-08 LAURINHA REELS`, `27-08 GGBIEL RRELS` e, somente ao final, `27-08 LEXY STORY`;
- a função ativa calcula `execute_at = schedule_base_at + (slot_index + 1) × interval_minutes` e, ao reabrir um chunk, materializa a partir de `next_slot_index`; portanto resetar falhas sem avançar o cursor recriaria horários vencidos;
- estratégia aprovada: parar temporariamente apenas o gerador, fixar um novo corte UTC, avançar cada chunk com timeout até o primeiro slot estritamente posterior ao corte, contabilizar a diferença como `ignored_items`/`ignored_slot_count`, zerar somente a falha transitória e reabrir apenas o futuro;
- `27-08 LEXY STORY` será mantido com o plano pausado enquanto Laurinha/Ggbiel são reparados e processados;
- IDs confirmados: Laurinha `0d54e188-a3a3-48b9-ba9c-bb73dbb56356`, Ggbiel `f25919fd-569a-48d8-a241-ad104f2464da`, Lexy `7c8df847-a475-4bf9-9dd5-c4056d38d7a0`;
- baseline: Laurinha possui 21 chunks esgotados por `statement_timeout`; Ggbiel possui 31; Lexy possui 149 chunks ainda enfileirados, sem erro e sem lease ativo.

**Rollback:** antes da mutation dos chunks, manter gerador parado; migration forward-only deverá oferecer apenas operação service-only, por IDs explícitos e corte explícito.  
**Última condição segura:** gerador ainda subordinado à pressão; publicador parado; Lexy ainda não foi liberada.  
**Próxima ação exata:** parar e persistir `athena-generation-worker`, confirmar ausência de lease ativo nos três planos e preparar migration 308 com prévia/dry-run da quantidade ignorada e futura.

#### Contenção do gerador — 28/08/2026 01:10 BRT / 04:10 UTC

**Estado:** aprovado.

- `athena-generation-worker` foi parado isoladamente e o estado foi persistido com `pm2 save`;
- `athena-publication-worker` continuou parado; os workers Instagram auxiliares e todos os workers Twitter permaneceram online;
- VPS no instante da contenção: aproximadamente 3,7% de CPU, 30% de RAM e I/O desprezível;
- nenhuma fila compacta pode avançar enquanto a migration 308 é preparada, eliminando a corrida que poderia liberar Lexy antes da ordem solicitada.

**Rollback:** `pm2 start athena-generation-worker && pm2 save`, somente depois de validar os cursores.  
**Última condição segura:** publicador e gerador Instagram parados; demais serviços ativos.  
**Próxima ação exata:** criar migration/teste 308, validar aritmética do primeiro slot futuro e executar prévia remota sem mutação.

#### Migration 308 aplicada — 28/08/2026 01:13 BRT / 04:13 UTC

**Estado:** schema aprovado; nenhuma linha operacional alterada pela aplicação.

- `git diff --check` dos arquivos 308 e do diário passou;
- dry-run remoto apresentou exclusivamente `308_recover_only_future_bulk_rotation_slots.sql`;
- migration aplicada sem erro e paridade confirmada em `308 | 308`;
- foram adicionadas duas RPCs service-only: hold/release seletivo por plano e recuperação de slots futuros após timeout;
- o reparo exige ID e nome exatos, corte passado explícito, ausência de lease e ausência de progresso confirmado no chunk falho;
- o modo `dryRun` calcula ignorados, futuros e conflitos sem mutation; conflito com outro horizonte ativo cancela a transação;
- chunks com futuro são convertidos em um novo segmento iniciado no primeiro slot futuro, impedindo dupla contagem entre slots ignorados e gerados.

**Rollback:** funções podem ser substituídas por migration forward-only; nenhum dado foi tocado até este ponto.  
**Última condição segura:** schema 308; publicador e gerador parados.  
**Próxima ação exata:** executar o teste SQL 308, aplicar hold na Lexy e obter dry-run remoto de Laurinha/Ggbiel com um único corte fixo.

#### Primeira execução do teste 308 — 28/08/2026 01:14 BRT / 04:14 UTC

**Estado:** teste bloqueado por asserção textual desatualizada; runtime não falhou e nenhuma mutation ocorreu.

- o catálogo encontrou as duas RPCs e os três primeiros subtestes iniciaram corretamente;
- o quarto subteste ainda procurava a expressão simples anterior de `ignored_items`; a implementação final usa `CASE` porque segmentos futuros reiniciam seus contadores e segmentos integralmente vencidos preservam a contagem no chunk;
- o teste foi corrigido para normalizar a definição e verificar separadamente o `CASE`, a soma no ramo vencido e o contador autoritativo de perfil;
- publicador e gerador continuaram parados durante toda a falha de teste.

**Rollback:** não aplicável; somente arquivo de teste foi ajustado.  
**Última condição segura:** schema 308 inalterado, zero dado operacional tocado.  
**Próxima ação exata:** repetir os sete subtestes remotos antes de chamar qualquer RPC operacional.

- segunda execução avançou até o subteste 5; o subteste 6 falhou apenas porque a definição foi normalizada para minúsculas, mas a asserção ainda procurava a mensagem com inicial maiúscula e aliases que o `pg_get_functiondef` remove da atribuição;
- asserção textual ajustada sem alterar a migration nem o runtime; nenhuma RPC operacional foi chamada.

#### Validação final e executor operacional — 28/08/2026 01:17 BRT / 04:17 UTC

**Estado:** aprovado local/remoto.

- terceira execução remota concluiu 7/7 subtestes com `PASS`;
- foi adicionado executor operacional explícito `scripts/workers/recover-future-bulk-plan.mjs`, com ações separadas `hold`, `preview`, `repair` e `release`;
- o executor carrega credenciais apenas do ambiente, não imprime segredos e exige plano/corte/nome nos comandos destrutivos;
- nenhum dado dos três planos foi alterado até este registro.

**Rollback:** remover o executor não altera produção; RPCs permanecem service-only.  
**Última condição segura:** ferramentas validadas e workers contidos.  
**Próxima ação exata:** validar sintaxe do executor, aplicar hold na Lexy e registrar o resultado antes dos previews.

#### Hold de Lexy aplicado — 28/08/2026 01:18 BRT / 04:18 UTC

**Estado:** aprovado e ativo.

- `node --check` aprovou o executor;
- RPC confirmou ID/nome `27-08 LEXY STORY` e colocou exatamente 149 chunks enfileirados em `paused`;
- motivo persistido: `operator_ordered_recovery_2026_08_28`;
- chunks já concluídos de Lexy não foram alterados e nenhum lease estava ativo;
- mesmo após a futura retomada global do gerador, Lexy não será reivindicada até a chamada explícita de `release` com o mesmo motivo.

**Rollback:** ação `release` pelo mesmo executor/motivo; não executar antes de Laurinha/Ggbiel.  
**Última condição segura:** Lexy contida duravelmente; publicador e gerador globais parados.  
**Próxima ação exata:** fixar o corte de recuperação e executar somente `preview` para Laurinha e Ggbiel.

#### Primeira tentativa de preview — 28/08/2026 01:18 BRT / 04:18 UTC

**Estado:** bloqueada com segurança; zero mutation.

- corte proposto pelo relógio local: `2026-08-28T04:16:39.399Z`;
- ambas as RPCs recusaram antes de examinar/mutar chunks com `22023: Nome esperado ou corte inválido`;
- como os nomes já foram confirmados no banco, a causa provável é pequeno avanço do relógio local em relação ao relógio transacional do banco;
- a proteção funcionou como projetada: não aceitar corte aparentemente futuro;
- Lexy permaneceu em hold e ambos os workers permaneceram parados.

**Rollback:** não aplicável; nenhuma linha foi alterada.  
**Última condição segura:** idêntica à anterior.  
**Próxima ação exata:** obter o relógio HTTP do projeto sem expor credenciais, escolher corte com margem segura e repetir os previews.

#### Previews aprovados — 28/08/2026 01:17 BRT / 04:17 UTC do banco

**Estado:** aprovado; zero mutation nos planos reparados.

- endpoint REST do projeto respondeu HTTP 200 e `Date: Fri, 28 Aug 2026 04:17:02 GMT`;
- corte fixado com margem em `2026-08-28T04:16:00.000Z` e será reutilizado sem recalcular durante o reparo;
- Laurinha: 21 chunks inspecionados/recuperáveis, 3.024 slots futuros, zero slot não gerado vencido e zero conflito;
- Ggbiel: 31 chunks inspecionados/recuperáveis, 3.596 slots futuros, 124 slots não gerados vencidos e zero conflito;
- os 124 slots vencidos de Ggbiel serão contabilizados como `ignored`; nenhum `publication_item` será criado para eles;
- todos os 52 chunks atendem à proteção de progresso zero e erro esgotado por `statement_timeout`;
- Lexy continua em hold com 149 chunks pausados.

**Rollback:** até este ponto não é necessário; previews não mutaram dados.  
**Última condição segura:** corte e quantidades conhecidos, sem conflito.  
**Próxima ação exata:** executar `repair` de Laurinha e Ggbiel com o mesmo corte, um plano por vez, registrando cada resultado.

#### Laurinha reparada — 28/08/2026 01:17 BRT / 04:17 UTC

**Estado:** aprovado; ainda não materializado pelo worker.

- chamada `repair` usou exatamente o corte aprovado `2026-08-28T04:16:00.000Z`;
- 21/21 chunks de timeout foram reabertos, totalizando 3.024 slots futuros;
- zero slot vencido, zero conflito e zero chunk integralmente encerrado;
- nenhum item foi agendado nesta etapa: a RPC apenas restaurou os segmentos futuros para processamento adaptativo posterior;
- gerador permaneceu parado e Lexy permaneceu em hold.

**Rollback:** parar o fluxo mantendo o gerador desligado; os chunks podem ser novamente colocados em hold antes de qualquer materialização.  
**Última condição segura:** Laurinha preparada, mas sem geração em curso.  
**Próxima ação exata:** aplicar o mesmo reparo aprovado a Ggbiel e validar que exatamente 124 slots vencidos passam para ignored.

#### Ggbiel reparada — 28/08/2026 01:17 BRT / 04:17 UTC

**Estado:** aprovado; ainda não materializado pelo worker.

- chamada `repair` reutilizou exatamente o corte aprovado;
- 31/31 chunks foram reabertos com 3.596 slots futuros;
- exatamente 124 slots não gerados que já haviam vencido foram avançados e contabilizados como `ignored` no estado autoritativo do perfil/plano;
- nenhum `publication_item` foi criado para esses 124 horários e nenhum conflito de horizonte foi encontrado;
- zero chunk foi integralmente encerrado; todos possuem trecho futuro válido;
- gerador permaneceu parado e Lexy permaneceu em hold.

**Rollback:** manter o gerador desligado/colocar os planos em hold antes da materialização se a auditoria pós-mutation divergir.  
**Última condição segura:** Laurinha e Ggbiel preparados para somente o futuro; Lexy contida.  
**Próxima ação exata:** auditar contadores/status/leases dos três planos e somente depois decidir a retomada controlada do publicador para reconciliar as 57 criações já aceitas.

#### Auditoria pós-reparo — 28/08/2026 01:18 BRT / 04:18 UTC

**Estado:** Laurinha/Ggbiel aprovados; Lexy requer correção de estado anterior antes do release.

- executor ganhou ação read-only `status`; sintaxe Node aprovada;
- Laurinha: plano `generating`, 188 chunks concluídos + 21 enfileirados, 27.072 gerados + 3.024 futuros, zero ignored/falha/lease/esgotamento;
- Ggbiel: plano `generating`, 102 chunks concluídos + 31 enfileirados, 12.240 gerados + 3.596 futuros + 124 ignored, zero falha/lease/esgotamento;
- os totais autoritativos fecham: Laurinha 30.096; Ggbiel 12.240 + 3.596 + 124 = 15.960;
- Lexy: plano corretamente `paused`, 43 chunks concluídos + 149 pausados, zero lease/esgotamento;
- foi detectada inconsistência preexistente em Lexy: dois perfis seguem `failed`/seis slots falhos, embora os chunks correspondentes estejam apenas pausados e sem retry esgotado; liberar agora deixaria esses dois perfis inelegíveis ao claim;
- nenhum worker foi religado.

**Rollback:** holds preservam todos os cursores; nenhum item novo foi materializado.  
**Última condição segura:** Laurinha/Ggbiel íntegros e prontos; Lexy contida.  
**Próxima ação exata:** identificar os dois perfis/chunks inconsistentes de Lexy, confirmar causa e corrigir somente o estado necessário antes do release final.

#### Causa dos dois resíduos de Lexy — 28/08/2026 01:20 BRT / 04:20 UTC

**Estado:** diagnóstico concluído; correção ainda não aplicada.

- perfis afetados: `cb289139-2d38-454d-bd77-4c6054eb1ab2` e `68e8ace0-0a3c-418e-b34f-1a045eb0d581`;
- cada perfil possui três slots, cursor zero, zero item gerado e `failed_slot_count = 3`; chunks correspondentes possuem `failed_items = 3`, mas `retry_exhausted_at = null` e `consecutive_failure_count = 0`;
- a assinatura coincide com o reparo da migration 304: ela reabriu os três chunks atingidos pelo worker antigo após a mudança 303, zerando status/retry/erro, porém não zerou `failed_items`, `failed_slot_count` nem restaurou o status do perfil;
- o chunk ficou tecnicamente enfileirável, mas o claim exige perfil `queued/generating`; por isso dois perfis da Lexy continuariam invisíveis após o release;
- os dois chunks estão sem lease e integralmente não gerados; não há risco de duplicar item ao limpar exclusivamente esse resíduo;
- o relatório read-only foi ajustado para expor IDs anômalos; a lista extensa ocorreu porque o marcador do hold também é, intencionalmente, `last_error_message`, sem efeito funcional.

**Rollback:** manter Lexy em hold; nenhuma correção foi aplicada.  
**Última condição segura:** os dois alvos estão identificados com prova de cursor/progresso zero.  
**Próxima ação exata:** criar migration 309 service-only que só aceite o plano/nome/quantidade esperada, exija exatamente essa assinatura residual e restaure os dois perfis sem liberar o hold.

#### Migration 309 preparada — 28/08/2026 01:23 BRT / 04:23 UTC

**Estado:** validação local aprovada; aplicação remota pendente.

- função exige `service_role`, ID/nome exatos, plano em `paused`, quantidade esperada de perfis e marcador exato do hold;
- candidatos precisam ter cursor/progresso zero, `failed_items = slot_count`, perfil integralmente falho, ausência de lease/retry esgotado e contador consecutivo zero;
- divergência de uma única linha aborta toda a transação;
- mutation limita-se a zerar contadores residuais e restaurar perfil para `queued`; chunks permanecem `paused` e o hold não é liberado;
- `git diff --check` passou e dry-run remoto apresentou somente a migration 309.

**Rollback:** não aplicar/chamar; Lexy continua contida.  
**Última condição segura:** schema remoto 308.  
**Próxima ação exata:** aplicar 309, executar os quatro testes remotos e somente então chamar o reparo com quantidade esperada igual a dois.

#### Migration 309 aplicada — 28/08/2026 01:24 BRT / 04:24 UTC

**Estado:** schema aprovado; função ainda não chamada.

- aplicação remota concluiu sem erro;
- paridade local/remota confirmada em `309 | 309`;
- aplicar a migration não alterou os três planos nem liberou worker/hold.

**Rollback:** substituição forward-only da função; dados ainda intocados pela 309.  
**Última condição segura:** Lexy pausada, schema 309.  
**Próxima ação exata:** executar o teste SQL 309 antes do reparo de dados.

#### Teste 309 aprovado — 28/08/2026 01:25 BRT / 04:25 UTC

**Estado:** 4/4 `PASS` remoto.

- presença da RPC, identidade/cardinalidade exatas, proteção de progresso zero e preservação do hold foram aprovadas;
- executor operacional recebeu ação explícita `repair-residue`, exigindo nome e quantidade esperada;
- nenhuma linha foi corrigida antes deste gate.

**Rollback:** não aplicável até a chamada.  
**Última condição segura:** função testada, Lexy em hold.  
**Próxima ação exata:** validar sintaxe do executor e chamar o reparo residual esperando exatamente dois perfis.

#### Resíduo de Lexy corrigido — 28/08/2026 01:25 BRT / 04:25 UTC

**Estado:** aprovado; hold preservado.

- sintaxe do executor aprovada;
- RPC encontrou exatamente os dois perfis esperados e reparou exatamente dois chunks/dois perfis;
- resposta confirmou `holdPreserved = true`;
- nenhum chunk foi liberado, reivindicado ou materializado;
- relatório read-only foi refinado para não classificar o próprio marcador de hold como anomalia.

**Rollback:** antes do release, basta manter o hold; os contadores corrigidos representam o estado real de progresso zero e não devem ser restaurados para falha.  
**Última condição segura:** Lexy integralmente elegível após release, porém ainda pausada.  
**Próxima ação exata:** auditar novamente Lexy; depois encerrar qualquer item que venceu durante a janela de contenção antes de religar o publicador para reconciliar apenas criações já aceitas e itens correntes.

#### Auditoria final de Lexy e preparação do segundo corte — 28/08/2026 01:26 BRT / 04:26 UTC

**Estado:** Lexy aprovada; encerramento da janela em preparação.

- Lexy permanece `paused`: 43 chunks concluídos + 149 pausados, 129 itens gerados e zero ignored/falha/lease/esgotamento/anomalia;
- perfis agora fecham em 43 concluídos + 148 queued + um generating, todos elegíveis após release;
- foi criado executor paginado para reutilizar a RPC 307 com corte fixo, páginas máximas configuráveis e verificação terminal de zero itens vencidos sem criação;
- o executor registra duração por página, não imprime segredo e falha se atingir o limite antes da página terminal zero.

**Rollback:** não executar o segundo corte; workers continuam parados.  
**Última condição segura:** todos os planos coerentes e contidos.  
**Próxima ação exata:** obter hora do projeto, escolher corte com margem, validar sintaxe e executar páginas de 50 até zero antes de reiniciar publicação.

#### Segundo corte concluído — 28/08/2026 01:23 BRT / 04:23 UTC do projeto

**Estado:** aprovado.

- relógio HTTP do projeto: `Fri, 28 Aug 2026 04:22:43 GMT`;
- corte imutável escolhido com margem: `2026-08-28T04:22:30.000Z`;
- executor passou em `node --check`;
- página 1 marcou 48 itens vencidos sem criação como `ignored` em 1.040 ms;
- página terminal retornou zero em 50 ms;
- verificação independente do executor confirmou `remainingOverdueUnstarted = 0`;
- esses 48 itens venceram enquanto publicação/geração estavam contidos e não serão disparados atrasados.

**Rollback:** decisão `ignored` é auditada e não será revertida automaticamente.  
**Última condição segura:** zero item anterior ao segundo corte sem criação; gerador/publicador ainda parados.  
**Próxima ação exata:** medir criações já aceitas versus fila futura, reiniciar somente o publicador e observar a reconciliação sem religar o gerador.

#### Baseline antes da reconciliação — 28/08/2026 01:24 BRT / 04:24 UTC do projeto

**Estado:** aprovado para restart isolado do publicador.

- auditor read-only validado por `node --check`;
- anterior ao corte: zero item sem criação e apenas quatro itens com criação já aceita pelo provedor; total devido igual a quatro;
- os 57 itens aceitos medidos na parada caíram para quatro sem novo envio do worker, compatível com atualizações assíncronas/callbacks do provedor enquanto o processo estava parado;
- fila futura contém 102.597 itens, mas o publicador só reivindica conforme `execute_at`; ela não constitui backlog devido;
- gerador continuará parado e Lexy em hold durante a reconciliação.

**Rollback:** `pm2 stop athena-publication-worker && pm2 save`.  
**Última condição segura:** não existe item vencido apto a criação nova.  
**Próxima ação exata:** iniciar apenas `athena-publication-worker`, salvar PM2, observar ciclos/erros e repetir a auditoria do corte.

#### Publicador reiniciado isoladamente — 28/08/2026 01:23 BRT / 04:23 UTC da VPS

**Estado:** online; observação em execução.

- somente `athena-publication-worker` foi iniciado e o dump PM2 salvo;
- processo ficou `online`, PID 200720, zero restart instável, cwd `/opt/athena-worker`;
- `athena-generation-worker` permaneceu `stopped`; Lexy continua em hold;
- todos os demais serviços permaneceram online;
- VPS no restart: aproximadamente 3,1% CPU, 28,8% RAM e I/O desprezível.

**Rollback:** parar somente `athena-publication-worker` e salvar PM2.  
**Última condição segura:** não havia item vencido sem criação no corte; publicador pode reconciliar quatro criações aceitas e atender somente itens que vencerem após o corte.  
**Próxima ação exata:** ler ciclos/mtime de erro e repetir contagens sem religar geração.

#### Reconciliação do publicador aprovada — 28/08/2026 01:24 BRT / 04:24 UTC do projeto

**Estado:** aprovado.

- processo permaneceu vivo no PID 200720 e executou ciclos concluídos;
- log de erro manteve mtime `2026-08-28 03:20:17 UTC`, anterior ao restart; os timeouts exibidos pelo tail são históricos, não novos;
- auditoria repetida retornou zero vencido sem criação, zero vencido com criação e total devido zero;
- as quatro criações aceitas foram reconciliadas sem reenvio e sem formar novo backlog;
- fila futura permaneceu em 102.597, aguardando seus próprios horários;
- gerador continua parado e Lexy continua em hold.

**Rollback:** publicador pode ser parado isoladamente, mas o gate atual está limpo.  
**Última condição segura:** publicação corrente online e fila vencida zerada.  
**Próxima ação exata:** auditar globalmente os planos que o gerador poderia reivindicar; somente se Laurinha/Ggbiel estiverem na frente e Lexy continuar pausada, reiniciar o gerador adaptativo.

#### Auditoria global da geração — 28/08/2026 01:25 BRT / 04:25 UTC

**Estado:** retomada ainda contida; um plano posterior será colocado em hold temporário.

- auditor read-only passou em `node --check` e encontrou 649 chunks não terminais em sete planos;
- planos antigos `Julio / 17/08`, `Igor / 24/08` e `Laura / 24/08` estão respectivamente pausado ou esgotados e não são elegíveis ao claim;
- ordem elegível atual: Ggbiel (31/3.596), Laurinha (21/3.024) e depois `ggIgor/ 28/08 / Reels` (189/4.536);
- Lexy permanece inelegível em hold, 149 chunks/447 slots;
- sem contenção adicional, o gerador iniciaria ggIgor assim que concluísse Laurinha, antes do release controlado de Lexy;
- decisão operacional: aplicar hold reversível em ggIgor durante esta sequência, garantindo que somente Ggbiel/Laurinha sejam drenados; liberar Lexy depois deles e ggIgor somente após Lexy.

**Rollback:** release de ggIgor com o mesmo motivo.  
**Última condição segura:** gerador parado; nenhum plano adicional tocado.  
**Próxima ação exata:** aplicar hold exato em ggIgor, repetir auditoria e reiniciar o gerador somente se restarem Ggbiel/Laurinha como elegíveis.

#### Hold temporário de ggIgor — 28/08/2026 01:26 BRT / 04:26 UTC

**Estado:** aprovado e reversível.

- RPC confirmou ID/nome `ggIgor/ 28/08 / Reels`;
- exatamente 189 chunks foram alterados de queued para paused, zero lease disputado;
- motivo persistido: `ordered_recovery_after_lexy_2026_08_28`;
- nenhum cursor/item foi alterado; o plano será liberado somente após Lexy concluir.

**Rollback:** ação `release` com o mesmo motivo.  
**Última condição segura:** Ggbiel/Laurinha são os únicos planos novos elegíveis; Lexy/ggIgor contidos.  
**Próxima ação exata:** confirmar a fila global e iniciar o gerador adaptativo.

#### Gerador adaptativo reiniciado — 28/08/2026 01:25 BRT / 04:25 UTC da VPS

**Estado:** online; drenagem seletiva em observação.

- auditoria repetida confirmou Ggbiel/Laurinha como únicos planos elegíveis; Lexy e ggIgor permanecem pausados;
- somente `athena-generation-worker` foi iniciado e o dump PM2 salvo;
- processo ficou `online`, PID 200893, zero restart instável, cwd `/opt/athena-worker`;
- publicador permaneceu online; todos os demais serviços não mudaram;
- VPS no restart: aproximadamente 6,4% CPU, 30,4% RAM e I/O baixo.

**Rollback:** parar somente o gerador e salvar PM2; holds permanecem.  
**Última condição segura:** gerador adaptativo 25/50/100 ativo somente sobre os 52 chunks recuperados.  
**Próxima ação exata:** acompanhar heartbeat, step/cooldown, mtimes de erro e queda dos slots restantes até Ggbiel/Laurinha concluírem; não liberar Lexy antes disso.

#### Primeiro slice recuperado — 28/08/2026 01:26 BRT / 04:26 UTC

**Estado:** comportamento adaptativo aprovado; drenagem continua.

- sinal de pressão: `criticalDelay = false`, `overdueCurrent = 0`, `oldestDueAt = null`;
- primeiro chunk de Ggbiel processou 48 slots em 1.256 ms, zero falha;
- por exceder 750 ms, controlador reduziu imediatamente o passo de 50 para 25 e aplicou cooldown de 2.512 ms (`slow_database_slice`);
- gerados de Ggbiel avançaram de 12.240 para 12.288; ignored permaneceu 124 e falha zero;
- log de erro manteve mtime histórico `03:22:16 UTC`, sem erro após o restart;
- a janela móvel de 48 horas limita a materialização imediata: os slots posteriores permanecem na definição integral e entrarão automaticamente na janela; o gate desta recuperação é zerar os chunks atualmente elegíveis, não forçar vários dias contra o banco.

**Rollback:** parar gerador; primeiro slice é idempotente e já confirmado.  
**Última condição segura:** passo 25/cooldown ativo, publicações atuais em dia.  
**Próxima ação exata:** continuar observando até nenhum chunk de Ggbiel/Laurinha estar elegível no horizonte atual; então parar o gerador antes de liberar Lexy.

- auditor de geração foi estendido para calcular `eligibleNow` usando relógio HTTP do projeto, `schedule_base_at`, cursor, intervalo e horizonte de 48 horas;
- primeira execução ampliada recebeu HTTP 400 porque tentou enviar 649 UUIDs em um único filtro `in`, sem qualquer efeito no banco;
- leitura foi paginada em blocos de 100 IDs; runtime de geração não foi alterado e continuou ativo.

- após mais 20 segundos, o gerador permaneceu corretamente contido porque o sinal alternou para um item atual com atraso superior a 60 s; Ggbiel/Laurinha não tiveram falha nem lease preso, apenas aguardaram prioridade;
- auditor do publicador foi estendido de forma read-only para retornar o sinal oficial e o item crítico mais antigo, permitindo distinguir polling aceito pelo provedor de item realmente não iniciado.

- item crítico confirmado com `creation_id`, tentativa 1, zero erro/lease e `next_attempt_at` futuro; após o polling ele foi substituído por outro perfil do mesmo lote/timestamp, mostrando uma faixa de confirmações do provedor, não reenvio nem chunk travado;
- auditor foi ampliado para contar separadamente críticos sem criação e críticos já aceitos, evitando inferência pela amostra de uma linha.

#### Nova onda vencida detectada e contida — 28/08/2026 01:32 BRT / 04:32 UTC

**Estado:** ambos os workers interrompidos; encerramento pendente.

- a faixa inicial de confirmações caiu de 25 para 10, depois sete e quatro, sempre com zero crítico sem criação;
- na leitura seguinte, uma nova faixa grande ultrapassou o limite de 60 s: 368 itens críticos sem criação e 94 já aceitos pelo provedor;
- isso representa exatamente o risco operacional proibido pelo operador: centenas de itens com o mesmo período passando a devidos enquanto o publicador estava ativo;
- `athena-publication-worker` foi parado imediatamente e o PM2 salvo, impedindo novas criações;
- `athena-generation-worker` foi parado em seguida e o PM2 salvo, evitando retomada automática após a limpeza;
- os 94 aceitos não serão falsamente marcados como ignored; os ainda não iniciados serão encerrados pelo novo corte;
- VPS permaneceu controlada: cerca de 10,5% CPU, 32,7% RAM e I/O baixo.

**Rollback:** workers só serão religados após novo zero terminal e estratégia de reconciliação sem criação.  
**Última condição segura:** publicação/geração Instagram paradas; Twitter e auxiliares online; Lexy/ggIgor em hold.  
**Próxima ação exata:** capturar hora do projeto, fixar novo corte e marcar em páginas de 50 todos os vencidos sem criação como ignored; medir separadamente os já aceitos.

#### Primeiro lote do terceiro corte recusado por timeout — 28/08/2026 01:33 BRT / 04:33 UTC

**Estado:** lote de 50 revertido pelo banco; workers continuam parados.

- relógio HTTP: `Fri, 28 Aug 2026 04:32:52 GMT`; corte fixado em `2026-08-28T04:32:40.000Z`;
- primeira página de 50 recebeu `57014 statement_timeout` após aproximadamente 13 s;
- por atomicidade da RPC, a página foi revertida; não será contabilizada como processada;
- a carga inclui evento auditável, liberação de reservas e sincronização dos lotes afetados; 50 ficou pesado sob o estado atual;
- controlador operacional seguirá o mesmo princípio adaptativo: repetir o corte imutável com páginas de 10, sem religar workers.

**Rollback:** já ocorreu automaticamente pela transação abortada.  
**Última condição segura:** nenhuma nova criação desde a parada; corte preservado.  
**Próxima ação exata:** executar páginas de 10 até terminal zero e registrar durações/total.

#### Terceiro corte concluído — 28/08/2026 01:34 BRT / 04:34 UTC

**Estado:** não iniciados encerrados; aceitos aguardam callback com workers parados.

- páginas adaptativas de 10 processaram 276 itens e a página 29 retornou zero;
- durações ficaram entre 130 e 478 ms nas páginas com itens; terminal zero em 38 ms;
- verificação final retornou `remainingOverdueUnstarted = 0` para o corte `04:32:40 UTC`;
- diferença entre os 368 inicialmente observados e os 276 ignorados ocorreu porque parte recebeu `creation_id` entre a leitura e a parada efetiva do publicador;
- auditoria pós-corte: zero vencido sem criação, 108 vencidos já aceitos e 17 outros estados de processamento/publicação no total devido;
- não será usado restart normal para reconciliar agora, pois o mesmo fluxo também poderia criar a próxima onda; callbacks do provedor já demonstraram atualizar itens com o worker parado;
- publicação e geração permanecem paradas; Lexy e ggIgor permanecem em hold.

**Rollback:** estados ignored são decisão auditada; aceitos permanecem autoritativos e intocados.  
**Última condição segura:** nenhuma criação nova pode partir dos workers; callbacks podem concluir os aceitos.  
**Próxima ação exata:** observar queda dos 108 aceitos via callbacks; ao estabilizar, executar novo corte terminal dos não iniciados que vencerem durante a espera e reavaliar a necessidade de um modo explícito `reconciliation-only`.

#### Decisão: modo explícito de reconciliação — 28/08/2026 01:35 BRT / 04:35 UTC

**Estado:** implementação em preparação; workers continuam parados.

- callbacks reduziram aceitos de 108 para 103 em 25 s, ritmo insuficiente para liberar o gate sem prolongar a janela;
- reiniciar o modo normal é inseguro: ele executa preparação, recuperação, claim de itens sem criação, reciclagem e reconciliação no mesmo ciclo;
- será criado modo temporário `reconciliation-only`, que reivindica exclusivamente linhas com `creation_id is not null` e nunca chama preparação, recuperação de slots, criação nova ou reciclagem;
- RPC dedicada manterá leases, justiça por organização/perfil, `SKIP LOCKED`, limite curto e idempotência; o processamento existente já escolhe polling quando `creation_id` está presente;
- configuração será opt-in por variável interna do worker, sem alterar API pública; após zerar aceitos, worker será parado e a variável revertida antes da retomada normal;
- migration prevista: 310, forward-only e service-only.

**Rollback:** manter workers parados; migration apenas adiciona RPC; código novo fica inativo por padrão.  
**Última condição segura:** zero vencido sem criação no corte, 103 aceitos pendentes.  
**Próxima ação exata:** implementar RPC 310, flag no dispatcher/worker e testes; não fazer deploy antes de TypeScript/suíte focada/dry-run.

#### Modo reconciliation-only implementado localmente — 28/08/2026 01:39 BRT / 04:39 UTC

**Estado:** validação local aprovada; migration/deploy pendentes.

- migration 310 adiciona `claim_provider_accepted_publication_items`, obrigando `creation_id is not null` antes da seleção, lock e update;
- limite do claim dedicado é no máximo 20; o runtime reconciliation-only limita efetivamente a quatro por ciclo;
- claim preserva justiça por organização/perfil, `SKIP LOCKED`, lease e backoff;
- dispatcher no modo novo pula integralmente preparação, recuperação de horários, recuperação coordenada e reciclagem; processamento existente apenas consulta/publica o contêiner já criado;
- flag `PUBLICATION_WORKER_RECONCILIATION_ONLY=false` é opt-in e aditiva; modo normal permanece inalterado por padrão;
- sintaxe Node dos dois workers e `git diff --check` aprovados;
- suíte Node executada integralmente por limitação do script: 306/306 aprovados, incluindo o novo teste de não criação;
- nenhum worker foi iniciado e schema remoto permanece 309.

**Rollback:** não aplicar/deployar; mudanças locais inativas.  
**Última condição segura:** produção com ambos os workers parados.  
**Próxima ação exata:** dry-run 310, aplicar migration, executar cinco testes SQL remotos e só então implantar os dois arquivos na VPS com backup.

- dry-run remoto apresentou exclusivamente `310_claim_only_provider_accepted_publications.sql`; autorizado avançar sem outras migrations.

#### Migration 310 aplicada — 28/08/2026 01:40 BRT / 04:40 UTC

**Estado:** schema ativo; runtime VPS ainda parado/antigo.

- migration aplicada sem erro e paridade confirmada em `310 | 310`;
- nenhuma linha foi reivindicada durante a aplicação; a função só atua quando chamada pelo service role;
- publicador e gerador permaneceram parados.

**Rollback:** função pode ser removida/substituída forward-only; não há dado mutado.  
**Última condição segura:** claim dedicado disponível, mas ainda não usado.  
**Próxima ação exata:** executar os cinco testes SQL remotos antes do deploy VPS.

#### Teste SQL 310 aprovado — 28/08/2026 01:41 BRT / 04:41 UTC

**Estado:** 5/5 `PASS`; deploy isolado autorizado.

- teste remoto comprovou presença, exigência de `creation_id`, limite/`SKIP LOCKED`, justiça e permissão exclusiva do service role;
- nenhum claim funcional foi executado pelo teste transacional;
- runtime VPS continua parado, portanto não há janela entre schema/código.

**Rollback:** inalterado.  
**Última condição segura:** schema e código validados, ainda sem execução.  
**Próxima ação exata:** criar backups remotos do dispatcher, worker e `.env.worker`; copiar apenas os dois arquivos, validar hash/sintaxe e ativar a flag antes de iniciar somente o publicador.

#### Runtime reconciliation-only instalado — 28/08/2026 01:42 BRT / 04:42 UTC

**Estado:** arquivos/ambiente aprovados; processo ainda parado.

- backups criados: `publication-direct-dispatch.mjs.before-310`, `publication-worker.mjs.before-310` e `.env.worker.before-310`;
- somente dispatcher e worker de publicação foram copiados;
- `PUBLICATION_WORKER_RECONCILIATION_ONLY=true` persistida na linha 68 do ambiente remoto;
- `node --check` remoto aprovou ambos os arquivos;
- hashes SHA-256 local/remoto idênticos: dispatcher `96f656...d8d32b`, worker `7b98b7...743a1f`;
- gerador continuou parado; nenhum claim ocorreu durante instalação.

**Rollback:** restaurar três arquivos `.before-310`, validar sintaxe e manter processo parado.  
**Última condição segura:** runtime pronto e inativo.  
**Próxima ação exata:** iniciar somente o publicador, confirmar no primeiro log `reconciliationOnly: true`, limite quatro, preparação/recuperação/reciclagem zero e acompanhar aceitos.

#### Reconciliação exclusiva ativa — 28/08/2026 01:40 BRT / 04:40 UTC

**Estado:** comportamento funcional aprovado; drenagem em curso.

- somente o publicador iniciou, PID 201739; gerador permaneceu parado;
- startup confirmou `mode: direct`, `dryRun: false`, `reconciliationOnly: true`;
- dois primeiros ciclos reivindicaram quatro itens cada e resultaram em quatro `published` por ciclo;
- preparação, recovery, recuperação coordenada e reciclagem ficaram todos em zero;
- aceitos vencidos caíram para 61; vencidos sem criação permaneceram exatamente zero;
- log de erro manteve mtime histórico `03:20:17 UTC`, sem erro novo;
- campo de log `maximum` ainda exibia o máximo configurado 44, embora `used/next` estivessem rigidamente em quatro; saída local foi corrigida para mostrar o máximo efetivo quatro e será instalada somente após a drenagem, sem interromper o processo agora.

**Rollback:** parar publicador e restaurar `.before-310`; não necessário no comportamento atual.  
**Última condição segura:** somente contêineres existentes são consultados/publicados, quatro por ciclo.  
**Próxima ação exata:** manter até `criticalAccepted = 0`, confirmar zero sem criação/erro e então parar o publicador antes de remover a flag temporária.

#### Reconciliação exclusiva concluída — 28/08/2026 01:42 BRT / 04:42 UTC

**Estado:** aceitos zerados; processo parado e persistido.

- pendências aceitas caíram de 61 para 41, 21, cinco e finalmente zero;
- durante toda a execução, `criticalUnstarted` permaneceu zero até a faixa seguinte vencer; isso comprova que o modo exclusivo não criou trabalho novo;
- uma nova faixa de 209 itens chegou ao atraso crítico já com `creation_id = null`, tentativa zero, zero lease/erro;
- publicador foi parado imediatamente após `criticalAccepted = 0` e o PM2 salvo;
- gerador continuou parado; VPS em aproximadamente 4,6% CPU e 29,9% RAM;
- nenhum novo mtime de erro foi observado durante a reconciliação.

**Rollback:** modo exclusivo cumpriu o objetivo; manter processo parado.  
**Última condição segura:** zero criação aceita pendente; 209 não iniciados preservados para ignored.  
**Próxima ação exata:** fixar novo corte pelo relógio do projeto e encerrar a nova faixa em páginas de 10 até terminal zero.

#### Quarto corte concluído — 28/08/2026 01:43 BRT / 04:43 UTC

**Estado:** 209 não iniciados encerrados; um polling tardio reapareceu.

- relógio HTTP `04:42:27 UTC`; corte fixo `04:42:15 UTC`;
- 209 itens foram marcados ignored em 21 páginas úteis de até 10; página 22 terminal zero em 47 ms;
- páginas úteis duraram entre 206 e 597 ms, sem timeout;
- verificação retornou zero vencido sem criação para o corte e zero aceito na contagem-base;
- logo após, um item anteriormente em processamento retornou para waiting com `creation_id`, tentativa 2 e próximo polling `04:43:45 UTC`; isso explica sinal crítico ainda verdadeiro sem indicar nova criação;
- há 17 itens devidos em estados amplos; auditor foi ampliado para separar status e presença de criação antes de decidir qualquer ação.

**Rollback:** ignored auditados; workers permanecem parados.  
**Última condição segura:** nenhuma fila pode criar; um polling aceito aguarda janela.  
**Próxima ação exata:** auditar os 17 por status/creation e executar no máximo um ciclo one-shot reconciliation-only após o próximo polling, se necessário.

#### Segunda janela reconciliation-only — 28/08/2026 01:45 BRT / 04:45 UTC

**Estado:** publicador exclusivo online; gerador parado.

- auditoria detalhada encontrou cinco `waiting` com criação aceita e 12 `preparing` sem criação;
- os 12 sem criação não entram na RPC 310 por três barreiras explícitas de `creation_id is not null` e não podem ser enviados pelo modo atual;
- somente o publicador foi iniciado novamente com a flag exclusiva ainda ativa; PM2 salvo;
- VPS no restart: aproximadamente 3,2% CPU e 28,6% RAM;
- gerador, Lexy e ggIgor continuam contidos.

**Rollback:** parar imediatamente o publicador; nenhum fluxo de criação está habilitado.  
**Última condição segura:** somente cinco polls aceitos estão elegíveis.  
**Próxima ação exata:** confirmar zero aceitos, parar o publicador e inspecionar leases/claimed_by dos 12 preparando sem criação.

#### Segunda reconciliação encerrada — 28/08/2026 01:45 BRT / 04:45 UTC

**Estado:** gate de aceitos aprovado; publicador novamente parado.

- aceitos caíram de cinco para zero;
- atraso crítico oficial voltou a `false`, sem waiting/ready acima de 60 s;
- resíduos `preparing` sem criação caíram de 12 para sete por recuperação/encerramento externo, sem terem sido processados pela RPC exclusiva;
- publicador foi parado e PM2 salvo imediatamente após o zero;
- log de erro permaneceu em `03:20:17 UTC`, sem erro novo;
- auditor foi ampliado para expor status, lease ativo e `claimed_by` dos resíduos sem criação, sem dados sensíveis.

**Rollback:** processo já parado.  
**Última condição segura:** zero aceitos e zero atraso crítico; sete resíduos sem criação não elegíveis ao reconciliador.  
**Próxima ação exata:** verificar leases dos sete; se expirados, encerrá-los por RPC dedicada sem reabrir publicação normal.

#### Migration 311 preparada — 28/08/2026 01:47 BRT / 04:47 UTC

**Estado:** validação local/dry-run aprovada; aplicação pendente.

- os sete resíduos possuem o mesmo lease expirado `04:35:16 UTC`, `claimed_by = athena-vps-publication-1`, criação ausente e status `preparing`;
- RPC 311 exige service role, corte passado, estado preparing/publishing, `creation_id is null`, lease não nulo/expirado e cardinalidade exata informada pelo operador;
- qualquer oitava linha ou mudança de estado aborta a transação integralmente;
- função libera reservas, registra evento ignored e sincroniza lotes;
- `git diff --check` passou; dry-run exibiu exclusivamente a migration 311;
- ambos os workers continuam parados.

**Rollback:** não aplicar/chamar; produção ainda em 310.  
**Última condição segura:** sete resíduos identificados e inativos.  
**Próxima ação exata:** aplicar 311, executar quatro testes SQL e chamar uma vez com quantidade esperada sete/corte 04:42:15 UTC.

#### Migration 311 aplicada e testada — 28/08/2026 01:48 BRT / 04:48 UTC

**Estado:** schema/testes aprovados; RPC operacional ainda não chamada.

- migration aplicada sem erro e paridade `311 | 311` confirmada;
- quatro testes SQL remotos passaram integralmente;
- foi criado executor mínimo que exige corte e cardinalidade exatos e não imprime credenciais;
- workers permaneceram parados durante aplicação/teste.

**Rollback:** função forward-only; nenhum resíduo alterado ainda.  
**Última condição segura:** schema 311 pronto.  
**Próxima ação exata:** validar sintaxe do executor e chamar a RPC esperando exatamente sete.

#### Sete leases expirados encerrados — 28/08/2026 01:47 BRT / 04:47 UTC

**Estado:** aprovado.

- executor passou em `node --check`;
- RPC encontrou e encerrou exatamente sete resíduos, distribuídos nos lotes Ggbiel e no lote da onda reconciliada;
- resposta confirmou corte, cardinalidade sete e dois lotes sincronizados;
- auditoria subsequente retornou zero item anterior ao corte em qualquer estado operacional, zero accepted e nenhuma linha in-flight;
- enquanto os workers permaneceram parados, uma nova faixa de 21 itens alcançou 60 s de atraso às `04:47:31 UTC`; todos sem criação/tentativa/lease;
- Ggbiel está em 12.361 gerados + 124 ignored; Laurinha em 27.072 gerados; ambos sem falha/lease.

**Rollback:** estados ignored são auditados; workers seguem parados.  
**Última condição segura:** não há resíduo anterior; a nova faixa de 21 ainda não foi enviada.  
**Próxima ação exata:** impedir estruturalmente que a geração reabra slots que se tornaram vencidos desde o corte inicial: criar RPC de avanço de cursor por plano/corte, com dry-run e preservação do hold.

#### Migration 312 preparada — 28/08/2026 01:50 BRT / 04:50 UTC

**Estado:** validação local/dry-run aprovada; aplicação pendente.

- RPC calcula o primeiro slot posterior ao corte a partir de `schedule_base_at`, intervalo e cursor atual;
- somente o intervalo ainda não materializado entre `next_slot_index` e o novo cursor vira ignored; itens já gerados nunca são recontados;
- segmentos com futuro são recompactados a partir do novo cursor; segmentos totalmente vencidos são concluídos;
- plano pausado mantém chunks/perfis pausados e `holdPreserved = true`;
- lease ativo aborta; modo dry-run não muta;
- `git diff --check` passou e dry-run apresentou exclusivamente a 312;
- schema remoto ainda 311; workers continuam parados.

**Rollback:** não aplicar/chamar.  
**Última condição segura:** cursores atuais intactos.  
**Próxima ação exata:** aplicar/testar 312; depois obter corte do relógio do projeto e executar previews dos três planos antes de qualquer mutation.

#### Migration 312 aplicada e testada — 28/08/2026 01:51 BRT / 04:51 UTC

**Estado:** schema/testes aprovados; cursores ainda não alterados.

- migration aplicada sem erro; paridade `312 | 312`;
- cinco testes SQL remotos passaram;
- executor operacional recebeu ações separadas `advance-preview` e `advance`, ambas exigindo nome/corte;
- workers e holds permanecem inalterados.

**Rollback:** função forward-only; ainda não chamada.  
**Última condição segura:** schema 312.  
**Próxima ação exata:** validar executor, obter hora do projeto e executar previews de Ggbiel, Laurinha e Lexy com o mesmo corte.

#### Previews de avanço aprovados — 28/08/2026 01:49 BRT / 04:49 UTC

**Estado:** zero mutation; corte fixo aprovado.

- executor passou em `node --check`; relógio HTTP do projeto retornou `04:49:03 UTC`;
- corte único com margem: `2026-08-28T04:48:50.000Z`;
- Ggbiel: 31 chunks inspecionados, 28 com um slot vencido cada, total 28 ignored, zero chunk concluído;
- Laurinha: 21 chunks inspecionados, zero slot vencido adicional;
- Lexy: 149 chunks pausados inspecionados, 149 primeiros slots vencidos, zero chunk concluído e hold preservado;
- a Lexy possui três slots por perfil; somente o primeiro vencido será pulado, mantendo os dois futuros por perfil no segmento pausado.

**Rollback:** previews não mutaram.  
**Última condição segura:** corte/quantidades conhecidos.  
**Próxima ação exata:** aplicar advance em Ggbiel, Laurinha (no-op comprovado) e Lexy com o mesmo corte; auditar contadores/status.

#### Cursores avançados — 28/08/2026 01:50 BRT / 04:50 UTC

**Estado:** mutations coincidem exatamente com os previews.

- Ggbiel: 28 slots adicionais ignored em 28 chunks;
- Laurinha: no-op, zero alteração;
- Lexy: 149 slots ignored em 149 chunks, `holdPreserved = true`;
- nenhum chunk foi concluído, nenhum lease criado e nenhum publication_item materializado pelas RPCs;
- workers permaneceram parados.

**Rollback:** contadores ignored refletem horários passados e não serão revertidos.  
**Última condição segura:** todos os cursores começam estritamente após 04:48:50 UTC.  
**Próxima ação exata:** auditar os três planos e a fila vencida; se tudo fechar, drenar primeiro Ggbiel/Laurinha com Lexy pausada.

#### Auditoria pós-avanço — 28/08/2026 01:50 BRT / 04:50 UTC

**Estado:** planos aprovados; fila corrente exige fechamento antes da geração.

- Ggbiel: 12.361 gerados + 152 ignored, 31 chunks futuros, zero falha/lease;
- Laurinha: 27.072 gerados, 21 chunks futuros, zero falha/lease;
- Lexy: 129 gerados + 149 ignored, 149 chunks pausados, zero falha/lease/anomalia;
- contadores de chunk foram resegmentados para o futuro; o contador autoritativo completo permanece nos perfis/planos;
- na fila operacional há 50 vencidos sem criação e dez aceitos anteriores ao corte, sem in-flight;
- gerador não será iniciado enquanto o sinal crítico estiver verdadeiro.

**Rollback:** holds/worker stops preservados.  
**Última condição segura:** planos íntegros, fila sem processamento ativo.  
**Próxima ação exata:** ignorar os 50 sem criação em páginas de 10 e reconciliar exclusivamente os dez aceitos; repetir zero terminal antes de iniciar geração.

#### Fechamento da fila operacional antes da geração — 28/08/2026 01:51 BRT / 04:51 UTC

**Estado:** aprovado; ambos os workers pesados parados.

- os 50 vencidos sem criação foram marcados `ignored` em cinco páginas de dez, com durações de 322, 209, 201, 205 e 220 ms; uma sexta chamada terminal retornou zero em 49 ms;
- o publicador foi iniciado exclusivamente em `PUBLICATION_WORKER_RECONCILIATION_ONLY=true`, portanto somente publicações já aceitas pelo provedor ficaram elegíveis e nenhuma criação nova foi permitida;
- após 15 segundos, a auditoria retornou `overdueUnstarted=0`, `overdueAccepted=0`, `dueTotal=0`, `futureWaiting=101692` e `criticalDelay=false`;
- o publicador foi parado imediatamente, o estado do PM2 foi salvo e o gerador permaneceu parado;
- o log de erro do publicador manteve `mtime=2026-08-28 03:20:17 UTC`, comprovando ausência de erro novo durante a drenagem;
- baseline da VPS no stop: aproximadamente 4,5% CPU, 30,1% RAM e I/O desprezível;
- Lexy e ggIgor permanecem sob hold; nenhuma etapa fora da ordem foi liberada.

**Arquivos/workers envolvidos:** `scripts/workers/ignore-overdue-unstarted-publications.mjs`, `scripts/workers/audit-publication-recovery-state.mjs`, `athena-publication-worker`, `athena-generation-worker`.  
**Comandos sem segredos:** executor paginado de ignore; auditor de recuperação; `pm2 stop athena-publication-worker`; `pm2 save`; inspeção de `mtime` do log.  
**Rollback:** publicador e gerador já estão parados; holds continuam ativos.  
**Última condição segura:** zero item vencido operacional no corte auditado, zero aceitação pendente e nenhum worker pesado ativo.  
**Próxima ação exata:** obter novo corte do relógio do projeto, fazer preview e avançar somente os cursores de Ggbiel/Laurinha que tenham envelhecido desde 04:48:50 UTC; depois iniciar apenas o gerador, mantendo Lexy e ggIgor pausados.

#### Geração controlada de Ggbiel/Laurinha iniciada — 28/08/2026 01:51 BRT / 04:51 UTC

**Estado:** em execução e sob observação.

- relógio HTTP autoritativo do projeto: `Fri, 28 Aug 2026 04:51:30 GMT`; corte conservador usado no preview: `04:51:15 UTC`;
- previews da RPC 312 inspecionaram 31 chunks de Ggbiel e 21 de Laurinha e retornaram zero slot adicional vencido/zero mutation para ambos;
- baseline antes do restart: Ggbiel 12.361 gerados + 152 ignored, Laurinha 27.072 gerados, ambos sem falha, lease ou anomalia;
- somente `athena-generation-worker` foi iniciado (`pid=202355`) e o PM2 foi salvo; `athena-publication-worker` permanece parado;
- VPS no restart: aproximadamente 4,2% CPU e 28,8% RAM;
- Lexy e ggIgor continuam pausados, portanto não podem ser reivindicados pelo gerador nesta etapa.

**Comandos sem segredos:** dois `advance-preview`; `pm2 start athena-generation-worker`; `pm2 save`; auditoria de status dos planos.  
**Rollback:** `pm2 stop athena-generation-worker`; nenhum hold foi removido.  
**Última condição segura:** somente os 52 chunks futuros aprovados de Ggbiel/Laurinha estão elegíveis.  
**Próxima ação exata:** observar logs, erro, pressão e `eligibleNow`; parar imediatamente se surgir atraso crítico e encerrar a etapa quando ambos alcançarem `eligibleNow=0`.

#### Primeira observação da geração controlada — 28/08/2026 01:53 BRT / 04:53 UTC

**Estado:** aprovado para continuar.

- primeira fatia real processou 48 itens em 994 ms; o controlador classificou `slow_database_slice`, reduziu automaticamente de 50 para 25 e aplicou cooldown de 1.988 ms;
- fatias seguintes processaram 25 e 23 itens em 483 e 457 ms, com cooldowns de 966 e 914 ms, sem timeout;
- Ggbiel reduziu seus slots restantes de 3.373 para 3.277; Laurinha ainda aguardava sua vez no recorte observado;
- `eligibleNow` total caiu de 48 para 46 chunks (Ggbiel 25, Laurinha 21), enquanto Lexy/ggIgor permaneceram em zero por hold;
- auditoria da fila no corte `04:52:45 UTC`: zero vencido sem criação, zero aceito, zero total vencido e `criticalDelay=false`; 101.862 itens futuros;
- log de erro do gerador permaneceu no `mtime=03:22:16 UTC`; nenhum erro novo;
- VPS durante a atividade: aproximadamente 8,6% CPU, 30,1% RAM e I/O baixo.

**Rollback:** parar o gerador; estado persiste por cursor idempotente.  
**Última condição segura:** 144 itens futuros materializados no período, nenhum vencido/duplicado detectado e adaptação em passo 25.  
**Próxima ação exata:** continuar monitorando a drenagem de `eligibleNow`, a justiça entre os dois planos e o sinal de pressão, sem iniciar o publicador.

#### Gargalo de cadência identificado — 28/08/2026 01:58 BRT / 04:58 UTC

**Estado:** correção de configuração aprovada para aplicação imediata.

- a fatia de 25 dura aproximadamente 0,3–0,5 s e calcula cooldown de aproximadamente 0,6–1,0 s, mas o loop ainda usa `PUBLICATION_GENERATION_WORKER_POLL_INTERVAL_MS=10000`;
- assim, o worker processa no máximo uma fatia a cada ~10,3 s, deixando o banco ocioso muito além do cooldown adaptativo;
- Ggbiel avançou de 3.373 para 2.676 slots restantes e `eligibleNow` de 27 para 13; zero erro/timeout, enquanto Laurinha permaneceu aguardando a ordenação do claim;
- será alterada somente a cadência para 2.000 ms; tamanho 25, lease único, limites adaptativos, gate de atraso e cooldown de timeout permanecem intactos;
- expectativa: reduzir o intervalo efetivo por fatia de ~10,3 s para ~2,3–3,0 s sem aumentar o tamanho transacional.

**Arquivos/workers envolvidos:** `/opt/athena-worker/.env.worker`, `athena-generation-worker`.  
**Rollback:** restaurar `PUBLICATION_GENERATION_WORKER_POLL_INTERVAL_MS=10000` e reiniciar o gerador.  
**Última condição segura:** gerador online em passo 25, sem pressão crítica ou erro novo.  
**Próxima ação exata:** criar backup do env remoto, aplicar polling de 2 s, reiniciar somente o gerador e comparar vazão/pressão por 30–60 s.

#### Polling de 2 s aplicado e validado — 28/08/2026 02:00 BRT / 05:00 UTC

**Estado:** aprovado para manter durante a recuperação.

- backup criado em `/opt/athena-worker/.env.worker.before-poll-2000`;
- `PUBLICATION_GENERATION_WORKER_POLL_INTERVAL_MS` alterado de 10.000 para 2.000; somente o gerador foi reiniciado (`pid=202728`) e PM2 salvo;
- Ggbiel caiu de 2.676 para 2.292 slots restantes e de 13 para cinco chunks elegíveis no primeiro minuto, ganho prático superior a 3× na drenagem;
- chamadas mais frequentes elevaram as durações recentes para 801 e 1.220 ms, mas o controlador preservou passo 25 e cooldowns de 1.602 e 2.440 ms;
- fila operacional permaneceu com zero vencido/aceito, `criticalDelay=false` e 102.870 itens futuros;
- log de erro do gerador permaneceu no `mtime=03:22:16 UTC`; zero timeout/erro novo;
- publicador continua parado e Lexy/ggIgor continuam sob hold.

**Teste numérico:** a cadência agora acompanha o cooldown; o banco respondeu mais lentamente sob maior frequência, mas sem formar atraso operacional ou erro.  
**Rollback:** restaurar o backup ou polling 10.000 e reiniciar o gerador.  
**Última condição segura:** Ggbiel com cinco chunks elegíveis; Laurinha com 21; nenhuma carga fora de ordem.  
**Próxima ação exata:** concluir os cinco chunks elegíveis de Ggbiel, observar a entrada de Laurinha e manter o gate por pressão; não elevar o tamanho transacional enquanto durações estiverem acima de 750 ms.

#### Ggbiel e Laurinha repostos no horizonte de 48 h — 28/08/2026 02:02 BRT / 05:02 UTC

**Estado:** etapa aprovada e encerrada.

- Ggbiel atingiu `eligibleNow=0` com 2.077 slots restantes exclusivamente fora do horizonte móvel;
- Laurinha iniciou somente depois do recorte de Ggbiel e atingiu `eligibleNow=0` com 2.121 slots exclusivamente fora do horizonte;
- no fechamento, ambos tinham zero chunk falho, zero lease ativo e zero `retry_exhausted`;
- fila no corte `05:01:30 UTC`: zero vencido sem criação, zero aceito, zero total vencido, `criticalDelay=false` e 103.965 itens futuros;
- log de erro do gerador continuou em `03:22:16 UTC`; zero erro novo;
- gerador foi parado e PM2 salvo antes de tocar no hold da Lexy; publicador segue parado;
- VPS no stop: aproximadamente 4,5% CPU e 30,4% RAM.

**Resultado de desempenho:** o polling de 2 s concluiu a parte elegível de Ggbiel e Laurinha em poucos minutos sem ampliar a transação acima de 25 durante pressão lenta.  
**Rollback:** ambos os workers pesados estão parados; cursores são idempotentes.  
**Última condição segura:** primeira e segunda tarefas solicitadas concluídas; Lexy ainda pausada com 298 slots futuros e ggIgor pausado.  
**Próxima ação exata:** obter novo corte, fazer `advance-preview` da Lexy sob hold, pular somente eventual horário que tenha vencido e então liberar exclusivamente `27-08 LEXY STORY`.

#### Hold da Lexy removido na ordem aprovada — 28/08/2026 02:03 BRT / 05:03 UTC

**Estado:** liberação aprovada; gerador ainda parado no instante da mutation.

- relógio HTTP do projeto: `05:02:31 UTC`; preview com corte `05:02:15 UTC` inspecionou 149 chunks e encontrou zero novo slot vencido;
- RPC de release removeu o hold de exatamente 149 chunks com razão `operator_ordered_recovery_2026_08_28`;
- Lexy passou para `generating`: 129 gerados, 149 ignored históricos, 298 slots futuros em 149 chunks, zero falha/lease/anomalia;
- ggIgor permanece pausado em 189 chunks e não está elegível;
- nenhuma publicação foi criada pela operação de release.

**Rollback:** reaplicar hold antes do gerador se surgir qualquer inconsistência; gerador/publicador ainda parados.  
**Última condição segura:** somente Lexy está liberada entre os planos especiais restantes.  
**Próxima ação exata:** iniciar somente o gerador com polling de 2 s, observar Lexy até `eligibleNow=0` e parar antes de liberar ggIgor.

#### Lexy em geração; cadência temporária de 1 s autorizada — 28/08/2026 02:05 BRT / 05:05 UTC

**Estado:** em execução; ajuste temporário pendente.

- gerador iniciado em `pid=203054`, publicador parado e ggIgor ainda sob hold;
- cada chunk da Lexy contém somente dois slots futuros, portanto o step 25/50/100 não aumenta essa transação específica;
- 36 chunks foram concluídos desde o release; restam 113 chunks/226 slots, zero falha, lease preso ou exaustão;
- chamada observada: dois itens em 282 ms, cooldown adaptativo 564 ms;
- fila operacional: zero vencido/aceito e `criticalDelay=false`; log de erro inalterado;
- reduzir polling de 2.000 para 1.000 ms ainda respeita o cooldown e manté um único chunk sequencial por ciclo, sem paralelismo nem aumento transacional.

**Rollback:** restaurar polling de 2.000 ms e reiniciar; backup de 10.000 ms também preservado.  
**Última condição segura:** 113 chunks Lexy elegíveis, todos com dois slots, banco sem atraso.  
**Próxima ação exata:** aplicar polling temporário de 1 s, reiniciar somente o gerador e medir por 30–60 s.

#### Gate crítico interrompeu a Lexy corretamente — 28/08/2026 02:06 BRT / 05:06 UTC

**Estado:** recuperação pausada automaticamente e confirmada manualmente.

- backup `/opt/athena-worker/.env.worker.before-lexy-poll-1000` criado; polling temporário de 1.000 ms aplicado e gerador reiniciado em `pid=203201`;
- antes de ampliar a drenagem, surgiu uma onda operacional: 56 itens vencidos sem criação e cinco itens vencidos já aceitos pelo provedor;
- `criticalDelay` mudou para `true`, com mais antigo em `05:03:52 UTC`; gerador avançou somente quatro chunks Lexy após o restart e deixou de adquirir trabalho pesado;
- gerador foi parado imediatamente e PM2 salvo; publicador continua parado;
- Lexy preserva 109 chunks/218 slots futuros sem falha; ggIgor permanece pausado;
- VPS no stop: aproximadamente 4,5% CPU e 30,0% RAM.

**Evidência da contramedida:** a prioridade de publicação impediu a geração de continuar quando apareceu atraso superior a 60 s.  
**Rollback:** ambos os workers pesados estão parados.  
**Última condição segura:** 56 itens nunca enviados podem ser ignorados; cinco criações já aceitas exigem apenas reconciliação.  
**Próxima ação exata:** ignorar exatamente os 56 em páginas pequenas, reconciliar exclusivamente os cinco aceitos e exigir zero terminal antes de retomar a Lexy.

#### Onda vencida fechada sem novas publicações — 28/08/2026 02:07 BRT / 05:07 UTC

**Estado:** unstarted aprovado; reconciliação exclusiva em andamento.

- entre a primeira auditoria e a mutation, cinco dos 56 itens adquiriram `creation_id` por processamento externo já aceito; a cardinalidade total permaneceu 61;
- RPC paginada marcou 51 itens ainda sem criação como `ignored` em páginas 10/10/10/10/10/1 e uma página terminal zero;
- durações: 966, 679, 581, 707, 952, 510 e 650 ms; zero restante sem criação no corte;
- dez criações aceitas ficaram para polling; `PUBLICATION_WORKER_RECONCILIATION_ONLY=true` foi confirmado antes de iniciar o publicador em `pid=203370`;
- reconciliador reduziu aceitos de dez para cinco e depois para dois, sem habilitar preparação/criação;
- dois itens aguardam `next_attempt_at` do provedor; gerador permanece parado.

**Rollback:** parar o publicador; modo atual não possui caminho de criação.  
**Última condição segura:** zero unstarted vencido; somente dois polls aceitos restantes.  
**Próxima ação exata:** aguardar o `next_attempt_at` dos dois, confirmar zero aceito, parar o publicador e somente então retomar Lexy.

#### Regra permanente anti-rajada exigida pelo segundo gate — 28/08/2026 02:12 BRT / 05:12 UTC

**Estado:** implementação em andamento; workers pesados parados.

- o último item aceito chegou a zero às `05:08:59 UTC`; reconciliador foi parado e Lexy retomada;
- Lexy avançou de 109 para 21 chunks, mas uma segunda faixa de publicações correntes venceu e o gate retornou `critical_publication_delay` com cooldown de ~9,6 s;
- auditoria simultânea recebeu falha transitória do Data API; gerador foi parado e PM2 salvo, evitando aumento de carga;
- causa operacional confirmada: manter publicador parado faz novos horários vencerem; reativar a claim antiga permitiria enviar itens sem criação até 15 minutos atrasados;
- será criada migration 313 forward-only para excluir de `claim_publication_items` qualquer item sem `creation_id` com mais de 60 s de atraso, mantendo criações já aceitas sempre reconciliáveis;
- o worker normal chamará a RPC 307 em página curta antes da preparação para marcar esses expirados `ignored`; falha auxiliar não reabre o envio porque a barreira autoritativa ficará dentro da claim SQL.

**Arquivos/migrations previstos:** migration 313; `scripts/workers/publication-direct-dispatch.mjs`; testes de regressão.  
**Rollback:** workers parados; não aplicar 313 nem implantar o dispatcher até testes passarem.  
**Última condição segura:** Lexy com 21 chunks restantes, gerador/publicador parados, ggIgor pausado.  
**Próxima ação exata:** implementar 313 e limpeza pré-claim, testar exclusão >60 s/aceito sempre elegível e somente depois restaurar publicação normal.

#### Migration 313 e limpeza pré-claim validadas localmente — 28/08/2026 02:14 BRT / 05:14 UTC

**Estado:** aprovada para aplicação remota; produção ainda em 312.

- migration 313 substitui `claim_publication_items` e torna inelegível qualquer item sem `creation_id` cujo horário tenha passado há mais de 60 s;
- itens com `creation_id` permanecem prioritários e elegíveis independentemente do horário para reconciliação segura;
- validação explícita de `service_role` foi adicionada à claim;
- dispatcher normal chama limpeza de no máximo dez expirados por ciclo antes da preparação; se essa limpeza auxiliar falhar, a claim SQL ainda impede o envio tardio;
- dois novos testes cobrem corte exato de 60 s/página curta e falha não bloqueante; arquivo completo passou 33/33;
- `node --check` e `git diff --check` passaram;
- `supabase db push --linked --dry-run` apresentou exclusivamente `313_prevent_late_unstarted_publication_claims.sql`; paridade anterior confirmada em `312 | 312`.

**Arquivos:** `supabase/migrations/313_prevent_late_unstarted_publication_claims.sql`, `scripts/workers/publication-direct-dispatch.mjs`, `scripts/workers/publication-direct-dispatch.test.mjs`.  
**Rollback:** não aplicar; workers pesados continuam parados.  
**Última condição segura:** código testado localmente, remoto ainda inalterado.  
**Próxima ação exata:** aplicar 313, confirmar paridade, executar teste transacional remoto da barreira e só então implantar o dispatcher na VPS.

#### Migration 313 aplicada e testada remotamente — 28/08/2026 02:15 BRT / 05:15 UTC

**Estado:** schema aprovado; deploy do consumidor pendente.

- `supabase db push --linked` aplicou somente a migration 313 sem erro;
- `supabase migration list --linked` confirmou paridade `313 | 313`;
- teste SQL transacional inspecionou a função remota e aprovou cinco contratos: existência, corte de 60 s, exceção para criação aceita, service role/`skip locked` e grant;
- o primeiro ensaio do teste revelou somente uma aspas incorreta no próprio arquivo de teste, sem mutation por estar em transação; arquivo corrigido e reexecutado com sucesso;
- nenhuma publicação foi reivindicada pelo teste; workers pesados permaneceram parados.

**Migration/teste:** `313_prevent_late_unstarted_publication_claims.sql`, `313_prevent_late_unstarted_publication_claims.test.sql`.  
**Rollback:** claim remota já é mais restritiva; manter publicador parado impede qualquer consumo até o deploy.  
**Última condição segura:** banco impede autoritativamente envio novo após 60 s, mesmo com dispatcher antigo.  
**Próxima ação exata:** criar backup do dispatcher remoto, copiar a versão testada, validar hash/sintaxe e limpar a faixa expirada atual antes de ativar modo normal.

#### Publicador normal protegido pela 313 ativado — 28/08/2026 02:20 BRT / 05:20 UTC

**Estado:** aprovado após observação inicial; gerador ainda parado.

- backup remoto criado em `publication-direct-dispatch.mjs.before-313`;
- dispatcher implantado com SHA-256 local/remoto idêntico `c7475c5c0bafe942312b1ab2d6829f0303dacb015118f32448fcde81e48c7e7b`; `node --check` remoto passou;
- auditoria antes do restart, com corte superior a 60 s, encontrou zero vencido/aceito e `criticalDelay=false`;
- backup do env criado em `.env.worker.before-normal-313`; `PUBLICATION_WORKER_RECONCILIATION_ONLY=false` aplicado;
- publicador normal iniciou em `pid=203884`; em 30 s, limpeza automática reportou zero, preparação/recovery/claim reportaram zero e nenhum erro ocorreu;
- auditoria posterior manteve zero vencido/aceito e `criticalDelay=false`; log de erro permaneceu no `mtime=03:20:17 UTC`;
- VPS na observação: 8,4% CPU, 30,5% RAM e I/O baixo.

**Rollback:** parar publicador, restaurar dispatcher/env anteriores; a barreira SQL mais restritiva permanece segura.  
**Última condição segura:** publicador normal atende o horário corrente e não pode reivindicar unstarted com mais de 60 s.  
**Próxima ação exata:** manter publicador online, iniciar gerador para concluir os 21 chunks Lexy e verificar se publicação corrente continua sem atraso sob carga combinada.

#### Lexy concluída integralmente — 28/08/2026 02:22 BRT / 05:22 UTC

**Estado:** aprovado; ordem operacional solicitada concluída.

- sob publicador normal + gerador, Lexy atingiu `completed` às `05:21:27 UTC`;
- resultado autoritativo: 576 esperadas = 427 futuras geradas + 149 vencidas ignored; 192/192 chunks e perfis completed;
- zero falha, zero lease ativo, zero exaustão e zero anomalia;
- durante a carga combinada, auditoria encontrou zero vencido/aceito e `criticalDelay=false`;
- Laurinha repôs mais 21 slots que cruzaram o horizonte durante a execução e voltou a `eligibleNow=0`; Ggbiel permaneceu em zero;
- gerador foi parado e PM2 salvo; publicador normal protegido permaneceu online;
- log de erro do gerador permaneceu no `mtime=03:22:16 UTC`; VPS no stop: 6,7% CPU e 32% RAM.

**Resultado da ordem pedida:** vencidos foram ignorados, Ggbiel/Laurinha futuros foram repostos e, por último, Lexy foi liberada/concluída sem rajada atrasada.  
**Rollback:** gerador parado; publicador pode ser parado sem afetar os cursores concluídos.  
**Última condição segura:** Lexy encerrada; plano adicional ggIgor continua isolado sob hold.  
**Próxima ação exata:** tratar separadamente ggIgor: restaurar polling de 2 s, fazer preview/avanço de vencidos sob hold e liberar somente após validar o recorte.

#### ggIgor liberado após a Lexy — 28/08/2026 02:23 BRT / 05:23 UTC

**Estado:** pronto para geração controlada.

- polling do gerador restaurado de 1.000 para 2.000 ms antes do novo plano;
- relógio HTTP `05:22:03 UTC`; preview com corte `05:21:45 UTC` encontrou exatamente um slot vencido em cada um dos 189 chunks;
- advance aplicou exatamente 189 ignored e preservou o hold durante a mutation;
- somente depois do advance, release removeu o hold de 189 chunks com razão `ordered_recovery_after_lexy_2026_08_28`;
- estado inicial: 4.536 esperadas = 189 ignored + 4.347 slots futuros; zero gerado, falha, lease ou anomalia;
- publicador normal protegido pela 313 permanece online.

**Rollback:** reaplicar hold ou parar o gerador; gerador ainda parado neste registro.  
**Última condição segura:** somente slots posteriores ao corte estão em 189 chunks queued.  
**Próxima ação exata:** iniciar gerador com polling 2 s, observar fatias/duração e exigir zero atraso operacional sob carga combinada.

#### Primeira observação ggIgor — 28/08/2026 02:23 BRT / 05:23 UTC

**Estado:** aprovado; cadência temporária de 1 s autorizada.

- gerador iniciou em `pid=204255` com publicador normal online;
- 11 chunks/perfis concluídos em ~25 s; restam 178 chunks e 4.094 slots;
- cada chunk possui no máximo 23 itens futuros, portanto o controlador permaneceu em step 50 mas processou 23 por chamada;
- chamada recente: 23 itens em 381 ms, cooldown 762 ms; zero erro, falha, lease ou exaustão;
- auditoria da publicação: zero vencido/aceito e `criticalDelay=false`; 104.519 itens futuros;
- log de erro do gerador continua inalterado.

**Decisão de desempenho:** usar polling de 1.000 ms reduz o tempo ocioso sem elevar o lote acima de 23 nem criar paralelismo.  
**Rollback:** restaurar 2.000 ms e reiniciar; o gate de atraso continua autoritativo.  
**Última condição segura:** 178 chunks ggIgor elegíveis, publicador sem atraso.  
**Próxima ação exata:** aplicar 1.000 ms, reiniciar somente o gerador e observar vazão/pressão por 30 s.

#### Segunda onda operacional contida pela 313 — 28/08/2026 02:28 BRT / 05:28 UTC

**Estado:** geração pausada; publicador drenando somente estados seguros.

- polling de 1 s elevou a vazão para aproximadamente 1.000–1.100 itens/minuto; ggIgor caiu de 178 para 27 chunks e de 4.094 para 621 slots;
- chamadas chegaram a 23 itens em 272 ms; log de erro do gerador permaneceu inalterado, VPS em ~10,2% CPU e 32,5% RAM;
- uma onda de 114 itens no mesmo horário cruzou o corte: 77 sem criação e 37 já aceitos;
- o gate marcou `critical_publication_delay`, reduziu o passo e interrompeu novas aquisições; gerador foi parado e PM2 salvo;
- a claim 313 impediu envio atrasado dos 77; a limpeza automática os reduziu 77 → 27 → 0 em cerca de 30 s, em páginas de dez;
- aceitos caíram de 37 para nove e aguardam o `next_attempt_at` do provedor; não representam nova criação.

**Evidência estrutural:** a nova barreira permitiu manter o publicador normal online e converteu toda a faixa nunca enviada em ignored, sem rajada atrasada.  
**Rollback:** gerador parado; publicador pode ser parado, mas deve concluir os polls aceitos.  
**Última condição segura:** zero unstarted vencido, nove aceitos aguardando polling e 27 chunks ggIgor preservados.  
**Próxima ação exata:** aguardar zero aceito/`criticalDelay=false`, retomar os 27 chunks e finalizar ggIgor.

#### ggIgor concluído integralmente — 28/08/2026 02:31 BRT / 05:31 UTC

**Estado:** aprovado; recuperação extraordinária encerrada.

- nove criações aceitas da segunda onda chegaram a zero e `criticalDelay=false` às `05:29:54 UTC`;
- gerador retomou somente após o gate e concluiu ggIgor às `05:30:41 UTC`;
- resultado autoritativo: 4.536 esperadas = 4.347 futuras geradas + 189 vencidas ignored; 189/189 chunks/perfis completed;
- zero falha, lease, exaustão ou anomalia;
- gerador foi parado, polling permanente restaurado para 2.000 ms e PM2 salvo; publicador normal 313 permaneceu online;
- log de erro do gerador continuou em `03:22:16 UTC`; auditoria final no corte >60 s retornou zero vencido, zero aceito e `criticalDelay=false`;
- VPS no encerramento: aproximadamente 7,9% CPU e 32,3% RAM.

**Rollback:** gerador parado; todos os cursores concluídos são idempotentes.  
**Última condição segura:** todos os quatro planos operacionais tratados; somente horizontes móveis futuros de Ggbiel/Laurinha permanecem naturalmente queued fora de 48 h.  
**Próxima ação exata:** corrigir a subida adaptativa 25/50/100 para usar custo por item/vazão, validar em testes e canário sem reabrir qualquer plano concluído.

#### Controlador 25/50/100 orientado por vazão implementado — 28/08/2026 02:33 BRT / 05:33 UTC

**Estado:** validação local aprovada; deploy pendente.

- controlador agora calcula `lastDurationPerItemMs` e considera estável uma fatia com custo ≤25 ms/item e duração total ≤3 s;
- cinco fatias estáveis elevam 25→50 e outras cinco elevam 50→100;
- uma chamada acima de 750 ms somente reduz se também for ineficiente por item (>37,5 ms/item); qualquer chamada >3 s ainda reduz;
- timeout/Data API degradada continua forçando 25 + pausa de 120 s; atraso crítico continua forçando 25 + cooldown de 5–15 s;
- chunks menores que o step continuam reportando o custo real, sem fingir que processaram 50/100;
- três cenários novos/ajustados comprovam subida real com 50 em 1 s e 100 em 2 s, e redução com 25 em 1,25 s;
- teste focado passou 11/11; `node --check` e `git diff --check` passaram.

**Arquivos:** `scripts/workers/publication-generation-worker.mjs`, `scripts/workers/publication-generation-worker.test.mjs`.  
**Rollback:** gerador está parado; não copiar arquivo para VPS.  
**Última condição segura:** todos os planos extraordinários concluídos; novo controlador somente local.  
**Próxima ação exata:** criar backup remoto, implantar com hash/sintaxe, fixar thresholds no env e iniciar gerador normal para reposição do horizonte.

#### Controlador de vazão implantado; limpeza multipágina reforçada — 28/08/2026 02:36 BRT / 05:36 UTC

**Estado:** deploy aprovado; canário de geração pendente após gate limpo.

- worker de geração implantado com backup e SHA-256 local/remoto `f160dfbb27783c00367b9a71b5b054d766469b449eebd8d03107b7c4d73ccbe8`; sintaxe remota aprovada;
- thresholds explícitos no env: 25 ms/item, 3.000 ms máximo estável e cinco fatias para subida;
- ao iniciar o canário natural de 31 chunks Ggbiel, uma onda excepcional de ~630 itens cruzou o corte: aproximadamente 590 sem criação e 40 aceitos;
- gate impediu aquisição de Ggbiel e gerador foi parado; claim 313 bloqueou envio dos atrasados;
- limpeza automática foi ampliada para até cinco páginas sequenciais de dez por ciclo, preservando transações pequenas;
- teste dedicado e arquivo completo passaram 34/34; dispatcher implantado com backup e SHA-256 `a223ac1933aa3509d1f916873c74151ae8455e1a21a38c753fb8b7b7a2637690`;
- evidência do novo runtime mostrou `ignored: 50`, `pages: 5`, `failed: false` em um ciclo;
- a onda caiu de 380 unstarted + 15 aceitos para 130 + 11 e depois zero/zero às `05:35:51 UTC`; `criticalDelay=false`;
- logs de erro de ambos os workers permaneceram sem nova escrita.

**Rollback:** gerador parado; restaurar os dois backups de worker e reiniciar publicador.  
**Última condição segura:** fila corrente zerada, publicador normal online e canário Ggbiel ainda não consumido.  
**Próxima ação exata:** iniciar gerador com polling 2 s e observar se o controlador sobe 25→50→100 nos 31 chunks Ggbiel sem atraso de publicação.

#### Canário natural do controlador reiniciado — 28/08/2026 02:37 BRT / 05:37 UTC

**Estado:** em execução; observação combinada de geração e publicação.

- baseline imediatamente anterior: VPS com ~4,8–6,2% CPU, 30,4–30,7% RAM e I/O baixo; gerador parado e publicador normal online;
- relógio HTTP do Supabase: `05:37:34 UTC`; auditoria com corte conservador `05:36:04 UTC` retornou zero vencido sem criação, zero aceito vencido, zero devido e `criticalDelay=false`;
- Ggbiel possui 31 chunks naturalmente elegíveis no horizonte de 48 h e 2.077 slots restantes; Laurinha possui zero chunk elegível neste instante;
- configuração remota confirmada em `.env.worker`: polling 2.000 ms, início 50, mínimo 25, máximo 100, custo estável ≤25 ms/item, duração estável ≤3 s e subida após cinco fatias;
- somente `athena-generation-worker` foi iniciado (`pid=205561`) e a lista PM2 foi salva; `athena-publication-worker` permaneceu online;
- nenhum upgrade de compute, migration ou alteração adicional foi executado neste passo.

**Arquivos/workers envolvidos:** `.env.worker`, `athena-generation-worker`, `athena-publication-worker`.  
**Comandos sem segredos:** auditorias de fila/pressão, `pm2 start athena-generation-worker`, `pm2 save`, `pm2 status`.  
**Rollback:** `pm2 stop athena-generation-worker && pm2 save`; claim 313 e limpeza multipágina continuam protegendo a publicação.  
**Última condição segura:** canário iniciou somente com fila atual limpa e gate sem atraso.  
**Próxima ação exata:** coletar logs do controlador e duas auditorias durante a drenagem, exigindo evidência de subida 50→100 e zero atraso de publicação.

#### Canário natural drenado sem regressão — 28/08/2026 02:39 BRT / 05:39 UTC

**Estado:** aprovado para operação normal; prova real de lote 100 continua dependente de chunk com pelo menos 100 itens elegíveis.

- os 31 chunks elegíveis do Ggbiel foram drenados para zero em aproximadamente 92 s de uptime; 31 slots novos foram gerados e o horizonte móvel voltou a ficar abastecido;
- cada chunk possuía somente um slot recém-cruzado no horizonte, portanto `lastProcessedItems=1` e o step permaneceu em 50; este canário não contém cardinalidade suficiente para demonstrar 50→100 sem fabricar carga em produção;
- duas auditorias de publicação retornaram zero vencido sem criação, zero aceito vencido, zero total devido e `criticalDelay=false` durante e depois da geração;
- VPS permaneceu em aproximadamente 7–10,2% CPU, 31,8–32,1% RAM e I/O baixo; workers de geração e publicação seguem online;
- logs de erro permaneceram sem escrita nova: geração `03:22:16 UTC`, publicação `03:20:17 UTC`;
- controlador permanece configurado e testado para 25/50/100; reposição normal utiliza o step disponível, mas processa apenas a quantidade realmente elegível por chunk.

**Testes/evidências:** auditoria de chunks `eligibleNow: 31 → 20 → 1 → 0`; auditoria de pressão limpa antes/durante/depois; PM2 online.  
**Rollback:** parar somente o gerador; nenhum rollback é indicado pelas métricas atuais.  
**Última condição segura:** horizonte reposto, publicação corrente sem atraso, ambos os workers online e protegidos.  
**Próxima ação exata:** auditar o checklist estrutural restante do plano e executar o próximo item ainda não aprovado, sem criar carga artificial no banco de produção.

#### Gate para manutenção direcionada — 28/08/2026 02:40 BRT / 05:40 UTC

**Estado:** manutenção autorizada pelo gate; execução pendente neste checkpoint.

- `publication_items` apresenta 347.924 linhas estimadas e 55.407 tuplas mortas (~15,9%), acima do critério de 10%; último autovacuum registrado às `02:34 UTC`;
- `publication_batch_terminal_outcomes` apresenta 139.198 linhas e 18.183 mortas (~13,1%), mas será tratado separadamente para manter cada operação pequena e mensurável;
- banco com 3.643 MB, índices com 1.607 MB, tabelas com 1.254 MB, hit rate 1,00/1,00 e WAL alocado 464 MB;
- zero query acima de cinco minutos e zero relação bloqueada; publicação está com `criticalDelay=false` e zero vencido;
- decisão: parar temporariamente somente o gerador ocioso, executar `VACUUM (ANALYZE) public.publication_items` e medir novamente antes de qualquer segunda tabela; `VACUUM FULL` continua proibido.

**Rollback:** vacuum comum não reescreve a tabela e não possui rollback; em caso de pressão, interromper o comando e manter o gerador parado até normalização.  
**Última condição segura:** gerador online mas ocioso, publicador online e fila corrente limpa.  
**Próxima ação exata:** parar/salvar somente o gerador, executar e cronometrar o vacuum direcionado, revalidar pressão/bloqueios/tuplas mortas e religar o gerador.

#### Vacuum de `publication_items` concluído — 28/08/2026 02:41 BRT / 05:41 UTC

**Estado:** aprovado; primeira tabela voltou amplamente abaixo do gate.

- somente o gerador ocioso foi parado e o estado PM2 salvo; publicador permaneceu online;
- `VACUUM (ANALYZE) public.publication_items` concluiu em aproximadamente 34 s, sem `FULL` e sem erro;
- tuplas mortas caíram de 55.407/347.924 (~15,9%) para 46/348.575 (~0,01%); `last_vacuum` e `last_analyze` registraram `05:40 UTC`;
- após a operação havia zero query longa, zero bloqueio e zero publicação vencida/aceita; `criticalDelay=false`;
- `publication_batch_terminal_outcomes` permanece isoladamente em 18.183/139.198 (~13,1%), acima do gate, e nenhuma segunda tabela foi tocada antes desta medição.

**Teste/evidência:** `supabase inspect db vacuum-stats`, `blocking`, `long-running-queries` e auditoria autoritativa da fila.  
**Rollback:** não aplicável a vacuum comum; dados não foram removidos e nenhuma tabela foi reescrita.  
**Última condição segura:** primeira tabela saudável, gerador parado, publicador em dia.  
**Próxima ação exata:** executar separadamente `VACUUM (ANALYZE)` em `publication_batch_terminal_outcomes`, revalidar os mesmos gates e religar/persistir o gerador.

#### Vacuum terminal concluído e onda protegida — 28/08/2026 02:43 BRT / 05:43 UTC

**Estado:** manutenção aprovada; uma criação aceita aguarda reconciliação do provedor.

- `VACUUM (ANALYZE) public.publication_batch_terminal_outcomes` concluiu em ~24 s, sem `FULL` e sem erro;
- tuplas mortas caíram de 18.183/139.198 (~13,1%) para 0/141.485; `publication_items` permaneceu saudável, com 140 mortas em 348.575;
- gerador foi religado e PM2 salvo; ao detectar nova faixa corrente atrasada, reduziu 50→25 e entrou em `critical_publication_delay`, sem adquirir geração pesada;
- durante a manutenção, 109 itens do mesmo horário cruzaram o corte e uma preparação recebeu `statement_timeout`: 104 ainda não iniciados foram impedidos de publicar pela claim 313 e encerrados como `ignored` pela limpeza multipágina; cinco criações já aceitas foram apenas reconciliadas;
- em ~20 s a auditoria caiu de 104 sem criação + cinco aceitos para zero sem criação + um aceito; nenhum item vencido foi criado depois do corte;
- zero bloqueio e zero query longa após os vacuums; a única pendência possui `creation_id`, tentativa 1 e próximo polling do provedor às `05:44:48 UTC`.

**Evidência:** vacuum stats, logs `ignored:50/pages:5`, auditoria 104/5 → 0/1, gate do gerador e inspeções de bloqueio.  
**Rollback:** nenhum dado removido pelos vacuums; gerador pode ser parado, claim 313 permanece autoritativa.  
**Última condição segura:** tabelas abaixo do gate, publicador online, não iniciados zerados e somente uma criação já aceita aguardando desfecho.  
**Próxima ação exata:** executar suíte final/TypeScript/build enquanto aguarda o polling aceito; depois exigir zero/zero e `criticalDelay=false` antes de fechar o gate técnico.

#### Gate técnico final após manutenção — 28/08/2026 02:45 BRT / 05:45 UTC

**Estado:** aprovado; observação temporal e comparação de WAL ainda permanecem abertas.

- a última criação já aceita foi reconciliada no polling previsto; auditoria final retornou zero vencido sem criação, zero aceito, zero total devido e `criticalDelay=false`;
- gerador e publicador estão online, PM2 persistido; VPS ~5,4% CPU, 32,2% RAM e I/O baixo;
- o único novo mtime de erro do publicador (`05:41:27 UTC`) corresponde ao `statement_timeout` observado durante o vacuum; não houve repetição após o término;
- suíte da aplicação: 306/306 testes aprovados; suíte focada dos três workers: 47/47; total desta passagem: 353 testes, zero falha/skip/cancelamento;
- `npx tsc --noEmit`, `npm run build` (56 páginas) e `git diff --check` aprovados; warnings de metadata/normalização já existentes não alteram o resultado;
- nenhuma carga sintética, upgrade ou publicação atrasada foi disparada para obter estas evidências.

**Rollback:** backups individuais dos workers e deployments continuam disponíveis; migrations 303–313 são forward-only.  
**Última condição segura:** fila corrente zerada, tabelas críticas saneadas, proteções ativas e validação integral aprovada.  
**Próxima ação exata:** alinhar os estados formais das Fases 0–6 no quadro do plano, medir uma janela pós-correção de WAL/erros/pressão sem provocar carga e listar objetivamente os únicos gates que exigem tempo ou cenário futuro.

#### EXPLAIN revelou gargalo residual do claim — 28/08/2026 02:47 BRT / 05:47 UTC

**Estado:** gate de latência reprovado; correção 314 em preparação.

- amostra pós-correção de WAL: 26.991.304.583 → 26.992.573.839 bytes em 47,687 s, delta 1.269.256 bytes (~1,60 MB/min); serve como baseline pós-correção, mas não prova isoladamente redução de 50% no mesmo cenário;
- Vercel produção não retornou HTTP 500 na consulta da última hora;
- `EXPLAIN (ANALYZE, BUFFERS, WAL)` transacional do claim com limite quatro: 1.107,5 ms, 13.319 buffers hit, 55 reads e 51.762 bytes WAL; acima do gate de 300 ms;
- resumo legado global: 2.577,7 ms e 4.198 buffers hit; acima de 500 ms, porém já removido dos loops e substituído por snapshot assíncrono;
- primeira chamada de preparação foi recusada antes de executar por parâmetros de lease/janela fora do contrato; nenhuma mutation ocorreu;
- inspeção do claim 313 revelou ausência de `archived_at is null`, apesar de toda a fila operacional e índices quentes usarem apenas linhas não arquivadas; isso amplia desnecessariamente o conjunto varrido.

**Rollback:** nenhum dado persistiu nos EXPLAINs transacionais; preparar migration 314 sem aplicar até teste local/dry-run.  
**Última condição segura:** produção continua protegida e online; o claim funciona, mas não atende o gate de latência.  
**Próxima ação exata:** inspecionar índices/contrato remoto, criar migration 314 adicionando o recorte não arquivado e, se necessário, índice parcial exatamente compatível; testar e repetir EXPLAIN antes de qualquer outro rollout.

#### Migration 314 preparada — 28/08/2026 02:51 BRT / 05:51 UTC

**Estado:** validação local/dry-run aprovada; aplicação remota pendente.

- o plano com apenas `archived_at is null` ainda levou 616 ms e filtrou 107.434 linhas futuras, comprovando que o recorte isolado não basta;
- a 314 separa criações já aceitas de itens não iniciados com `union all`, preserva prioridade/fairness por organização e perfil, barreira de 60 s, lease e `skip locked`;
- dois índices parciais compatíveis separam o polling aceito do recorte corrente, evitando filtrar toda a agenda futura em cada claim;
- assinatura e retorno de `claim_publication_items(text, integer, integer)` permanecem inalterados; nenhuma API/worker precisa reiniciar;
- teste SQL possui sete contratos; dry-run mostrou somente `314_bound_publication_claim_candidates.sql`;
- TypeScript e `git diff --check` passaram.

**Arquivos:** `supabase/migrations/314_bound_publication_claim_candidates.sql`, `supabase/tests/314_bound_publication_claim_candidates.test.sql`.  
**Rollback:** migration forward-only restaurando a função 313 e removendo os dois índices somente após confirmar que não são usados; antes da aplicação, basta não executar o push.  
**Última condição segura:** remoto continua em 313, fila online e protegida.  
**Próxima ação exata:** aplicar somente a 314, executar os sete testes remotos e repetir o mesmo EXPLAIN transacional de claim limite quatro.

#### Migration 314 aplicada e gate de latência aprovado — 28/08/2026 02:50 BRT / 05:50 UTC

**Estado:** aprovada em produção; polling de três criações aceitas em observação.

- migration local/remota alinhada em `314 | 314`; sete contratos SQL aprovados;
- mesmo EXPLAIN transacional do claim limite quatro: 1.107,5 → 118,2 ms, melhora de ~89,3% e abaixo do gate de 300 ms; WAL ocioso ficou em 86 bytes;
- preparação correta com limite quatro/lease 180/janela 24 h: 185,0 ms, abaixo do gate de 200 ms;
- snapshot operacional: 4,6 ms, contra 2.577,7 ms do resumo legado; o consumidor crítico usa o snapshot;
- função foi atualizada sem reiniciar worker/API; PM2 permaneceu online, VPS ~6,3% CPU/32,9% RAM e nenhum novo mtime de erro;
- smoke real processou dois itens após a 314; auditoria encontrou zero não iniciado atrasado e três criações aceitas aguardando apenas polling do provedor;
- zero query longa e zero bloqueio.

**Rollback:** forward-only restaurando 313; índices 314 podem permanecer sem alterar semântica durante rollback.  
**Última condição segura:** claim atende latência, nenhum envio atrasado pendente e somente criações aceitas em reconciliação.  
**Próxima ação exata:** aguardar o próximo ciclo dos três aceitos, exigir zero/zero e registrar os gates remanescentes exclusivamente temporais/de carga equivalente.

#### Fechamento da execução imediata — 28/08/2026 02:51 BRT / 05:51 UTC

**Estado:** correções estruturais imediatas aprovadas; observação prolongada continua.

- os três pollings aceitos chegaram a terminal; fila retornou a zero sem criação, zero aceita, zero total devido e `criticalDelay=false`;
- geração/publicação seguem online, nenhum mtime de erro mudou após 314 e VPS ficou em ~7,2% CPU, 33,1% RAM e I/O baixo;
- o trabalho que ainda falta não é uma correção conhecida de código: (1) completar 2–4 h de observação real no Micro, (2) formar amostra suficiente para p95 de atraso corrente, (3) comparar WAL no mesmo cenário e (4) executar carga equivalente a 2.500 perfis em ambiente/execução transacional segura;
- upgrade para Small/2 GB continua explicitamente fora desta execução;
- qualquer nova publicação com mais de 60 s sem `creation_id` continuará sendo marcada `ignored`; criações já aceitas continuam apenas em reconciliação.

**Última condição segura:** schema 314, workers normais online, PM2 salvo, fila/pressão limpas, duas tabelas críticas saneadas e 360 contratos/testes aprovados nesta passagem (353 Node + 7 SQL).  
**Próxima ação exata:** manter observação automatizada dos sinais de produção e registrar no plano somente mudança real, regressão ou aprovação do intervalo; não provocar carga artificial na produção Micro.

#### Observação automatizada preservada — 28/08/2026 02:52 BRT / 05:52 UTC

**Estado:** ativa no mesmo task, a cada 30 minutos durante a janela de quatro horas.

- a automação existente `fechar-rollout-dos-logs-instagram` foi atualizada, sem criar duplicata, para observar primeiro esta estabilização;
- a cada ciclo ela audita fila/pressão, workers/restarts, VPS, bloqueios/queries longas, tuplas mortas, 5xx e WAL quando comparável, sem carga artificial nem upgrade;
- após quatro horas limpas, deve registrar a aprovação temporal e restaurar sua finalidade original de auditorar a Central de Logs às 23:15 BRT;
- regressão preserva rollback e interrompe apenas o consumidor pesado necessário; atrasados continuam sem publicação.

**Próxima ação exata:** primeira leitura automática em 30 minutos; intervenção manual somente se surgir regressão ou quando houver evidência suficiente para fechar um gate.

#### Status visual do horizonte em `/postagem` — 28/08/2026 02:55 BRT / 05:55 UTC

**Estado:** implementação local aprovada; deployment pendente.

- identificado que a tela mostrava diretamente o estado autoritativo `generating`, embora este também represente planos contínuos sem nenhum chunk elegível dentro das próximas 48 horas;
- criado estado operacional aditivo `horizon_ready`, exibido como `Horizonte abastecido`, sem alterar o status persistido, agenda, cursores ou worker;
- a API calcula elegibilidade com a mesma fórmula do worker: `schedule_base_at + (next_slot_index + 1) * interval_minutes <= now + 48 h`;
- o card informa `Próximas 48 horas prontas` e a data da próxima reposição automática;
- polling da tela cai de 4 s para 60 s enquanto todos os planos ativos estiverem somente com horizonte abastecido, reduzindo leitura inútil no banco;
- chunks processando, elegíveis, falhos/exauridos e estados terminais não são mascarados pelo novo rótulo;
- 17/17 testes focados, TypeScript e `git diff --check` aprovados.

**Arquivos:** `lib/publications/bulk-horizon-status.ts`, teste correspondente, API de planos e componente/CSS do progresso.  
**Rollback:** promover deployment anterior ou reverter apenas o campo operacional aditivo; banco e workers não dependem dele.  
**Última condição segura:** alteração somente local; produção ainda mostra `generating`.  
**Próxima ação exata:** executar build, publicar na Vercel, autenticar a resposta da API e confirmar Ggbiel/Laurinha como `horizon_ready` em produção.

#### Status de horizonte validado em produção — 28/08/2026 02:57 BRT / 05:57 UTC

**Estado:** aprovado e ativo.

- build local e build Vercel aprovados; deployment `dpl_3Y352uMGc25nvpsBLUmvSBVgAn59` está `READY` no alias principal;
- validação visual autenticada em `/postagem` confirmou `HORIZONTE ABASTECIDO` nos dois cards, sem erro de console;
- Ggbiel: 13.762/15.960 tratadas, 133 perfis, 102/133 chunks, zero falha e próxima reposição indicada a partir de `28/08 03:31 BRT`;
- Laurinha: 27.996/30.096 tratadas, 209 perfis, 188/209 chunks, zero falha e próxima reposição indicada a partir de `28/08 03:10 BRT`;
- os percentuais continuam representando o plano integral; o rótulo e o rodapé agora deixam explícito que o horizonte imediato está pronto e o restante será reposto automaticamente;
- nenhuma migration, restart de worker ou alteração de dados foi necessária para esta correção visual.

**Rollback:** promover o deployment anterior; contrato é somente aditivo.  
**Última condição segura:** produção mostra o estado correto, agenda intacta e workers independentes da UI.  
**Próxima ação exata:** manter a observação automática; quando o horário de reposição chegar, o card deve mudar temporariamente para `Gerando` e retornar a `Horizonte abastecido` após zerar os chunks elegíveis.

#### Regressão transitória detectada pela observação — 28/08/2026 03:54 BRT / 06:54 UTC

**Estado:** gate temporal reiniciado; proteções atuaram e a fila voltou ao estado seguro sem intervenção manual.

- às `06:47 UTC`, uma nova onda corrente produziu `statement_timeout` em seis itens isolados do publicador; os mtimes dos logs de erro avançaram para geração `06:47:27 UTC` e publicação `06:47:30 UTC`, invalidando a janela limpa iniciada às `05:51 UTC`;
- às `06:53 UTC`, o sinal autoritativo registrou um item vencido desde `06:50:20 UTC`, `criticalDelay=true`; o gerador reduziu automaticamente para 25, aplicou cooldown de aproximadamente 14,5 s e não adquiriu trabalho pesado enquanto o atraso permaneceu;
- às `06:54 UTC`, a fila já havia retornado a zero item devido não terminal, zero criação aceita pendente e `criticalDelay=false`; não houve disparo manual nem publicação atrasada e, como o gate automático já conteve o consumidor pesado, não foi necessário parar o processo no PM2 depois da recuperação;
- banco sem bloqueios e sem queries longas; Vercel sem 5xx na janela consultada; VPS saudável, com ~7,9% CPU, 33,2% RAM, load `0,02/0,11/0,09` e I/O desprezível;
- todos os workers Instagram permaneceram `online`, sem restart durante a ocorrência; `publication_items` está em 14.457 mortas/348.575 (~4,15%) e `publication_batch_terminal_outcomes` em 352/141.485 (~0,25%), ambas abaixo de 10%; WAL alocado permanece em 464 MB, mas esta leitura não fornece cenário comparável para o gate de redução de 50%;
- a geração compacta continuou drenando após a normalização: os planos ativos caíram de nove para três e os chunks elegíveis de 351 para 52; os alertas de planos/chunks antigos permanecem separados desta ocorrência.

**Comandos sem segredos:** auditorias autoritativas de pressão/fila e heartbeats; `pm2 status`, mtimes e métricas da VPS; `supabase inspect db blocking`, `long-running-queries`, `vacuum-stats` e `db-stats`; consulta Vercel 5xx.  
**Rollback/gate preservado:** schema 314 mantido, nenhum upgrade, carga artificial ou alteração de dados; publicação corrente continua com prioridade absoluta.  
**Última condição segura:** `06:54 UTC`, fila corrente vazia, `criticalDelay=false`, banco sem bloqueio/query longa e workers online.  
**Próxima ação exata:** contar uma nova janela limpa de quatro horas a partir de `28/08/2026 03:54 BRT / 06:54 UTC`; repetir os mesmos gates até pelo menos `07:54 BRT / 10:54 UTC` e não aprovar a observação temporal antes disso.

#### Incidente de descarte por capacidade interna — 28/08/2026 03:57 BRT / 06:57 UTC

**Estado:** reprovado; implementação corretiva 315 iniciada.

- três ondas venceram entre `06:31:03` e `06:31:29 UTC`: 469 Reels de `Lexy / 27/08 / Reels`, 189 de `ggIgor/ 28/08 / Reels` e 133 de `27-08 GGBIEL RRELS`, totalizando 791 itens em 26 s e duas organizações;
- somente 91 foram publicados; 700 terminaram `ignored` com tentativa zero, dos quais 690 por `automatic_expired_unstarted_publication` e dez por desconexão Zernio já reconhecida;
- os 791 itens estavam `preparation_status=ready`; portanto mídia/preparação não causaram o descarte;
- a combinação da limpeza 307, barreira de 60 s 313/314 e capacidade instantânea do único publicador converteu backlog interno em perda de postagem; as 91 reivindicadas terminaram entre 84 e 249 s depois do horário, comprovando incoerência da barreira;
- requisito aprovado: até 1.000 perfis podem compartilhar o mesmo horário; o Athena continua autoritativo para repetição/rotação e a Zernio continua recebendo `publishNow`, pois o agendamento remoto rejeita conteúdo idêntico por conta dentro de 24 h;
- invariantes obrigatórias: nenhuma publicação válida vira `ignored` por atraso interno; staging durável antecede o horário; ativação e resultados são em lote; perfil é revalidado imediatamente antes da chamada externa; sinal terminal Zernio continua suspendendo, contendo, removendo no Athena e enfileirando reciclagem remota.

**Implementação decidida:** migration 315 remove o corte temporal do claim e desativa apenas o descarte automático por capacidade; adiciona staging autoritativo com lease separado e RPCs de reservar/ativar/liberar. A VPS persiste envelopes preparados em spool local recuperável, ativa somente os vencidos e executa concorrência limitada, com idempotência por item e reidratação pelo Supabase após perda local.  
**Arquivos/workers previstos:** migration/teste 315; spool e testes; `publication-direct-dispatch.mjs`; `publication-worker.mjs`; somente `athena-publication-worker`.  
**Rollback:** manter backup do publicador e desligar staging por flag; migration é forward-only e pode restaurar o claim 314 sem reativar descarte automático.  
**Última condição segura:** itens históricos permanecem terminais e não serão republicados automaticamente; workers atuais online.  
**Próxima ação exata:** criar migration/teste 315, validar contratos SQL e somente depois integrar o spool local sem tocar em produção.

#### Checklist executável — despacho de até 1.000 perfis no mesmo horário

**Início:** 28/08/2026 04:10 BRT / 07:10 UTC.  
**Estado geral:** em execução; produção permanece no schema 314 enquanto a solução é validada localmente.

- [x] Diagnóstico quantitativo do descarte e causa estrutural registrado.
- [x] Arquitetura aprovada: Athena autoritativo, Zernio `publishNow`, sem transferir repetição para a agenda Zernio.
- [x] Invariantes de segurança registrados: atraso interno não gera `ignored`; itens históricos não são republicados automaticamente.
- [x] Preservação do perfil offline definida: revalidar o estado imediatamente antes do provedor e manter suspensão, contenção Athena e reciclagem Zernio.
- [x] Revisar e fechar a migration 315: staging, ativação idempotente, claim sem corte de 60 s e limpeza manual auditável.
- [x] Criar e aprovar os contratos SQL da migration 315, incluindo perfil offline e proteção contra duplicidade.
- [x] Implementar spool durável e atômico na VPS, sem credenciais e com permissões restritas. _(implementação/teste local; instalação VPS pendente)_
- [x] Implementar pré-carregamento dos envelopes e ativação somente no horário devido.
- [x] Integrar dispatcher concorrente, fairness e recuperação após restart sem duplicar tentativas.
- [x] Garantir em teste que o check online e o fluxo terminal Zernio continuam executando antes/depois da chamada externa, respectivamente.
- [x] Rodar testes Node focados, SQL, TypeScript, build e `git diff --check`.
- [ ] Registrar baseline imediatamente anterior ao rollout e confirmar fila/pressão.
- [x] Parar somente `athena-publication-worker`, salvar estado PM2 e registrar backup/rollback.
- [x] Aplicar migration 315 e validar contratos no Supabase remoto.
- [x] Instalar spool/worker na VPS, validar sintaxe/hash/configuração e reiniciar somente o publicador.
- [ ] Smoke de produção: nenhum descarte automático, perfil offline suspenso, item devido publicado uma única vez.
- [ ] Observar pressão, latência, backlog, erros e reinícios; fechar ou reverter conforme os gates.

**Arquivos previstos:** `supabase/migrations/315_stage_publications_without_internal_discard.sql`, teste SQL 315, `scripts/workers/publication-dispatch-spool.mjs`, seus testes, `publication-direct-dispatch.mjs`, `publication-worker.mjs` e `.env.example`.  
**Rollback disponível:** flag de staging desligada, backup do publicador na VPS e restauração forward-only do claim 314 sem reativar o descarte automático.  
**Última condição segura:** produção em schema 314, worker atual online; nenhuma alteração 315 aplicada remotamente.  
**Próxima ação exata:** preservar no claim 315 a contenção de incidentes `at_risk`, restaurar a limpeza manual explícita da 307 e escrever os testes SQL antes de integrar o worker.

#### Implementação local do staging e spool — 28/08/2026 04:22 BRT / 07:22 UTC

**Estado:** implementação local concluída; validação ampliada em execução; nenhuma alteração de produção.

- a 315 agora reserva somente itens futuros dentro do horizonte, sem tirar tentativa nem mudar status, e ativa apenas após `execute_at`;
- reativação do mesmo lote pelo mesmo worker recupera claims ainda válidos sem incrementar novamente `attempt_count`;
- o claim de contingência aceita backlog interno com mais de 60 s, mas preserva a contenção `publication_slot_risk_incidents` para não recriar slots possivelmente duplicados;
- `automatic_expired_unstarted_publication` foi neutralizado no worker e no banco; a limpeza manual explícita continua paginada e auditada;
- spool local usa um JSON por item, escrita temporária + rename atômico, diretório `0700` e arquivos `0600`; temporários de crash são removidos na inicialização;
- snapshot Zernio contém IDs, dados da mídia e URLs temporárias verificadas, mas não contém token; item Meta é reidratado no vencimento para não persistir credencial;
- o dispatcher ordena o vencimento alternando organizações, ativa até 500 itens e processa inicialmente com concorrência 32;
- o snapshot não concede autorização: `assert_claimed_publication_profile_online` é executado novamente após o claim e também imediatamente antes do provedor; se falso, `suspend_claimed_publication_item` mantém a lógica de queda;
- o tratamento terminal Zernio existente não foi removido: continua chamando `schedule_zernio_profile_disconnection`, seguido da fila de contenção/remoção Athena e reciclagem remota.

**Testes executados:** sintaxe dos três módulos aprovada; 40/40 testes Node focados aprovados, incluindo atomicidade/restart do spool, fairness, descarte automático desativado e suspensão de perfil que caiu depois do staging.  
**Arquivos alterados nesta etapa:** migration/teste 315, testes compatíveis 313/314, spool/teste, dispatcher direto, worker e `.env.example`.  
**Rollback:** staging permanece desligado por padrão; produção continua em 314.  
**Última condição segura:** somente arquivos locais alterados; nenhum worker reiniciado e nenhum schema remoto tocado.  
**Próxima ação exata:** executar validação SQL local/isolada da 315, corrigir qualquer contrato, então rodar toda a suíte Node/TypeScript/build antes do gate de rollout.

#### Validação isolada e janela segura de throughput — 28/08/2026 04:34 BRT / 07:34 UTC

**Estado:** aprovada localmente; rollout ainda não iniciado.

- a migration 315 foi executada integralmente no PostgreSQL remoto dentro de `BEGIN/ROLLBACK`; sintaxe, índices e funções foram aceitos e nenhuma mudança persistiu;
- `supabase migration list --linked` confirmou novamente remoto 314 e local 315 pendente;
- suíte completa: 361/361 testes aprovados; suíte focada após o último ajuste: 42/42; TypeScript, build Next e `git diff --check` aprovados;
- a configuração **interna do Athena** limita Zernio a 200 publicações/minuto por organização; para não lançar 500 reservas concorrentes contra o Micro, o spool seleciona 180/min por organização, deixando margem para reconciliações/fallback. **Correção de 2026-08-29:** esse 200 foi descrito como "autoritativo" da Zernio, o que é falso — a Zernio limita requisições por *team* (60/600/1.200 por minuto conforme o número de contas) e postagem por conta (25/hora, 100/dia no Instagram). Ver [runbook](../docs/vps-worker-runbook.md);
- organizações avançam em paralelo e alternadas; 1.000 perfis de uma organização formam backlog interno durável e são drenados em cerca de seis minutos, em vez de virarem `ignored`;
- a reserva Zernio passa de 300 s para 60 s, alinhada à janela por minuto; continua persistida no banco e impede estouro após restart ou concorrência externa;
- o spool lê até 5.000 vencidos para aplicar fairness antes do recorte, evitando que uma organização com muitos itens esconda as demais.

**Rollback:** staging continua `false` no exemplo e produção não recebeu a 315.  
**Última condição segura:** schema 314, código 315 apenas local, todos os gates locais aprovados.  
**Próxima ação exata:** coletar baseline de fila/pressão e configuração do publicador na VPS, confirmar ausência de onda iminente, então parar somente o publicador para o rollout coordenado.

#### Baseline revelou onda imediata — 28/08/2026 04:22 BRT / 07:22 UTC

**Estado:** rollout compatível em execução; não parar o publicador antes da migration.

- fila futura: 192 itens às 04:25 BRT; 781 às 04:31 (133 em uma organização e 648 em outra); 61 às 04:33; 212 às 04:40;
- o publicador atual está online, PID 205308, zero reinício instável, cwd `/opt/athena-worker`, limite 44, polling 5 s e preparação 4;
- VPS saudável: ~6,8% CPU, 34,9% RAM, load baixo e disco 13%; log de erro não muda desde 06:47:30 UTC;
- decisão segura: não parar o runtime diante da onda; aplicar primeiro a 315, compatível com o worker antigo, para neutralizar o descarte automático e remover o corte de 60 s;
- depois do schema, validar os 16 contratos SQL e somente então instalar/ligar staging com restart curto; durante o intervalo, o worker antigo continua drenando sem transformar atraso interno em `ignored`.

**Rollback:** se a migration falhar, ela é transacional e o schema fica 314; se aplicar e o runtime apresentar regressão, parar somente o publicador preserva o backlog, sem reativar descarte.  
**Última condição segura:** schema 314 e worker online imediatamente antes do push.  
**Próxima ação exata:** executar `supabase db push --linked`, confirmar paridade 315 e rodar o teste SQL 315 remoto.

#### Migration 315 e worker implantados — 28/08/2026 04:24 BRT / 07:24 UTC

**Estado:** ativos; smoke da onda real em andamento.

- migration 315 aplicada em 9,5 s; o worker antigo permaneceu online durante o push e passou a receber imediatamente `automaticDiscardDisabled=true`;
- contratos SQL executados remotamente; a função terminal `schedule_zernio_profile_disconnection` e o check `assert_claimed_publication_profile_online` permanecem no schema;
- três módulos foram copiados primeiro para `/tmp`, tiveram sintaxe Node aprovada e só então foram promovidos;
- parada exclusiva do publicador durou menos de cinco segundos; PID 205308 → 208716, zero restart instável e PM2 salvo;
- backup: sufixo `.before-315-20260828T072449Z` nos dois workers anteriores e no `.env.worker`;
- hashes implantados: worker `ac25d8aa...d66111`, dispatcher `8ade8c13...6ea4`, spool `8fec60a7...9fcd`;
- spool `/var/lib/athena-publication-spool` com permissão 0700 e staging ativado em 250/4, janela 10 min, dispatch 500/32 e limite local 180/min/organização;
- primeira evidência: 500 leases de staging formados, 0 novo `automatic_expired_unstarted_publication` e log de erro sem mudança desde 06:47:30 UTC;
- onda 04:25: 138/192 já possuíam `creation_id` na primeira leitura durante o processamento; os demais permaneciam waiting/preparing, não `ignored`.

**Rollback:** backups citados; staging pode ser desligado pela variável, e parar somente o publicador preserva o backlog no schema 315.  
**Última condição segura:** schema/runtime 315 alinhados, publicador online, descarte automático zerado e spool avançando.  
**Próxima ação exata:** acompanhar a onda 04:25 até terminal e confirmar que o staging alcança as ondas 04:31/04:33 antes do vencimento, sem novo erro ou pressão do banco.

#### Primeiro smoke real aprovado — 28/08/2026 04:29 BRT / 07:29 UTC

**Estado:** onda 04:25 preservada; onda 04:31 integralmente preparada no escopo válido.

- 192/192 itens da onda 04:25 receberam `creation_id` Zernio; 0 `ignored`; as confirmações finais continuam pelo polling normal;
- os 12 que excederam a janela local inicial não foram perdidos: permaneceram duráveis e avançaram no ciclo seguinte;
- onda nominal 04:31 contém 791 linhas, mas dez já estavam terminalmente `ignored` por `zernio_account_disconnected`, decididas entre 27/08 10:02 BRT e 28/08 02:31 BRT;
- todos os 781 itens válidos restantes (133 de uma organização e 648 de outra) estão com lease de staging e snapshot no spool antes do horário;
- isso confirma a regra solicitada: queda real de perfil continua removendo/suspendendo; capacidade interna não produz mais o mesmo estado;
- zero novo `automatic_expired_unstarted_publication`, zero query longa e log de erro inalterado.

**Última condição segura:** primeira onda aceita integralmente; segunda onda válida 100% preparada.  
**Próxima ação exata:** observar a ativação 04:31 com limite 180/min/organização, medir aceitos/publicados/erros e confirmar que o remanescente fica waiting/staged, nunca ignored.

#### Escopo transferido para plano próprio — 28/08/2026 04:37 BRT / 07:37 UTC

**Estado:** acompanhamento desta frente encerrado neste documento para evitar mistura com upgrade/estabilização geral.

Toda a continuação do despacho de até 1.000 perfis, spool, fairness, sequência dos loops e preservação de perfis caídos passa a ser registrada exclusivamente em `plans/plano-despacho-instagram-1000-perfis-sem-descarte-2026-08-28.md`. O novo documento contém o ponto exato da pausa, produção versus código local, desenho final, fases, gates e rollback.

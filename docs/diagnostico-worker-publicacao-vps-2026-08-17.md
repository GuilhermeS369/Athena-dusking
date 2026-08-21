# Diagnóstico operacional — worker de publicação na VPS

**Data da inspeção:** 2026-08-17 (UTC)  
**Escopo:** somente leitura. Nenhuma variável, processo PM2, código ou configuração da VPS foi alterada.

## Resumo executivo

O Athena possui uma fila durável no Supabase e um worker publicador direto na VPS. O fluxo não é serial: o processo publicador reivindica e processa vários itens em paralelo. No instante da inspeção, a configuração efetiva era:

- um processo PM2 publicador: `athena-publication-worker`;
- modo `direct`, com `dry_run=false`;
- `PUBLICATION_WORKER_LIMIT=44`;
- polling de 5 segundos depois de completar cada ciclo;
- lease de 180 segundos;
- limite interno default de 5 requisições HTTP simultâneas para a API da Meta;
- 11.440 publicações futuras em `waiting`, sem leases expirados, retentativas vencidas ou atrasos.

O health agregado respondeu `ok`, com quatro workers ativos, zero stale e zero erros registrados pelo health.

## Processos reais em execução

O PM2 tinha cinco processos online:

| Processo | Responsabilidade | Publica itens da fila? |
| --- | --- | --- |
| `athena-publication-worker` | Claim, preparação, publicação e retry da fila | Sim |
| `athena-generation-worker` | Materialização de planos/agendamentos grandes em chunks | Não |
| `athena-media-maintenance-worker` | Exclusão e organização assíncrona de mídias | Não |
| `athena-profile-analytics-worker` | Atualização de analytics de perfis | Não |
| `athena-zernio-sync-worker` | Sincronização de contas Zernio | Não |

Há somente **um processo publicador** neste momento. Os outros processos evitam que geração, mídia, analytics e sincronização bloqueiem a publicação, mas não aumentam a concorrência de postagem.

## Concorrência efetiva de publicação

Em um ciclo, o worker solicita ao banco até 44 itens. Os itens efetivamente reivindicados são processados juntos com `Promise.allSettled`, portanto não há espera intencional de um item terminar para começar o seguinte.

Para um pico de 100 itens vencendo no mesmo minuto, na ausência de outros guardrails, a distribuição de claims é:

1. primeira onda: até 44 itens;
2. segunda onda: até 44 itens;
3. terceira onda: até 12 itens.

O próximo claim só ocorre quando a onda atual termina e o loop aguarda o intervalo de polling. Assim, `PUBLICATION_WORKER_LIMIT` é o teto de itens simultâneos por ciclo, e não uma garantia de que cada fase externa receberá 44 chamadas simultâneas.

## O que são as cinco requisições Meta simultâneas

`PUBLICATION_WORKER_META_CONCURRENCY` controla somente as chamadas HTTP realizadas contra a Graph API da Meta pelo processo Node. Como a variável não está definida na VPS, o código aplica o valor default **5**.

Exemplo com 44 Reels Meta no mesmo ciclo:

- os 44 itens podem estar sendo preparados em paralelo (consulta ao banco, leitura de mídia, verificação de perfil, reservas e estados);
- quando precisam chamar a Meta — criar container, consultar status de container ou publicar — no máximo 5 chamadas HTTP à Meta ficam em voo ao mesmo tempo;
- a sexta chamada aguarda uma das cinco anteriores terminar;
- isso não reduz o claim para cinco itens, apenas limita a pressão contra a API externa.

Esse limitador é por processo. Se futuramente existirem dois processos publicadores, cada processo terá seu próprio limite de 5, perfazendo até 10 chamadas Meta simultâneas, salvo uma coordenação adicional. As quotas transacionais de publicação por organização/provedor continuam compartilhadas pelo banco.

## Guardrails de justiça e limites

O claim usa `FOR UPDATE SKIP LOCKED`, então processos diferentes não podem obter lease do mesmo item. A seleção também usa round-robin por organização: a primeira publicação elegível de cada organização entra antes da segunda de qualquer organização. Isso evita que uma única organização drene todas as vagas do ciclo.

Antes da publicação final, o worker reserva capacidade no banco. Os defaults globais observados são:

| Regra | Default |
| --- | ---: |
| Publicações por organização/provedor por minuto | 50 |
| Publicações por organização/provedor por hora | 3.000 |
| Publicações por organização/provedor por dia | 72.000 |
| Publicações por perfil em 24 horas | 100 |
| Intervalo mínimo entre posts do mesmo perfil | 45 segundos |

Logo, 100 itens para a mesma organização e o mesmo provedor no mesmo minuto não devem disparar todos para o provedor: depois da capacidade permitida, os restantes são devolvidos para `waiting` com próximo horário de tentativa. Isso é uma proteção de fornecedor e não uma limitação da CPU da VPS.

## Por que o uso de CPU da VPS está baixo

O uso baixo é esperado e é positivo. O processo é predominantemente I/O-bound: ele passa boa parte do tempo aguardando Supabase, Storage, Meta e Zernio responderem. Não há transcodificação de vídeo, download de mídia final para processamento local ou banco local pesado nessa VPS.

Na inspeção, a máquina de 1 vCPU/3,8 GiB apresentava carga média de 0,04, cerca de 3,0 GiB de memória disponível e 8% de disco utilizado. Baixa CPU não prova capacidade ilimitada: os limites reais podem surgir em latência dos provedores, rate limits, conexões HTTP, uso de memória no pico, tempo de ciclo e taxa de falhas externas.

## Erros: estado atual e lacuna de report

O sistema já persiste estados, eventos de worker, retries, leases e health agregado. O health da inspeção retornou zero erros e zero itens atrasados. Porém, isso **não é suficiente como reporte operacional de erro para uma operação de alto volume**.

Também foram encontrados registros no log histórico de falhas isoladas em recuperação de mídia de Reels via Zernio. O código implantado contém proteção para mídia ausente, e o health atual não acusa erro; ainda assim, o histórico precisa ser consolidado em relatório para diferenciar erro antigo, recorrente e resolvido.

## Relatório operacional mínimo a implementar no painel

Sem alterar a VPS, o relatório deve ser construído sobre dados já duráveis no Supabase e atualizado no painel. Cada período (últimos 15 min, 1 h, 24 h e intervalo escolhido) deve apresentar:

1. **Vazão:** publicados, falhados, removidos, adiados e tentativas totais.
2. **Atraso:** atraso médio e máximo contra `execute_at`, itens overdue e tempo de drenagem estimado do backlog.
3. **Erros agrupados:** provedor, código, mensagem normalizada, quantidade, primeiro/último evento, organizações e perfis afetados.
4. **Retentativas e leases:** itens em retry, retries vencidos, leases expirados, itens em `preparing`/`publishing` há tempo excessivo.
5. **Rate limit/fairness:** quantidade de adiamentos por `profile_min_interval`, limite de 24 h do perfil e quotas por minuto/hora/dia do provedor.
6. **Worker:** último heartbeat, duração dos ciclos, itens claimed/processados por ciclo, distribuição de resultados, reinícios PM2 e uso de CPU/memória.
7. **Alertas acionáveis:** aumento de falhas, atraso máximo acima da meta, backlog crescendo por três janelas, worker stale, taxa de retry alta e erro externo recorrente.

O relatório deve separar Meta e Zernio, pois suas etapas e modos de falha são diferentes. Ele deve manter links/IDs para a fila filtrada, sem carregar milhares de itens diretamente na tela.

## Critérios antes de aumentar capacidade

Antes de subir `PUBLICATION_WORKER_LIMIT`, `PUBLICATION_WORKER_META_CONCURRENCY` ou criar outro processo publicador, medir por uma janela representativa:

- tempo p50/p95/p99 de ciclo e de publicação;
- throughput concluído por minuto/hora;
- atraso máximo no pico;
- percentuais de sucesso, falha e adiamento;
- respostas 429/5xx/timeouts por provedor;
- consumo de memória no pico;
- leases expirados e duplicidade (esperado: zero).

Uma alteração segura de capacidade depende desses dados e deve ser incremental. Nenhuma alteração de VPS é parte deste diagnóstico.

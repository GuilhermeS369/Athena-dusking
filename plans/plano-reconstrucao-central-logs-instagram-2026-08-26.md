# Plano de reconstrução da Central de Logs do Instagram

**Status:** Fases 0–7A concluídas e publicadas; Fase 7B em observação de 24 horas desde `28/08/2026 02:10:03 UTC` (`27/08/2026 23:10:03 BRT`); Fase 8 bloqueada e rollback preservado  
**Escopo:** `/operacao`, funções de observabilidade, integração com workers e retenção dos dados de log  
**Data do levantamento:** 26/08/2026  
**Estado do rollout em 26/08/2026:** fases 0–6 concluídas; fase 7 em observação real de 24 horas; fase 8 preservada para depois desse gate. Banco, produtores completos, backfill, APIs, central web, telemetria própria e retenção automática estão ativos. Nenhum worker de publicação teve comportamento, concorrência ou processo alterado.

## 1. Resultado esperado

Substituir a tela atual por uma central de observabilidade única, rápida e realmente operacional para todo o Instagram, cobrindo Meta oficial e Zernio. As páginas separadas de **Quedas Zernio** e **Histórico de adições** deixam de ser destinos independentes e passam a ser recortes da mesma experiência em `/operacao`.

A nova central deve:

- abrir com rapidez mesmo em uma organização com 2.500 perfis;
- mostrar primeiro o que exige ação humana;
- separar falha sem proteção, falha em recuperação automática, problema contido e problema já resolvido;
- agrupar milhares de ocorrências repetidas em incidentes compreensíveis;
- permitir investigação por perfil, conexão, worker, publicação, lote, código e correlação;
- mostrar o estado atual dos workers sem transformar cada ciclo saudável em uma linha de log;
- reter somente 14 dias de observabilidade bruta;
- nunca apagar ou confundir dados autoritativos da fila, publicações, saldos, perfis ou tentativas ainda necessárias para idempotência;
- remover botões decorativos ou sem contrato funcional e exibir somente ações que o backend realmente permite executar naquele estado;
- funcionar bem em desktop e celular, com CSS próprio, responsivo e visualmente mais leve que a tela atual.

O objetivo não é copiar a tela do Twitter literalmente. A arquitetura boa do Twitter será reaproveitada — incidentes agrupados, filtros no servidor, paginação por cursor, drawer de detalhes, códigos estáveis e evidências sanitizadas — mas a taxonomia, a retenção e as contramedidas serão próprias do Instagram.

### 1.1 Reconstrução limpa, sem reaproveitar a tela atual

A implementação será um módulo novo. A tela existente será usada somente para inventariar regras, dados e operações que não podem desaparecer. Não serão copiados como fundação:

- componentes ou estrutura visual de `OperationClient`;
- consultas do Server Component atual;
- contadores montados no cliente;
- funções atuais de limpar/ocultar logs;
- APIs paginadas atuais de eventos e itens com atenção;
- CSS operacional atual;
- separação entre Operação, Quedas Zernio e Adições Zernio.

Os motores autoritativos de publicação, retry, cancelamento, conexão e recuperação não devem ser reescritos sem necessidade, pois possuem garantias transacionais próprias. A central nova, porém, terá contratos, APIs, banco de observabilidade, componentes e CSS novos. Ela poderá solicitar uma operação autoritativa existente depois de validar papel e estado, mas não reutilizará a lógica da tela de logs antiga.

## 2. Diagnóstico do que existe hoje

### 2.1 Fragmentação da experiência

Hoje a operação está dividida entre:

- `/operacao` para fila, perfis, conexões, workers, alertas, telemetria e eventos;
- `/operacao/quedas-zernio` para conflitos, desconexões, duplicidades, reciclagem e remoções;
- `/operacao/adicoes-zernio` para tentativas de adição de contas;
- `/queue`, `/perfis` e `/zernio` para completar várias ações iniciadas nos logs.

Além de obrigar o operador a trocar de página, essa divisão cria semânticas inconsistentes. Em `/operacao`, “Limpar logs” apenas oculta registros para o usuário. Em “Quedas Zernio”, “Limpar logs” executa exclusão real de conflitos e não pode ser desfeito.

### 2.2 Carregamento inicial excessivo e frágil

A rota atual carrega, antes de renderizar a tela:

- todos os perfis ativos da organização;
- todas as conexões Zernio;
- itens de publicação com atenção;
- eventos de publicação;
- saúde e resumo da fila;
- riscos de slots;
- para o superusuário, workers, jobs, alertas, throughput, ciclos e telemetria agregada.

Quase todas essas fontes fazem parte de um contrato tudo-ou-nada: a falha de uma consulta derruba a tela inteira. Somente uma telemetria recente recebeu fallback isolado.

Com 2.500 perfis, não é aceitável enviar toda a lista de perfis no primeiro payload apenas para preencher buscas, contar estados e enriquecer linhas no navegador. Perfil e conexão precisam ser resolvidos pelo servidor somente para a página visível, e os seletores precisam usar busca assíncrona.

### 2.3 Contadores e buscas incompletos

O contador de “problemas críticos” mistura:

- os itens com falha presentes na página carregada, inicialmente limitada a 40;
- todos os perfis offline/reautorização;
- conexões Zernio com erro;
- alertas agregados;
- slots em risco.

Isso combina universos diferentes e pode apresentar um total parcial como se fosse exato. A busca de eventos por perfil também filtra apenas os registros já carregados no browser, não o histórico completo da janela.

Na reconstrução, todos os KPIs e filtros devem ser calculados no banco sobre o mesmo escopo, sem depender do número de linhas que o usuário já carregou.

### 2.4 Excesso visual sem hierarquia operacional

A tela atual coloca até oito métricas e uma longa sequência de cards antes da lista principal. Alertas, throughput, saúde da fila, travamentos, workers, jobs, slots, ciclos, capacidade e erros competem pela mesma atenção.

O resultado é uma página extensa em que:

- um erro que já possui retry automático parece tão grave quanto um erro terminal;
- estado atual e histórico ficam misturados;
- métricas globais e incidentes da organização aparecem juntos;
- as mesmas informações reaparecem em cards, itens com atenção e eventos;
- o operador demora para descobrir “o que preciso fazer agora?”.

### 2.5 Crescimento já comprovado

O retrato local de estatísticas do banco, coletado em 21/08/2026, já mostra:

| Tabela | Linhas estimadas | Tamanho total aproximado |
|---|---:|---:|
| `publication_item_events` | 186.373 | 92 MB |
| `publication_worker_cycle_events` | 181.409 | 131 MB |
| `publication_items` | 92.051 | 100 MB |
| `zernio_publication_request_rollups` | 28.925 | 15 MB |
| `zernio_sync_log_items` | 312 no retrato mais recente; 7.586 no anterior | 2,8 MB |
| `zernio_profile_disconnection_incidents` | 589 | 776 kB |

Os ciclos de worker são o exemplo mais claro do problema: gravar linhas para `started` e `completed` em todo ciclo saudável gerou mais espaço que o histórico individual de publicações. Para escalar, a central deve gravar detalhes somente quando há valor investigativo e usar rollups para o funcionamento normal.

### 2.6 Fontes atuais que precisam ser consolidadas

A central nova deve projetar, sem consultas soltas no cliente, eventos vindos de:

- `publication_items` e `publication_item_events`;
- `publication_worker_heartbeats` e `publication_worker_cycle_events`;
- jobs de geração, mídia, grupos e analytics;
- `zernio_connection_attempts`;
- `zernio_sync_log_items`;
- `zernio_profile_disconnection_incidents` e `zernio_profile_recycling_jobs`;
- `zernio_publication_request_rollups` e `zernio_publication_request_anomalies`;
- estados de `instagram_profiles` e `zernio_connections`;
- circuit breakers, leases, retries, suspensões, recuperações de horário e fallback VPS/Vercel.

Essas tabelas continuam sendo fontes autoritativas durante a migração. A nova central recebe uma projeção sanitizada e otimizada; ela não passa a editar diretamente cada tabela de origem.

## 3. Princípios da reconstrução

1. **Atenção antes de atividade.** A primeira aba mostra incidentes ativos agrupados, não uma timeline infinita.
2. **Estado atual separado de histórico.** Heartbeat, backlog e breakers são estado atual; ocorrências são histórico; throughput é métrica agregada.
3. **Contramedida é parte do dado.** Retry, backoff, lease, suspensão, fallback e reciclagem não serão inferidos apenas pela cor da mensagem.
4. **Um problema repetido não vira mil cards.** Ocorrências com a mesma assinatura viram um incidente com contagem, perfis afetados e última ocorrência.
5. **Detalhe sob demanda.** O primeiro carregamento entrega resumo e primeira página. Evidências, ocorrências e entidades relacionadas abrem no drawer.
6. **Paginação sempre no servidor.** Nenhuma lista operacional dependerá de carregar todos os perfis, conexões ou logs.
7. **Retenção limitada e verificável.** APIs nunca retornam mais de 14 dias, e uma manutenção diária remove os dados expirados.
8. **Dados sensíveis nunca entram no log.** Sem tokens, chaves Zernio, URLs assinadas, mídia, legendas, payloads completos, cookies ou headers de autorização.
9. **Ação só aparece quando existe contrato.** O backend informa `availableActions`; a interface não adivinha se retry, cancelamento, reconexão ou remoção estão disponíveis.
10. **Falha parcial não derruba a central.** Resumo, lista ativa, worker status e detalhe possuem carregamento e erro independentes.

## 4. Arquitetura de informação da nova tela

### 4.1 Cabeçalho compacto

O topo terá somente:

- nome da organização e título **Central de Logs do Instagram**;
- estado geral: `Saudável`, `Atenção`, `Degradado` ou `Crítico`;
- horário da última atualização;
- botão funcional **Atualizar**;
- atalho discreto para Fila, Perfis e Zernio, sem ocupar a hierarquia principal.

### 4.2 KPIs principais

Usar no máximo cinco cards:

1. **Exigem ação** — incidentes cuja contramedida terminou, falhou ou requer decisão humana;
2. **Em recuperação automática** — retries, backoff, lease recovery, reciclagem ou fallback em andamento;
3. **Perfis afetados** — perfis únicos em incidentes ativos;
4. **Workers** — ativos/esperados, com destaque se algum serviço obrigatório estiver stale;
5. **Eventos nas últimas 24h** — volume agregado, sem contar linhas no cliente.

Os KPIs sempre vêm de uma RPC/resumo próprio e compartilham a mesma definição usada nas abas.

### 4.3 Abas

| Aba | Conteúdo |
|---|---|
| **Atenção** | Incidentes ativos agrupados por assinatura e ordenados por impacto, necessidade de ação e recência |
| **Contas e quedas** | Perfis offline, auth expirada, desconexões Meta/Zernio, duplicidades, reciclagem e histórico de adição |
| **Postagens e fila** | Falhas, retries, atrasos, leases, slots coletivos, suspensões, rate limit e desfechos de publicação |
| **Workers e jobs** | Estado atual de publicação, geração, mídia, analytics e sincronia; backlog e ciclos anormais |
| **Integrações** | Zernio e Meta: conexão, sync, callbacks, requests anômalos, inventário e breakers |
| **Analytics e mídia** | Falhas de coleta, jobs V2, mídia apagada, preparação, downloads e manutenção |
| **Toda a atividade** | Timeline paginada da janela selecionada, incluindo eventos informativos úteis |

“Quedas Zernio” passa a ser um filtro da aba **Contas e quedas**. “Histórico de adições Zernio” passa a ser um filtro `tipo=adição` na mesma central. As rotas antigas devem redirecionar para os filtros correspondentes para não quebrar favoritos.

### 4.4 Barra de filtros

Os filtros ficam em uma única barra sticky abaixo das abas:

- busca por `@perfil`, nome de exibição, mensagem, código estável, request ID, post ID ou correlation ID;
- severidade;
- tratamento: `exige ação`, `investigando`, `recuperação automática`, `contido`, `resolvido`;
- perfil com autocomplete remoto;
- formato de publicação: Story, Reel, imagem ou carrossel;
- estado da publicação: agendada, preparando, publicando, publicada, retry, suspensa, cancelada ou falhou;
- provedor: Meta oficial ou Zernio;
- conexão Zernio com autocomplete remoto;
- lote/programação de origem quando aplicável;
- worker/tipo de job quando a aba permitir;
- período: 24 horas, 7 dias ou 14 dias;
- botão **Limpar filtros**.

Filtros ficam na URL para permitir atualizar a página, copiar o link e voltar ao mesmo recorte. Busca textual terá debounce curto e será executada no servidor.

### 4.4.1 Visão focada em um perfil

Selecionar um perfil pela busca global abre um modo focado, sem limitar a investigação a uma única categoria. O cabeçalho mostra `@username`, nome de exibição, provedor, conexão e saúde atual. Abaixo dele, o operador pode alternar entre:

- todas as atividades do perfil;
- somente publicações;
- somente problemas;
- contas/conexões;
- analytics e mídia.

O filtro de formato continua disponível dentro dessa visão. Assim, é possível pesquisar pelo `@` ou nome, selecionar **Story** e ver apenas os Stories daquele perfil dentro dos últimos 14 dias.

### 4.4.2 Caso obrigatório: Story esperado e não encontrado

A central deve responder sem depender de investigação manual externa:

1. se existia um Story agendado;
2. qual lote/programação o criou;
3. para qual horário ele estava previsto;
4. se chegou a ser reivindicado por um worker;
5. se a mídia foi preparada/baixada;
6. se houve chamada à Meta ou Zernio;
7. se o provedor aceitou, rejeitou ou deixou o resultado incerto;
8. se houve retry, backoff, suspensão, cancelamento ou recuperação;
9. qual foi o erro e qual ação é possível agora;
10. se o sistema registrou publicação com sucesso, mesmo que o Story já tenha expirado após 24 horas no Instagram.

Cada publicação terá uma timeline correlacionada:

```text
Agendado → elegível → claimed → mídia preparada → enviado ao provedor
→ confirmado/publicado | retry | suspenso | cancelado | falha terminal | resultado incerto
```

Também é necessário detectar ausência de evento, não apenas erros explícitos. Se um Story deveria existir mas não houver item de fila, claim ou desfecho depois da tolerância configurada, a central cria um incidente estável como:

- `expected_publication_not_materialized` — programação esperada não virou item;
- `publication_not_claimed_in_window` — item venceu sem claim;
- `publication_outcome_missing` — processamento começou, mas não há desfecho confiável;
- `provider_success_not_confirmed` — chamada externa pode ter ocorrido, mas a confirmação local está ausente.

Isso evita que um crash antes da gravação da falha deixe a tela silenciosa. Se não existia nenhum Story agendado, a tela deve dizer claramente **“Nenhum Story foi programado para este perfil neste período”**, em vez de sugerir que houve erro.

O resultado desta jornada é um requisito de aceite prioritário, não apenas uma combinação ocasional de filtros.

### 4.4.3 Visão por grupo de perfis

A busca global também terá autocomplete remoto por nome de grupo. Selecionar um grupo abre uma visão focada que permite combinar:

- grupo + formato Story, Reel, imagem ou carrossel;
- grupo + estado da publicação;
- grupo + somente problemas ou toda a atividade;
- grupo + provedor;
- grupo + período de 24 horas, 7 dias ou 14 dias;
- grupo + lote/programação de origem.

O resumo do grupo mostra:

- quantidade de perfis no escopo;
- perfis afetados por incidentes ativos;
- publicações esperadas, publicadas, em recuperação e com ação necessária;
- incidentes mais frequentes;
- formatos mais afetados;
- timeline paginada e filtrada no servidor.

Ao abrir um incidente, o drawer lista quais perfis daquele grupo foram afetados e permite descer para a visão individual de cada perfil.

Existem dois conceitos distintos e ambos devem aparecer claramente:

1. **Grupo atual do perfil:** usa a associação atual para responder “como está este grupo agora?”. Eventos recentes do perfil acompanham o grupo atual para investigação operacional.
2. **Grupo de origem da programação:** usa a referência/snapshot do lote quando a publicação foi criada a partir de um grupo, preservando “de qual programação em grupo este item veio?”, mesmo que o perfil mude de grupo depois.

O filtro é resolvido no banco por associação/indexação; a interface nunca recebe todos os membros do grupo apenas para filtrar no navegador.

### 4.5 Lista de incidentes

Cada linha de incidente mostra somente:

- severidade e estado de tratamento;
- título humano;
- domínio, etapa e código estável;
- quantidade de ocorrências;
- perfis afetados;
- primeira e última ocorrência;
- contramedida atual, quando existir.

Exemplo de leitura visual:

```text
[ERRO] Publicação recusada pela Zernio
publication · publish · zernio_timeout
183 ocorrências · 41 perfis · última há 2 min
[RECUPERAÇÃO AUTOMÁTICA] retry 2/5 · próxima tentativa 14:32
```

Clicar na linha abre um drawer lateral, sem trocar de página.

### 4.6 Drawer de investigação

O drawer terá:

- resumo do incidente;
- impacto e entidades afetadas;
- explicação da contramedida;
- ocorrências individuais paginadas;
- IDs técnicos copiáveis;
- evidências sanitizadas recolhidas em `<details>`;
- histórico de tratamento humano;
- ações disponíveis naquele momento.

As ocorrências não devem despejar JSON aberto na tela. Evidências técnicas ficam recolhidas por padrão e limitadas em tamanho.

### 4.7 Aba de workers

A tela deve conhecer os workers **esperados**, não apenas listar quem já enviou heartbeat. O catálogo inicial é:

- publicação;
- geração/planner;
- manutenção de mídia e grupos;
- analytics direto/V2;
- sincronia Zernio;
- manutenção da própria observabilidade, se aprovada.

Para cada worker lógico:

- estado atual e modo (`live`, `observe`, `dry-run`, fallback);
- último heartbeat e limite de stale configurado;
- versão/deploy;
- throughput recente;
- backlog relacionado;
- último erro relevante;
- breaker/fallback associado;
- réplica ativa, sem contar PIDs antigos como novos workers.

Ciclos saudáveis alimentam rollups. A timeline recebe apenas mudança de estado, ciclo lento acima do limite, falha, recuperação, início/parada de instância ou alteração de modo.

## 5. Linguagem visual para erros e contramedidas

Severidade e tratamento serão conceitos diferentes.

### 5.1 Severidade: qual foi o impacto?

| Severidade | Uso visual | Exemplo |
|---|---|---|
| `critical` | vermelho forte | resultado externo incerto, risco de duplicação/cobrança, worker obrigatório indisponível sem fallback |
| `error` | vermelho controlado | falha terminal de publicação ou conexão |
| `warning` | âmbar | rate limit, atraso, retry ou degradação |
| `info` | neutro/azul | publicação concluída, sync concluído, mudança normal de estado |

### 5.2 Tratamento: o que o sistema está fazendo?

| Tratamento | Cor/ícone | Significado |
|---|---|---|
| `action_required` | vermelho, ícone de ação | não existe recuperação restante ou é necessária decisão humana |
| `investigating` | roxo | operador assumiu o incidente |
| `auto_recovering` | âmbar/azul, animação sutil respeitando reduced motion | retry, backoff, lease recovery, fallback ou reciclagem em andamento |
| `contained` | azul/verde | proteção evitou propagação: fila suspensa, breaker aberto, item isolado |
| `resolved` | verde discreto | recuperação confirmada ou tratamento humano concluído |

Um evento pode ser `error` e ao mesmo tempo `auto_recovering`. Nesse caso, ele não entra no KPI vermelho “Exigem ação”; aparece no KPI âmbar e informa a próxima tentativa. Se todas as tentativas acabarem, o mesmo incidente muda para `action_required`.

### 5.3 Contramedidas que devem ficar explícitas

- retry com tentativa atual, máximo e próxima execução;
- backoff por rate limit;
- lease expirado que pode ser retomado;
- recuperação única de horário perdido;
- suspensão segura de publicações quando o perfil fica offline;
- circuit breaker aberto e condição para reabrir;
- fallback da Vercel armado ou ativo quando o worker VPS fica stale;
- reciclagem/remoção Zernio agendada, adiada ou em dead-letter;
- conflito preservado sem sobrescrever o perfil canônico;
- mídia preparada em cache e retry do mesmo post;
- erro terminal que exige reconexão, security check ou ação manual.

## 6. Modelo de dados proposto

Os nomes finais podem ser ajustados na implementação, mas os contratos devem permanecer separados.

### 6.1 `instagram_observability_events`

Eventos imutáveis e investigáveis, particionados por dia:

- `id`, `occurred_at`, `organization_id`;
- `domain`, `severity`, `treatment_state`, `stage`, `event_type`, `stable_code`;
- referências opcionais: perfil, conexão, lote, publicação, job, tentativa e incidente;
- `worker_kind`, `worker_name` lógico e `worker_id` técnico;
- HTTP, provider code, request ID, post ID e correlation ID;
- `source_type` + `source_id` para idempotência;
- mensagem curta normalizada;
- `countermeasure` JSONB pequeno e validado;
- `evidence` JSONB sanitizado e limitado.

Partições diárias permitem remover dias expirados sem grandes `DELETE`s sobre a janela quente. Deve existir uma partição default como proteção e criação antecipada das próximas partições.

### 6.2 `instagram_observability_incidents`

Resumo mutável do problema agrupado:

- fingerprint versionado;
- domínio, etapa, código estável, provedor e tipo lógico de worker;
- severidade máxima atual;
- tratamento atual;
- primeira/última ocorrência;
- contagem total e perfis afetados;
- contagem de reaberturas;
- timestamps e autor de investigação/resolução;
- justificativa e referência da correção.

A fingerprint não deve conter profile ID, connection ID, item ID nem PID. Ela agrupa o mesmo tipo de problema entre entidades. A assinatura recomendada é:

```text
versão + domínio + etapa + código estável + provedor + classe HTTP + tipo lógico do worker
```

### 6.3 Entidades e estado por incidente

Tabelas compactas ligam o incidente a perfis, conexões, lotes, itens e jobs. Cada entidade mantém `active`, `recovering`, `contained` ou `resolved`.

Isso evita marcar um incidente inteiro como resolvido porque um dos 41 perfis se recuperou. A resolução automática acontece somente quando não restar entidade ativa e uma recuperação correlacionada tiver sido registrada.

### 6.4 `instagram_observability_incident_actions`

Auditoria imutável de mudanças humanas:

- status anterior e novo;
- justificativa obrigatória;
- referência de correção;
- usuário e data.

Marcar incidente como resolvido não executa retry, não chama Meta/Zernio e não altera saldo. Ação operacional e tratamento do incidente são contratos separados.

### 6.5 `instagram_observability_rollups_5m`

Rollups de cinco minutos por organização, domínio, provedor, operação e resultado:

- total de eventos/requests;
- sucessos, falhas, retries, adiamentos e recuperações;
- duração e lag p50/p95/p99;
- perfis únicos aproximados ou calculados por janela adequada;
- backlog e throughput observados.

Essa tabela alimenta KPIs e gráficos pequenos. Ela não guarda listas de IDs nem payloads por postagem.

### 6.6 Catálogo de códigos e contramedidas

Criar um catálogo versionado no código, com seed/validação no banco, contendo:

- código estável;
- título humano;
- severidade padrão;
- tratamento padrão;
- se é retryable;
- contramedida esperada;
- se exige ação do usuário, operador ou sistema;
- texto curto de orientação;
- documentação/runbook opcional.

Eventos desconhecidos continuam sendo registrados como `unknown_error`, mas entram em uma validação que impede o crescimento silencioso de mensagens sem código estável.

### 6.7 Estado atual de workers

O heartbeat deve continuar como upsert de uma linha por worker lógico. É necessário adicionar ou derivar:

- nome lógico estável;
- papel esperado;
- modo atual;
- versão;
- escopo global ou organizacional;
- instante do último trabalho e do último heartbeat;
- backlog observado;
- erro atual sanitizado;
- réplica/host/PID apenas para o superusuário.

O parâmetro de organização do resumo atual não restringe os heartbeats globais. A nova API deve assumir isso explicitamente: membros comuns veem o impacto sanitizado sobre sua organização; infraestrutura global, host e PID permanecem exclusivos do superusuário.

## 7. Ingestão e normalização dos logs

### 7.1 Uma entrada comum

Criar uma função/RPC única para registrar observabilidade. Ela deve:

- exigir `service_role` para eventos de sistema;
- validar organização e referências;
- normalizar etapa, tipo e código;
- sanitizar mensagem e evidências também no banco;
- limitar tamanhos;
- deduplicar por origem;
- criar/atualizar o incidente quando a severidade não for apenas informativa;
- atualizar entidade e contramedida;
- nunca bloquear o trabalho principal por falha de telemetria não crítica.

### 7.2 Adaptadores das fontes atuais

Implementar adaptadores pequenos, em vez de a UI consultar cada tabela:

1. espelhar os eventos relevantes de `publication_item_events`;
2. registrar alterações de conta/perfil e desconexões;
3. projetar conflitos e tentativas Zernio;
4. registrar falhas e recuperações de jobs assíncronos;
5. projetar anomalias das requests Meta/Zernio;
6. transformar heartbeats e ciclos em mudanças de estado/rollups;
7. projetar breakers, fallback e recuperações como contramedidas explícitas.

Durante o rollout haverá dual-write ou espelhamento idempotente. A tela antiga continua disponível até a paridade ser validada.

### 7.3 O que não deve gerar evento individual

- todo heartbeat saudável;
- `started` + `completed` de todo ciclo rápido e vazio;
- polling sem mudança;
- leitura de status sem transição;
- uma linha por perfil em operações de massa quando um rollup e uma amostra bastam.

Esses sinais alimentam estado atual e rollups. Um evento individual é criado somente em mudança de estado, falha, recuperação, lentidão acima do limite ou amostra necessária para investigação.

## 8. Retenção obrigatória de 14 dias

### 8.1 Regra de leitura

Todas as APIs de eventos aplicam obrigatoriamente:

```text
occurred_at >= now() - 14 dias
```

O usuário pode escolher 24h, 7d ou 14d, nunca uma janela maior. Assim, uma eventual falha temporária da limpeza não transforma a API em leitura histórica ilimitada.

### 8.2 Manutenção automática

Executar diariamente, com lease e idempotência:

1. criar partições futuras;
2. verificar se a partição antiga está fora da janela;
3. remover partições/eventos expirados;
4. remover rollups expirados;
5. remover ações e vínculos de incidentes já elegíveis;
6. limpar resíduos órfãos;
7. registrar somente o resumo da manutenção e seu heartbeat.

A manutenção deve ter um caminho primário na VPS e fallback seguro, sem duas execuções concorrentes.

### 8.3 O que pode ou não ser apagado

| Classe | Retenção proposta |
|---|---|
| Eventos brutos da nova observabilidade | exclusão após 14 dias |
| Rollups de observabilidade | exclusão após 14 dias |
| Incidente resolvido | exclusão 14 dias após a última ocorrência/resolução |
| Incidente ainda ativo | manter como estado operacional compacto até resolver; ver decisão pendente |
| Heartbeat atual | uma linha por worker lógico, atualizada por upsert |
| Ciclos brutos antigos | remover após migração dos consumidores e preservação dos rollups de 14 dias |
| `publication_items`, batches, perfis, conexões e estados financeiros | fora do escopo da limpeza de logs |
| Tentativas ainda necessárias para idempotência/recovery | fora do escopo até encerrar o fluxo; depois, remover ou reduzir somente diagnóstico conforme contrato |

Não será criado arquivo frio de 90 dias como no Twitter. O requisito desta central é manter somente 14 dias. Qualquer exportação manual futura deve ser uma decisão separada.

### 8.4 Limpeza das tabelas legadas

Não executar um `DELETE` geral assim que a nova tabela nascer. Algumas telas e scripts ainda usam `publication_item_events` e tentativas Zernio como parte da investigação.

A limpeza legada terá quatro gates:

1. inventário de todos os leitores;
2. migração dos leitores para a nova projeção ou para o estado final autoritativo;
3. relatório dry-run com contagem e tamanho por tabela/dia;
4. primeira limpeza em lotes pequenos, com validação entre lotes.

Somente depois disso aplicar a política de 14 dias também às tabelas que forem confirmadas como puramente históricas. Registros de negócio não serão apagados para cumprir uma meta de log.

## 9. APIs da nova central

### 9.1 Endpoints

- `GET /api/operation/summary` — KPIs e estado geral;
- `GET /api/operation/incidents` — incidentes agrupados e filtrados;
- `GET /api/operation/events` — atividade bruta da janela;
- `GET /api/operation/incidents/[id]/occurrences` — detalhes paginados;
- `POST /api/operation/incidents/[id]/status` — investigar/resolver com justificativa;
- `GET /api/operation/workers` — estado atual, backlog e proteções;
- `GET /api/operation/filter-options` — autocomplete paginado de perfis/conexões;
- `POST /api/operation/visibility` — ocultação pessoal opcional, sem exclusão física.

Ações de retry, cancelamento, reconexão ou remoção continuam em endpoints de domínio específicos. A resposta do detalhe informa quais ações são válidas e para qual endpoint seguro apontam.

### 9.2 Contrato de paginação

- 50 linhas por página;
- máximo fixo no servidor;
- cursor opaco contendo timestamp e ID;
- ordenação determinística `occurred_at desc, id desc` ou `last_seen_at desc, id desc`;
- nenhum `offset` em tabelas grandes;
- nenhum `count exact` sobre eventos em cada mudança de filtro;
- `hasMore` obtido com `limit + 1`.

### 9.3 Busca escalável

Não usar um grande `OR ILIKE '%texto%'` sobre milhões de linhas sem índice. Separar:

- IDs e códigos exatos/prefixados com índices B-tree;
- usuário e conexão por lookup dedicado;
- mensagem por `tsvector`/GIN ou trigram controlado;
- entrada sanitizada, limitada e com debounce.

### 9.4 Resiliência

- o Server Component entrega apenas contexto de organização, papel e shell da página;
- resumo, lista e worker status carregam independentemente;
- cada chamada possui estado de erro e botão de retry;
- atualizar uma aba não bloqueia as demais;
- polling somente enquanto a aba está visível;
- resumo a cada 30 segundos;
- lista ativa a cada 15–30 segundos quando houver incidente em recuperação;
- nenhuma repetição a cada quatro segundos para todo o histórico de adições.

## 10. Ações operacionais e botões

### 10.1 Regra geral

O backend retorna algo como:

```json
{
  "availableActions": [
    { "type": "retry_publication", "requiresConfirmation": true },
    { "type": "reconnect_profile", "href": "/api/integrations/..." }
  ]
}
```

Se a ação não for válida, o botão não aparece. Se for útil explicar o bloqueio, exibir texto “recuperação automática em andamento” em vez de um botão desabilitado sem motivo.

### 10.2 Ações previstas

- abrir a publicação/lote correto na fila, já focado;
- reenfileirar somente quando o estado permitir retry seguro;
- cancelar somente o escopo autorizado;
- reconectar perfil Meta/Zernio;
- iniciar investigação ou marcar resolvido;
- retomar recuperação Zernio existente sem criar nova conta;
- encaminhar o admin para a área protegida do Zernio quando o incidente exigir remoção global; a ação destrutiva não será executada na Central de Logs.

### 10.2.1 O que significa “remoção global Zernio”

Essa ação existe hoje apenas para um caso raro de duplicidade: o mesmo `accountId` do Instagram aparece associado a duas chaves/conexões Zernio. O `DELETE` remoto desse `accountId` pode removê-lo das duas conexões ao mesmo tempo, e o perfil local é marcado como removido até ser reconectado.

Ela não é “excluir um log” nem uma exclusão comum de perfil. É uma operação destrutiva de recuperação, com impacto externo e necessidade de reconexão. Por isso, a recomendação atual é:

- não mostrar essa ação na lista normal de logs;
- mostrar o diagnóstico da duplicidade para todos os papéis autorizados;
- disponibilizar a ação somente para admin, dentro do detalhe do incidente;
- executar um preflight novo imediatamente antes do botão ser liberado;
- exigir confirmação digitada com o `@perfil` e informar as duas conexões afetadas;
- registrar o resultado como nova ocorrência, sem apagar o incidente original.

A decisão aprovada é deixar a central somente diagnosticar esse caso. O drawer mostrará as conexões afetadas e encaminhará o admin para uma área protegida da administração Zernio. O preflight atualizado, as consequências e a confirmação digitada existirão nessa área, nunca como botão destrutivo na lista ou no drawer de logs.

### 10.3 “Limpar logs”

Com retenção automática de 14 dias, não deve existir botão comum que apague fisicamente registros. A opção recomendada é **Limpar visualização**, pessoal e reversível. Exclusão técnica de logs antigos pertence à manutenção automática.

## 11. Permissões e privacidade

| Papel | Visualização | Evidências | Ações |
|---|---|---|---|
| `viewer` | resumo, incidentes e eventos da organização | sanitizadas e reduzidas | nenhuma ação mutável |
| `operator` | conteúdo operacional completo da organização | sanitizadas | retry/cancelamento permitido pelo domínio, investigar/resolver |
| `admin` | igual ao operador | sanitizadas | ações administrativas e destrutivas com confirmação |
| superusuário | inclui infraestrutura global | host, PID e metadata ainda sanitizada | diagnóstico e ações globais explicitamente autorizadas |

RLS e APIs devem sempre restringir por organização. O uso de admin client em uma rota não substitui a validação explícita de organização, papel e vínculo da entidade.

## 12. CSS, responsividade e acessibilidade

A central terá um conjunto de estilos próprio, preferencialmente em CSS Module, evitando acrescentar outra seção extensa e global em `app/globals.css`.

Direção visual:

- largura útil maior no desktop para lista operacional;
- densidade confortável, sem cards gigantes;
- tipografia com hierarquia clara e números tabulares;
- cor usada como reforço, nunca como única informação;
- chips consistentes para severidade e tratamento;
- foco visível em teclado;
- alvos de toque de pelo menos 44 px no mobile;
- drawer em desktop e bottom sheet/página cheia no celular;
- toolbar que quebra em duas linhas antes de virar rolagem confusa;
- cabeçalho da lista sticky em telas largas;
- skeletons apenas nas regiões em carregamento;
- suporte a `prefers-reduced-motion`;
- contraste AA para texto, chips, bordas e estados.

Breakpoints mínimos de validação visual: 1440 px, 1024 px, 768 px e 390 px.

## 13. Metas de desempenho

Cenário mínimo de teste:

- 2.500 perfis;
- 100 ou mais conexões;
- 2 milhões de eventos distribuídos na janela quente de 14 dias;
- incidentes repetidos afetando centenas de perfis;
- múltiplos workers e jobs concorrentes;
- pelo menos 50 mil itens de fila ativos/históricos relacionados.

Metas iniciais, a validar no ambiente de teste:

- nenhuma consulta sem limite ou sem recorte de organização/janela;
- primeira página com no máximo 50 registros;
- payload de cada página de eventos abaixo de 150 kB sem compressão, salvo evidência aberta sob demanda;
- shell + resumo úteis sem esperar listas e detalhes;
- p95 da consulta de primeira página abaixo de 300 ms no banco após aquecimento;
- p95 do resumo abaixo de 500 ms;
- busca por código/ID/perfil sem varredura sequencial da partição inteira;
- manutenção de retenção sem lock prolongado nas partições quentes;
- nenhuma degradação mensurável no caminho de publicação se a gravação de observabilidade falhar.

Os números serão registrados por `EXPLAIN (ANALYZE, BUFFERS)`, testes sintéticos e medição de payload. Se o ambiente não sustentar uma meta, o gate não será relaxado sem registrar a causa e a nova meta aprovada.

## 14. Fases de implementação

### Fase 0 — decisões e baseline

**Execução — CONCLUÍDA em 26/08/2026**

- decisões de escopo, papéis, retenção, grupos e remoção global aprovadas pelo usuário;
- baseline remoto medido: aproximadamente 186 mil eventos/92 MB em `publication_item_events` e 181 mil ciclos/131 MB em `publication_worker_cycle_events` no levantamento inicial;
- fluxo atual, consumidores, tabelas, workers e diferenças da Central X/Twitter inventariados;
- worktree sujo auditado e estratégia de deploy isolado escolhida para não publicar alterações alheias;
- nenhuma escrita externa ocorreu antes da autorização explícita do usuário.

- responder às decisões pendentes do final deste documento;
- congelar a taxonomia inicial de domínios, códigos e contramedidas;
- medir volume por fonte e por dia;
- listar consumidores de todas as tabelas legadas;
- registrar tempos atuais de `/operacao` e tamanho do payload;
- definir feature flag/allowlist para a V2.

**Gate:** baseline e decisões aprovados; nenhuma escrita externa.

### Fase 1 — fundação do banco

**Execução — CONCLUÍDA em 26/08/2026**

- migration `277_instagram_observability_center.sql` aplicada no Supabase remoto;
- criados enums, eventos particionados por dia, incidentes, perfis/entidades afetados, ações, preferências, rollups de operação e rollups de worker;
- fingerprint, sanitização recursiva, RLS, grants, índices, resumo e manutenção de 14 dias implementados;
- migration validada pela aplicação transacional do Supabase e por consultas reais após o deploy;
- estratégia de rollback é forward-only: consumidores podem voltar para a tela anterior sem apagar as novas tabelas; migrations não são revertidas destrutivamente.

**Desvio registrado:** Docker/PostgreSQL local não estava disponível nesta máquina. A validação SQL ocorreu no projeto Supabase vinculado; cada migration foi aplicada transacionalmente e somente a próxima fase foi iniciada após sucesso.

- criar tipos, eventos particionados, incidentes, entidades, ações, rollups e preferências;
- criar índices compostos e parciais para todos os filtros;
- implementar sanitização, fingerprint e RPC de registro;
- implementar RLS e matriz de grants;
- criar manutenção de partições e dry-run de retenção;
- criar testes SQL transacionais.

**Gate:** migrations locais completas, rollback forward-only documentado e testes aprovados.

### Fase 2 — catálogo e projeção das fontes

**Execução — CONCLUÍDA em 26/08/2026**

- migration `278_instagram_observability_projections.sql` aplicada;
- projeções aditivas instaladas para eventos de publicação, sync Zernio, incidentes de desconexão/reciclagem e ciclos do worker;
- ciclos saudáveis passaram a alimentar rollups de cinco minutos em vez de dependerem de uma linha visual por ciclo;
- erros com retry, contenção e recuperação automática recebem tratamento diferente de falhas sem contramedida;
- backfill seletivo executado: atenção dos últimos 14 dias e timeline recente, sem duplicar cegamente os 478 mil eventos legados encontrados na janela;
- fechamento do rollout registrou 41.998 eventos projetados, 56 incidentes compactos, 2.881 eventos de Story e 1.764 eventos de erro/críticos;
- nenhum segredo foi copiado para evidência; URLs, tokens, captions, bodies e chaves sensíveis são removidos.

**Escopo preservado:** os motores transacionais de publicação, retry, cancelamento e recuperação permaneceram autoritativos e não tiveram concorrência ou comportamento alterados.

- cadastrar códigos estáveis existentes;
- adaptar publicação/fila;
- adaptar perfis, Meta e Zernio;
- adaptar adições, quedas, conflitos e reciclagem;
- adaptar analytics, mídia e jobs;
- transformar worker status/ciclos em estado + rollup + eventos anormais;
- iniciar dual-write/shadow sem alterar a tela atual.

**Gate:** paridade amostral entre fonte e projeção, zero segredo persistido e nenhum impacto no worker principal.

### Fase 3 — APIs V2

**Execução — CONCLUÍDA em 26/08/2026**

- adicionados endpoints V2 de resumo, eventos, incidentes, status de incidente, preferências, workers, entidades e diagnóstico de perfil;
- paginação por cursor opaco, limites rígidos, período máximo de 14 dias e filtros server-side implementados;
- busca assíncrona por `@username`, nome de exibição e grupo confirmada com dados reais;
- filtros por domínio, perfil, grupo, formato, provedor, severidade, tratamento e texto implementados;
- viewer recebe leitura sanitizada; operator/admin recebem ações autorizadas; somente superusuário recebe host, PID, versão e identificador do worker;
- migration `280_instagram_group_incident_filter.sql` adicionou filtro escalável de incidentes por grupo sem transportar milhares de UUIDs;
- diagnóstico por perfil/formato diferencia: ausência de agenda, plano ainda futuro, falha de materialização, item vencido sem claim, processamento, retry, falha, contenção e publicação confirmada;
- teste real confirmou o caso `@franfrancielinha + Story`: “Nenhuma publicação foi agendada neste período”, com zero itens e zero planos.

**Complementação:** métricas próprias persistentes de duração, payload, status e erros 5xx foram adicionadas na migration `282`, agregadas em cinco minutos e retidas por 14 dias.

- implementar resumo, incidentes, eventos, ocorrências, workers e filtros;
- implementar cursores opacos;
- aplicar limite rígido de 14 dias;
- aplicar sanitização por papel;
- retornar `availableActions` por item/incidente;
- implementar busca assíncrona por `@username` e nome de exibição;
- implementar busca assíncrona e filtro server-side por grupo de perfis;
- implementar filtros server-side por formato, estado, perfil e lote;
- diferenciar grupo atual do perfil e grupo de origem da programação;
- fornecer timeline correlacionada da publicação;
- detectar publicações esperadas que não foram materializadas, reivindicadas ou finalizadas;
- adicionar telemetria de duração e payload das próprias APIs.

**Gate:** testes de autorização, paginação, filtro, cursor, isolamento e falha parcial aprovados.

### Fase 4 — interface nova

**Execução — CONCLUÍDA em 26/08/2026**

- `OperationClient` deixou de ser a fundação de `/operacao`; foi criado `InstagramObservabilityCenter` novo com CSS Module próprio;
- shell, KPIs, abas, busca contextual, filtros, incidentes, timeline, detalhes técnicos, contramedidas, workers e estados vazios implementados;
- visão focada por perfil e por grupo implementada, incluindo alternância entre “grupo de origem” e “membros atuais”;
- diagnóstico explícito de Story implementado e validado com sessão real;
- CSS responsivo validado em desktop e viewport móvel de 390 × 844; não houve erro de console;
- atualização, carregar mais, limpar/desfazer visualização e investigar/resolver têm contratos funcionais.

**Desvio registrado:** filtros principais mantêm estado durante a sessão, mas a URL ainda não é reescrita a cada alteração. URLs antigas e `?scope=connection` são interpretadas; persistência completa de todos os filtros na URL permanece melhoria posterior.

- reconstruir `OperationClient` em componentes menores;
- criar shell, KPIs, abas, toolbar, lista, worker cards e drawer;
- criar a visão focada no perfil e o filtro Story/Reel/Imagem/Carrossel;
- criar a visão focada no grupo, com agregados, perfis afetados e drill-down para perfil;
- mostrar a jornada completa de cada publicação e estados explícitos quando não existir agendamento;
- persistir filtros na URL;
- implementar atualização controlada e estados independentes;
- criar CSS Module responsivo;
- validar teclado, leitores de tela, contraste e reduced motion.

**Gate:** revisão visual nos quatro breakpoints e nenhum botão sem comportamento verificável.

### Fase 5 — unificação das páginas e ações

**Execução — CONCLUÍDA em 26/08/2026**

- `/operacao/quedas-zernio` e `/operacao/adicoes-zernio` agora redirecionam para `/operacao?scope=connection`;
- os eventos de quedas, adições/sync, conflitos e recuperação são recortes da central única;
- remoção global foi retirada dos logs e isolada em `/administracao/zernio` para admin;
- área protegida preserva preflight das duas chaves, valida account ID/identidade/estado e exige confirmação digitada;
- “Limpar visualização” é pessoal e reversível; nenhuma exclusão física fica disponível na central.

- incorporar Quedas Zernio e Adições Zernio;
- remover a ação de remoção global da Central de Logs e criar somente o encaminhamento para a área protegida da administração Zernio;
- converter links antigos em redirects para a aba/filtro correto;
- manter somente redirects das URLs antigas durante a transição; a central V2 não dependerá das APIs antigas;
- remover a exclusão manual de conflitos da navegação comum.

**Gate:** todos os cenários das duas páginas antigas encontrados na central única.

### Fase 6 — escala e retenção

**Execução — CONCLUÍDA em 26/08/2026**

- migrations `279_instagram_observability_retention_batches.sql` e endpoint interno de manutenção aplicados;
- eventos quentes são particionados diariamente; partições futuras são preparadas e partições vencidas são removidas;
- incidentes resolvidos vencem 14 dias após último evento/resolução; ativos preservam somente o resumo compacto;
- limpeza legada usa lotes pequenos e independentes para evitar locks longos;
- cron VPS instalado a cada cinco minutos com `flock`, segredo lido do arquivo protegido e nenhum segredo gravado no crontab;
- primeiro teste com lote 5.000 excedeu o timeout do Supabase e retornou `500`; lote foi reduzido para 200, validado manualmente com `200` e republicado no deployment final. O erro e a correção permanecem registrados neste plano.
- após a republicação, o script foi executado diretamente na VPS e retornou `maintenance-exit-ok`; o crontab permaneceu instalado e todos os processos PM2 preexistentes foram confirmados `online`, sem restart provocado por esta entrega.

**Gate concluído:** benchmark sintético isolado executado no PostgreSQL local com 2.500 perfis, 100 conexões, 2 milhões de eventos e 50 mil itens de fila. O schema descartável foi removido depois das medições.

- gerar dataset sintético de 2.500 perfis e 2 milhões de eventos;
- medir planos de consulta, payload e concorrência;
- ativar manutenção de 14 dias em shadow/dry-run;
- comparar contagens antes/depois;
- executar primeira limpeza controlada somente das estruturas já aprovadas;
- confirmar que registros autoritativos permanecem intactos.

**Gate:** metas de desempenho cumpridas e relatório de retenção sem divergências.

### Fase 7 — rollout controlado

**Execução — JANELA OBSERVADA; GATE REPROVADO em 27/08/2026**

- migrations remotas alinhadas até `280`;
- deploy isolado evitou incluir mudanças não relacionadas do worktree;
- deployment Production vigente: `dpl_CXNYbKNzDWywKR2tKEPPhr8ybtmC`, alias `https://pomodoro-theta-one-82.vercel.app`;
- smoke autenticado confirmou resumo, 50 eventos paginados, incidentes e cinco workers saudáveis;
- produção confirmou perfil + Story sem agenda e grupo `Bielzinho` com 15 incidentes e 50 eventos, sem erro de console;
- suíte completa do repositório aprovada com 286/286 testes, TypeScript sem erros e `git diff --check` sem erro estrutural;
- processos de publicação, planejamento, mídia, analytics e sync não foram reiniciados nem reconfigurados.

**Resultado do gate:** a janela real de pico e o ciclo diário foram observados. O gate falhou por latência acima das metas, respostas 500 intermitentes do job de retenção legada e 54 eventos além do cutoff exato de 14 dias. Evidências completas na seção 19.7.

- habilitar V2 primeiro para uma organização;
- comparar resumo e incidentes com as fontes atuais;
- observar pelo menos uma janela real de pico e um ciclo diário de retenção;
- ampliar por organização;
- manter rollback para a tela antiga enquanto houver dual-write.

**Gate:** nenhuma perda de incidente, ação ou isolamento; erros e latência dentro das metas.

### Fase 7A — correção dos bloqueios do rollout

**Execução — CONCLUÍDA EM 27/08/2026**

- instrumentar cada etapa das APIs para separar tempo de autenticação/contexto, consulta principal, enriquecimento, serialização e gravação da própria telemetria;
- medir planos reais das consultas padrão, perfil + formato, grupo atual/origem, busca textual, incidentes, resumo e workers;
- corrigir as consultas e índices que forem comprovadamente responsáveis pela latência, sem aumentar o payload nem retirar filtros;
- reduzir o custo do carregamento inicial mantendo falha parcial por seção; avaliar um bootstrap agregado somente se as medições provarem que quatro autenticações/contextos independentes são o gargalo;
- corrigir a retenção quente para limpar em lotes a faixa vencida da partição de borda, além de continuar descartando partições totalmente expiradas;
- indexar os cortes temporais das fontes legadas e dividir a manutenção por fonte/lote, impedindo que um timeout isolado invalide todo o ciclo;
- registrar resultado estruturado do cron e criar evidência verificável de sucesso/falha por execução, sem expor segredo;
- auditar a fragmentação de incidentes em recuperação automática e normalizar fingerprints que incluam identificadores variáveis;
- verificar por que `scheduling` e `worker` não produziram eventos brutos na janela e corrigir produtor ou documentar formalmente a projeção substituta;
- criar testes de regressão para desempenho, retenção exata, manutenção parcial, agrupamento de incidentes, domínios e isolamento por papel.

Progresso detalhado e evidências: seções 19.9 e 19.10. A retenção foi dividida por fonte em `298`, o resumo passou a usar snapshot em `299`–`301`, a proteção global de carga foi aplicada em `302`, e cron, PostgREST, workers e smoke autenticado fecharam na mesma baseline.

**Gate:** correções aprovadas localmente e no banco com migrations forward-only; nenhuma fonte autoritativa alterada; TypeScript, build e suíte completa aprovados; rollback técnico documentado.

### Fase 7B — nova observação controlada

**Execução — EM OBSERVAÇÃO**

- deployment-base: `dpl_1LP962S2Mj15vMwJ4M6Ey27H5rVw`;
- início: `28/08/2026 02:10:03 UTC` (`27/08/2026 23:10:03 BRT`);
- término mínimo: `29/08/2026 02:10:03 UTC` (`28/08/2026 23:10:03 BRT`);
- baseline de abertura: manutenção frequente `exit=0`, 2.283 ms, `hasMore=false`, um evento de borda removido, 38 rollups recompostos, três snapshots atualizados e zero falha;
- consulta posterior: zero evento quente anterior ao cutoff exato, lease pesado livre, cinco de cinco workers recentes e sem erro persistente;
- APIs desde a baseline: `events` 2/2 abaixo de 1 s, `summary` 2/2 abaixo de 1 s, `incidents` 1/1 em 426 ms e `workers` 1/1 em 322 ms, zero erro; payload máximo da timeline 71.547 bytes.

- publicar as correções mantendo o legado disponível;
- executar smoke autenticado de perfil, grupo, Story, Reel, busca, incidentes, drawer, ações por papel e status dos workers;
- observar nova janela contínua de 24 horas, incluindo pelo menos um pico real e 288 execuções previstas do cron de cinco minutos;
- comparar telemetria nova com a baseline registrada na seção 19.7;
- somente aprovar o gate quando todos os critérios numéricos da seção 19.8 forem atendidos simultaneamente.

**Gate:** zero regressão funcional ou de isolamento, retenção exata e manutenção estável, workers saudáveis, zero 5xx e latência dentro dos novos limites de produção.

### Fase 8 — remoção do legado

**Execução — BLOQUEADA; NENHUMA REMOÇÃO APLICADA**

- `/operacao` não importa nem renderiza mais o componente antigo;
- páginas antigas foram reduzidas a redirects e a central nova não depende das APIs antigas;
- arquivos e APIs antigos continuam no repositório porque outras alterações do worktree estão em andamento e o período de rollback ainda não terminou;
- tabelas legadas classificadas como logs já recebem retenção incremental; tabelas autoritativas continuam preservadas.

**Pendente para concluir o gate:** corrigir os bloqueios da Fase 7, repetir a observação em produção e somente então remover `OperationClient`, APIs antigas e componentes Zernio comprovadamente sem uso, rodar suíte completa e registrar o rollback final.

- remover componentes e consultas antigas de `/operacao`;
- remover páginas antigas após período de redirects;
- retirar APIs sem consumidores;
- desativar dual-write redundante;
- aplicar retenção às tabelas legadas confirmadas como logs;
- atualizar runbook e documentação operacional.

**Gate:** busca no repositório sem consumidores antigos, build/testes aprovados e rollback documentado.

## 15. Estratégia de testes

### Banco

- fingerprint agrupa ocorrências equivalentes e separa etapas/provedores diferentes;
- incidente resolvido reabre quando o mesmo problema volta;
- recuperação de uma entidade não encerra as outras;
- sanitização remove todas as chaves sensíveis conhecidas;
- evento duplicado pela mesma origem não incrementa duas vezes;
- RLS impede leitura cruzada entre organizações;
- viewer não recebe evidência técnica restrita;
- partição e manutenção preservam exatamente 14 dias;
- limpeza não toca tabelas autoritativas.

### API

- cursor inválido retorna 400;
- limite nunca ultrapassa 50;
- todos os filtros combinam corretamente;
- a busca considera o conjunto completo, não apenas a página carregada;
- falha do resumo não impede carregar a lista e vice-versa;
- ações respeitam papel e estado atual;
- resposta nunca contém token, chave, URL assinada, legenda ou payload bruto.

### Interface

- filtros sobrevivem a refresh e navegação voltar/avançar;
- drawer carrega ocorrências progressivamente;
- loading, vazio, erro e retry são testados por seção;
- botões entram em busy state, mostram resultado e atualizam os dados;
- viewer não vê controles mutáveis;
- tabs e drawer funcionam por teclado;
- mobile não produz overflow horizontal da página.
- busca por `@` e nome encontra o perfil no conjunto completo de 2.500 perfis;
- busca por nome encontra o grupo e filtra todos os seus perfis no servidor;
- grupo + formato + estado + período funciona sem carregar a lista completa de membros;
- o detalhe diferencia grupo atual do perfil e grupo de origem da programação;
- perfil + Story mostra somente Stories daquele perfil e permite voltar a todos os formatos;
- a timeline diferencia não agendado, não materializado, não reivindicado, falha, retry, resultado incerto e publicado;
- um Story publicado há mais de 24 horas continua aparecendo como sucesso na janela de logs, mesmo que já não esteja visível no Instagram.

### Regressão operacional

- publicar, retry, cancelamento, reconexão, queda e reciclagem continuam usando seus contratos atuais;
- falha de observabilidade não bloqueia publicação;
- fallback VPS/Vercel continua respeitando heartbeat e fence;
- workers não expõem segredos em metadata ou mensagens.

## 16. Critérios finais de aceite

- existe somente uma central de logs do Instagram para o usuário;
- Quedas e Adições Zernio são filtros/abas, não páginas soltas;
- o primeiro bloco responde claramente o que exige ação agora;
- erros com contramedida aparecem separados de falhas terminais;
- incidentes repetidos são agrupados com ocorrências paginadas;
- workers esperados, ativos, stale, fallback e backlog são compreensíveis;
- todos os filtros são server-side e persistem na URL;
- é possível buscar um perfil por `@` ou nome, filtrar por Story/Reel/Imagem/Carrossel e investigar a timeline completa;
- é possível buscar um grupo, aplicar os mesmos filtros e descer do incidente agregado até cada perfil afetado;
- a central detecta publicação esperada sem item, claim ou desfecho, em vez de depender somente de erros gravados;
- nenhum carregamento inicial envia os 2.500 perfis;
- nenhuma lista usa offset ou consulta sem limite;
- APIs e limpeza respeitam a janela de 14 dias;
- dados autoritativos não são apagados como se fossem logs;
- não há ação visual sem endpoint, permissão, confirmação e retorno tratado;
- testes de escala com 2 milhões de eventos passam;
- layout é aprovado em desktop e mobile;
- rollout e rollback estão documentados.

## 17. Decisões e aprovações

Decisões registradas em 26/08/2026:

1. **Escopo do Instagram — APROVADO**  
   A central inclui Meta oficial e Zernio, com filtro por provedor.

2. **Incidente ainda ativo após 14 dias — APROVADO**  
   As ocorrências brutas são apagadas ao completar 14 dias, mas uma linha compacta permanece enquanto o incidente estiver ativo. Depois de resolvido, o incidente é apagado 14 dias após a última ocorrência/resolução.

3. **Versão para todos os usuários — APROVADO**  
   Todos os papéis terão acesso à nova central e à busca por perfil, formato e logs da própria organização. Viewer recebe uma versão somente leitura e sanitizada. Admin/operator recebem os recursos operacionais autorizados. Somente o superusuário vê host, PID, infraestrutura global e detalhes internos dos workers. Para usuários comuns, a aba de workers pode ser ocultada ou substituída por um resumo de disponibilidade do serviço sem detalhes de infraestrutura.

4. **Ações dentro da tela — APROVADO**  
   Ações seguras no drawer permanecem: retry, cancelar, reconectar e investigar/resolver, sempre conforme papel e estado. A remoção global Zernio não ficará na Central de Logs; o diagnóstico encaminhará o admin para uma área protegida da administração Zernio, com preflight novo e confirmação digitada.

5. **Limpar visualização — APROVADO**  
   A central terá somente limpeza pessoal e reversível. A exclusão física fica exclusivamente na retenção automática de 14 dias. Nenhuma função da tela atual será reaproveitada como implementação dessa experiência.

6. **Investigação por grupo de perfis — APROVADO**  
   A central permitirá busca por nome do grupo, filtros combinados de formato/estado/período, agregados do grupo e drill-down até cada perfil. Grupo atual do perfil e grupo de origem da programação serão conceitos distintos.

## 18. Arquivos e áreas provavelmente afetados na implementação

- `app/(painel)/operacao/page.tsx`;
- `app/operacao/operation-client.tsx`, que deve ser dividido em componentes menores;
- novo CSS Module da central;
- novas rotas em `app/api/operation/*`;
- redirects das rotas `quedas-zernio` e `adicoes-zernio`;
- migrations novas após o último número disponível no momento da implementação;
- testes SQL em `supabase/tests`;
- novos módulos de observabilidade em `lib/instagram` ou `lib/observability`;
- instrumentação nos workers de publicação, geração, mídia, analytics e sync Zernio;
- runbook dos workers e documentação de retenção;
- scripts de benchmark, dry-run e validação pós-deploy.

Como o worktree já contém muitas alterações em andamento, a implementação deverá começar com um novo inventário de diffs e editar somente trechos compatíveis, sem sobrescrever trabalho existente.

## 19. Registro da implementação

Entregue em 26/08/2026:

- armazenamento particionado de eventos quentes, incidentes compactos, entidades afetadas, ações, preferências pessoais e rollups de workers;
- projeções aditivas das fontes autoritativas de publicação, sync Zernio, desconexões e ciclos de worker;
- APIs novas com paginação por cursor, filtros no servidor, evidência sanitizada e autorização por papel;
- busca assíncrona por `@`, nome e grupo, sem enviar todos os perfis no primeiro carregamento;
- diagnóstico por perfil e formato capaz de distinguir ausência de agenda, falha de materialização, item não capturado, processamento, retry, falha, contenção e publicação confirmada;
- filtro de grupo por origem da programação ou associação atual, incluindo incidentes e timeline;
- UI e CSS Module novos, responsivos, validados em desktop e viewport móvel com sessão real;
- redirects das páginas antigas de quedas e adições para a central única;
- remoção global Zernio isolada em `/administracao/zernio`, fora dos logs, mantendo preflight e confirmação digitada;
- retenção quente de 14 dias e limpeza legada incremental agendada na VPS a cada cinco minutos, sem reiniciar workers;
- 41.998 eventos já projetados no fechamento do rollout, incluindo 2.881 eventos de Story e 1.764 eventos de erro/críticos;
- migrations locais e remotas alinhadas até `280`;
- deploy Production isolado vigente `dpl_CXNYbKNzDWywKR2tKEPPhr8ybtmC`, publicado no alias oficial após build aprovado.

Validações executadas: suíte completa com 286/286 testes aprovados, TypeScript, build local, build Vercel, `git diff --check`, smoke autenticado de produção, busca real por perfil/Story, busca real por grupo, status de cinco workers e execução manual do job de retenção.

### 19.1 Continuação e correção da retenção

Na continuação solicitada pelo usuário, a auditoria do cron detectou duas execuções com erro `500`. A causa não estava no cron nem nos workers: o diretório isolado do deploy ainda continha `p_batch_size: 5000`, embora o worktree principal já tivesse sido corrigido para 200. O diretório isolado foi reconstruído do zero, todos os arquivos da entrega foram copiados novamente e o deployment `dpl_5iT4n6VAttNfZJccqg6nt2neWoLo` substituiu o anterior.

Depois da correção:

- chamada direta da VPS para o endpoint de produção: sucesso (`maintenance-exit-ok`);
- crontab: presente, a cada cinco minutos, protegido por `flock`;
- workers Instagram no PM2: publicação, geração, mídia, analytics e sync Zernio `online`;
- nenhum processo foi reiniciado pela correção;
- filtro de grupo em produção: grupo de origem e membros atuais disponíveis, 15 incidentes e 50 eventos carregados no smoke;
- console do navegador: zero erro no fluxo validado.

### 19.2 Fechamento da validação do repositório

A suíte completa inicialmente acusou uma única falha em `lib/operation-page-resilience.test.ts`. O teste ainda exigia propriedades do componente legado `OperationClient`, removido da rota pela Fase 4. O teste de regressão foi atualizado para o contrato novo: a página monta a central sem pré-carregar telemetria agregada e o cliente captura falhas das APIs, apresenta `errorBanner` e mantém a rota renderizada.

Resultado final em 26/08/2026:

- `npm test`: 286 testes aprovados, zero falhas;
- `npx tsc --noEmit`: aprovado;
- `git diff --check`: aprovado; apenas avisos de conversão LF/CRLF em arquivos já presentes no worktree;
- os quatro testes específicos de `lib/instagram/observability.test.ts` permanecem aprovados;
- naquele momento o benchmark sintético ainda estava pendente; ele foi executado e concluído posteriormente, conforme a seção 19.5.

### 19.3 Correção da integração visual com o painel escuro

Após a primeira publicação, o usuário identificou corretamente que a central tinha sido desenhada com superfícies claras, embora o shell Athena seja escuro. A Fase 4 foi corrigida em 26/08/2026 sem alterar contratos, dados ou comportamento operacional:

- paleta da central convertida para as superfícies escuras e identidade roxa já usadas pelo painel;
- cards, filtros, selects, sugestões, timeline, incidentes, diagnósticos e estados de erro receberam contraste específico para fundo escuro;
- validação real em desktop confirmou fundo `rgb(10, 10, 13)`, cards `rgb(23, 21, 30)` e zero erro de console;
- validação em 390 × 844 confirmou layout responsivo e ausência de overflow horizontal;
- `npm test`: 286/286 aprovados; `npx tsc --noEmit` e `git diff --check` aprovados;
- deployment corrigido: `dpl_VXo6ZGjD8AySn5Ax4W2zQRKmFLSt`, ativo no alias oficial.

### 19.4 Correção do vazamento dos cards de incidentes

O usuário identificou que os cards da coluna “Incidentes ativos” ultrapassavam a divisória e cobriam a timeline. A causa era o tamanho mínimo intrínseco dos itens da grid, que podia superar a largura fixa da coluna esquerda.

Correção aplicada em 26/08/2026:

- itens das duas colunas receberam `min-width: 0` e limite de 100%;
- painel de incidentes passou a conter qualquer excedente;
- cards agora usam `width: 100%` e `box-sizing: border-box`;
- títulos, códigos e textos de contramedida podem quebrar sem ampliar a coluna;
- teste visual em 1495 px: cards de 355 px dentro da coluna de 380 px, zero vazamento;
- teste visual em 1024 px: cards de 305 px dentro da coluna de 330 px, zero vazamento;
- teste de regressão adicionado a `lib/operation-page-resilience.test.ts`;
- TypeScript, teste focado e `git diff --check` aprovados;
- produção revalidada com dados reais e zero erro de console;
- deployment: `dpl_CXNYbKNzDWywKR2tKEPPhr8ybtmC`.

### 19.5 Auditoria integral das fases e complementação

Em 26/08/2026, após solicitação explícita do usuário, o plano foi reavaliado pelo critério original de cada gate, e não pelas marcações otimistas anteriores.

#### Fase 0 — descoberta e baseline: concluída

- inventário, decisões de produto, papéis, retenção, grupos e remoção global já estavam aprovados;
- worktree sujo foi novamente auditado antes do deploy;
- deploy continuou isolado das alterações de Twitter e demais áreas.

#### Fase 1 — fundação do banco: concluída

- migrations locais e remotas permaneceram íntegras;
- ambiente Supabase local foi localizado e passou a ser usado para validação antes do remoto;
- migrations `281` a `284` foram aplicadas primeiro localmente e depois no projeto remoto, sem reparo artificial de histórico;
- lint das novas estruturas não encontrou erro novo. O lint global ainda lista três erros preexistentes e fora deste escopo em `rollback_legacy_waiting_randomization`, `enqueue_zernio_organization_sync_batch` e `twitter_record_connection_dispatch_signal`.

#### Fase 2 — fontes e projeções: concluída

- migration `281_complete_instagram_observability_sources.sql` adicionou produtores best-effort para perfis, conexões, tentativas de conexão, geração de publicações, exclusão e agrupamento de mídia, refresh de analytics, reciclagem Zernio, assets e anomalias de request;
- dez novos gatilhos foram confirmados no remoto, somados às projeções anteriores de publicação, sync, quedas e worker;
- os gatilhos capturam mudança de estado sem bloquear o fluxo autoritativo caso a observabilidade falhe;
- backfill idempotente das fontes novas materializou 2.111 perfis, 684 conexões, 2.366 tentativas, 694 jobs de analytics, 899 jobs de reciclagem e 3 jobs de mídia, sem copiar credenciais ou payloads brutos;
- contagem remota após o backfill: `account=2.111`, `analytics=694`, `connection=3.953`, `media=3` e `publication=53.514` eventos na janela de 14 dias. Agenda permanece vazia quando não existem jobs recentes, em vez de inventar atividade.

#### Fase 3 — APIs V2: concluída

- escopos separados de Agenda, Analytics e Mídia substituíram a aba ambígua combinada;
- filtros server-side passaram a incluir status de origem, worker/job, conexão por nome ou UUID e lote;
- filtro de domínio também foi aplicado aos incidentes;
- backend retorna `availableActions` conforme papel e estado; viewer recebe lista vazia;
- endpoint de detalhe do incidente entrega até 100 ocorrências recentes, perfis afetados, entidades, contramedida e histórico auditável, sanitizando evidência e ator conforme papel;
- migration `283` adicionou índices de conexão, lote, job, worker e status;
- telemetria própria agrega duração, payload, status e 5xx em cinco minutos; manutenção remove métricas após 14 dias;
- falha parcial foi implementada com `Promise.allSettled`: resumo, incidentes, timeline e workers preservam os blocos que responderam;
- atualização automática ocorre a cada 30 segundos somente com a página visível.

#### Fase 4 — interface: concluída

- todos os filtros operacionais são persistidos na URL e sobrevivem a reload;
- drawer real de incidente foi entregue com evidência operacional e histórico;
- abas Contas, Agenda, Analytics e Mídia agora têm produtores reais e recortes independentes;
- revisão autenticada em produção confirmou Analytics com incidentes reais, drawer completo e filtros Story/14 dias restaurados após reload;
- tema escuro confirmado com fundo `rgb(10, 10, 13)`;
- desktop e viewport 390 × 844 sem overflow horizontal;
- todos os controles principais medidos no celular passaram a ter alvo mínimo de 44 px;
- console permaneceu sem erros ou warnings no fluxo validado.

#### Fase 5 — unificação: concluída

- redirects, central única e administração Zernio protegida permanecem funcionando;
- nenhuma ação destrutiva global voltou para a tela de logs;
- limpar visualização continua pessoal e reversível.

#### Fase 6 — escala e retenção: concluída

- benchmark isolado gerou exatamente 2.000.000 eventos, 2.500 perfis, 100 conexões e 50.000 itens de fila;
- armazenamento sintético observado: 1.199 MB para eventos e 6.512 kB para fila;
- `EXPLAIN (ANALYZE, BUFFERS)`: perfil + Story em `0,363 ms`, conexão em `2,193 ms`, busca textual em `0,327 ms` e resumo sintético de fila em `12,637 ms`;
- payload sintético de 50 eventos: `15.168 bytes`; payload real máximo observado da API de eventos: `75.231 bytes`, abaixo do teto de 150 kB;
- a primeira medição da fila real encontrou `987,479 ms` por buscar 32.872 itens e o gate não foi relaxado;
- migration `284` criou índice parcial de cobertura; a mesma consulta caiu para `271,068 ms`, abaixo da meta de 500 ms;
- scripts reproduzíveis salvos em `scripts/observability/benchmark-instagram-observability-setup.sql` e `benchmark-instagram-observability.sql`;
- schema sintético `instagram_observability_bench` removido após a coleta;
- endpoint de manutenção pós-deploy respondeu `200`, com retenção quente, legada e de telemetria ativa.

#### Fase 7 — rollout: auditoria executada, gate reprovado

- deployment final vigente: `dpl_H9mTA1KPg5sftkn7baREkp8WuXnt`;
- alias oficial: `https://pomodoro-theta-one-82.vercel.app`;
- migrations remotas alinhadas até `284`;
- build local, build Vercel, TypeScript e 288/288 testes aprovados;
- smoke autenticado confirmou dados, filtros, drawer, workers e zero 5xx nas métricas coletadas;
- contratos automatizados confirmam viewer sem ações/evidência restrita, operator/admin com ações válidas e somente superusuário com host/PID/ID de worker;
- a janela mínima de 24 horas foi completada e auditada em 27/08/2026; as evidências finais e os bloqueios estão registrados na seção 19.7;
- o gate não foi aprovado por latência acima das metas, falhas 5xx do job automático de retenção e divergência na retenção quente exata de 14 dias.

#### Fase 8 — remoção do legado: bloqueada pelo gate

- central nova continua independente das APIs/componentes antigos e as URLs antigas continuam apenas como redirects;
- remoção física de `OperationClient`, APIs e componentes antigos não foi executada porque eliminaria o rollback antes das 24 horas exigidas na Fase 7;
- a busca de consumidores foi executada, mas nenhuma remoção foi feita porque o gate técnico da Fase 7 falhou; os candidatos e consumidores que precisam ser preservados estão registrados na seção 19.7;
- depois de corrigir e observar novamente os bloqueios, a ação restante é remover somente arquivos comprovadamente órfãos, executar build/testes e registrar o rollback final.

### 19.6 Auditoria após interrupção por limite

Ao retomar a tarefa ainda em 26/08/2026, foi conferido se a execução anterior havia parado entre uma alteração e sua publicação:

- migrations local e remota continuam alinhadas até `284`;
- deployment `dpl_H9mTA1KPg5sftkn7baREkp8WuXnt` continua `Ready` e associado ao alias oficial;
- `npx tsc --noEmit` e `git diff --check` continuam aprovados;
- 14.953 eventos foram gravados depois do deployment, com evento recente no momento da consulta;
- os cinco workers estavam ativos, com heartbeat entre 5 e 30 segundos e sem `last_error_message`;
- telemetria desde o deploy registrou `events=17`, `incidents=16`, `summary=16` e `workers=16` respostas observadas, todas com zero erro 5xx;
- existem 76 incidentes ativos, dos quais 47 exigem ação; isso representa estado operacional real a ser acompanhado, não falha da implantação.

Foi encontrada uma única interrupção administrativa: a chamada anterior de automação havia criado somente uma sugestão visual e não uma agenda ativa. Isso foi corrigido nesta retomada:

- automação ativa: `fechar-rollout-dos-logs-instagram`;
- execução diária às 17:15, com instrução de confirmar pelo menos 24 horas desde o deploy antes de fechar a Fase 7;
- a automação deve se pausar após a auditoria, evitando repetições;
- Fase 8 continua proibida antes da aprovação desse gate.

### 19.7 Auditoria do gate após 24 horas — 27/08/2026

**Resultado:** gate da Fase 7 **reprovado**. A janela temporal terminou, mas os critérios técnicos não ficaram integralmente limpos. O rollback foi preservado e a Fase 8 não foi executada.

#### Janela e deployments

- deployment-base `dpl_H9mTA1KPg5sftkn7baREkp8WuXnt`: criado em 26/08/2026 às 16:54:17 BRT e ainda `Ready`;
- auditoria principal coletada em 27/08/2026 entre 17:22 e 17:25 BRT, aproximadamente 24 horas e 28 minutos depois do deployment-base;
- no momento da auditoria, o alias oficial já apontava para o deployment posterior `dpl_7KSd8Mv4x8mJ8P8Z6E5oFVob8ckb`, criado em 27/08/2026 às 13:01:12 BRT e `Ready`; a Central de Logs continuava presente e funcional nesse deployment;
- migrations locais e remotas estavam alinhadas até `292`.

#### Telemetria das APIs desde o deployment-base

| Rota | Requests | 5xx | Média | Máximo | p95 dos máximos de cada bucket de 5 min | Payload máximo |
|---|---:|---:|---:|---:|---:|---:|
| `events` | 119 | 0 | 2.588 ms | 23.807 ms | 16.138 ms | 76.541 bytes |
| `incidents` | 119 | 0 | 1.578 ms | 22.481 ms | 11.718 ms | 22.131 bytes |
| `summary` | 109 | 0 | 2.009 ms | 13.087 ms | 11.639 ms | 427 bytes |
| `workers` | 123 | 0 | 1.508 ms | 16.973 ms | 12.597 ms | 5.500 bytes |

- os payloads permaneceram abaixo do teto de 150 kB e as quatro APIs de leitura não registraram 5xx;
- a métrica disponível não guarda amostras individuais, portanto o valor de p95 acima é o p95 conservador dos máximos dos buckets, não o p95 bruto de requests;
- mesmo sem usar essa aproximação, as médias de `events` e `summary` já ficaram muito acima das metas de 300 ms e 500 ms;
- no smoke visual, a primeira leitura após cerca de 13 segundos ainda mostrava o skeleton; o conteúdo só foi confirmado depois de uma espera adicional. Isso confirma que a regressão é perceptível para o usuário e não apenas uma anomalia do benchmark.

#### Erros 5xx e retenção

- o cron da VPS continua instalado a cada cinco minutos com `flock`, mas o log apresentava falhas HTTP 500 repetidas;
- os logs da Vercel mostraram cinco respostas 500 recentes do endpoint `/api/internal/instagram-observability-maintenance`; a causa registrada foi `maintain_instagram_legacy_log_retention_batch: canceling statement due to statement timeout`;
- uma execução manual autenticada às 17:23 BRT respondeu `200`, sem linhas legadas removidas e sem erro, demonstrando comportamento intermitente dependente do custo da consulta;
- telemetria própria: zero registros vencidos e nenhum purge pendente;
- retenção legada na execução manual: `hasMore=false` e zero vencidos removidos em `publication_item_events`, ciclos de worker, sync logs, anomalias e rollups de request;
- retenção quente: 174.812 eventos, dos quais 54 estavam anteriores ao cutoff exato de 14 dias; o mais antigo era `2026-08-13T00:07:52Z` para um cutoff de `2026-08-13T20:22:08Z`;
- a função atual derruba somente partições cujo **dia inteiro** esteja antes do cutoff e limpa o default; ela não apaga a faixa vencida da partição de borda. Na prática, a retenção quente pode chegar perto de 15 dias, divergindo do requisito de manter apenas os últimos 14 dias.

#### Workers, incidentes e volume por domínio

- os cinco tipos esperados estavam ativos, sem `last_error_message`, com heartbeats de 2 a 20 segundos: publicação, planejamento, limpeza de mídia, analytics e sincronização Zernio;
- o PM2 da VPS confirmou todos os processos Instagram relacionados como `online`; nenhum restart foi provocado por esta auditoria;
- incidentes persistidos: 48 `action_required`, 1.112 `auto_recovering`, 18 `contained`, 1 `resolved` e zero `investigating`;
- volume desde o deployment-base: `account=453` (11 erros), `connection=2.093` (29 erros), `analytics=682`, `media=129`, `publication=112.474`; `scheduling` e `worker` não tiveram eventos brutos nessa janela, enquanto a saúde de workers permaneceu disponível pela projeção própria;
- a contagem exata adicional dos erros de `publication` chegou a timeout durante a auditoria; a última leitura completa, minutos antes, havia registrado 1.268. O timeout de uma contagem operacional reforça o bloqueio de desempenho.

#### Isolamento por papel e revisão visual

- 10/10 testes focados de observabilidade, resiliência e rollout passaram;
- contratos verificados: viewer sem ações e com evidências restritas; operator/admin com transições permitidas; host, PID e identificadores internos somente para superusuário;
- RLS das tabelas de incidentes e eventos continua limitada a membros da organização; telemetria da própria API permanece revogada de `anon` e `authenticated` e liberada somente para `service_role`;
- produção autenticada carregou resumo, filtros, incidentes, timeline e os cinco workers, sem erro ou warning no console;
- tema escuro confirmado com fundo `rgb(10, 10, 13)`;
- desktop em 1280 px e mobile em 390 × 844 ficaram sem overflow horizontal (`scrollWidth = clientWidth`); o botão principal `Atualizar` manteve 44 px no mobile.

#### Auditoria do legado e decisão da Fase 8

- comprovadamente sem consumidor fora do próprio bloco legado: `app/operacao/operation-client.tsx`, `/api/operation-events`, `/api/operation-attention-items`, `/api/operation-log-visibility`, `zernio-additions-client.tsx` e `clear-zernio-sync-conflicts-button.tsx`;
- devem ser preservados: redirects de `/operacao/adicoes-zernio` e `/operacao/quedas-zernio`, além de `zernio-global-removal-button.tsx` e sua API, porque a administração Zernio protegida ainda os consome;
- nenhuma remoção foi aplicada. TypeScript, build, suíte completa e smoke pós-remoção não foram executados porque pertencem ao gate da Fase 8 e remover o legado agora violaria a condição explícita de rollback;
- para reabrir a Fase 8 é necessário corrigir a latência das APIs, impedir o timeout do batch legado, tornar a retenção quente estritamente limitada a 14 dias e observar novamente esses sinais em produção.

### 19.8 Plano de correção para reabrir o gate

Esta etapa corrige primeiro as causas mensuradas. Ela não remove legado, não reinicia workers de publicação e não mistura otimização com a limpeza final da Fase 8.

#### Bloco A — diagnóstico de latência

1. ampliar a telemetria agregada para guardar duração por etapa e histograma de latência, permitindo calcular p50, p95 e p99 reais sem armazenar uma linha por request;
2. medir separadamente `getOrganizationContext`, query principal, enriquecimentos e resposta nas rotas `events`, `incidents`, `summary` e `workers`;
3. executar `EXPLAIN (ANALYZE, BUFFERS)` com a organização real nos seguintes recortes:
   - timeline padrão de 24 horas, 7 dias e 14 dias;
   - perfil + Story e perfil + Reel;
   - grupo por origem e membros atuais;
   - busca por código, request, post e texto;
   - incidentes ativos e por tratamento;
   - resumo de observabilidade e resumo da fila;
   - workers por tipo e último heartbeat;
4. verificar contenção causada pelas quatro chamadas simultâneas do primeiro carregamento;
5. registrar uma tabela antes/depois no plano. Nenhuma meta será considerada cumprida somente com benchmark sintético.

#### Bloco B — otimização das leituras

1. criar ou ajustar somente índices demonstrados pelos planos reais, sempre incluindo `organization_id` e o recorte temporal quando aplicável;
2. eliminar consultas auxiliares desnecessárias e evitar scans globais sem organização, como os que chegaram ao timeout durante a auditoria;
3. otimizar o enriquecimento dos 50 eventos com perfis, grupos e conexões; preferir uma projeção/RPC segura em uma ida ao banco se ela for mais rápida que as três consultas atuais;
4. revisar o resumo para identificar separadamente o custo de `get_instagram_observability_summary` e `get_publication_queue_operational_summary`;
5. se autenticação/contexto repetido for o maior custo, criar um endpoint de bootstrap que carregue as quatro seções em paralelo com isolamento de erro por seção; paginação e filtros continuam em endpoints independentes;
6. manter cursor, limite máximo de 50 eventos, payload abaixo de 150 kB e sanitização por papel.

#### Bloco C — retenção exata e cron confiável

1. criar migration forward-only que continue descartando partições totalmente vencidas e também apague, em lotes limitados, somente as linhas anteriores ao cutoff dentro da partição diária de borda;
2. confirmar após a manutenção que `count(occurred_at < now() - interval '14 days') = 0` na tabela quente;
3. adicionar índices temporais adequados em cada fonte legada usada por `maintain_instagram_legacy_log_retention_batch`;
4. processar cada fonte legada em lote independente, com resultado por tabela e continuidade segura quando uma fonte falhar; o endpoint não deve esconder sucesso parcial;
5. manter `flock`, limite de execução e segredo fora do crontab, mas registrar horário, duração, quantidade removida e fonte que falhou;
6. validar que tabelas autoritativas de perfis, publicações, lotes, conexões e saldos não entram na limpeza;
7. repetir manualmente até `hasMore=false` e depois deixar o cron operar sozinho durante a nova janela de 24 horas.

#### Bloco D — qualidade dos incidentes e cobertura dos domínios

1. agrupar os 1.112 incidentes `auto_recovering` por `stable_code`, etapa, provedor e fingerprint para localizar fragmentação por request, worker, item ou mensagem variável;
2. remover identificadores efêmeros da fingerprint, preservando diferenças que realmente mudam a causa ou a contramedida;
3. preparar consolidação segura dos incidentes duplicados, preservando contagem, primeiro/último evento, perfis afetados, entidades e auditoria;
4. confirmar que erros com retry automático continuam visualmente diferentes de erros que exigem ação humana;
5. testar produtores de `account`, `scheduling`, `publication`, `worker`, `connection`, `analytics` e `media`; domínio sem evento deve ter justificativa e projeção equivalente comprovada;
6. repetir os casos principais: perfil por `@`/nome, grupo, Story ausente, filtro por formato, conexão, lote, worker e busca textual.

#### Bloco E — validação e publicação

1. executar testes SQL das migrations, testes unitários das rotas e testes de autorização viewer/operator/admin/superusuário;
2. executar `npx tsc --noEmit`, `npm test`, `npm run build` e `git diff --check`;
3. publicar em produção sem remover os consumidores legados e confirmar o deployment/alias vigente;
4. executar smoke desktop e mobile, verificando tema escuro, overflow, alvos de toque, filtros persistidos, drawer, mensagens de falha parcial e console;
5. iniciar a Fase 7B e registrar no plano o horário exato do novo deployment e o início/fim das 24 horas.

#### Critérios numéricos para aprovar a nova janela

| Sinal | Critério obrigatório |
|---|---|
| APIs de leitura | zero 5xx na janela |
| Manutenção interna | 288/288 ciclos esperados sem 500, descontando apenas execução comprovadamente bloqueada por `flock` |
| Consulta de primeira página no banco | p95 aquecido abaixo de 300 ms |
| Resumo no banco | p95 aquecido abaixo de 500 ms |
| `events`, `incidents` e `workers` ponta a ponta | p95 abaixo de 1.000 ms e p99 abaixo de 3.000 ms |
| `summary` ponta a ponta | p95 abaixo de 1.500 ms e p99 abaixo de 3.000 ms |
| Primeira carga visual | conteúdo operacional útil em até 2 segundos e tela completa em até 3 segundos no desktop de produção |
| Payload de eventos | máximo de 150 kB por página |
| Retenção quente | zero evento anterior ao cutoff exato de 14 dias após cada ciclo concluído |
| Retenção legada e telemetria | zero vencido após drenagem; nenhuma tabela autoritativa afetada |
| Workers | 5/5 ativos, heartbeat inferior a 120 segundos e sem erro persistente |
| Papéis | viewer sem ações/evidência restrita; operator/admin somente com ações permitidas; infraestrutura apenas para superusuário |
| Interface | zero overflow horizontal, console limpo e todos os fluxos principais funcionando em desktop e mobile |

#### Condição para iniciar a Fase 8

A Fase 8 só será desbloqueada se todos os critérios acima passarem na mesma janela contínua de 24 horas. Se qualquer critério falhar, o deployment corretivo poderá permanecer ativo somente se não houver regressão funcional, mas o legado continuará disponível como rollback e uma nova janela será necessária após a correção.

Quando o gate passar, a remoção será limitada aos candidatos já auditados como órfãos. Os redirects antigos e a remoção global da administração Zernio permanecerão até uma auditoria específica provar que não possuem consumidores.

### 19.9 Execução da Fase 7A — 27/08/2026

**Estado atual:** correções principais publicadas, porém o gate continua bloqueado. Durante a validação surgiu saturação real do compute do Supabase; a causa introduzida pelo rollup síncrono foi removida, mas a estabilidade do projeto e a manutenção quente ainda precisam ser confirmadas antes de iniciar a Fase 7B.

#### Telemetria e leituras

- migration `293` adicionou histogramas agregados e duração por etapa sem criar uma linha por request;
- a gravação da telemetria saiu do caminho da resposta e passou a executar em `after()`, evitando que o usuário espere o RPC de métrica;
- `events`, `incidents`, `summary` e `workers` agora registram separadamente contexto, filtros, consulta, preferência e enriquecimento;
- migration `295` substituiu as duas chamadas de autenticação/contexto por uma RPC isolada, validada contra tentativa de selecionar organização pertencente a outro usuário;
- migration `296` criou projeção interna `service_role` para enriquecer timeline com perfil, grupo e conexão em uma ida ao banco;
- o enriquecimento observado caiu de centenas de milissegundos para aproximadamente 13 ms por request e depois para menos de 1 ms nas amostras aquecidas;
- migration `294` retirou o `count(*)` da tabela particionada do resumo e criou rollup de cinco minutos. O resumo caiu de aproximadamente 2,0–2,7 s para cerca de 800 ms na primeira amostra após a correção;
- nenhum 5xx foi observado nas quatro APIs de leitura nas amostras anteriores à saturação do compute.

#### Retenção

- migration `293` passou a remover exatamente a faixa anterior a 14 dias da partição diária de borda;
- após execução manual, a contagem de eventos com `occurred_at < now() - interval '14 days'` chegou a zero;
- as cinco fontes legadas passaram a ser processadas em transações independentes e receberam índices temporais;
- script da VPS registra horário UTC, código de saída, duração e resultado por fonte sem gravar segredo no crontab;
- ciclos confirmados em `23:25`, `23:30` e `23:40` UTC concluíram com `exit=0`; o ciclo de `23:35` isolou somente `publication_events`, e o ciclo seguinte drenou oito linhas dessa fonte;
- o endpoint passou a tentar novamente uma fonte legada com lote menor quando o primeiro lote falha.

#### Qualidade de incidentes

- auditoria encontrou 1.238 incidentes em recuperação automática, dos quais 1.233 eram de publicação e 1.210 vinham de `provider_request`;
- a fragmentação histórica foi atribuída à fingerprint v2 que incluía perfil, conexão, código/status exato e identificadores variáveis;
- migration `293` normalizou a fingerprint dos novos eventos por causa operacional e classe HTTP; a consolidação histórica ainda não foi executada para não alterar auditoria sem um merge dedicado e testado;
- erros com retry automático continuam separados visualmente dos erros que exigem ação humana.

#### Saturação encontrada durante a validação

- em 27/08 foram observados cerca de 133 mil eventos na partição do dia; os maiores volumes nas últimas 24 horas eram `queued` (35.144), `processing_deferred` (26.801) e `published` (21.609);
- o trigger criado em `294` fazia um upsert na mesma chave de rollup para cada evento, gerando contenção no bucket quente;
- migration `297` removeu o trigger por linha e criou recomposição idempotente em lote para a janela recente; a chamada isolada atualizou quatro grupos em 2.912 ms;
- durante o pico, até consultas simples alternaram entre ~500 ms, 8–30 s, timeout e `PGRST002`; o painel do Supabase chegou a mostrar `Status: Unhealthy` e `Compute: Unknown`;
- o PostgreSQL direto não mostrou query longa nem lock bloqueador, indicando indisponibilidade/saturação da camada de compute/conexões e não deadlock da aplicação;
- todos os processos PM2 permaneceram `online`, com baixo uso de CPU; nenhum worker foi reiniciado ou pausado;
- a limpeza foi bloqueada temporariamente somente pelo lock já usado no cron, por 30 minutos, para não competir com a recuperação do compute. Publicações, planejamento, mídia, analytics e sync continuaram ativos.

#### Retenção e manutenção divididas

- migration `298_split_instagram_hot_retention.sql` foi aplicada e separou `partitions`, `boundary_events`, `default_events`, `event_rollups`, `worker_rollups`, `incident_actions` e `resolved_incidents` em chamadas independentes e limitadas;
- o modo frequente executa somente telemetria, faixa exata da partição de borda e rollup recente; o modo diário percorre as demais seis fontes quentes e cinco fontes legadas, preservando o restante quando uma fonte falha;
- a VPS executa o modo frequente a cada cinco minutos e o diário às `06:17 UTC` (`03:17 BRT`), cada um com lock próprio e registro estruturado;
- a execução diária manual concluiu 10/11 fontes; somente `partitions` encontrou statement timeout ao tentar descartar partição durante o pico e ficou programada para nova tentativa na janela de menor carga;
- o lock temporário órfão foi identificado exatamente como PID `191835` (`sleep 1800`), removido sem tocar em worker ou serviço e o cron retomou;
- o ciclo manual das `00:40 UTC` concluiu em `1.499 ms`, removendo 16 eventos que cruzaram a fronteira; o primeiro ciclo automático após a retomada concluiu às `00:45 UTC` em `1.948 ms`;
- às `00:50 UTC`, durante recarga do schema do PostgREST, um ciclo falhou com `PGRST002`; por isso essa amostra não inicia a janela da Fase 7B.

#### Redução de carga da leitura

- o cliente deixou de liberar a interface somente depois das quatro APIs: resumo e timeline agora aparecem na primeira onda, enquanto incidentes e workers carregam depois;
- a atualização automática passou de quatro APIs a cada 30 segundos para somente resumo/timeline a cada 120 segundos; o botão **Atualizar** continua recarregando todas as seções;
- migrations `299` e `300` criaram e preencheram snapshots de resumo por organização, retirando a agregação de incidentes do caminho de cada request;
- o backfill confirmou três organizações e 131.420 eventos agregados nas últimas 24 horas; a leitura direta do snapshot respondeu em 727 ms durante a recuperação do compute;
- a primeira recomposição via PostgREST mostrou que `count(distinct profile_id)` ainda excedia o statement timeout; migration `301` preserva a cardinalidade exata já calculada e atualiza no ciclo quente apenas contadores de incidentes, domínios e eventos;
- respostas 500 de `events` e `summary` passaram a alimentar a própria telemetria com duração por etapa, em vez de retornarem antes do registro;
- o smoke do deployment intermediário confirmou tema escuro e dados autenticados, mas ainda encontrou falha parcial e reload de aproximadamente 10 segundos antes do snapshot; essa evidência bloqueou corretamente o gate e motivou `299`–`301`.

#### Validações concluídas e pendentes

- migrations `293`–`301`: aplicadas remotamente; testes SQL novos existem para `297`–`299`, mas a execução local continua aguardando o Docker Desktop voltar a ficar disponível;
- TypeScript, build local e suíte completa foram repetidos após as mudanças: 297/297 testes aprovados;
- deployments corretivos mais recentes: `dpl_5Wcw9Xrw24bDnnZodHJKh7PRvRM3`, `dpl_5bmMnoNw4Hwe6eZG3pt7XruL43AY` e `dpl_HtWuAu3uPcx6YiiLmQ6ka71984wY`, este último com polling reduzido, snapshot e telemetria de erros;
- todos os processos PM2 permaneceram `online`, com CPU em 0% na amostra e sem reinício operacional provocado por esta fase;
- o banco direto não mostrou query bloqueadora nem lock exclusivo de aplicação; o banco possui 3.312 MB, hit rate de índice/tabela em 1,00 e WAL de 464 MB na amostra;
- Fase 7B não começou. É obrigatória uma nova janela contínua de 24 horas depois de `301`, cron estável, PostgREST saudável e nova baseline autenticada de latência;
- Fase 8 permanece bloqueada e nenhum arquivo legado foi removido.

### 19.10 Proteção estrutural contra operações pesadas concorrentes

**Motivo incluído em 27/08/2026:** a saturação foi reproduzida quando três ações legítimas se sobrepuseram: geração de filas muito grandes, limpeza massiva de encerradas e sincronização geral da Zernio. O usuário não deve precisar coordenar manualmente essas ações. A aplicação precisa aplicar backpressure global e preservar capacidade para publicação em horário, autenticação e leitura da interface.

#### Execução imediata concluída

- a captura do Supabase confirmou compute em `100%`, CPU em `97%`, memória em `90%`, I/O em `100%` e 37/60 conexões;
- a preparação de publicação deixou de executar até 100 itens simultaneamente e passou a preservar o lote com concorrência interna máxima de quatro;
- o gerador compacto caiu de 20 para um chunk por ciclo, sem cancelar o job ou perder slots;
- o polling ocioso dos workers X passou de cinco para 15 segundos, sem pausar filas;
- depois de o Data API permanecer sem entregar bytes por 25–60 segundos, o projeto Supabase foi reiniciado pelo endpoint oficial e voltou `ACTIVE_HEALTHY`;
- o Data API recuperou de timeout superior a 60 segundos para `200` em 685 ms e depois 554 ms;
- o ciclo automático das `01:50 UTC` concluiu em 1.031 ms, os cinco workers ficaram saudáveis e a tela autenticada completou os dados em 1.699 ms;
- a manutenção diária drenou a partição antiga, oito rollups e dez eventos legados; a consulta posterior encontrou zero evento quente anterior ao cutoff exato de 14 dias.

#### Implementação estrutural concluída

- migration `302_global_heavy_workload_backpressure.sql` criou um único lease global, expirável e protegido por papel para `bulk_generation`, `queue_cleanup` e `zernio_sync`;
- geração em massa, limpeza de encerradas e sincronização geral Zernio passaram a disputar esse orçamento. O worker de publicação em horário não adquire o lease e continua prioritário;
- o lease expira sozinho entre 15 e 300 segundos e pode ser liberado antecipadamente pelo mesmo token, impedindo bloqueio permanente após queda de processo;
- a limpeza passou a arquivar no máximo 250 itens por transação, aguarda um segundo quando a capacidade está ocupada e adiciona 250 ms entre lotes. A interface apresenta essa espera como proteção normal e preserva o progresso já concluído;
- o índice parcial `publication_items_finished_cleanup_idx` passou a atender somente itens terminais ainda visíveis que podem ser arquivados;
- o gerador processa somente um chunk compacto por ciclo e libera o lease em `finally`;
- a sincronização Zernio processa adições de conexão primeiro, limita a fila geral a dois perfis por ciclo e libera o lease em `finally`;
- o teste vivo da RPC confirmou exclusão mútua, liberação e nova aquisição. Com geração ativa, o log real do worker Zernio registrou `waitingForCapacity: true` e, no ciclo seguinte, retomou normalmente com zero itens pendentes;
- os dois workers foram instalados na VPS com hashes locais/remotos idênticos e reiniciados isoladamente. `athena-generation-worker` e `athena-zernio-sync-worker` permaneceram `online`;
- após o restart controlado, ambos permaneceram nove minutos sem novo restart na amostra final; as mensagens `PGRST002` ainda visíveis no arquivo de erro pertencem à indisponibilidade anterior ao reinício do Supabase, enquanto os ciclos novos concluíram normalmente;
- a migration `302` foi aplicada no Supabase remoto. O teste SQL transacional cobre exclusão mútua, liberação, nova aquisição, categoria inválida e teto da limpeza; a execução SQL local ainda depende do Docker Desktop, mas o contrato central foi exercitado no projeto remoto sem resíduos;
- `supabase migration list --linked` confirmou migrations locais e remotas alinhadas de `001` a `302`;
- os testes de regressão confirmam também que o worker de publicação em horário não participa do bloqueio pesado.

#### Publicação e smoke da proteção

- `npx tsc --noEmit`, `npm run build` e `git diff --check` concluíram sem erro;
- suíte completa: 298 testes aprovados, zero falhas; o gate focado de fila/dispatcher aprovou 35/35 testes;
- deployment de produção: `dpl_1LP962S2Mj15vMwJ4M6Ey27H5rVw`, alias `https://pomodoro-theta-one-82.vercel.app`;
- a Central autenticada carregou 90 cards, cinco de cinco workers e todos os filtros, em tema escuro, sem overflow horizontal (`1265 = 1265`) e sem falha parcial;
- a Fila autenticada carregou o shell em 1.222 ms e os agregados assíncronos em seguida: 92.180 itens, 47.701 encerrados elegíveis para limpeza e 50.919 pendentes, sem trazer todos os itens detalhados para o navegador;
- Central e Fila permaneceram sem erro no console e sem overflow horizontal. O deployment novo não apresentou resposta 5xx nos logs inspecionados após a publicação;
- os cinco tipos de worker continuaram com heartbeat recente e sem `last_error_message`: publicação, planejamento, limpeza de mídia, analytics e sincronização Zernio.

#### Decisão de rollout

- o ciclo frequente pós-deployment das `02:10:03 UTC` terminou com `exit=0` em 2.283 ms, `hasMore=false`, zero falha, um evento de borda removido, 38 rollups recompostos e três snapshots atualizados;
- às `02:10:38 UTC`, a retenção quente estava exatamente zerada antes do cutoff de 14 dias e o slot pesado estava livre, sem holder ou expiração residual;
- a Fase 7B começou nesse ciclo e termina, no mínimo, em `29/08/2026 02:10:03 UTC` (`28/08/2026 23:10:03 BRT`);
- a automação `fechar-rollout-dos-logs-instagram` foi reativada para `28/08/2026 23:15 BRT`, apontando para o novo deployment e para esta janela; ela deve se pausar depois de registrar o resultado;
- a Fase 8 continua bloqueada durante toda a janela. Qualquer 5xx, worker stale, retenção vencida depois de ciclo concluído ou regressão dos limites numéricos reinicia a contagem e preserva o legado.

### 19.11 Gate interrompido por saturação estrutural do banco — 27/08/2026

- após o início da Fase 7B, o Supabase voltou a atingir 100% de compute e I/O sob a soma de geração, publicação, preparação e manutenção, mesmo com a exclusão mútua entre geração, limpeza e sincronização Zernio;
- a janela iniciada às `23:10:03 BRT` não pode mais aprovar a Fase 7, pois houve `statement_timeout` real na geração e saturação sustentada do compute;
- a Fase 8 continua bloqueada e nenhum legado deve ser removido;
- o diagnóstico e a execução corretiva passam a ser controlados pelo plano dedicado `plans/plano-estabilizacao-supabase-carga-e-upgrade-2026-08-27.md`;
- somente depois do gate de capacidade, do upgrade controlado e de 24 horas contínuas estáveis uma nova Fase 7B poderá começar.

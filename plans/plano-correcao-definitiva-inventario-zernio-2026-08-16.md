# Plano de correção definitiva do inventário Zernio

## Objetivo

Eliminar a divergência entre o inventário remoto da Zernio e o Athena, tornar a sincronia mestre convergente e fechar as lacunas de concorrência, durabilidade, analytics e apresentação identificadas na auditoria complementar. Este documento substitui decisões ambíguas do plano anterior para este incidente e organiza a implementação futura em fases independentes, observáveis e reversíveis.

## Decisão operacional confirmada

1. A resposta atual de `GET /v1/accounts` de cada API key Zernio é a autoridade sobre quais contas Instagram existem naquela chave.
2. O Athena deve refletir esse inventário: conta remota ausente localmente deve ser importada; vínculo local apontando para a chave errada deve ser corrigido; vínculo local sem correspondente remoto deve ser classificado e removido apenas pelo fluxo auditável apropriado.
3. Uma identidade encontrada em duas chaves não pode permanecer duplicada. Uma ocorrência canônica será preservada e a excedente será desconectada remotamente somente após snapshot, prova da duplicidade e verificação de ausência de publicação em andamento.
4. Todas as contas são de propriedade do usuário e ele autorizou corrigir vínculos e remover duplicidades excedentes entre as chaves relacionadas às três contas usuárias abrangidas pela operação.
5. A autorização não elimina guardrails: nunca expor segredo, nunca escolher a ocorrência a remover sem regra determinística, nunca apagar a única ocorrência remota e nunca interromper publicação em execução.

## Causas raiz comprovadas

### 1. Anastacio mostra `0/2`, mas tem duas contas remotas

- A chave `AnastacioTawes66395` responde normalmente e possui duas contas Instagram saudáveis na Zernio.
- O `0` exibido não vem da Zernio. A projeção conta apenas perfis locais cujo `zernio_connection_id` aponta para a conexão atual em [`zernio_connections_safe`](../supabase/migrations/118_fix_zernio_safe_view_reservation_access.sql:29).
- As duas identidades remotas existem no Athena, mas apontam para outra conexão local. Isso produz `0/2` no cartão de Anastacio e conflitos durante a reconciliação.
- O `2` é o limite local configurável `instagram_slot_limit`, não o limite externo do plano Zernio.
- A interface chama essa composição local de capacidade e cria uma interpretação incorreta em [`connectionOptionLabel()`](../app/zernio/zernio-client.tsx:67).

### 2. O bloqueio externo é real neste caso

- A operação que falha é `GET /v1/connect/instagram`, chamada por [`startConnect()`](../lib/integrations/zernio-client.ts:254), antes do redirecionamento OAuth.
- Três tentativas persistidas receberam a mensagem sanitizada `Add a payment method to connect more than 2 accounts`.
- `GET /v1/accounts` retorna duas contas; `GET /v1/accounts/health` indica duas saudáveis; `GET /v1/billing` indica acesso geral permitido.
- A documentação oficial informa o gate `PAYMENT_REQUIRED` para exceder o free tier. Portanto, a chave está online, mas não pode iniciar uma terceira conexão sem atender ao requisito externo.
- [`isZernioPlanLimitError()`](../lib/integrations/zernio-client.ts:218) classificou corretamente este incidente, porém sua heurística textual é ampla demais e pode classificar outros erros incorretamente.

### 3. O botão Sincronia de contas está quebrado antes da VPS

- A rota [`POST()`](../app/api/integrations/zernio/sync-all/route.ts:8) retornou HTTP 500 em produção.
- A RPC [`enqueue_zernio_organization_sync_batch()`](../supabase/migrations/115_zernio_async_sync_jobs.sql:36) falha com PostgreSQL `42804`.
- O `CASE` em [`enqueue_zernio_organization_sync_batch()`](../supabase/migrations/115_zernio_async_sync_jobs.sql:77) produz texto para uma coluna do enum `zernio_sync_batch_status`.
- A transação reverte antes de criar lote ou itens. O worker permanece saudável, mas recebe zero itens; ele não é a causa do erro.

### 4. O feedback está no contexto errado

- O erro é disparado dentro do fluxo do modal Conectar conta em [`ProfilesClient()`](../app/perfis/profiles-client.tsx:1013).
- Após o redirect, o modal deixa de representar a operação e o erro aparece somente na região global em [`ProfilesClient()`](../app/perfis/profiles-client.tsx:788).
- O feedback deve voltar ao modal que iniciou a conexão, preservando chave selecionada, motivo estruturado e ação recomendada.

### 5. O Bulk Zernio ignora os limites individuais já cadastrados

- O modal Bulk mantém um valor global em [`bulkZernioMaxSlots`](../app/perfis/profiles-client.tsx:374), iniciado em 2.
- O plano é calculado passando esse único valor para todas as conexões em [`buildBulkZernioRows()`](../app/perfis/profiles-client.tsx:452).
- O helper [`buildBulkZernioRows()`](../lib/integrations/zernio-bulk.ts:100) nem recebe `instagram_slot_limit` por conexão; ele calcula todas as vagas com o mesmo `maxSlotsPerConnection`.
- Consequentemente, alterar o limite de uma chave em Zernio não altera a distribuição do Bulk em Perfis. Há duas fontes de verdade para a mesma decisão.
- O campo manual `Máximo por conta Zernio` em [`ProfilesClient()`](../app/perfis/profiles-client.tsx:1120) deve ser removido. Cada linha deve respeitar o limite persistido da própria conexão e a ocupação remota mais recente.

### 6. Não existe preferência administrativa para o limite de futuras chaves

- A coluna `instagram_slot_limit` possui default técnico 2 em [`114_zernio_connection_slot_reservations.sql`](../supabase/migrations/114_zernio_connection_slot_reservations.sql:4).
- Esse default não pode ser alterado pela organização na tela Zernio e não representa uma preferência persistida para novas importações.
- O provisionamento em [`provisionZernioConnection()`](../lib/integrations/zernio-connection-provisioning.ts:31) não recebe limite e depende implicitamente do default fixo do banco.
- É necessário um campo administrativo em Zernio para `Limite padrão das próximas contas`, com valor inicial 2, sem alterar retroativamente as conexões existentes.

### 7. Os botões dos cards misturam inventário, saúde e analytics

- `Sincronizar métricas` chama a rota de reconciliação de contas em [`syncConnection()`](../app/zernio/zernio-client.tsx:304). O nome está errado: a ação lista contas, reconcilia perfis e pode enfileirar analytics como efeito posterior.
- `Atualizar todas` aparece repetido em cada card, mas chama o mesmo refresh global de analytics em [`requestMetricsRefresh()`](../app/zernio/zernio-client.tsx:138). Um botão visualmente pertencente a uma chave dispara trabalho para perfis da organização inteira.
- `Checar` chama [`POST()`](../app/api/integrations/zernio/connections/[connectionId]/health/route.ts:9), que lista contas e atualiza billing/status, mas não usa o resumo de `GET /v1/accounts/health` nem reconcilia o inventário.
- As três ações têm sobreposição e rótulos insuficientes. A página Zernio deve tratar chaves e inventário; analytics globais não devem ser disparados a partir de cada card.

### 8. Nomes longos quebram a composição visual do card

- O card possui `overflow: hidden`, mas o título em [`app/globals.css`](../app/globals.css:1306) não define `min-width: 0`, `overflow-wrap`, `word-break` ou estratégia de truncamento.
- A composição flex da linha superior e os filhos de grid podem manter largura mínima intrínseca, permitindo que nomes contínuos alarguem ou deformem o conteúdo.
- A correção precisa cobrir título, identificador de profile, detalhes, badges, ações e modal, em desktop e celular, sem esconder silenciosamente o nome completo.

## Auditoria complementar somente leitura — 2026-08-16

### Escopo e distinção temporal

- A auditoria complementar comparou migrations, rotas, bibliotecas, workers, configuração PM2 e evidências sanitizadas de produção. Não criou duplicidades, não chamou `DELETE` e não alterou dados.
- O erro PostgreSQL `42804` descrito na causa raiz 3 é um achado histórico comprovado do snapshot anterior: naquela execução, a transação de enqueue revertia antes de criar itens.
- No estado complementar mais recente, o código e os consumidores estavam implantados, os cinco processos relevantes estavam online e já existia lote de sincronia concluído com erros. Portanto, a Fase 1 deve primeiro detectar o estado efetivamente aplicado e validar o contrato; não deve presumir que o pipeline continua totalmente parado nem reaplicar migration antiga.
- Pipeline ativo não significa contrato completo: a auditoria confirmou processamento real, mas também caminhos que podem adiar trabalho sem persistência, repetir indefinidamente, concluir sem analytics ou deixar a tela desatualizada.

### Evidência sanitizada observada

- PM2 reportou online os workers de geração, manutenção de mídia, analytics, publicação e sincronia Zernio.
- O consumidor de reciclagem em [`processZernioProfileRecyclingJobs()`](../scripts/workers/publication-direct-dispatch.mjs:843) e o agendamento de duplicidade em [`schedule_zernio_duplicate_identity_disconnection()`](../supabase/migrations/116_zernio_duplicate_remote_disconnection.sql:29) estavam presentes no código implantado.
- Foram observados 11 incidentes de desconexão e 11 jobs de reciclagem, todos concluídos como remoção remota, sem job aberto ou lease vencido na amostra. A amostra não continha incidente de duplicidade nem incidente com `profile_id` nulo; por isso, esse caminho permanece comprovado por contrato de código, mas ainda precisa de teste controlado antes de aceite operacional.
- O snapshot remoto consultou 128 conexões sem erro de API, encontrou 78 perfis locais ativos, nenhuma duplicidade local, três grupos de `accountId` remoto em múltiplas chaves e quatro grupos de username remoto em múltiplas chaves, todos dentro de uma única organização.
- Foram observadas 142 tentativas OAuth: 112 sincronizadas, 12 falhas, duas vazias e 16 ainda em `redirected` após tempo incompatível com uma operação ativa. Isso comprova ausência de encerramento explícito para tentativas abandonadas.
- Havia duas reservas persistidas, ambas liberadas, sem reserva ativa ou expirada na amostra. Isso valida o caminho comum, mas não prova correção sob disputa intensa.
- Nos 100 jobs recentes de analytics, 56 terminaram sem erro e 44 registraram erros; nos 100 itens recentes, 95 sincronizaram e cinco falharam. Na amostra ampliada de 1.000 itens, 924 sincronizaram e 76 falharam, todos com uma única tentativa observada.
- O worker de analytics estava online, porém seus logs recentes continham `ConnectTimeoutError` e `HeadersTimeoutError`. Os heartbeats apresentavam desvio aproximado de três horas em relação à atividade indicada pelo PM2 e pelos logs, exigindo validação de relógio, fuso e semântica dos timestamps.

### Sete fontes de risco avaliadas e diagnóstico consolidado

1. Ausência do consumidor de remoção remota: descartada no estado observado; o consumidor estava implantado e ativo.
2. Incompatibilidade de `profile_id = null`: não reproduzida em produção, mas o schema atual aceita esse caso; falta teste ponta a ponta.
3. Perda de trabalho por publicação ativa ou reaparecimento de duplicidade: confirmada no contrato, pois o adiamento não gera estado durável e um job concluído pode impedir novo enqueue por conflito.
4. Repetição ilimitada de remoção: confirmada no contrato, pois erros retryable e terminal seguem o mesmo requeue sem limite nem dead-letter.
5. Corrida Bulk/OAuth: confirmada no desenho; a lista é apenas estimativa, a reserva ocorre no start, não há idempotência por intenção e callbacks concorrentes podem disputar o mesmo conjunto de contas novas.
6. Sincronia geral incompleta: confirmada; o worker direto reconcilia inventário presente, mas não trata ausentes como reconciliação integral, não reutiliza todo o caminho compartilhado e não enfileira analytics dos perfis afetados.
7. Fragilidade de analytics e apresentação: confirmada; falha de item não recebe retry efetivo e a UI encerra polling sem recarregar os dados dos cards.

As duas fontes dominantes são contratos assíncronos incompletos — ausência de estado durável, transições monotônicas, retry terminal e reconciliação integral — e duplicação de caminhos para operações conceitualmente iguais. As fases abaixo devem validar essas hipóteses com logs estruturados e métricas antes de mudar comportamento destrutivo.

### Instrumentação mínima antes de cada correção

- Adotar `correlation_id`, `organization_id`, IDs internos de conexão/job/item/attempt, estado anterior, estado seguinte, número da tentativa, classificação do erro e latência, sem API key, token, URL assinada ou payload sensível.
- Registrar contadores para `deferred_active_publication`, `duplicate_reopened`, `retry_scheduled`, `dead_lettered`, `oauth_intent_reused`, `callback_ignored_terminal`, `remote_snapshot_stale`, `inventory_absent_remote`, `analytics_retry_scheduled` e `ui_revalidated`.
- Medir idade do item mais antigo, leases expirados, tentativas OAuth abandonadas, divergência entre inventário local/remoto, taxa de timeout e relógio observado pelo banco, aplicação e VPS.
- Cada fase deve começar em modo observação ou dry-run, produzir baseline e somente depois habilitar escrita por feature flag ou escopo canário.

## Contrato de convergência

Para cada chave ativa das três contas usuárias, produzir um snapshot com:

- organização, conexão e rótulo;
- `accountId`, `profileId`, username normalizado e saúde retornados pela Zernio;
- perfil Athena correspondente, conexão local atual e estado;
- tentativas que originaram o vínculo;
- classificação `convergente`, `remoto_ausente_local`, `local_chave_errada`, `local_sem_remoto`, `duplicado_mesma_organizacao`, `duplicado_entre_organizacoes` ou `erro_api`;
- decisão proposta, evidência, ocorrência canônica e ocorrência excedente;
- resultado final e incidente de auditoria quando houver remoção.

A operação só termina quando uma segunda leitura de todas as chaves produzir:

- zero contas remotas ausentes no Athena;
- zero perfis locais ativos apontando para chave diferente da origem remota escolhida;
- zero duplicidades não classificadas;
- zero remoções sem incidente;
- zero chaves sem resultado ou com erro silencioso.

## Regra para escolher e corrigir a ocorrência canônica

1. Se a identidade existir em somente uma chave remota, essa chave é a origem canônica e o Athena deve apontar para ela.
2. Se existir em mais de uma chave, preservar preferencialmente a ocorrência saudável que corresponde ao vínculo confirmado pela tentativa OAuth mais antiga concluída.
3. Na ausência dessa prova, preservar a ocorrência com histórico local saudável mais antigo.
4. Persistindo empate, preservar a conexão mais antiga e usar o menor ID apenas como desempate técnico.
5. Antes de remover a excedente, bloquear por identidade e verificar publicações em preparação, publicação ou geração. Se houver risco, criar estado pendente e não remover naquele ciclo.
6. Remover remotamente a excedente por `DELETE /v1/accounts/:accountId`, tratar `404` como sucesso idempotente e concluir limpeza local transacionalmente.
7. Registrar no relatório a identidade, chave preservada, chave removida, regra de decisão, request ID sanitizado, resultado remoto e momento em `America/Sao_Paulo`.

## Fases de execução

### Fase 0 — Congelamento e baseline

- Impedir novas ações destrutivas automáticas durante o primeiro snapshot das três contas.
- Registrar deployment, migrations aplicadas, estado dos workers e IDs das três contas/organizações.
- Tirar snapshot completo remoto e local antes de qualquer alteração.
- Armazenar evidência sanitizada e um identificador de execução para rollback lógico e auditoria.

**Executada em 16/08/2026:** snapshot sanitizado das 128 conexões ativas concluído sem erro de API, cobrindo 82 contas remotas e 78 vínculos locais. Foram detectadas 3 contas remotas repetidas entre chaves e 4 usernames repetidos entre chaves. A remoção automática foi congelada, com correlação `85fc1bc3-f8ac-48ba-8b72-21fe04d2bded`, nas 2 organizações encontradas no escopo. Durante a validação não foram criados incidentes nem jobs destrutivos pelo worker de sincronia.

### Fase 1 — Reparar a sincronia mestre

- Consultar migrations aplicadas e executar uma chamada controlada de enqueue para determinar se o erro histórico `42804` ainda existe no deployment atual.
- Se o erro persistir, criar migration que tipa explicitamente os ramos do `CASE` como `zernio_sync_batch_status`; se já estiver corrigido, registrar a migration responsável e não criar correção redundante.
- Não editar uma migration já aplicada; criar uma migration corretiva nova.
- Adicionar teste SQL para organização sem conexões, organização com conexões, reutilização de lote ativo e duas chamadas concorrentes.
- Fazer a rota registrar código PostgreSQL, correlação e organização de forma sanitizada.
- Fazer a UI preservar a mensagem útil e um código de correlação sem vazar detalhes internos.
- Validar que o endpoint retorna `202`, cria itens, a VPS os reivindica e o lote chega a estado terminal coerente mesmo com falha parcial.

**Executada em 16/08/2026:** as migrations 119 e 120 corrigiram os dois `CASE` sem cast explícito — enqueue do lote e conclusão do item — e adicionaram correlação e controle operacional. O lote de produção `7b02f961-24c9-4461-acc9-3777c6cebb93`, correlação `b8cdf41f-f657-4f82-af7f-e3954896ffb2`, criou 108 itens, foi integralmente reivindicado pela VPS e terminou como `completed_with_errors`, com 108 itens concluídos, 67 contas sincronizadas, 3 conflitos e 0 falhas terminais. O estado é coerente: conflitos tornam o lote concluído com ressalvas. O worker foi atualizado com erros estruturados e sanitizados, correlação por lote e validação dos writes auxiliares; permaneceu online após o deploy. TypeScript, sintaxe do worker, build local e build/deploy de produção na Vercel passaram. O teste SQL transacional foi ampliado para cobrir também claim e conclusão, mas sua execução local segue reservada à fase final porque o ambiente local não possui Docker.

### Fase 2 — Corrigir o modelo de ocupação

- Separar `perfis Athena vinculados`, `contas remotas Zernio`, `reservas locais`, `limite local de concorrência` e `gate externo do plano`.
- Persistir o último snapshot remoto por conexão com contagem, timestamp, saúde e erro estruturado.
- O seletor de conexão deve usar a ocupação remota recente como fonte primária; snapshot ausente ou vencido exige consulta antes de reservar.
- O limite local continua configurável, mas não pode ser apresentado como limite do plano nem autorizar uma terceira conexão quando o remoto já contém duas.
- Para Anastacio, a UI deve explicar `2 contas na Zernio`, `0 vínculos atualmente atribuídos a esta chave no Athena` até a correção e `nova conexão bloqueada pela Zernio`.

**Implementada em 16/08/2026:** a migration 121 separou a contagem remota e seu timestamp dos vínculos locais, reservas e limite configurado. O worker passou a persistir snapshots remotos por conexão. Uma execução controlada nas 20 conexões da organização principal terminou com 20/20 snapshots, 12 contas remotas, 11 vínculos locais e 1 conflito preservado. Os cards agora exibem separadamente `na Zernio`, `vínculos no Atena` e `reservas`, usando a maior ocupação confiável apenas para o rótulo de capacidade enquanto a convergência definitiva permanece congelada.

### Fase 2A — Limite padrão das próximas conexões

- Criar preferência por organização `default_instagram_slot_limit`, administrável somente por admin, com fallback seguro 2 e validação entre 1 e 100.
- Não reutilizar a tabela legada de credencial única [`zernio_organization_settings`](../supabase/migrations/053_add_zernio_instagram_provider.sql:8), pois ela exige uma API key e pertence ao modelo anterior de uma conexão por organização.
- Persistir a preferência em uma configuração específica do modelo multi-conexão, com RLS, projeção segura e trilha `updated_at` e `updated_by`.
- Exibir em Zernio um campo separado e inequívoco: `Limite padrão para novas contas`, acompanhado do texto `Aplica-se somente às contas adicionadas depois de salvar`.
- Manter o default 2 no schema como última proteção, mas fazer tanto o cadastro unitário quanto a importação em lote gravarem explicitamente a preferência vigente.
- Capturar o limite no momento em que o lote de importação é criado, para que alterar a preferência durante o processamento não produza limites diferentes dentro do mesmo lote.
- Não alterar conexões já existentes ao salvar a preferência. Alterações retroativas continuam sendo feitas no modal Configurar de cada conexão.

**Implementada em 16/08/2026:** foi criada configuração multi-conexão por organização, com padrão 2, validação de 1 a 100, RLS e auditoria de usuário/data. A tela Zernio recebeu o campo administrativo e o cadastro unitário consulta a preferência vigente. A importação em lote captura o valor no batch e em cada item, garantindo resultado estável mesmo que a preferência mude durante o processamento. Conexões existentes não são alteradas.

### Fase 2B — Bulk sem limite manual duplicado

- Remover `bulkZernioMaxSlots`, seu input e a dependência global de `maxSlotsPerConnection` de [`ProfilesClient()`](../app/perfis/profiles-client.tsx:342).
- Ampliar [`NamedZernioConnection`](../lib/integrations/zernio-bulk.ts:1) para receber o limite individual, ocupação remota recente, reservas ativas e validade do snapshot.
- Calcular por conexão `vagas = limite individual - maior ocupação confiável - reservas ativas`, sem permitir valor negativo.
- Enquanto a reconciliação definitiva não estiver concluída, usar a maior ocupação entre remoto recente e vínculo local para evitar oferecer uma vaga inexistente. Após convergência, o remoto permanece autoridade e o local funciona como verificação de integridade.
- Chave sem snapshot remoto válido não entra silenciosamente na lista: deve ser consultada ou marcada como indisponível até atualização.
- O Bulk gera no máximo a quantidade solicitada, distribuída pelas chaves conforme o limite próprio de cada uma; o backend ainda faz reserva atômica antes de iniciar OAuth.
- Identificar a prévia como estimativa não vinculante e informar explicitamente que copiar a lista não reserva slots.
- Adicionar testes para limites heterogêneos, por exemplo 1, 2 e 4; chaves cheias; reservas simultâneas; snapshot vencido; e quantidade maior que a capacidade agregada.

**Implementada em 16/08/2026:** o campo global `Máximo por conta Zernio` foi removido do Bulk. O cálculo agora usa, para cada chave, seu limite individual menos a maior ocupação entre inventário remoto recente e vínculos locais, menos reservas ativas. Snapshots ausentes, com erro ou com mais de 30 minutos ficam explicitamente indisponíveis até nova sincronia. A prévia passou a informar que é uma estimativa e que copiar não reserva capacidade. A migration 122 aplicou a mesma regra conservadora à reserva transacional do backend sob advisory lock, impedindo que a UI e o início do OAuth usem fórmulas diferentes. A sincronia individual e o cadastro de novas chaves também passaram a persistir snapshot remoto. TypeScript, oito testes unitários do Bulk, build local, migration remota e build/deploy Vercel passaram; o congelamento destrutivo permaneceu ativo.

### Fase 2C — Intenção Bulk idempotente e reserva concorrente

- Criar uma intenção persistida por organização, usuário, dispositivo/sessão e ação Bulk, com chave idempotente, quantidade, grupo solicitado, snapshot de configuração e expiração.
- Fazer duplo clique, retry de rede e reenvio do mesmo celular reutilizarem a intenção, sem criar tentativas ou reservas adicionais.
- Manter a reserva atômica no backend imediatamente antes do OAuth; a lista copiada continua sem reserva antecipada para não bloquear capacidade por horas.
- Vincular cada reserva e cada tentativa OAuth a uma única intenção e a uma conexão escolhida. Depois de emitido o OAuth, a tentativa não pode trocar silenciosamente de chave.
- Antes do OAuth, revalidar snapshot remoto, ocupação local e reservas ativas. Se a chave ficou inelegível, escolher fallback uma única vez, registrar motivo e apresentar a troca ao usuário.
- Se a Zernio rejeitar por capacidade remota, permitir no máximo um fallback controlado para outra chave elegível antes de criar o redirect; nunca reiniciar automaticamente depois que o OAuth externo começou.
- Evitar starvation com ordenação por ocupação e rotação determinística entre chaves equivalentes; aplicar cotas por usuário/intenção quando dezenas de dispositivos disputarem capacidade.
- Exibir o aviso de fallback no modal que iniciou a operação, antes do redirect quando possível, e manter resumo secundário após o callback.

**Implementada em 16/08/2026 (núcleo de segurança):** a migration 123 criou intenção durável por organização, usuário e chave de idempotência, vinculada de forma única à reserva e à tentativa OAuth. O modal gera uma chave por abertura e a rota de início reutiliza/bloqueia retries e duplos cliques antes de reservar. O início revalida snapshots vencidos diretamente na Zernio antes da reserva atômica; a conexão resolvida pelo fallback fica gravada na intenção e na tentativa. O callback passou a ignorar o `connectionId` recebido quando há tentativa, exige o mesmo usuário que iniciou e não reabre estados terminais. Transições para callback, sucesso ou falha tornaram-se monotônicas e atualizam também a intenção. Migration remota, TypeScript, build local e novo deploy Vercel passaram. Fairness avançada e aviso de fallback antes do redirect continuam para a validação de concorrência final.

### Fase 3 — Reconciliação integral das três contas

- Enumerar todas as API keys ativas pertencentes às três contas usuárias.
- Consultar individualmente `GET /v1/accounts` e `GET /v1/accounts/health` em cada chave, com retry limitado e sem paralelismo agressivo.
- Cruzar todo o inventário por `accountId`, `profileId` e username normalizado.
- Importar perfis remotos ausentes localmente de forma idempotente.
- Corrigir perfis locais vinculados à chave errada sem apagar publicações, grupos, métricas ou histórico.
- Comparar também o conjunto local contra o snapshot remoto completo. Perfil local sem correspondente remoto deve ser classificado, marcado e encaminhado ao fluxo auditável apropriado; ausência remota nunca pode ser ignorada como simples upsert.
- Definir uma política explícita para ausentes: tolerância a snapshot parcial, número de confirmações, estado intermediário, bloqueio por publicação ativa e somente então desconexão lógica ou reciclagem.
- Para Anastacio, corrigir as duas identidades que hoje apontam para outra conexão e repetir o snapshot.

**Base não destrutiva implementada e validada em 16/08/2026:** a migration 124 criou observações compartilhadas de inventário por conexão e perfil. Os caminhos individual e geral registram presença pelo mesmo contrato; somente snapshots completos incrementam ausência, e duas leituras completas consecutivas são exigidas para chegar a `suspected_absent`. Callback OAuth isolado usa snapshot parcial, não reduz a contagem remota total da chave e não pode produzir falso ausente. A regra não altera status, não faz soft delete e não agenda remoção. Foram executados dois lotes controlados com o congelamento ativo: `026f70c1-4a6b-4730-af40-fb9431a000a0`, correlação `559ef0ab-4630-4e5c-9089-c187af4f8f0e`, processou 20/20 chaves, 11 presenças, 1 conflito e 0 falhas; `b2b9bef1-f156-487e-b088-ea79519551fa`, correlação `a3656bd4-9b3b-47d2-88c0-4f368d90442c`, processou 108/108 chaves, 64 presenças, 2 conflitos e 0 falhas finais. O inventário observado totalizou 75 perfis presentes; não havia perfil local ausente no remoto nas leituras atuais, portanto `absence_observed` e `suspected_absent` permaneceram em zero sem fabricar divergência em produção. Nenhum incidente destrutivo foi criado durante os lotes.

### Fase 3A — Unificar os caminhos de sincronia

- Extrair um único serviço de aplicação para listar, reconciliar, classificar ausentes, registrar conflitos, atualizar snapshot e enfileirar analytics somente dos perfis novos ou alterados.
- Fazer o worker VPS e o dispatcher HTTP chamarem o mesmo serviço usado por [`syncZernioInstagramAccounts()`](../lib/integrations/zernio-accounts.ts:202), eliminando a implementação paralela em [`syncClaimedItem()`](../scripts/workers/zernio-sync-worker.mjs:60).
- Separar por contrato as operações `reconciliar inventário`, `verificar saúde`, `atualizar analytics` e `conectar conta`; uma pode orquestrar a seguinte apenas quando o escopo afetado estiver explícito.
- Definir resultado por conexão com contagens de presentes, importados, reatribuídos, ausentes, conflitos, analytics enfileirados e erros estruturados.
- Alinhar autorização e visibilidade: se [`POST()`](../app/api/integrations/zernio/sync-all/route.ts:8) continuar exclusiva de admin, operador não deve receber botão executável; se operador puder executar, a política backend deve ser alterada e testada deliberadamente.

**Núcleo compartilhado implementado e validado em 16/08/2026:** a migration 125 tornou [`reconcile_zernio_connection_accounts()`](../supabase/migrations/125_zernio_reconciliation_outcomes_and_selective_analytics.sql:4) a classificação comum de `created`, `updated`, `unchanged` e `conflict`. A função prioriza `accountId` dentro da organização para reconhecer renome da mesma conta, preserva o bloqueio global por username e não executa `UPDATE` quando o perfil está inalterado, evitando tocar `updated_at` e disparar efeitos colaterais desnecessários. Tanto [`syncZernioInstagramAccounts()`](../lib/integrations/zernio-accounts.ts:229) quanto [`syncClaimedItem()`](../scripts/workers/zernio-sync-worker.mjs:87) usam o mesmo retorno e enfileiram analytics somente para perfis criados ou alterados. Se já existir job de analytics ativo na organização, o novo enqueue acrescenta itens idempotentemente ao mesmo job sob advisory lock, em vez de perder perfis concorrentes.

Na execução das 108 chaves, seis perfis foram efetivamente alterados e os demais presentes permaneceram `unchanged`. Cinco atualizações seletivas concluíram analytics normalmente durante o lote. O primeiro teste real do ramo que estende job ativo revelou PostgreSQL `42702` por ambiguidade entre a coluna e a variável de saída `job_id`; a reconciliação permaneceu salva, o item foi retomado sem falha terminal e nenhuma ação destrutiva ocorreu. A migration 126 corrigiu o `ON CONFLICT` usando a constraint primária explícita. A validação concorrente posterior criou um job com um perfil e estendeu o mesmo job com o segundo, retornando `active_job_extended`; o job `6e0aa7a7-e0bd-44b5-a0ac-a29802626777` terminou com 2/2 itens sincronizados, recuperando também o perfil afetado pelo primeiro erro. O worker Zernio permaneceu online, com zero reinícios instáveis após o deploy.

### Fase 4 — Resolver duplicidades remotas

- Gerar uma lista de duplicidades com a decisão canônica antes de executar `DELETE`.
- Aplicar trava por identidade e revalidar ambas as ocorrências imediatamente antes da remoção.
- Remover uma ocorrência por vez, aguardar confirmação e consultar novamente as duas chaves.
- Criar incidente auditável mesmo quando a Zernio responder `404`.
- Se uma identidade existir em organizações diferentes entre as três contas autorizadas, aplicar a mesma regra determinística e registrar que a operação foi autorizada pelo proprietário.
- Interromper a execução daquela identidade diante de erro ambíguo, timeout sem confirmação ou atividade de publicação.

**Auditoria canônica concluída, remoções ainda congeladas, em 16/08/2026:** duas leituras integrais consecutivas das 128 conexões ativas terminaram sem erro de API e produziram o mesmo estado: 78 ocorrências remotas, 75 identidades canônicas, 75 perfis locais ativos com vínculo exato, zero perfil local ausente remotamente, zero ocorrência remota única ausente localmente e somente três ocorrências remotas excedentes. Portanto, a etapa de reatribuir vínculos locais ou importar ausentes foi encerrada sem alteração de perfil: o estado local já está convergente com as ocorrências canônicas e preserva publicações, grupos, mídias, métricas e histórico.

As decisões canônicas registradas são: preservar `erishimizu67` em `ChrissyMurtaza780312` (`6a80d7a877555aae01249756`) e classificar como excedente `CasperAshmon2315` (`6a80d7d577555aae01249c6d`); preservar `thodglaura_bowdre` em `AnonaSynowiec695965` (`6a80cda377555aae01223a29`) e classificar como excedente `AnastacioTawes66395` (mesmo account ID); preservar `crimsonix74298` em `CorneliousSmolar124581` (`6a80df0477555aae0125d15e`) e classificar como excedente `GeorgineDescheenie566259` (mesmo account ID). A regra aplicada foi o vínculo local exato já confirmado na mesma organização.

O utilitário seguro [`register-zernio-duplicate-incidents.mjs`](../scripts/workers/register-zernio-duplicate-incidents.mjs:1) exige snapshot, vínculo canônico exato e `automatic_duplicate_removal_enabled = false` antes de registrar trabalho; ele não possui chamada de DELETE remoto. Com a segunda leitura, criou para `thodglaura_bowdre` e `crimsonix74298` incidentes estruturados e jobs `deferred`, ambos com `automatic_removal_frozen`, `attempt_count = 0`, `max_attempts = 6`, `profile_id = null` e os dois lados da decisão canônica. Somados ao incidente de `erishimizu67`, as três duplicidades conhecidas ficaram cobertas por auditoria durável antes do início do canário destrutivo.

**Descoberta operacional durante o canário destrutivo:** `erishimizu67`, cujas duas ocorrências tinham account IDs diferentes, foi removida somente da chave excedente e a canônica permaneceu confirmada. Ao testar `thodglaura_bowdre`, cujas duas chaves expunham exatamente o mesmo account ID, a Zernio aplicou o DELETE globalmente e a conta desapareceu também da chave canônica. O job foi encerrado em dead-letter terminal com código `zernio_account_id_global_delete`, sem tocar o perfil local; `crimsonix74298`, que possui a mesma topologia, foi bloqueada antes de qualquer DELETE. As migrations 130 a 133 adicionaram preflight recente, lease exclusivo e evento auditável para impedir claim destrutivo sem revalidação. Um OAuth emergencial auditável foi gerado para restaurar `thodglaura_bowdre` na conexão canônica `AnonaSynowiec695965`; a tentativa é `ab19d8b4-231a-4ac8-b771-c66c04484f02`.

#### Instagrams e ocorrências desplugadas — lista para reconexão futura

| Instagram | Ocorrência/chave desplugada | Estado remoto atual | Reconexão futura |
|---|---|---|---|
| `erishimizu67` | Somente a ocorrência excedente de `CasperAshmon2315`, account ID `6a80d7d577555aae01249c6d` | Continua conectada e confirmada na chave canônica `ChrissyMurtaza780312`, account ID `6a80d7a877555aae01249756` | Não requer reconexão. Somente a duplicidade excedente foi limpa. |
| `thodglaura_bowdre` | A remoção iniciada pela chave excedente `AnastacioTawes66395` também desplugou a chave canônica `AnonaSynowiec695965`, pois ambas expunham o mesmo account ID global `6a80cda377555aae01223a29` | Ausente em todas as chaves remotas; perfil, publicações, grupos, mídias, métricas e histórico locais preservados | Deixar o slot vazio por decisão do usuário. Pode ser reconectada posteriormente ou substituída por outro Instagram. Não executar restauração OAuth agora. |
| `crimsonix74298` | Em 16/08/2026, após nova autorização explícita do proprietário para remover globalmente e reconectar depois, um único DELETE foi enviado pela chave excedente `GeorgineDescheenie566259`; o account ID compartilhado `6a80df0477555aae0125d15e` também foi removido da antiga canônica `CorneliousSmolar124581` | Ausente das duas chaves remotas; perfil local `075c8865-e599-484d-b292-f7bc1bbd697b`, publicações, grupos, mídias, métricas e histórico preservados sem alteração | Reconectar manualmente `crimsonix74298` apenas à chave desejada. Após a conexão, executar `Sincronizar contas` para atualizar o vínculo remoto. |

A tentativa OAuth emergencial `ab19d8b4-231a-4ac8-b771-c66c04484f02` não será utilizada. Por decisão explícita do usuário, ela deve ser encerrada administrativamente sem login, callback ou nova sincronização, mantendo o slot de `thodglaura_bowdre` vazio e o incidente original auditável.

**Encerramento confirmado em 16/08/2026:** a tentativa OAuth emergencial foi movida de `redirected` para `failed` com motivo administrativo `restoration_oauth_abandoned_by_owner`, sem enviar requisição remota, sem login e sem callback. O slot permaneceu vazio conforme solicitado.

**Remoção global de `crimsonix74298` autorizada e concluída em 16/08/2026:** antes da mutação, uma nova leitura das 128 chaves terminou sem erro e confirmou o mesmo account ID nas chaves `GeorgineDescheenie566259` e `CorneliousSmolar124581`, além de um único perfil local ativo vinculado à segunda. Como o contrato oficial oferece somente `DELETE /v1/accounts/{accountId}`, sem operação seletiva por chave, o proprietário autorizou expressamente remover das duas e reconectar manualmente depois. O utilitário excepcional [`disconnect-shared-zernio-account.mjs`](../scripts/workers/disconnect-shared-zernio-account.mjs:1) refez o preflight, enviou um único DELETE pela chave excedente e recebeu HTTP 200. A verificação imediata e a auditoria integral posterior confirmaram zero ocorrência remota nas duas chaves, zero erro de conexão e o perfil local preservado sem alteração. Evidências sanitizadas: [`.zernio-crimsonix-global-removal-2026-08-16.json`](../.zernio-crimsonix-global-removal-2026-08-16.json) e [`.zernio-crimsonix-post-removal-audit-2026-08-16.json`](../.zernio-crimsonix-post-removal-audit-2026-08-16.json). A trava automática para account IDs compartilhados continua correta e ativa; esta foi uma operação manual excepcional, com autorização específica.

#### Extensão operacional — queda terminal pela API Oficial Meta

Em 16/08/2026, o ciclo de encerramento isolado por perfil foi estendido aos perfis `meta_official` quando a Graph API responde código `190` acompanhado de sinal inequívoco de invalidação de token, checkpoint ou login obrigatório no Instagram. O dispatcher preserva `error_subcode`, tipo, HTTP status e `fbtrace_id` somente para diagnóstico estruturado e usa classificação conservadora: código `190` sozinho não basta; são aceitos subcodes terminais conhecidos ou mensagens explícitas como `Error validating access token`, `log in to www.instagram.com`, `follow the instructions given`, sessão invalidada ou checkpoint. Rate limit e erros transitórios permanecem no fluxo normal de retry.

Quando esse sinal ocorre, [`isMetaTerminalProfileDisconnection()`](../scripts/workers/publication-direct-dispatch.mjs) aciona a RPC transacional [`finalize_meta_profile_disconnection()`](../supabase/migrations/136_meta_terminal_token_disconnection.sql:5). A transação converte para `ignored` somente itens ainda operacionais do perfil afetado, libera claims, leases, retries e reservas, devolve a tentativa consumida pelo claim-fonte, cancela chunks, horizontes e planos ativos daquele perfil, remove sua associação a grupos, marca o perfil `offline` e soft-deleted, soft-deleta analytics e recalcula apenas os lotes envolvidos. Publicações com confirmação remota, mídias, histórico, itens já cancelados, demais perfis e o restante dos lotes são preservados. Cada item encerrado recebe evento imutável `ignored` com `meta_profile_disconnected`.

As migrations [`136_meta_terminal_token_disconnection.sql`](../supabase/migrations/136_meta_terminal_token_disconnection.sql), [`137_fix_meta_terminal_profile_credential_constraint.sql`](../supabase/migrations/137_fix_meta_terminal_profile_credential_constraint.sql) e [`138_allow_service_role_profile_analytics_soft_delete.sql`](../supabase/migrations/138_allow_service_role_profile_analytics_soft_delete.sql) foram aplicadas. A segunda mantém a credencial criptografada no registro histórico soft-deleted para respeitar o constraint legado de `meta_official`; ela não volta a ser exposta pela aplicação. A terceira autoriza explicitamente o service role a concluir o soft delete transacional dos snapshots de analytics.

O incidente real de `@linhafrancie`, perfil `15aeae8c-448a-4413-ad28-4405eb6b6b08`, foi finalizado pela mesma RPC depois de três publicações chegarem à quinta tentativa com o erro `190` de login obrigatório. O resultado auditado foi: perfil `offline` e soft-deleted; 464 itens pendentes ou falhados convertidos para `ignored`; 38 itens `published` preservados; um item `cancelled` preservado; zero item operacional restante naquele perfil. O teste unitário do dispatcher passou com 11/11 casos, incluindo positivos e negativos do erro Meta; TypeScript, verificação sintática e build de produção local também passaram. O teste SQL [`136_meta_terminal_token_disconnection.test.sql`](../supabase/tests/136_meta_terminal_token_disconnection.test.sql) foi tornado autocontido e transacional, sem depender do perfil real.

### Fase 4A — Tornar adiamento, reincidência e falha terminal duráveis

- Quando houver publicação ativa, persistir incidente/job em estado `deferred`, motivo, próxima verificação e referência da atividade bloqueadora, em vez de retornar apenas `scheduled = false`.
- Reavaliar adiamentos por worker e também por evento de término/cancelamento da publicação, usando claim com lease e idempotência.
- Permitir que uma duplicidade reaparecida reabra o incidente ou crie uma ocorrência versionada e gere novo job, mesmo que o job anterior esteja concluído.
- Separar `retryable_error` de `terminal_error`; usar máximo de tentativas, backoff com jitter, `next_attempt_at` e dead-letter para falhas terminais ou esgotadas.
- Se o `DELETE` remoto tiver ocorrido e a confirmação local falhar, a retomada deve tratar `404` como sucesso idempotente e concluir o mesmo incidente.
- Se a conexão for desativada/removida antes do consumo, preservar dados mínimos criptograficamente seguros ou mover o job para estado terminal explícito; nunca deixá-lo em retry infinito.
- Incluir operação manual auditada para reprocessar dead-letter após correção da causa, sem editar o histórico original.

**Implementada e validada sem `DELETE` remoto em 16/08/2026:** a migration 127 criou estados duráveis de `deferred`, `retry_pending` e `dead_letter`, contador de reincidência, limite padrão de seis tentativas, backoff exponencial com jitter, reabertura manual auditada e o ledger imutável `zernio_profile_recycling_job_events`. A classificação do consumidor em [`processZernioProfileRecyclingJobs()`](../scripts/workers/publication-direct-dispatch.mjs:843) passou a tratar `404` como sucesso idempotente, `429`/`5xx` como retryable e erros explicitamente não retryable como terminais. O worker de publicação foi implantado atomicamente na VPS; o SHA-256 local/remoto coincidiu, o PM2 permaneceu `online` por mais de cinco minutos e reportou zero reinícios instáveis.

O lote controlado `51291b9d-30e3-435c-ab9d-4562070fa06e` processou 20/20 conexões da organização menor, preservou um conflito e terminou sem falha de conexão. A duplicidade real `erishimizu67` criou o incidente `08c83a6c-cc82-4d0f-92f4-64732cc7489c` e o job `7f66544f-ac04-4db1-be2b-16c57f59f8f4` em `deferred`, com `automatic_removal_frozen`, `attempt_count = 0`, sem lease e com `profile_id = null`; o perfil canônico aparece somente em `retained_profile_id`. Uma segunda observação reutilizou os mesmos IDs, incrementou `occurrence_count` e acrescentou novo evento `deferred`. O claim vencido retornou zero itens e não consumiu tentativa enquanto o congelamento permaneceu ativo.

O primeiro claim de validação revelou PostgreSQL `42702` no `RETURNING job_id` do CTE de eventos. A transação foi integralmente revertida, sem entrega de job ou chamada remota. A migration 128 recompilou [`claim_zernio_profile_recycling_jobs()`](../supabase/migrations/128_fix_zernio_recycling_claim_event_job_id_ambiguity.sql:5) com a coluna do ledger qualificada. Depois da correção, o arquivo de erro do worker permaneceu inalterado em 31.428 bytes/970 linhas durante novos ciclos, enquanto a saída registrou `recycling: []`.

Os ramos de conclusão foram exercitados sem rede, forçando apenas leases locais sobre o incidente congelado: erro retryable gerou `retry_pending` e backoff de 61 segundos; a sexta tentativa gerou dead-letter por `max_attempts_exhausted`; erro terminal HTTP 401 gerou dead-letter imediato; ambas as ocorrências foram reabertas pela RPC administrativa e registradas no ledger. Ao final, o mesmo job foi restaurado para `deferred`, sem lease, com `attempt_count = 0`, `reopened_count = 2`, `occurrence_count = 3`, `profile_id = null` e congelamento ainda ativo. Nenhuma dessas validações executou `DELETE /v1/accounts/{accountId}` nem alterou perfil, publicação ou vínculo local.

### Fase 4B — Estruturar incidente e corrigir a tela operacional

- Persistir em colunas próprias a identidade normalizada, conexão/account ID preservados, conexão/account ID removidos, regra canônica, motivo do adiamento, resultado remoto e job associado.
- Não depender de `error_message` para reconstruir qual chave foi preservada.
- Atualizar [`ZernioDisconnectionsPage()`](../app/(painel)/operacao/quedas-zernio/page.tsx:33) para exibir chave preservada, chave removida, identidade, regra, tentativas, estado e motivo.
- Diferenciar visualmente `remote_deleted`, `already_absent_404`, `deferred_active_publication`, `retry_scheduled`, `terminal_error` e `dead_letter`.
- Manter snapshots de rótulo/username para que a auditoria continue inteligível se conexão ou perfil forem removidos depois.

**Implementada e validada em 16/08/2026:** a migration 129 adicionou ao incidente identidade normalizada, conexão/account ID preservados, conexão/account ID excedentes, snapshots dos dois rótulos e regra canônica. Um trigger preenche esses campos em toda inserção/reobservação de duplicidade, e o backfill estruturou o incidente real `erishimizu67` com conexões e account IDs distintos. A leitura dos jobs foi liberada por RLS somente para membros da própria organização.

A tela [`ZernioDisconnectionsPage()`](../app/(painel)/operacao/quedas-zernio/page.tsx:77) deixou de tratar todo incidente como sucesso verde e passou a exibir métricas de aguardando ação segura, dead-letter e concluídos/404; estados `deferred`, `retry_scheduled`, `remote_removal_pending` e `dead_letter` têm tons próprios. Para duplicidades, mostra cards separados de ocorrência preservada e excedente, rótulo e account ID com quebra segura, regra canônica, motivo, tentativas, limite, reincidências, reaberturas e próxima avaliação. A aplicação passou em TypeScript/build e foi promovida ao alias de produção da Vercel.

Os produtores de conflito também foram alinhados. Tanto [`syncZernioInstagramAccounts()`](../lib/integrations/zernio-accounts.ts:225) quanto [`syncClaimedItem()`](../scripts/workers/zernio-sync-worker.mjs:87) associam o conflito ao perfil canônico primeiro por `accountId` e depois por username normalizado, criam o incidente durável e gravam `zernio_account_id`, `instagram_identity` e `conflict_profile_id` no log técnico. O lote de validação `04dce56a-9b21-4366-a2ed-4f525b5d6352` processou 20/20 conexões, registrou um conflito enriquecido, reutilizou o mesmo incidente/job, incrementou `occurrence_count` para 4 e manteve `deferred`, tentativa zero e ausência de lease. O worker Zernio implantado teve SHA-256 local/remoto idêntico, permaneceu online com zero reinícios instáveis e seu log de erro não cresceu durante novos ciclos.

### Fase 5 — Erros estruturados e mensagem no modal

- Expandir [`readZernioResponse()`](../lib/integrations/zernio-client.ts:194) para preservar HTTP status, código, razão e contexto documentados de forma sanitizada.
- Classificar limite prioritariamente por HTTP `402`, código `PAYMENT_REQUIRED` e razão estruturada; manter texto apenas como fallback conservador.
- Persistir status e caps úteis de billing, sem dados sensíveis.
- Reabrir ou manter o modal Conectar conta após o retorno e exibir o resultado dentro dele.
- Para o caso atual, mostrar que a chave já tem duas contas remotas e que a Zernio exige forma de pagamento para uma terceira; não instruir remoção genérica sem listar o estado real.
- Manter a região global apenas como resumo secundário e para progresso de jobs fora de modal.

**Implementação do feedback concluída localmente em 16/08/2026:** o retorno de sucesso ou falha de conexão agora reabre automaticamente o modal `Conectar conta` e apresenta o resultado dentro do próprio fluxo, retirando esse feedback da região global. Erros de limite preservam HTTP status, código e razão estruturados da Zernio; `402` e `PAYMENT_REQUIRED` têm precedência sobre heurísticas textuais. O retorno identifica a chave usada e o modal mostra ocupação remota, limite configurado e a exigência de cobrança sem sugerir remoção genérica nem alterar contas existentes. O diagnóstico técnico permanece sanitizado e recolhido em `details`. TypeScript passou após as alterações.

### Fase 5A — Simplificar e tornar honestas as ações dos cards

- Remover `Atualizar todas` de cada card. A atualização global de analytics deve existir, se necessária, em uma única ação claramente global na área de Perfis ou Analytics, nunca repetida por chave Zernio.
- Renomear `Sincronizar métricas` para `Sincronizar contas`. Essa ação deve consultar a chave, reconciliar o inventário e atualizar seu snapshot remoto.
- Não disparar uma atualização global de métricas como efeito colateral da sincronia de uma chave. Enfileirar somente os perfis novos ou alterados que realmente precisem de analytics.
- Fundir `Checar` na sincronia manual por chave, pois ambas já consultam contas e billing. A ação unificada deve usar também `GET /v1/accounts/health` e retornar um resumo de chave, inventário, saúde e cobrança.
- Se houver necessidade operacional de uma checagem sem escrita, colocá-la em `Detalhes` e rotulá-la como `Verificar sem reconciliar`; não manter duas ações quase iguais no card.
- Manter no card apenas ações com escopo evidente: `Conectar Instagram`, `Sincronizar contas`, `Configurar` e `Excluir API`. Cada ação deve indicar no modal ou tooltip o que lê e o que altera.
- Proteger `Sincronizar contas` contra duplo clique e concorrência com o batch mestre, reutilizando lease ou lote ativo em vez de iniciar operações sobrepostas.
- Na tela Perfis, renomear e separar claramente a ação individual de saúde + analytics da reconciliação geral de inventário; nenhuma ação deve prometer métricas quando executa inventário ou vice-versa.
- Ao concluir lote de inventário ou analytics, revalidar no servidor perfis, resumo de analytics e conexões, em vez de atualizar apenas a lista de conexões ou encerrar o indicador de polling.

**Implementação das ações concluída localmente em 16/08/2026:** os cards deixaram de repetir a ação global `Atualizar todas` e não exibem mais a checagem parcialmente duplicada. A ação por chave foi renomeada para `Sincronizar contas` e agora resume inventário reconciliado, saúde detalhada de `GET /v1/accounts/health`, cobrança e analytics seletivo somente dos perfis criados ou alterados. `Conectar Instagram` e `Sincronizar contas` ficam disponíveis para admin e operador, em paridade com as rotas; configuração, exclusão e sincronia geral permanecem exclusivas de admin; viewer não recebe ações mutáveis. A interface também bloqueia operação individual durante lote mestre e usa guardas síncronas contra duplo clique antes da atualização do estado React. TypeScript foi validado com sucesso após as alterações.

### Fase 5B — Refazer a responsividade dos cards Zernio

- Aplicar `min-width: 0` aos filhos de grid e flex do card e às áreas de título, detalhes e ações.
- Permitir quebra segura no título com `overflow-wrap: anywhere` e `word-break: break-word`; limitar visualmente a duas linhas apenas se houver `title` ou detalhe acessível contendo o valor completo.
- Tratar `zernio_profile_id`, mensagens de erro e plataformas como texto potencialmente longo.
- Impedir que badges e saldo comprimam o título: permitir quebra da linha superior ou reorganização vertical em larguras menores.
- Usar ações em grid responsivo com larguras previsíveis e sem botões espremidos; no celular, uma coluna com área de toque adequada.
- Testar nomes com espaços, sem espaços, 80 caracteres, Unicode, identificadores longos e mensagens de erro extensas nos breakpoints usados pela aplicação.
- Validar que o modal Configurar e o modal de exclusão também não vazem nomes longos.

**Implementação responsiva concluída localmente em 16/08/2026:** cards, filhos de grid/flex, detalhes, plataformas e modais passaram a aceitar encolhimento com `min-width: 0` e quebra segura de nomes, IDs, erros e diagnósticos. As ações usam grid responsivo com largura previsível, texto quebrável e área de toque maior; em celular, cabeçalho do card, saldo e status empilham sem comprimir o título. Os modais de conexão, configuração e exclusão ganharam altura limitada pela viewport, rolagem interna e proteção contra vazamento horizontal. O build de produção passou; restaram apenas os warnings antigos de metadata em login, onboarding e not-found.

### Fase 5C — Analytics resiliente e verificável

- Substituir o claim não atômico de [`claimNextItem()`](../lib/integrations/profile-analytics-refresh-worker.ts:79) por RPC transacional com `FOR UPDATE SKIP LOCKED`, lease, worker ID e retomada após expiração.
- Implementar retry real por item com classificação de timeout, rate limit, indisponibilidade transitória, autenticação terminal e erro de dados; aplicar máximo de tentativas, backoff com jitter e dead-letter.
- Fazer o campo `attempts` representar tentativas efetivas e registrar `next_attempt_at`, último erro estruturado e histórico resumido.
- Não converter silenciosamente falha de subendpoint em ausência de dados. O resultado deve distinguir `synced`, `partial`, `no_data`, `retryable_error` e `terminal_error`, preservando quais fontes falharam.
- Impedir que um job seja apresentado como sucesso integral quando houver itens falhos; expor contagens e permitir retry somente dos itens elegíveis.
- Recarregar os cards após conclusão e mostrar timestamp dos dados, estado parcial e erro por perfil quando aplicável.
- Corrigir ou documentar a origem do desvio de heartbeat, persistindo timestamps UTC do banco e convertendo apenas na apresentação.
- Instrumentar latência e timeout entre VPS e endpoint interno; se o endpoint web continuar sendo gargalo, avaliar execução compartilhada direta sem duplicar regra de negócio.

**Implementação de resiliência concluída localmente e no banco em 16/08/2026:** as migrations 134 e 135 adicionaram claim atômico de item com `FOR UPDATE SKIP LOCKED`, lease por worker, retomada de lease expirado, limite de cinco tentativas, backoff exponencial com jitter, `retry_pending`, `dead_letter`, estado `partial`, contadores no job e ledger imutável por tentativa. O claim do job agora só entrega trabalho efetivamente elegível e não gira sobre retry futuro. A conclusão de item valida a posse do lease e classifica resultado integral, parcial, sem dados, ignorado, retryable e terminal.

O worker compartilhado em [`dispatchProfileAnalyticsRefreshJobs()`](../lib/integrations/profile-analytics-refresh-worker.ts:196) deixou de executar `SELECT` + `UPDATE` não atômicos e de falhar todos os itens restantes após uma exceção isolada. Timeouts, falha de transporte, `429` e `5xx` recebem retry; autenticação, conta ausente e dados inválidos seguem para dead-letter. A coleta em [`syncProfileAnalytics()`](../lib/integrations/zernio-analytics.ts:149) passou a registrar `partial` e as fontes auxiliares indisponíveis, em vez de converter silenciosamente todas as falhas secundárias em sucesso integral.

Em Perfis, a conclusão do polling agora chama revalidação do App Router e atualiza seguidores, último post e demais resumos sem reload completo do navegador; o detalhe do perfil aplica a mesma estratégia. A rota de status expõe contagens de parcial, retry pendente e dead-letter. Migrations remotas, TypeScript e builds local/Vercel passaram. A aplicação foi promovida ao alias de produção e o pacote do worker foi implantado atomicamente em `/opt/athena-worker`, preservando a configuração anterior; `athena-profile-analytics-worker` voltou online no PM2 sem reinício instável.

O canário transacional `b06eaa93-dc0c-4783-9c29-3a6429affe35` usou um item sintético e nenhuma chamada Zernio: primeiro claim na tentativa 1, lease forçadamente expirado, recuperação por outro worker na tentativa 2, timeout retryable com backoff persistido, bloqueio comprovado de claim prematuro, terceiro claim após vencimento controlado e dead-letter no máximo de três tentativas. O ledger confirmou exatamente `claimed:1`, `lease_recovered:2`, `retry_scheduled:2`, `claimed:3` e `dead_lettered:3`; o job sintético foi removido ao final. Assim, claim atômico, recuperação, backoff, elegibilidade temporal, esgotamento e limpeza estão comprovados em produção.

### Fase 5D — Encerrar tentativas OAuth abandonadas e tornar callback monotônico

- Definir máquina de estados com transições permitidas e CAS transacional para `started`, `redirected`, `callback_received`, `synced`, `empty`, `failed`, `expired` e `cancelled`.
- Callback repetido de tentativa terminal deve devolver o resultado já persistido e não reclassificar, reassociar grupo nem importar novamente.
- Validar que organização, usuário iniciador, intenção, reserva, conexão e state OAuth pertencem ao mesmo fluxo; o parâmetro da URL não pode substituir silenciosamente a conexão persistida na tentativa.
- Registrar no start o conjunto conhecido de account IDs e, no callback, atribuir somente os IDs inequivocamente correlacionados àquela tentativa.
- Serializar callbacks concorrentes por conexão/profile remoto ou usar marcador de posse por account ID para impedir que duas tentativas associem o mesmo perfil a grupos diferentes.
- Expirar periodicamente tentativas paradas em `started`, `redirected` ou `callback_received`, liberar reserva ainda ativa e registrar motivo sem contar abandono como falha remota da Zernio.

### Fase 6 — Validar concorrência e recuperação

- Testar cenários de 2, 10 e dezenas de conexões simultâneas, com um e vários celulares, mesma intenção, intenções diferentes, mesma última vaga e capacidade distribuída.
- Confirmar que a reserva usa snapshot remoto recente, que o fallback escolhe outra chave elegível, que há fairness entre chaves/usuários e que a tentativa não troca de chave após iniciar OAuth.
- Testar duplo clique, retry do navegador, callback duplicado, callbacks fora de ordem, associação simultânea a grupos distintos e tentativa abandonada.
- Testar expiração e liberação em callback, erro, cancelamento, timeout e queda do processo entre reserva e persistência da tentativa.
- Validar lote interrompido, lease expirado, reinício PM2, retry, dead-letter e recuperação da UI após refresh.
- Validar duplicidade controlada ponta a ponta com `profile_id = null`, publicação ativa, reabertura por reincidência, erro retryable, erro terminal, `404` e remoção remota idempotente.
- Validar reconciliação de remoto presente/local ausente, chave local errada e local ausente no remoto com snapshots completos e parciais.
- Simular timeouts de analytics e comprovar múltiplas tentativas, backoff, conclusão parcial, dead-letter e recarga dos cards.

**Validação automatizada consolidada em 16/08/2026:** a suíte local concluiu 85/85 testes, TypeScript e build de produção passaram. O canário transacional de analytics foi repetido com sucesso no job sintético `3db0c37c-ab62-4b72-b306-f1f986cf4e5b`, comprovando claim, recuperação por lease expirado, bloqueio antes do backoff, retry e dead-letter, com limpeza ao final. A saúde operacional remota respondeu corretamente, com 5 workers registrados, 4 ativos, zero leases expirados e zero retries vencidos; o estado global permaneceu `unhealthy` por 33 itens antigos atrasados na fila de publicações, não por Zernio ou analytics. Os cenários destrutivos, OAuth abandonado, fallback/reservas e callback monotônico permanecem cobertos pelos canários e evidências das fases anteriores; nenhuma nova chamada destrutiva foi feita nesta validação.

### Fase 7 — Auditoria final e prevenção de regressão

- Executar novamente a varredura integral das três contas depois das correções.
- Comparar snapshot inicial e final por chave e identidade.
- Publicar relatório com importados, vínculos corrigidos, duplicidades removidas, pendências bloqueadas e erros externos.
- Adicionar testes automatizados de enum da RPC, classificação `PAYMENT_REQUIRED`, divergência remoto/local, escolha canônica, idempotência e mensagem no modal.
- Criar painéis/alertas sanitizados para jobs atrasados, leases expirados, dead-letter, tentativas OAuth abandonadas, divergência de inventário, analytics parcial e heartbeat defasado.
- Comparar contadores de PM2, banco e logs por correlação para detectar consumidor online sem progresso real.
- Executar testes, typecheck e build antes do deploy; validar em canário e só então ampliar para todas as chaves.

## Ordem técnica de implementação

1. Baseline, logs estruturados, relógio/heartbeat e verificação do estado real da RPC histórica.
2. Migration corretiva da RPC somente se necessária, acompanhada de testes SQL.
3. Serviço único de reconciliação integral e contrato de ausentes; adoção pelo worker VPS e dispatcher HTTP.
4. Snapshot remoto persistido, projeção separada de ocupação e preferência do limite padrão para novas conexões.
5. Bulk pelos limites individuais, intenção idempotente, reserva revalidada, fallback controlado e callback monotônico.
6. Analytics com claim atômico, retry/backoff/dead-letter e recarga dos cards.
7. Durabilidade da remoção de duplicidade: deferred, reabertura, retry limitado e dead-letter.
8. Incidente estruturado e tela operacional com chaves preservada/removida.
9. Diagnóstico dry-run de todas as chaves das três contas.
10. Reatribuição local idempotente, importação de ausentes e classificação segura de ausentes remotos.
11. Execução canário e auditada das duplicidades excedentes.
12. Erros estruturados, feedback contextual, alinhamento de permissões e simplificação das ações.
13. Correção responsiva integral dos cards e modais Zernio.
14. Testes concorrentes em 2, 10 e dezenas de conexões, auditoria final e alertas permanentes.

## Guardrails obrigatórios

- Nunca imprimir ou persistir API key em claro, mesmo com autorização para operar.
- Nenhum `DELETE` durante o primeiro snapshot ou dry-run.
- Nenhum `DELETE` sem duas ocorrências remotas comprovadas e ocorrência canônica registrada.
- Reconsulta imediatamente antes e depois de cada remoção.
- Interrupção por identidade, não da operação inteira, em caso de publicação ativa ou erro ambíguo.
- Toda alteração local deve preservar publicações, mídia, grupos, analytics e histórico.
- Toda remoção remota deve possuir incidente e resultado idempotente.
- Lotes precisam ser retomáveis; nenhuma correção depende de uma única execução Vercel.
- Nenhum estado assíncrono pode depender apenas de retorno HTTP, texto em log ou memória do worker; adiamento, retry, expiração e terminalidade precisam ser persistidos.
- Nenhum callback pode mover uma tentativa terminal para outro estado nem escolher conexão/grupo diferente do fluxo persistido.
- Nenhum job pode repetir indefinidamente: todo retry possui classificação, limite, próxima execução e destino terminal auditável.
- Nenhuma ação de UI pode ter escopo mais amplo do que o rótulo e a permissão apresentados ao usuário.

## Critérios de aceite

- O botão Sincronia de contas cria lote e a VPS processa todas as chaves sem erro `42804`.
- O plano registra se `42804` era apenas histórico ou ainda estava ativo no início da implementação, sem aplicar migration redundante.
- Anastacio exibe duas contas remotas antes da correção e, após a reatribuição, dois vínculos Athena na chave correta.
- Nenhum cartão apresenta contador local como se fosse capacidade do plano Zernio.
- Toda conta remota das três contas usuárias aparece exatamente uma vez no inventário canônico do Athena.
- Toda duplicidade excedente removida está ausente na segunda leitura da Zernio e presente no relatório de incidentes.
- Duplicidade bloqueada por publicação ativa permanece em estado durável, é reavaliada após o desbloqueio e não depende de nova sincronia manual.
- Reincidência após job concluído cria nova execução auditável; erro esgotado chega a dead-letter e não gera loop infinito.
- A tela operacional mostra, em campos próprios, chave/account preservados, chave/account removidos, regra canônica, estado e resultado remoto, inclusive para `404`.
- Nenhuma identidade única é removida remotamente.
- O erro de conexão aparece dentro do modal Conectar conta com chave, ocupação remota, código e ação corretos.
- A sincronia recupera progresso após refresh e diferencia falha de enqueue, falha de chave e conflito de identidade.
- A sincronia geral trata inventário presente e ausente, usa o mesmo serviço em todos os consumidores e enfileira analytics apenas para perfis afetados.
- A auditoria final apresenta zero divergências não explicadas e zero erros silenciosos.
- Zernio permite salvar um limite padrão para novas conexões, inicialmente 2, sem alterar conexões existentes.
- Cadastro unitário e importação em lote aplicam o limite padrão salvo; um lote mantém o mesmo snapshot de configuração até terminar.
- O Bulk em Perfis não possui mais o campo manual de máximo e respeita o limite individual de cada chave.
- Uma chave com limite 1, outra com 2 e outra com 4 produz exatamente a capacidade agregada disponível após ocupação remota e reservas.
- Nenhum card contém uma ação repetida que dispare atualização global de métricas.
- `Sincronizar contas` descreve e executa reconciliação da chave; atualização de analytics limita-se aos perfis afetados.
- Operadores e admins veem somente ações que podem executar; o backend e a UI aplicam a mesma política.
- Copiar a lista Bulk não reserva capacidade; iniciar a mesma intenção duas vezes não duplica tentativa ou reserva.
- Em testes de 2, 10 e dezenas de conexões, nenhuma vaga é sobrealocada, callbacks não cruzam grupos, tentativas não trocam de chave depois do OAuth e nenhuma chave/usuário sofre starvation indefinido.
- Tentativas OAuth abandonadas expiram, liberam reservas e chegam a estado terminal explícito.
- Item de analytics transitório tenta novamente com backoff; falha esgotada chega a dead-letter; job parcial não aparece como sucesso integral.
- Ao concluir inventário ou analytics, os cards exibem dados revalidados e timestamp coerente sem exigir reload manual.
- Heartbeats usam UTC consistente e alertam consumidor online sem progresso ou com idade acima do limite operacional.
- Nomes e IDs longos não ampliam, vazam nem deformam os cards ou modais em desktop e celular.

## Referências oficiais verificadas

- Documentação: <https://docs.zernio.com/>
- OpenAPI: <https://docs.zernio.com/api/openapi>
- Endpoints verificados: `GET /v1/accounts`, `GET /v1/accounts/health`, `GET /v1/billing`, `POST /v1/profiles`, `GET /v1/connect/{platform}` e `DELETE /v1/accounts/{accountId}`.

## Estado deste plano

- Investigação factual: concluída.
- Auditoria complementar somente leitura de duplicidade, Bulk concorrente, sincronia e analytics: concluída.
- Causas raiz de Anastacio e a falha histórica do botão global: comprovadas; o estado mais recente também comprova pipeline implantado e ativo, ainda com lacunas de contrato.
- Autorização para convergência e remoção de duplicidades excedentes nas três contas: confirmada.
- Diagnóstico consolidado e organização das correções em fases: confirmados pelo usuário.
- Fases 0 e 1: implementadas e validadas em produção; migrations 119 e 120 aplicadas, worker VPS e aplicação Vercel implantados.
- Fase 2 e núcleo da Fase 3A: implementados; migrations 121 a 126 aplicadas. Os dois caminhos classificam reconciliação pelo mesmo contrato, registram observações não destrutivas e enfileiram analytics seletivo com extensão concorrente validada.
- Validação integral não destrutiva: duas leituras canônicas consecutivas das 128/128 conexões confirmaram 75 vínculos locais exatos, zero ausência local/remota, zero vínculo em chave errada e três ocorrências remotas excedentes. Não houve perfil a importar nem vínculo local a alterar.
- Fase 4A: implementada e validada; migrations 127 e 128 aplicadas, worker de publicação implantado, adiamento/reincidência/claim congelado/retry/esgotamento/dead-letter/reabertura comprovados em incidente real sem requisição remota destrutiva.
- Fase 4B: implementada e validada; migration 129 aplicada, logs técnicos enriquecidos, incidente estruturado com os dois lados da decisão canônica e Quedas Zernio implantada na Vercel.
- Auditoria canônica da Fase 4: concluída; as três decisões estão registradas, `erishimizu67` foi convergida, `thodglaura_bowdre` foi preservada localmente e classificada em dead-letter após o DELETE global da Zernio, e `crimsonix74298` permaneceu inicialmente bloqueada até a autorização posterior de remoção global e reconexão manual.
- Operações destrutivas de convergência: canário encerrado. A ocorrência excedente de `erishimizu67` foi removida com sucesso; `thodglaura_bowdre` foi desplugada remotamente das duas chaves pelo comportamento global do account ID e ficará sem restauração por decisão do usuário; em operação excepcional posterior, `crimsonix74298` também foi desplugada das duas chaves após autorização explícita para reconexão manual. O congelamento automático e o bloqueio preventivo para account IDs compartilhados permanecem ativos para qualquer execução automática.
- Fase 5C: migrations 134 e 135, worker e UI implantados. TypeScript, builds local/Vercel, PM2 e canário sintético de claim/lease/retry/backoff/dead-letter concluídos com sucesso; resta validar uma coleta real e a revalidação visual dos cards no fluxo final de concorrência.
- Fases 5A, 5B e feedback da Fase 5: implantadas na Vercel em produção em 16/08/2026. Cards simplificados, permissões alinhadas, saúde/cobrança incorporadas à sincronia por chave, `PAYMENT_REQUIRED` estruturado, resultado dentro do modal e responsividade reforçada. O deploy foi promovido ao alias principal após build remoto bem-sucedido.
- Paridade Meta/API Oficial: migrations 136 a 138 aplicadas e incidente real `@linhafrancie` encerrado atomicamente, com 464 itens `ignored`, 38 publicados e um cancelado preservados. O classificador e o dispatcher local passaram em 11/11 testes, TypeScript, sintaxe e build. O dispatcher foi implantado na VPS com backup da versão anterior; SHA-256 local/remoto `e7443aaf2b335204705af600e00977354c0d7ca0fa44a3d80a949221a0b898b4`, verificação sintática remota aprovada e `athena-publication-worker` reiniciado/salvo no PM2. Após mais de um minuto, permaneceu `online`, com zero reinícios instáveis, ciclos concluídos e arquivo de erro sem alteração desde antes do deploy. O ciclo está automático para ocorrências futuras equivalentes.
- Validação final originalmente concluída: 128/128 chaves responderam sem erro, com 73 ocorrências remotas e 72 perfis locais ativos. Não havia identidade local duplicada nem account ID local duplicado; a única divergência remota conhecida era `crimsonix74298` em duas chaves com o mesmo account ID. Evidência sanitizada daquele marco em [`.zernio-canonical-audit-final-2026-08-16.json`](../.zernio-canonical-audit-final-2026-08-16.json). Após a autorização posterior de remoção global, a auditoria pós-operação voltou a consultar 128/128 chaves sem erro, confirmou zero ocorrência remota de `crimsonix74298` e preservação do único perfil local ativo. Esse perfil fica intencionalmente sem ocorrência remota até a reconexão manual solicitada pelo proprietário.
- Verificação final: 85/85 testes passaram, TypeScript e builds local/Vercel passaram, o canário de analytics foi repetido com sucesso e o endpoint operacional após o deploy confirmou workers sem erro, zero leases expirados e zero retries vencidos. O alerta global ainda aponta 33 publicações antigas atrasadas, uma pendência da fila de publicação fora do escopo de convergência Zernio; não representa divergência silenciosa deste plano.

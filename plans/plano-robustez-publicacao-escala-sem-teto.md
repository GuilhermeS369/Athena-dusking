# Plano para aprovação — robustez de publicação em escala com proteção de provedor

## 1. Objetivo e decisão de capacidade

Robustecer a publicação multi-tenant por Zernio e Meta para absorver volume alto sem repetir URLs de mídia defeituosas, sem perder diagnóstico e sem corromper o circuito de falhas.

O cenário de validação inicial é de cinco organizações com pelo menos 1.000 publicações por hora cada, isto é, 5.000 publicações por hora no conjunto, com picos de slots coletivos. Esse número **não é uma cota de produto**. O dispatcher deve processar continuamente enquanto VPS, Storage e provedor estiverem saudáveis, mas sem ultrapassar as restrições técnicas e os sinais de proteção retornados por Zernio, Meta e Supabase Storage.

Não haverá:

- uma cota comercial fixa por organização que interrompa publicação saudável;
- atraso artificial de itens saudáveis apenas porque a organização publicou muito;
- um valor estático de capacidade tratado como garantia universal da VPS ou de cada provedor.

Permanecem somente controles técnicos indispensáveis, sem cota de negócio:

- paralelismo local configurável por processo e ajustável por métricas, de acordo com CPU, memória, rede, conexões e latência disponíveis na VPS;
- controle adaptativo por provedor, conexão e perfil quando Zernio ou Meta devolver `429`, `5xx`, timeout, limite informado ou indisponibilidade transitória;
- respeito a `Retry-After`, quando fornecido pelo provedor;
- escalonamento justo apenas durante saturação real, para impedir que uma organização, conexão ou perfil com erro monopolize workers e prejudique as demais;
- pausa operacional emergencial ao detectar condição crítica sustentada da VPS ou erro maciço de provedor;
- circuito por lote para isolar defeito recorrente de um lote, sem reduzir a vazão dos demais lotes.

Quando houver erro grave, a fila afetada deve parar de receber **novos claims**, os itens já aceitos pelo provedor devem ser preservados/reconciliados e o suporte deve receber alerta acionável. Nenhum item deve ser descartado automaticamente apenas por saturação ou erro operacional.

## 2. Diagnóstico consolidado

1. A URL de mídia é emitida com TTL fixo de 24 horas em [`createTemporaryUrl()`](../lib/integrations/instagram-publisher.ts:88) e em implementação equivalente no dispatcher direto. Não há sonda externa de acessibilidade antes do envio para o provedor.
2. Zernio monta `mediaItems` a partir dessas URLs e chama o post com a chave idempotente do item. O polling em [`statusResult()`](../lib/integrations/zernio-publisher.ts:40) tenta priorizar campos de falha, porém os tipos não formalizam todos os campos e o payload bruto sanitizado não é persistido. Isso explica a mensagem genérica do item Zernio, possivelmente criado/pollado em fluxo anterior ou com campo ainda não mapeado.
3. O circuito em [`apply_publication_batch_failure_circuit_breaker()`](../supabase/migrations/094_batch_failure_circuit_breaker.sql:26) ignora retry enquanto existe `next_attempt_at`, mas zera a sequência em `published` **e** `cancelled`. Cancelamento não pode representar recuperação bem-sucedida.
4. O projeto possui controle anterior em [`reserve_publication_dispatch_capacity()`](../supabase/migrations/062_publication_rate_limit_fairness.sql:102), com contagens por organização/provedor e proteção de perfil. Ele precisa ser auditado: nenhuma cota fixa e desconhecida pode bloquear tráfego saudável, mas controles dinâmicos reativos a `429`, `Retry-After`, latência e saúde do provedor precisam permanecer no caminho crítico.
5. A criação de fila já foi exercitada com dez organizações e 72 mil itens futuros em [`docs/load-test-runbook.md`](../docs/load-test-runbook.md:192). Ainda faltam ensaios controlados de claim/conclusão concorrente com comportamento de Storage e provedor.
6. Não havia ferramenta de navegação web disponível na etapa de planejamento. A documentação local contém referências Zernio de analytics, mas não o contrato completo de publicação em [`docs/plano-zernio-instagram-analytics.md`](../docs/plano-zernio-instagram-analytics.md:1). Antes de consolidar configurações produtivas, confirmar na documentação Zernio e, se necessário, com suporte os campos de falha, políticas de download e cabeçalho `Retry-After`.

## 3. Decisões de algoritmo

### 3.1 URL nova e validada em cada envio ao provedor

1. Nunca persistir URL assinada e nunca reutilizá-la entre tentativas de criação de post.
2. Para cada asset e tentativa de criação: emitir URL, guardar apenas um fingerprint irreversível da URL, executar sonda externa e então enviar ao provedor somente se a sonda passar.
3. A sonda tenta `HEAD`; se o origin não suportar ou negar `HEAD`, tenta `GET` com `Range: bytes=0-1023`.
4. Aceitar apenas status HTTP esperado, MIME compatível com o tipo de asset e tamanho coerente quando `Content-Length` estiver disponível.
5. Se o origin ignorar `Range`, cancelar o corpo imediatamente para não transferir vídeo inteiro em uma validação.
6. A URL só é gerada depois de o item ter passado a checagem de perfil/estado e imediatamente antes da chamada externa. Ela não aparece em logs, eventos, banco, mensagem de erro ou interface.

### 3.2 Classificação, retry e quarentena de mídia

1. Separar falha de sonda de mídia de falha do provedor: timeout, DNS/rede, assinatura/autorização, objeto ausente, status HTTP, MIME incompatível e falha de Range recebem códigos distintos.
2. Falha de sonda bloqueia o envio daquela URL; o retry gera URL nova e realiza nova sonda.
3. Considerar duas falhas independentes somente quando vierem de duas emissões de URL e duas execuções de dispatch distintas para o mesmo asset e versão, com categoria equivalente na janela configurável.
4. Após duas falhas independentes confirmadas, colocar o asset em quarentena e impedir novos envios que o referenciem. Os itens que ainda não chegaram ao provedor devem ser encerrados em estado revisável com código explícito de quarentena, sem retry automático; não apagar histórico nem mídia.
5. Falha transitória isolada de rede não deve colocar asset em quarentena. Uma indisponibilidade ampla precisa ser identificada por métrica/alerta de provedor para evitar quarentena em massa.
6. Reabilitação de asset é manual, auditada e exige nova validação bem-sucedida antes de voltar a ficar elegível.

### 3.3 Circuito de cinco falhas por lote

1. Somente uma publicação externamente confirmada, registrada como `published`, zera `consecutive_failures`.
2. `cancelled`, `removed`, `suspended`, adiamento, retomada manual, item ignorado e reconciliações que não confirmem publicação não zeram a sequência.
3. Criar ledger de observações terminais único por `publication_item_id`. Falhas intermediárias com retry agendado não entram no ledger; a falha terminal de cada item entra uma única vez.
4. Usar bloqueio transacional do lote e operação idempotente para que evento duplicado, lease recovery ou disputa entre workers nunca conte a mesma falha duas vezes.
5. Ao quinto item terminal com falha consecutiva, pausar somente o lote e registrar causa, último item, correlação e instrução para suporte. Lotes saudáveis continuam sem redução de throughput.
6. A retomada manual preserva histórico e zera o contador somente como ação explícita de retomada; ela não deve ser confundida com sucesso de publicação.

### 3.4 Escala sustentável e proteção operacional reativa

1. O worker reclama e processa itens enquanto a infraestrutura responder bem. [`PUBLICATION_WORKER_LIMIT`](../scripts/workers/publication-direct-dispatch.mjs:4) e a concorrência local de requisições são parâmetros técnicos da VPS, não cotas de negócio.
2. Substituir qualquer bloqueio fixo por um controlador adaptativo: aumentar a concorrência gradualmente quando p95 de latência e erros estiverem saudáveis; reduzir somente no escopo que receber sinais reais de sobrecarga. O estado é por provedor, conexão e perfil, sem parar organizações saudáveis.
3. Quando um provedor responder `429`, respeitar `Retry-After` se existir e aplicar backoff somente aos itens/conexão/provedor afetados. Quando responder `5xx` ou timeout, usar retry com backoff exponencial e jitter já compatível com a fila.
4. Durante saturação real, fazer claim ponderado por organização para reservar capacidade de progresso a todas as organizações prontas. Isso não cria limite por hora: serve apenas para não deixar uma fila problemática ocupar todos os workers.
5. Implementar circuit breaker operacional observável: se CPU/memória sustentadas, exaustão de conexões, crescimento de leases vencidos ou erro maciço do provedor ultrapassarem limiares de emergência, não reivindicar novos itens do escopo afetado por janela curta e reavaliar periodicamente. Itens já aceitos pelo provedor são consultados/reconciliados antes de qualquer nova criação.
6. A pausa operacional não cancela, remove, consome tentativa nem reprograma artificialmente itens saudáveis. Ela produz heartbeat, alerta e causa auditável para intervenção humana.

### 3.5 Diagnóstico Zernio

1. Formalizar campos potenciais de post e plataforma: status, categoria, origem, código, mensagem, `failureReason`, `error`, `errorMessage`, request ID e payload desconhecido.
2. Persistir diagnóstico sanitizado com chaves presentes, origem da leitura e request ID, removendo URLs, tokens, captions sensíveis e payload de mídia.
3. Para itens históricos com diagnóstico genérico, agendar um único re-poll idempotente que consulta o mesmo `creation_id`; jamais criar outro post durante o enriquecimento.
4. Mensagem ao operador deve mostrar causa normalizada, origem, ID de correlação e ação recomendada.

## 4. Passos de implementação

1. **Contrato comum de mídia:** extrair camada compartilhada para assinatura, sonda HEAD/Range, classificação, fingerprint e telemetria; eliminar a diferença entre módulo de aplicação e dispatcher da VPS.
2. **Persistência de saúde da mídia:** criar tabelas de tentativa de entrega, estado de saúde/quarentena e auditoria de reabilitação; criar RPC transacional para registrar uma tentativa, identificar independência e aplicar quarentena no segundo diagnóstico equivalente.
3. **Integração de publicação:** validar mídia imediatamente antes de [`createPost()`](../lib/integrations/zernio-publisher.ts:124) e antes da criação de container Meta. Garantir que retry emita URL nova e que URL invalidada jamais seja passada ao provedor.
4. **Normalização Zernio:** ampliar cliente, tipos, publisher e polling para capturar falhas específicas e correlação; adicionar re-poll único para itens legados com falha genérica.
5. **Correção do circuito:** substituir a lógica da migration 094 por ledger terminal idempotente, trava por lote, reset exclusivo por `published` confirmado e tratamento de reconciliação externa.
6. **Controle adaptativo de capacidade:** substituir controles fixos que bloqueiam tráfego saudável por sinais dinâmicos de `429`, `Retry-After`, latência, timeout e saúde de VPS; preservar isolamento por provedor, conexão e perfil e escalonamento justo apenas quando houver saturação real.
7. **Observabilidade e operação:** criar rollups/alertas por organização, provedor, conexão, lote e asset; expor motivo real na operação e atualizar scripts de diagnóstico.
8. **Validação e ativação:** executar testes automatizados e carga em staging, habilitar por flags independentes, fazer canário, ampliar cobertura e só então remover caminho legado.

## 5. Arquivos e migrations previstos

### Migrations novas após [`097_fix_circuit_breaker_claim_batch_id_ambiguity.sql`](../supabase/migrations/097_fix_circuit_breaker_claim_batch_id_ambiguity.sql:1)

1. Migration de telemetria de sonda/entrega, saúde e quarentena de asset, RPCs de registro/reabilitação e índices por asset, item, organização, categoria e janela temporal.
2. Migration de ledger de resultados terminais e correção idempotente do circuito de lote.
3. Migration de pause operacional, controlador adaptativo, rollups e alertas. Não criar cota comercial nem teto global de publicações.
4. Migration de compatibilidade para substituir o comportamento fixo de [`publication_dispatch_rate_reservations`](../supabase/migrations/062_publication_rate_limit_fairness.sql:83) por reservas reativas à saúde do provedor, sem apagar dados históricos até o rollout estar concluído.
5. Todas as estruturas devem ter RLS mínima, grants direcionados ao `service_role`, auditoria de ação manual e índices compatíveis com consulta por grande volume.

### Código e documentação

- Atualizar [`scripts/workers/publication-direct-dispatch.mjs`](../scripts/workers/publication-direct-dispatch.mjs:104) para usar a camada de mídia, flags, correlação, backoff `Retry-After`, controle adaptativo e pause por saúde.
- Atualizar [`lib/integrations/instagram-publisher.ts`](../lib/integrations/instagram-publisher.ts:88), [`lib/integrations/zernio-publisher.ts`](../lib/integrations/zernio-publisher.ts:73) e [`lib/integrations/zernio-client.ts`](../lib/integrations/zernio-client.ts:194) para compartilhar contrato de mídia e mapear payload Zernio sem segredos.
- Atualizar [`scripts/workers/publication-direct-dispatch.test.mjs`](../scripts/workers/publication-direct-dispatch.test.mjs:1), adicionar testes de integração Zernio e testes SQL em [`supabase/tests`](../supabase/tests).
- Expandir scripts em [`scripts/load-test`](../scripts/load-test), [`docs/load-test-runbook.md`](../docs/load-test-runbook.md:1) e [`docs/vps-worker-runbook.md`](../docs/vps-worker-runbook.md:501) com cenários de mídia, falha, pause operacional e throughput sem teto de negócio.

## 6. Estratégia de testes e carga

### Testes unitários

- fallback `HEAD` para `Range`;
- respostas `200` e `206` válidas;
- MIME inválido, assinatura inválida, objeto ausente, timeout e origin que ignora Range;
- ausência de URL, token ou query string em logs e dados persistidos;
- segunda falha independente coloca em quarentena;
- duplicata, retry intermediário e falha transitória isolada não colocam em quarentena;
- backoff por `429` com e sem `Retry-After` e por `5xx`;
- pausa emergencial não remove nem consome tentativa de item ainda não enviado.

### Testes SQL e de concorrência

- duas conclusões/recoveries simultâneas do mesmo item geram uma única observação terminal;
- cinco itens terminais distintos pausam o lote;
- publicação confirmada zera a sequência;
- cancelamento, remoção e suspensão não zeram;
- retomada manual e rollback não corrompem contador, auditoria ou estado do lote;
- quarentena de asset encerra de maneira consistente itens ainda não enviados, sem tocar item já aceito pelo provedor;
- worker concorrente não duplica registro de sonda, criação externa ou observação terminal.

### Contrato Zernio e staging de mídia

- fixtures Zernio para criado, processando, publicado, `failureReason`, `error`, `errorMessage`, categoria/origem e payload desconhecido;
- para cada fixture, exigir erro normalizado, diagnóstico sanitizado e request ID quando presente;
- servidor/bucket controlado para HEAD aceito, HEAD negado com Range aceito, assinatura inválida, objeto ausente, MIME incoerente e origin que ignora Range;
- validar que re-poll de item histórico usa apenas `creation_id` existente.

### Carga multi-tenant

1. Ensaiar pelo menos cinco organizações e 1.000 publicações/hora por organização como carga de referência, sem configurar esse número como limite.
2. Repetir com backlog desigual, mídias muito reutilizadas, múltiplos dispatchers e injeção de falhas Zernio/Storage.
3. Aumentar a carga enquanto VPS e provedores estiverem saudáveis; encontrar e registrar a capacidade prática da VPS, sem introduzir cota artificial.
4. Critérios de aceite: URL defeituosa não chega ao provedor após detecção; máximo de uma falha terminal por item; nenhum crescimento contínuo de leases vencidos; diagnóstico Zernio acionável; circuito de lote isola somente lote defeituoso; pause operacional alerta antes de colapso; recuperação não duplica publicação.

## 7. Observabilidade, alertas e rollout

### Logs e métricas

Registrar `correlation_id`, hash/fingerprint de URL, item, asset, organização, provedor, conexão, tentativa, fase da sonda, HTTP/MIME, duração, classificação, decisão de retry/quarentena, request ID Zernio, estado do circuit breaker do lote e saúde da VPS. Nunca registrar URL completa, token, query string, caption sensível ou corpo de mídia/resposta.

### Alertas acionáveis

- falha de download por asset e provedor;
- asset em quarentena e ação de reabilitação;
- repetição de payload Zernio genérico ou campo desconhecido;
- `429`, `Retry-After`, `5xx` e timeout em massa por provedor/conexão;
- CPU, memória, conexões, leases expirados e backlog em condição crítica;
- lote pausado por cinco falhas e instrução de retomada;
- worker em pause operacional, com organização, lote, itens/perfis afetados, motivo e estado da VPS.

### Flags e implantação

1. Flags independentes: observação de sonda, bloqueio de URL inválida, quarentena automática, circuito novo, diagnóstico Zernio enriquecido e pause operacional.
2. Migrations devem ser aditivas e compatíveis com worker anterior durante a implantação.
3. Subir código com flags desligadas e coletar telemetria em sombra.
4. Validar em staging com Storage/Zernio simulados, executar canário em uma organização e expandir para 10%, 50% e 100% com monitoramento.
5. Ajustar paralelismo técnico e o controlador adaptativo pelas métricas de VPS e retorno real dos provedores; não criar limite comercial de publicações por volume/hora.
6. Rollback desliga flags e retorna ao caminho anterior sem apagar telemetria. Reabilitação de asset e retomada de lote seguem auditadas e manuais.

## 8. Critério final de aceite

O plano estará concluído quando o sistema puder processar continuamente a maior carga sustentável da VPS e dos provedores, sem quota comercial por hora, mantendo URLs por tentativa validadas externamente, quarentena segura, diagnóstico Zernio específico, contagem correta de falhas terminais, controle adaptativo por sinais reais de provedores e suporte humano acionado antes de uma falha operacional ampla.

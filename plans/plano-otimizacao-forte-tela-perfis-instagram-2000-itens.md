# Plano — otimização forte da tela de Perfis Instagram para 2.000+ itens

## Objetivo

Fazer a tela `/perfis` continuar rápida com pelo menos 2.000 perfis Instagram, inclusive quando o operador acessa a Athena por celulares com proxies lentas e isoladas.

O alvo não é esconder o problema com um skeleton maior. A solução deve reduzir, ao mesmo tempo:

- trabalho do PostgreSQL para abrir a página;
- tamanho do HTML/RSC/JSON enviado ao aparelho;
- quantidade de cards e controles montados no DOM;
- número e peso dos avatares baixados pela proxy;
- custo de busca, filtro, ordenação e atualização no React.

## Resumo executivo

A tela atual não escala porque carrega o catálogo inteiro antes de exibir qualquer resultado. Em uma única abertura, o servidor busca todos os perfis, grupos, vínculos, métricas e conexões Zernio; o cliente recebe tudo, filtra e ordena os 2.000 itens em memória e cria um card grande para cada perfil. Cada card ainda pode iniciar o download de um avatar externo.

A correção principal deve ser **paginação real no servidor por cursor**, com no máximo 40 perfis por resposta. Busca, grupo, status e situação passam a ser filtros do banco. Contadores globais vêm de uma consulta compacta separada. Métricas vêm da projeção `profile_analytics_current` e de uma projeção compacta de publicações, nunca mais de uma agregação de todo o histórico na abertura da tela. Avatares devem ser miniaturas cacheadas pela Athena/CDN e baixadas apenas para os cards visíveis.

Com isso, 2.000, 20.000 ou mais perfis deixam de aumentar linearmente o payload, o DOM e o número de imagens da primeira tela.

## Escopo protegido — conexão de perfis

Este plano **não autoriza nenhuma mudança** no Bulk Zernio nem na lógica, componentes, endpoints, funções, regras ou fluxos usados para conectar perfis.

Devem permanecer funcional e estruturalmente intactos:

- Bulk Zernio, incluindo `buildBulkZernioRows()` e sua distribuição de contas/slots;
- modal e seletor Zernio manual;
- conexão por Meta oficial;
- OAuth, intents, callbacks, reservas e fallback de conexão;
- endpoints de criação, listagem e sincronização de conexões usados por esses fluxos;
- props, dados e estado necessários para abrir e operar os modais atuais;
- regras de capacidade, inventário remoto, grupos e associação pós-conexão;
- qualquer função executada durante conexão, reconexão ou conclusão da adição.

Mesmo que algum desses dados contribua para o peso atual, ele fica fora desta otimização. A implementação deve medir a listagem isoladamente e obter o ganho por paginação de perfis, consultas de métricas, redução do DOM e tratamento de imagens. Se uma mudança de listagem tocar um contrato compartilhado com conexão, deve-se criar um contrato paralelo de leitura, sem alterar o contrato existente.

---

## Diagnóstico confirmado no código atual

### 1. A página bloqueia em seis leituras completas

Em `app/(painel)/perfis/page.tsx`, `ProfilesPageContent()` executa em `Promise.all`:

1. todos os registros ativos de `instagram_profiles_safe`;
2. todos os grupos;
3. todos os registros de `profile_group_members`;
4. `get_profiles_analytics_summary()` para toda a organização;
5. todas as conexões de `zernio_connections_safe`;
6. o estado do link espelho.

Embora as consultas sejam paralelas, a página inteira espera a mais lenta. Para 2.000 perfis, o custo e o payload crescem junto com a organização.

### 2. A consulta de métricas varre um universo muito maior que a primeira tela

`get_profiles_analytics_summary()` em `supabase/migrations/077_force_profile_analytics_refresh_and_card_fields.sql`:

- agrega `publication_items` de toda a organização;
- executa buscas laterais de snapshots por perfil;
- calcula o último post por perfil;
- devolve uma linha para cada perfil ativo.

O repositório já possui `profile_analytics_current`, criada nas migrations 215–221, com uma linha compacta por perfil. A listagem ainda não aproveita essa projeção e continua usando a função antiga de resumo total.

### 3. Todas as associações são reconstruídas no navegador

`app/perfis/profiles-client.tsx` recebe `memberships` completos e cria `groupByProfileId` em memória. Essa associação deve ser feita na consulta paginada apenas para os perfis retornados.

### 4. Filtros e busca são locais

`visibleProfiles` percorre todos os perfis, resolve conta Zernio, filtra e ordena no React. Toda digitação na busca pode recalcular o catálogo completo. Isso funciona com dezenas de itens, mas transfere ao aparelho um trabalho que deveria ser limitado e indexado no servidor.

### 5. O DOM cresce para 2.000 cards grandes

`visibleProfiles.map()` monta todos os cards. Cada um possui checkbox, avatar, links, chips, blocos analíticos, listas de métricas, botões e um `select`. Isso produz dezenas de milhares de nós DOM, muito layout e muita hidratação.

### 6. Os avatares atravessam a conexão lenta do aparelho

`ProfileAvatar` usa `<img src={profile.profile_picture_url}>` sem `loading="lazy"`, dimensões explícitas ou miniatura controlada pela Athena. Em 2.000 perfis, o navegador pode disputar muitas conexões e baixar imagens externas grandes ou instáveis através da proxy.

### 7. Atualizações completas repetem o custo

Quando um job analítico termina, `router.refresh()` refaz o carregamento completo da rota. Com o desenho atual isso retransmite e reidrata os 2.000 perfis, mesmo se apenas poucos itens mudaram.

### Observação sobre as proxies

As consultas Supabase executadas pelo servidor da Athena não passam pela proxy móvel do Instagram. O que mais penaliza esses aparelhos é o volume devolvido pela Athena, a hidratação e os avatares externos. Chamadas de sincronização Zernio devem continuar assíncronas e fora do caminho crítico da listagem; não se deve consultar Instagram ou Zernio perfil a perfil ao abrir `/perfis`.

---

## Arquitetura alvo

### Fluxo da primeira tela

1. O servidor autentica usuário e organização.
2. Busca em paralelo:
   - resumo compacto da organização;
   - primeira página de até 40 perfis já com grupo, nome da conexão e métricas compactas;
   - lista leve de grupos;
   - link espelho, quando autorizado.
3. Entrega somente essa página ao `ProfilesClient`.
4. O navegador baixa avatares cacheados apenas para os cards próximos da viewport.
5. Busca e filtros pedem uma nova página ao servidor; nunca filtram os 2.000 registros locais.
6. Todo o fluxo atual de conexão continua recebendo os mesmos dados e contratos de hoje.

### Contrato sugerido da página

```ts
type ProfilesPageRequest = {
  limit: number;                 // padrão 40, máximo 100
  cursor?: string;              // cursor opaco assinado/validado
  query?: string;               // debounce no cliente
  groupId?: string;
  status?: string;
  situation?: 'online' | 'error' | 'paused';
  publication?: 'all' | 'posted';
};

type ProfilesPageResponse = {
  items: ProfileListItem[];
  nextCursor: string | null;
  hasMore: boolean;
  summary: {
    total: number;
    online: number;
    error: number;
    paused: number;
    publishedItems: number;
  };
};
```

O cursor deve representar `(created_at, id)`, pois a ordenação atual é por adição mais recente. Não usar `OFFSET` como solução definitiva: páginas profundas ficam progressivamente mais caras e podem pular/duplicar registros durante novas conexões.

---

## Fase 0 — baseline e orçamento de performance

Antes de alterar a tela, registrar uma medição reproduzível com organização sintética de 2.000 perfis.

### Instrumentação

- medir separadamente autenticação, consulta de perfis, consulta de resumo, serialização e resposta total;
- registrar `Server-Timing` na rota/RPC;
- capturar tamanho não comprimido e comprimido da resposta inicial;
- executar `EXPLAIN (ANALYZE, BUFFERS)` nas consultas atuais e propostas;
- contar cards, nós DOM e requisições de imagem após 5 segundos;
- medir em desktop normal e em perfil de rede equivalente à proxy real: latência, throughput e perda observados;
- guardar relatório antes/depois em `artifacts/profiles-scale/`.

### Orçamentos de aceite

- no máximo 40 perfis no payload inicial;
- payload inicial da listagem menor que 150 KB sem imagens;
- nenhum novo request do navegador para Instagram ou Zernio para montar dados dos cards;
- no máximo os avatares da viewport mais pequena margem de prefetch;
- consulta paginada p95 menor que 250 ms no banco com 2.000 perfis e menor que 500 ms no servidor;
- resposta de busca p95 do servidor menor que 700 ms;
- no máximo 60 cards montados simultaneamente;
- interação de busca/filtro sem tarefa longa maior que 100 ms no aparelho-alvo;
- nenhum aumento linear do payload inicial ao passar de 2.000 para 10.000 perfis.

Os limites de tempo ponta a ponta devem ser calibrados com a proxy real, mas os limites de servidor, payload e DOM são obrigatórios.

---

## Fase 1 — paginação real e payload inicial mínimo (maior impacto)

### 1.1 Criar um serviço único de catálogo

Criar um módulo de servidor, por exemplo `lib/profiles/catalog.ts`, usado tanto pelo SSR quanto pela rota de paginação. Não fazer o Server Component chamar sua própria API HTTP.

Responsabilidades:

- validar e limitar filtros;
- codificar/decodificar cursor opaco;
- chamar a RPC paginada;
- normalizar o DTO enxuto da lista;
- impedir que campos de credencial ou metadata ampla cheguem ao cliente.

### 1.2 Criar RPC paginada

Adicionar uma migration posterior à última disponível no momento da implementação, com uma função como `list_instagram_profiles_page(...)`.

A função deve:

- validar `is_organization_member()`;
- fixar `limit` entre 1 e 100;
- aplicar `organization_id` e `deleted_at is null` antes de joins;
- usar keyset `(created_at, id) < (cursor_created_at, cursor_id)`;
- aplicar busca, grupo, status, situação e “postadas” no banco;
- juntar no máximo um grupo, respeitando a restrição atual de grupo único;
- preservar `zernio_connection_id` no item para o mapeamento de leitura já existente;
- juntar `profile_analytics_current` por chave primária;
- juntar uma projeção compacta de publicações;
- buscar `limit + 1` para definir `hasMore`, devolvendo somente `limit`.

Não devolver `zernio_account_metadata`, capabilities inteiras, diagnósticos ou qualquer campo que o card não renderiza.

### 1.3 Trocar a página inicial completa pela primeira página

Em `app/(painel)/perfis/page.tsx`, sem alterar as consultas e props necessárias aos fluxos de conexão:

- remover a leitura completa de `instagram_profiles_safe`;
- remover a leitura completa de `profile_group_members`;
- remover `get_profiles_analytics_summary()` do caminho crítico;
- carregar a primeira página e o resumo compacto;
- preservar streaming/Suspense existente.

### 1.4 Criar endpoint de continuação

Criar `GET /api/profiles` ou equivalente com os mesmos filtros e cursor. A resposta deve ter cache privado/revalidação coerente com dados operacionais e retornar `ETag` quando viável. Dados de uma organização nunca podem ser compartilhados em cache com outra.

### 1.5 UX da paginação

Preferência para esta tela operacional:

- primeira página mostra os 40 perfis mais novos;
- botão **Carregar mais 40** ou paginação anterior/próxima;
- o DOM não pode crescer indefinidamente: ao usar carregamento acumulativo, virtualizar ou descartar páginas distantes;
- filtros e busca voltam ao início e cancelam a requisição anterior;
- URL preserva filtros úteis, permitindo atualizar/voltar sem perder contexto;
- exibir “40 carregados de 2.000” em vez de fingir que os 40 são o total do filtro.

Para menor risco inicial, recomenda-se substituir a página atual ao avançar/voltar, mantendo no máximo 40 cards. Rolagem infinita só deve entrar se vier acompanhada de virtualização e restauração de posição.

---

## Fase 2 — projeções e índices para leituras previsíveis

### 2.1 Usar `profile_analytics_current`

A lista deve ler seguidores, delta, views, reach, interações, posts, status e horário de sincronização de `profile_analytics_current`. Essa tabela já foi desenhada como current state compacto e possui chave `(organization_id, profile_id)`.

Manter fallback para snapshots apenas durante rollout controlado. Depois de validar cobertura e paridade, não executar lateral sobre snapshots na listagem.

### 2.2 Criar projeção compacta de publicação por perfil

Criar uma tabela/projeção como `profile_publication_current` com uma linha por `(organization_id, profile_id)`:

- totais agendados por formato;
- totais publicados por formato;
- total publicado;
- `latest_published_at`;
- `updated_at` e versão da projeção.

Atualização recomendada:

- aplicar deltas idempotentes nas transições relevantes de `publication_items`, ou consumir os eventos já duráveis do pipeline;
- fornecer backfill paginado;
- criar auditor de divergência contra a fonte;
- fornecer rebuild seguro por organização;
- nunca recalcular todo o histórico durante `GET /perfis`.

Como etapa intermediária de baixo risco, a RPC pode agregar `publication_items` somente para os até 40 IDs da página. Essa etapa já elimina a varredura para 2.000 perfis, mas a projeção é o estado final para organizações com histórico grande.

### 2.3 Resumo global separado

Criar `get_instagram_profiles_catalog_summary(organization_id, filtros opcionais)` para retornar apenas contadores. Não obter os contadores baixando todas as linhas.

O resumo deve cobrir:

- total;
- online;
- com erro;
- pausados/sem dados;
- quantidade de publicações exibida no filtro “Postadas”.

Se o resumo exato ficar caro sob escrita intensa, manter uma projeção por organização e reconciliá-la periodicamente. A tela pode mostrar horário da última atualização em vez de bloquear a listagem.

### 2.4 Índices necessários

Validar com `EXPLAIN`, criando somente os que forem utilizados:

- `instagram_profiles (organization_id, created_at desc, id desc) where deleted_at is null`;
- `instagram_profiles (organization_id, status, created_at desc, id desc) where deleted_at is null`;
- `profile_group_members (organization_id, group_id, profile_id)`;
- índice de busca normalizada para `username` e `display_name`, com `pg_trgm` se a busca continuar aceitando substring;
- para busca por nome da conta Zernio, usar um caminho de leitura isolado que não altere a view, endpoint ou contratos utilizados pela conexão;
- índices da projeção de publicação por organização, perfil e `published_total > 0`.

Não criar índices duplicados dos já existentes. O teste deve verificar plano, buffers, cardinalidade e impacto de escrita.

### 2.5 Consistência dos filtros

Hoje “Postadas” depende das métricas carregadas para todos os perfis. Depois da paginação, o filtro deve operar sobre a projeção no banco. O total exibido no botão deve ter semântica explícita: **quantidade de posts publicados** ou **quantidade de perfis com posts**, sem misturar as duas.

---

## Fase 3 — atualização localizada da listagem

Quando a listagem precisar refletir uma alteração já concluída:

- invalidar/refazer somente o resumo e a página atual;
- atualizar o card retornado pela ação quando possível;
- evitar `router.refresh()` que retransmita dados não relacionados;
- manter polling somente enquanto houver batch/job ativo, com backoff e pausa quando a aba estiver oculta.

Essa mudança deve ocorrer apenas no consumidor da listagem. Não alterar a ação, callback, job, sincronização ou resposta do fluxo de conexão. Se a resposta atual não tiver dados suficientes para atualizar um card, refazer a página atual depois da conclusão, preservando a conexão exatamente como está.

---

## Fase 4 — avatares adequados a proxies lentas

### Estado final recomendado

Criar uma camada de imagem exclusivamente de leitura, sem modificar conexão ou sincronização de perfil. Quando um card visível pedir a imagem já armazenada em `profile_picture_url`, a Athena pode gerar/servir uma miniatura cacheada:

- gerar miniatura WebP/AVIF de aproximadamente 96×96;
- remover metadata desnecessária;
- usar chave de cache derivada da URL/versão já persistida, sem escrever no perfil;
- servir por CDN com cache longo e URL versionada;
- guardar fallback por inicial quando o avatar não estiver disponível;
- impor limite de tamanho, timeout, content type e proteção contra SSRF no coletor.

O navegador deixa de depender diretamente do peso da imagem externa, sem alterar como o perfil foi conectado ou como `profile_picture_url` foi obtida.

### Ajustes obrigatórios no componente

Em `ProfileAvatar`:

- declarar `width` e `height`;
- usar `loading="lazy"` e `decoding="async"`;
- não baixar avatar de cards fora da página/viewport;
- reservar espaço fixo para evitar layout shift;
- aplicar `srcset` somente com tamanhos pequenos úteis;
- não usar avatar original como fallback automático em massa.

A implementação recomendada é uma rota de imagem cacheada com allowlist rigorosa, limite de bytes, timeout e cache. Ela deve ser somente leitura, não pode chamar funções de conexão e não pode ser um proxy aberto.

---

## Fase 5 — React e divisão do bundle

Depois de reduzir os dados, simplificar o cliente:

- remover `profiles`, `memberships` e métricas globais como estados/props completos;
- separar `ProfileCard` e memoizá-lo com props primitivas estáveis;
- usar `Set` para seleção, se a seleção tiver uma ação real;
- auditar os checkboxes atuais: `selectedProfileIds` não possui consumidor além do próprio checkbox; remover a UI morta ou implementar a ação pretendida em escopo separado;
- aplicar debounce de 300–400 ms à busca e `AbortController` às requisições;
- usar `useTransition` para feedback de troca de filtro;
- calcular formatadores compartilhados uma vez quando possível;
- usar `content-visibility: auto` como proteção adicional, sem tratá-la como substituta da paginação;
- manter foco, estado de carregamento e anúncios `aria-live` durante paginação.

Nenhuma biblioteca de virtualização deve ser adicionada antes de medir a solução paginada. Com no máximo 40 cards simultâneos, ela provavelmente será desnecessária.

---

## Fase 6 — robustez funcional

### Novos perfis enquanto a tela está aberta

- a primeira página é ordenada por `created_at desc, id desc`;
- quando a fonte de dados informar que existe um perfil novo, refazer somente a primeira página da listagem;
- cursores antigos continuam estáveis e não devem duplicar itens;
- não misturar automaticamente itens novos em uma página profunda.

Essa atualização é responsabilidade exclusiva do catálogo. Ela não adiciona resposta, evento ou comportamento ao fluxo que conecta o perfil.

### Busca

- normalizar `@`, caixa e espaços;
- definir se acentos serão equivalentes;
- mínimo recomendado de dois caracteres para substring ampla;
- username exato/prefixo deve ter caminho rápido;
- busca por nome de conexão Zernio pode usar uma consulta auxiliar de leitura, desde que não altere endpoints, funções ou estruturas usadas para conectar perfis.

### Seleção e ações

Se seleção em massa for adicionada no futuro:

- nunca interpretar “selecionar todos” como apenas os 40 visíveis sem deixar isso explícito;
- representar seleção global por filtro + exceções, não por download de 2.000 objetos;
- ações destrutivas precisam de snapshot, confirmação e idempotência.

### Falhas parciais

- falha no resumo não deve impedir a lista de abrir;
- falha em avatar mostra inicial;
- falha na resolução do rótulo Zernio do card não derruba a lista nem altera o modal;
- falha em métricas mostra estado indisponível e mantém identidade/ações do perfil;
- cada bloco secundário deve permitir tentar novamente isoladamente.

---

## Fase 7 — testes, carga e rollout

### Testes automatizados

- autorização e isolamento entre organizações na nova RPC;
- cursor sem duplicação ou perda com `created_at` igual;
- limite máximo imposto no servidor;
- combinações de busca, grupo, status, situação e “postadas”;
- perfil sem grupo, sem conexão e sem métricas;
- contadores iguais ao estado atual em dataset controlado;
- backfill e auditoria da projeção de publicações;
- teste de não regressão comprovando que nenhum arquivo/função de Bulk ou conexão foi alterado;
- cache de avatar sem SSRF, conteúdo excessivo ou tipo inválido;
- cancelamento de requests antigos na busca;
- ação de excluir/sincronizar atualizando apenas a página atual.

### Cenários de carga

Executar pelo menos:

- 2.000 perfis, poucos posts;
- 2.000 perfis, milhões de `publication_items` históricos;
- 10.000 perfis para provar crescimento constante da primeira página;
- 100 acessos concorrentes alternando filtros;
- busca por username presente, ausente e termo comum;
- grupo com 1, 40, 2.000 perfis;
- rede lenta com cache frio e cache quente de avatar.

### Rollout

1. adicionar RPCs/projeções e índices sem mudar a tela;
2. backfill em lotes pequenos, com checkpoint e sem lock longo;
3. auditar paridade por organização;
4. ativar a nova leitura por feature flag para uma organização canário;
5. comparar latência, erros, payload e contadores;
6. expandir gradualmente;
7. manter rollback apenas da leitura, sem apagar projeções;
8. remover a função antiga do caminho da tela somente após estabilidade.

---

## Ordem prática de implementação

1. Criar baseline e script de massa de 2.000 perfis.
2. Criar índices validados e RPC paginada para identidade/grupo/conexão.
3. Fazer a primeira tela devolver somente 40 itens.
4. Mover busca e filtros para o servidor.
5. Usar `profile_analytics_current` e agregar publicações somente para a página.
6. Criar resumo compacto separado.
7. Implementar miniaturas cacheadas e lazy loading de avatar sem tocar na conexão.
8. Criar `profile_publication_current`, backfill, auditor e trocar a leitura.
9. Localizar apenas as atualizações do consumidor da lista e remover refresh completo do catálogo.
10. Rodar carga, canário e rollout gradual.

Os passos 2–6 entregam a maior redução imediata. A projeção definitiva de publicações e o cache de avatar consolidam a escala para históricos e redes muito maiores.

---

## Critérios de aceite funcionais

- [ ] A tela abre e permite operar com 2.000 perfis sem baixar o catálogo completo.
- [ ] O perfil recém-adicionado aparece no topo após conclusão da conexão.
- [ ] Busca por username, nome, grupo e conta Zernio continua disponível.
- [ ] Filtros retornam total correto e podem ser combinados.
- [ ] Avançar e voltar não duplica nem perde perfis.
- [ ] Cards mantêm status, grupo, conexão, analytics e contagens existentes.
- [ ] Sincronizar, reautorizar, excluir e abrir detalhe continuam funcionando.
- [ ] Nenhum arquivo, função, endpoint ou regra de Meta, Zernio manual ou Bulk Zernio foi alterado.
- [ ] Conectar via Meta, Zernio manual e Bulk Zernio funciona exatamente como antes.
- [ ] Uma falha de analytics, avatar ou Zernio não bloqueia a lista básica.
- [ ] Isolamento multiempresa e papéis admin/operator/viewer permanecem intactos.

## Critérios de aceite de performance

- [ ] Primeira resposta contém no máximo 40 perfis.
- [ ] Nenhum array completo de perfis ou memberships aparece no RSC/HTML inicial.
- [ ] A abertura não chama `get_profiles_analytics_summary()` para toda a organização.
- [ ] As props e leituras exigidas pelos fluxos atuais de conexão permanecem intactas.
- [ ] O DOM mantém no máximo 60 cards.
- [ ] Avatares fora da viewport não são baixados antecipadamente.
- [ ] Payload, consultas e imagens respeitam os orçamentos da Fase 0.
- [ ] O custo da primeira página permanece praticamente constante entre 2.000 e 10.000 perfis.
- [ ] Nenhum refresh analítico retransmite todo o catálogo.

---

## Arquivos provavelmente envolvidos

- `app/(painel)/perfis/page.tsx` — bootstrap enxuto da primeira página;
- `app/perfis/profiles-client.tsx` — estado paginado, busca, filtros e atualização localizada;
- `app/globals.css` — paginação, estados de carregamento e reserva de avatar;
- `app/api/profiles/route.ts` — continuação/busca paginada;
- `lib/profiles/catalog.ts` — serviço compartilhado e contrato;
- nova migration após a migration mais recente — RPC, projeção e índices;
- testes SQL da RPC/projeções;
- testes TypeScript do catálogo, cursor e UI;
- scripts de baseline, carga, backfill e auditoria.

## Fora do escopo

- acelerar a internet das proxies;
- consultar Instagram/Zernio em tempo real para cada card;
- qualquer mudança em Bulk Zernio;
- qualquer mudança em lógica, função, endpoint, componente ou regra relacionada a conectar perfil;
- remover métricas ou funções da tela para mascarar lentidão;
- usar `OFFSET` ou apenas `display: none` como correção de escala;
- guardar os 2.000 perfis no browser e chamar isso de paginação;
- trocar toda a infraestrutura da Athena antes de medir a solução paginada.

## Resultado esperado

Ao entrar em `/perfis`, o operador recebe rapidamente um resumo e os 40 Instagrams mais recentes. O aparelho não baixa os outros 1.960 perfis, seus controles ou seus avatares. Busca e filtros consultam o banco com índices e métricas são lidas de estado compacto. Todo o Bulk Zernio e todos os fluxos de conectar perfil permanecem intactos. O custo da listagem passa a depender do tamanho fixo da página, e não do total de Instagrams conectados à Athena.

---

## Diário de execução

> Regra desta implementação: cada passo executado deve ser registrado nesta seção antes de avançar ao próximo. O escopo protegido de conexão permanece obrigatório durante toda a execução.

### 2026-08-27 — Passo 1: preflight e proteção de escopo

**Status:** concluído.

**Ações executadas:**

- verificado que não existe `AGENTS.md` aplicável no repositório fora de dependências;
- verificado que `app/(painel)/perfis/page.tsx`, `app/perfis/profiles-client.tsx`, `app/api/integrations/zernio/connections/route.ts` e `lib/integrations/zernio-bulk.ts` não possuem diff local anterior;
- identificado que o worktree contém muitas alterações do usuário fora deste escopo; elas serão preservadas;
- definida a sequência: banco/RPC aditivo, serviço/API de leitura, migração da listagem, imagens/renderização e validação;
- reafirmado que nenhum arquivo/função de Bulk, OAuth, callback, intent, reserva ou conexão será editado.

**Decisão:** a implementação será aditiva e começará pelo catálogo de leitura. A lista paginada terá contrato próprio; os dados de conexão atualmente entregues ao `ProfilesClient` continuarão no contrato existente para que os modais funcionem sem alteração.

**Arquivos alterados neste passo:** somente este plano.

**Próximo passo:** criar a migration e os testes SQL do catálogo paginado e do resumo compacto.

### 2026-08-27 — Passo 2: catálogo SQL paginado

**Status:** concluído.

**Ações executadas:**

- criada a migration `291_paginate_instagram_profiles_catalog.sql`;
- o número inicialmente escolhido, 285, colidia com migrations do usuário criadas no mesmo worktree; os novos arquivos foram renomeados para 291 antes da aplicação;
- criada `list_instagram_profiles_catalog_page(...)` com limite padrão 40/máximo 100, cursor `(created_at, id)`, filtros de busca/grupo/status/situação/publicação e isolamento por organização;
- a função agrega `publication_items` somente para os IDs da página e lê analytics de `profile_analytics_current`;
- criada `get_instagram_profiles_catalog_summary(...)` para contadores globais e total filtrado sem enviar os perfis ao navegador;
- adicionados índices de cursor, status, grupo e busca textual;
- criado teste pgTAP com 10 verificações de existência, índices e privilégios;
- migrations locais pendentes 285–290, pertencentes ao estado preexistente do worktree, foram aplicadas pelo Supabase CLI antes da 291 para permitir validação na ordem correta; nenhum arquivo delas foi editado;
- executado o teste isolado da migration 291: 10 testes aprovados.

**Proteção de conexão:** nenhuma função, endpoint, componente ou regra de conexão/Bulk foi alterada. A junção com `zernio_connections` é somente leitura e devolve apenas o rótulo usado pelo card.

**Arquivos alterados neste passo:**

- `supabase/migrations/291_paginate_instagram_profiles_catalog.sql`;
- `supabase/tests/291_paginate_instagram_profiles_catalog.test.sql`;
- este plano.

**Validação:** `supabase migration up --local` concluiu a migration; `supabase test db supabase/tests/291_paginate_instagram_profiles_catalog.test.sql --local` passou com 10/10.

**Próximo passo:** criar o contrato TypeScript, o serviço compartilhado de catálogo e a API paginada somente de leitura.

### 2026-08-27 — Passo 3: contrato, serviço e API de leitura

**Status:** concluído.

**Ações executadas:**

- criado `lib/profiles/catalog.ts` com tipos do item/resumo, limite 40–100, normalização de filtros e cursor opaco validado;
- criado `getInstagramProfilesCatalogPage()` para o SSR e a API compartilharem exatamente as mesmas RPCs e o mesmo mapeamento;
- criada `GET /api/profiles`, autenticada, isolada pela organização ativa, com `Cache-Control: private, no-store` e `Server-Timing`;
- adicionada a sinalização `has_more` à RPC para que o serviço gere o próximo cursor sem `OFFSET`;
- criado `lib/profiles/catalog.test.ts` cobrindo cursor, limites e filtros;
- a primeira tentativa de executar o teste pelo script global colocou o filtro depois do glob e acabou executando toda a suíte; ela revelou a necessidade de extensão explícita no import ESM do novo teste;
- o import foi corrigido para `./catalog.ts` e os testes foram repetidos de forma isolada;
- TypeScript foi executado após a criação do serviço e da rota.

**Proteção de conexão:** a nova rota é `/api/profiles`; nenhum endpoint em `/api/integrations/**` foi editado. O serviço apenas lê o catálogo e não inicia sincronização, OAuth, intent, callback ou Bulk.

**Arquivos alterados neste passo:**

- `lib/profiles/catalog.ts`;
- `lib/profiles/catalog.test.ts`;
- `app/api/profiles/route.ts`;
- `supabase/migrations/291_paginate_instagram_profiles_catalog.sql` (campo aditivo `has_more`);
- este plano.

**Validação:** teste TypeScript do catálogo 3/3; pgTAP 10/10; `npx tsc --noEmit` sem erros.

**Próximo passo:** trocar somente a fonte de dados da listagem em `/perfis`, mantendo as conexões Zernio, props e funções dos modais atuais intactas.

### 2026-08-27 — Passo 4A: retomada após interrupção

**Status:** concluído.

**Ações executadas:**

- conferido o estado dos arquivos após a interrupção mostrada pelo usuário;
- confirmado que migration, teste SQL, serviço e API permanecem presentes;
- executado TypeScript para localizar exatamente o ponto incompleto;
- identificadas somente referências residuais da UI antiga: `visibleProfiles` e `groupByProfileId` no trecho de renderização;
- confirmado que a migração parcial já substituiu estado global por `catalog`, adicionou debounce, cancelamento de requisição e histórico de cursor;
- confirmado que `app/globals.css` já possuía alterações do usuário e ainda não foi editado por esta implementação.

**Proteção de conexão:** a retomada não alterou nenhum arquivo de conexão ou Bulk. O próximo ajuste será restrito ao trecho visual da listagem em `ProfilesClient`.

**Validação:** o TypeScript falhou apenas nas referências residuais esperadas da migração interrompida; não foi encontrado erro no serviço/API novos.

**Próximo passo:** concluir a renderização paginada, os resets de cursor e a navegação anterior/próxima.

### 2026-08-27 — Passo 4B: listagem migrada para paginação de servidor

**Status:** concluído.

**Ações executadas:**

- `app/(painel)/perfis/page.tsx` deixou de baixar todos os perfis, memberships e `get_profiles_analytics_summary()`; agora carrega a primeira página pelo serviço compartilhado;
- mantida sem alteração a consulta completa de `zernio_connections_safe` e sua prop, pois os modais e o Bulk atuais dependem desse contrato protegido;
- `ProfilesClient` passou a receber `initialCatalog` e mantém no máximo uma página de 40 itens no estado/DOM;
- removidos filtro, ordenação e mapa de memberships sobre o catálogo completo no navegador;
- busca ganhou debounce de 350 ms e `AbortController` para cancelar respostas obsoletas;
- filtros de situação, status, grupo e publicação agora consultam `/api/profiles` e reiniciam o cursor;
- adicionada paginação estável **Anterior/Próxima**, com histórico de cursores e contador “X de Y”;
- cards passaram a usar `group_name` e `zernio_connection_label` já projetados pela consulta de leitura;
- exclusão já concluída atualiza somente a página/resumo local, sem retransmitir o catálogo inteiro;
- conclusão de refresh analítico deixou de executar `router.refresh()` e agora recarrega somente a página corrente do catálogo;
- adicionados estados isolados de carregamento e erro da listagem;
- o trecho novo de CSS foi limitado a paginação, mensagem de erro e `content-visibility`; as demais alterações preexistentes em `app/globals.css` foram preservadas.

**Proteção de conexão:** nenhum modal, link, seletor, função, URL, endpoint ou cálculo de conexão/Bulk foi alterado. A consulta e prop completa de conexões continuam exatamente disponíveis ao código existente.

**Arquivos alterados neste passo:**

- `app/(painel)/perfis/page.tsx`;
- `app/perfis/profiles-client.tsx`;
- `app/globals.css` (somente quatro seletores novos da listagem);
- este plano.

**Validação:** referências residuais `visibleProfiles`, `groupByProfileId`, `memberships`, `initialProfiles` e `setProfiles` foram eliminadas; `npx tsc --noEmit` passou sem erros após a migração.

**Próximo passo:** validar o comportamento SQL com dados controlados, revisar segurança/performance da consulta e executar testes/build completos.

### 2026-08-27 — Passo 5: avatares e proteção adicional de renderização

**Status:** concluído para a primeira entrega.

**Ações executadas:**

- `ProfileAvatar` recebeu dimensões explícitas 52×52, `loading="lazy"` e `decoding="async"`;
- como o DOM agora possui no máximo 40 cards, avatares dos outros 1.960 perfis não são criados nem solicitados;
- cards receberam `content-visibility: auto` e tamanho intrínseco estimado como proteção adicional de layout;
- não foi criada nesta entrega uma rota proxy/cache de imagem: isso exigiria política operacional de allowlist, armazenamento e retenção. O ganho principal já ocorre ao limitar os cards e carregar imagens preguiçosamente.

**Proteção de conexão:** a URL persistida do avatar é somente consumida pelo card; nenhuma etapa de conexão ou sincronização passou a copiar, transformar ou gravar imagens.

**Arquivos alterados neste passo:**

- `app/perfis/profiles-client.tsx`;
- `app/globals.css`;
- este plano.

**Próximo passo:** executar validação de escala, regressão de conexão/Bulk, suíte completa e build.

### 2026-08-27 — Passo 6: validação final da primeira entrega

**Status:** concluído, com uma pendência ambiental de rollout registrada abaixo.

**Ações executadas:**

- ampliado o teste pgTAP funcional para 18 verificações, incluindo primeira/segunda página, busca, grupo, status e isolamento multiempresa;
- criado teste pgTAP de escala que insere 2.000 perfis dentro de transação e confirma resposta fixa de 40 itens, ausência de duplicação, resumo 2.000, busca unitária e filtro de erro;
- criado teste estático de regressão da UI garantindo remoção das leituras completas antigas e presença intacta das funções/URLs de Meta, Zernio e Bulk existentes;
- executada a suíte TypeScript isolada do catálogo e da UI;
- executada a suíte completa do projeto;
- executado `npx tsc --noEmit`;
- executado build de produção do Next.js;
- conferido com `git diff` que os arquivos protegidos de Bulk, Meta start/callback e Zernio connections/start/callback não receberam alterações;
- executado `git diff --check` nos arquivos desta entrega;
- iniciada validação visual pelo navegador local conforme o fluxo de teste de aplicações locais; ela parou antes da UI porque `.env.local` aponta para um Supabase onde a migration 291 ainda não está aplicada. Nenhuma migration foi enviada a esse ambiente e nenhum dado externo foi modificado.

**Resultados:**

- pgTAP funcional: **18/18**;
- pgTAP com 2.000 perfis: **5/5**;
- testes TypeScript específicos: **6/6**;
- suíte completa: **293 aprovados, 0 falhas**;
- TypeScript: **aprovado**;
- build Next.js: **aprovado**;
- diff whitespace: **aprovado**;
- avisos do build sobre metadata `viewport/themeColor` já existiam e são fora deste escopo.

**Pendência de rollout:** aplicar primeiro `291_paginate_instagram_profiles_catalog.sql` no ambiente alvo e somente depois publicar o código da aplicação. Até isso ocorrer, o ambiente configurado em `.env.local` naturalmente responde `PGRST202` porque ainda não conhece as novas RPCs. Após a migration, repetir a validação visual autenticada de `/perfis`.

**Proteção de conexão comprovada:** os testes de regressão confirmam que `buildBulkZernioRows`, `resolveZernioBulkTarget`, rotas Meta/Zernio e `refreshBulkZernioConnections` continuam presentes; os arquivos protegidos não possuem diff produzido por esta entrega.

**Próximo passo operacional:** rollout banco-primeiro em canário, seguido de smoke visual autenticado e medição de `Server-Timing`/payload no ambiente com dados reais.

### 2026-08-27 — Passo 7A: autorização para aplicação completa

**Status:** em andamento.

**Autorização recebida:** o usuário solicitou “pode aplicar o restante todo”. Isso autoriza concluir a implementação remanescente e executar o rollout banco-primeiro e aplicação no ambiente configurado pelo projeto.

**Ordem obrigatória:**

1. auditar projeto Supabase/Vercel e executar dry-run;
2. revisar todas as migrations pendentes, porque o Supabase aplica a sequência completa e não apenas a 291;
3. aplicar migrations no banco alvo;
4. validar schema/RPC e isolamento;
5. publicar a aplicação;
6. executar smoke autenticado, medir resposta/payload e registrar evidências;
7. somente então declarar rollout concluído.

**Proteção de conexão:** a autorização de rollout não amplia o escopo funcional. Bulk Zernio e lógica/funções de conectar perfil continuam intocáveis. Migrations pendentes preexistentes serão auditadas antes de qualquer push; se houver risco material ou alvo ambíguo, a execução será interrompida antes da mutação.

**Próximo passo:** identificar exatamente o projeto vinculado, migrations remotas pendentes e configuração de deploy.

### 2026-08-27 — Passo 7B: auditoria dos destinos e dry-run

**Status:** concluído.

**Resultados da auditoria:**

- projeto Supabase vinculado: referência `hqwhumdumfmixxbvneae`, região São Paulo;
- histórico remoto já contém as migrations 001–290;
- dry-run confirmou que apenas `291_paginate_instagram_profiles_catalog.sql` está pendente no momento desta auditoria;
- projeto Vercel local: `pomodoro`, ID `prj_odT78sPKaY3qHUPNpRyd0wl1Tp1l`;
- repositório remoto: `GuilhermeS369/Athena-dusking`;
- nenhuma migration inesperada ou lacuna de versão foi encontrada;
- o destino do `.env.local` que havia retornado `PGRST202` é coerente com o projeto vinculado ainda sem a 291.

**Decisão:** é seguro prosseguir banco-primeiro. Antes do push, será concluída a projeção compacta de publicações prevista no plano, para evitar que o resumo global continue contando todo o histórico em cada filtro. Ela será uma migration aditiva 292, sem alterar qualquer fluxo de conexão.

**Próximo passo:** criar e validar localmente a projeção compacta de publicações e atualizar as RPCs do catálogo para consumi-la.

### 2026-08-27 — Passo 7C: projeção compacta de publicações

**Status:** concluído.

**Ações executadas:**

- criada a migration aditiva `292_profile_publication_catalog_current.sql` com uma linha agregada por perfil, contendo totais publicados, formatos e publicação mais recente;
- criado trigger incremental em `publication_items`: somente mudanças que entram ou saem do estado publicado recalculam o perfil afetado;
- executado backfill dos itens publicados existentes durante a migration;
- a RPC de resumo passou a contar a projeção compacta, eliminando a varredura do histórico completo de publicações a cada filtro;
- o primeiro teste revelou dois problemas somente na massa pgTAP: enum inválido `scheduled` e plano declarado com 8 verificações para 9 executadas; ambos foram corrigidos antes da aprovação final;
- repetidos os testes funcionais da paginação e a checagem TypeScript após a mudança.

**Proteção de conexão:** a projeção lê apenas `publication_items` e não altera perfis, credenciais, providers, conexões, callbacks ou Bulk Zernio.

**Arquivos alterados neste passo:**

- `supabase/migrations/292_profile_publication_catalog_current.sql`;
- `supabase/tests/292_profile_publication_catalog_current.test.sql`;
- este plano.

**Validação:** projeção 9/9; conjunto SQL das migrations 291–292 23/23; suíte completa 296 aprovados e 0 falhas; `npx tsc --noEmit` aprovado.

**Próximo passo:** restringir e habilitar miniaturas cacheáveis para os avatares, usando somente os hosts efetivamente presentes no catálogo.

### 2026-08-27 — Passo 7D: miniaturas de avatar com allowlist restrita

**Status:** concluído.

**Auditoria somente leitura:** foram encontrados 1.626 avatares não nulos no ambiente alvo. Todos os hosts terminam em `.cdninstagram.com`; nenhum host externo ou endereço genérico foi encontrado.

**Decisão:** usar `next/image` em 52×52 com `sizes="52px"`, lazy loading e allowlist HTTPS `**.cdninstagram.com`. O otimizador do Next busca, redimensiona e guarda a variante pequena em cache; a allowlist impede transformar a aplicação em proxy arbitrário.

**Ações executadas:**

- substituído o `<img>` direto do card por `next/image`, preservando fallback visual em caso de URL expirada;
- configurada allowlist somente HTTPS e somente para subdomínios de `cdninstagram.com`;
- mantidas dimensões 52×52 e carregamento preguiçoso;
- ampliado o teste estático para exigir o componente otimizado, a dimensão solicitada e a allowlist restrita.

**Proteção de conexão:** a mudança é exclusivamente de renderização HTTP de uma URL já armazenada. Não grava avatar, não acessa proxy de celular e não altera qualquer função de conectar perfil.

**Validação:** testes específicos 6/6; TypeScript aprovado; build de produção Next.js aprovado. Os avisos preexistentes de metadata `viewport/themeColor` permanecem fora deste escopo.

**Próximo passo:** repetir o dry-run e aplicar as migrations 291–292 no projeto Supabase vinculado.

### 2026-08-27 — Passo 7E: rollout banco-primeiro

**Status:** concluído.

**Ações executadas:**

- repetido `supabase db push --linked --dry-run`; somente as migrations 291 e 292 estavam pendentes;
- aplicadas as migrations 291 e 292 no projeto `hqwhumdumfmixxbvneae`;
- repetidos `migration list` e dry-run: versões locais/remotas 001–292 alinhadas e banco sem pendências;
- confirmada a presença das duas RPCs `security definer` e dos índices trigram de username/display name;
- comparado o backfill: 2.479 linhas na projeção e 2.479 perfis distintos publicados na fonte;
- executada chamada real da RPC com contexto de um membro: retorno limitado a 40 linhas e `has_more=1`;
- a primeira consulta de smoke tentou ordenar `organization_members` por uma coluna `created_at` inexistente, sem alterar dados; a consulta foi corrigida para a chave existente e repetida com sucesso.

**Proteção de conexão:** o rollout aplicou somente as migrations de catálogo/projeção 291–292. Nenhuma migration, tabela, trigger, função ou endpoint de conexão/Bulk foi alterado.

**Próximo passo:** publicar somente os arquivos desta otimização, sem incorporar as muitas mudanças paralelas já presentes no worktree, e executar smoke autenticado.

### 2026-08-27 — Passo 7F: isolamento da entrega para publicação

**Status:** concluído.

**Ações executadas:**

- detectadas várias alterações paralelas de outros módulos no worktree compartilhado;
- removidos os seletores desta entrega de `app/globals.css`, que já estava alterado por outro trabalho;
- criado `profiles-catalog.module.css`, isolando paginação, erro e `content-visibility` da tela de perfis;
- repetidos testes específicos (6/6), TypeScript e build Next.js, todos aprovados;
- auditados os horários em relação à última produção: as mudanças de runtime posteriores naquele deploy são as desta tela; as demais alterações posteriores são documentação, testes, scripts operacionais e migrations já tratadas por seus próprios rollouts;
- como a produção anterior foi criada a partir deste mesmo worktree e não há fonte versionada equivalente para reconstruí-la sem regressão, o deploy será feito do estado atual já validado. Criar um pacote a partir do `HEAD` antigo removeria funcionalidades que já estão em produção;
- reconfirmado imediatamente antes do deploy que os seis arquivos protegidos de conexão Meta/Zernio/Bulk não possuem diff.

**Proteção de conexão:** o isolamento evita publicar incidentalmente mudanças paralelas, inclusive arquivos de integrações que não pertencem a este plano.

**Próximo passo:** executar deploy de produção e validar `/perfis` e `/api/profiles` de forma autenticada.

### 2026-08-27 — Passo 7G: primeiro smoke de produção e gargalo de autenticação

**Status:** concluído.

**Evidências do primeiro deploy:**

- deploy Vercel `dpl_D9bPhirqSvqcfS5H2MpU5eDYc2m1` concluído como `READY` e promovido ao alias canônico;
- `/perfis` abriu autenticado na organização ativa, sem `PGRST202` e sem erro de catálogo;
- DOM limitado a 40 cards para um catálogo real de 751 perfis;
- paginação alcançou páginas 2 e 3 com 40 cards e itens diferentes;
- cada página criou somente 40 imagens; o `currentSrc` observado usa `/_next/image`, largura 64 e dimensão natural aproximada de 51×51;
- o primeiro `src` HTML é apenas fallback; o navegador selecionou efetivamente a variante de 64 px pelo `srcset`;
- o smoke revelou latência de aproximadamente 12–25 segundos nas trocas de página, portanto a entrega ainda não foi declarada concluída;
- `EXPLAIN ANALYZE` remoto mostrou a RPC de página em cerca de 119 ms e a consulta completa de diagnóstico em cerca de 135 ms. O gargalo não está no plano SQL;
- identificada a cadeia da API: `getOrganizationContext()` fazia validação remota do usuário, leitura remota de memberships e só então criava outro cliente para as duas RPCs.

**Primeira correção aplicada:** a API exclusiva do catálogo passou a verificar o JWT com `auth.getClaims()`, ler a organização ativa do cookie e reutilizar o mesmo cliente. A própria RPC mantém a checagem de membership, portanto um cookie adulterado não consegue ler outra organização. A leitura de membership fica apenas como fallback quando o cookie não existe.

**Resultado intermediário:** após o segundo deploy, o reload autenticado caiu para aproximadamente 3,0 s e uma paginação aquecida para aproximadamente 4,3 s. A primeira chamada após o deploy ainda ficou mais lenta por carregar/verificar JWKS.

**Ajuste final aplicado:** `getClaims()` foi trocado por `getSession()` apenas para detectar localmente se há sessão. Essa informação não autoriza nem filtra dados: organização/cookie e usuário são tratados como entrada não confiável, e a RPC continua verificando o JWT assinado e `is_member_of_organization()` antes de devolver qualquer linha. Assim a verificação de autorização permanece no banco e a chamada remota/JWKS saiu do caminho crítico da paginação.

**Proteção de conexão:** o smoke não clicou nem chamou qualquer ação de conexão, sincronização ou Bulk. A correção é exclusiva de autenticação/leitura em `GET /api/profiles`.

**Próximo passo:** validar e republicar a rota reduzida, depois repetir a medição autenticada.

### 2026-08-27 — Passo 8: rollout e validação final

**Status:** concluído.

**Rollout:**

- deploy final Vercel: `dpl_GrwXM8fVWgXR868ktFq21Li7XWkV`;
- estado: `READY`, produção, promovido para `https://pomodoro-theta-one-82.vercel.app`;
- banco vinculado alinhado em 001–292; dry-run final sem migrations pendentes;
- migrations efetivamente aplicadas por este plano: 291 e 292.

**Smoke autenticado final:**

- aba limpa após estabilização do alias: aproximadamente **2,47 s** até o primeiro card visível;
- troca de página já hidratada: aproximadamente **1,38 s**;
- catálogo real da organização ativa: 750 perfis no instante da medição;
- página 1/2/3: sempre 40 cards e 40 imagens no DOM, com itens trocados por cursor;
- paginação anterior/próxima habilitada corretamente e nenhum erro de catálogo;
- miniatura efetiva observada via `currentSrc`: `/_next/image`, variante de 64 px para slot de 52 px;
- nova aba estável: **0 erros de console**;
- durante a troca de aliases dos deploys intermediários, a aba antiga registrou hydration warnings ao misturar chunks de versões consecutivas; eles não se repetiram na aba limpa do deploy final.

**Validação final de código:**

- testes específicos do catálogo/UI/API: 7/7;
- suíte completa Node: **297 aprovados, 0 falhas**;
- pgTAP funcional 291: 18/18;
- pgTAP de escala com 2.000 perfis: 5/5;
- pgTAP da projeção 292: 9/9;
- TypeScript: aprovado;
- build local e três builds de produção Vercel: aprovados;
- `git diff --check`: aprovado nos arquivos desta entrega;
- arquivos protegidos Meta/Zernio/Bulk: nenhum diff.

**Resultado:** a tela deixou de transferir/renderizar o catálogo inteiro e agora trabalha com páginas fixas de 40, filtros no servidor, cursor estável, resumo compacto e avatares pequenos cacheáveis. O custo no navegador permanece constante mesmo quando o catálogo ultrapassa 2.000 itens.

**Proteção de conexão final:** nenhuma função, rota ou arquivo de conectar perfil foi alterado; o Bulk Zernio foi somente preservado e coberto por regressão estática, conforme solicitado.

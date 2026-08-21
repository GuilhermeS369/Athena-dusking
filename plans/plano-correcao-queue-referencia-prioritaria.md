# Plano de correção integral da fila — modelo novo prioritário

## Decisão principal

A rota `/queue` será corrigida com estas regras obrigatórias:

1. O **modelo novo baseado na referência** será a visualização principal, padrão e exibida primeiro.
2. O **modelo clássico** será secundário e só aparecerá quando o usuário selecionar explicitamente essa opção na chavinha.
3. Em nenhuma circunstância o modelo clássico será renderizado abaixo, dentro ou misturado ao modelo novo.
4. A preferência poderá ser persistida no navegador, mas o primeiro acesso e qualquer valor inválido sempre usarão o modelo novo.
5. A correção inclui uma **revisão completa do CSS novo e do CSS antigo relacionado à fila**. Não será apenas um remendo nos componentes.
6. Nenhuma ação poderá ser simulada. Toda ação que altera a fila deverá ter efeito real, confirmação adequada, resposta do servidor e atualização visual baseada no resultado persistido.

## Diagnóstico da implementação atual

### Problemas de composição

- O modo novo em [`QueueClient()`](../app/queue/queue-client.tsx:409) renderiza [`LumoraQueueView()`](../app/queue/queue-client.tsx:270) e também renderiza [`ClassicQueueList()`](../app/queue/queue-client.tsx:210) logo abaixo. Isso cria a duplicação visual e impede que os dois modelos sejam experiências independentes.
- Os KPIs estão fora do painel principal em [`QueueClient()`](../app/queue/queue-client.tsx:442), enquanto a referência concentra título, ações, KPIs e progresso no mesmo card superior.
- Filtros e ações foram colocados em um painel genérico separado em [`QueueClient()`](../app/queue/queue-client.tsx:450), quebrando a hierarquia visual observada na referência.
- O modo novo usa uma grade de cards em [`LumoraQueueView()`](../app/queue/queue-client.tsx:309), mas a referência usa uma lista vertical de linhas horizontais compactas.
- O painel de jobs foi acoplado ao fluxo principal sem hierarquia clara. Ele deve continuar acessível, mas não pode competir com o resumo e a lista principal.

### Problemas de CSS confirmados

- Há estilos antigos da fila compartilhados globalmente, como [`.queue-section`](../app/globals.css:911), [`.queue-card`](../app/globals.css:915), [`.queue-toolbar`](../app/globals.css:978) e [`.queue-item`](../app/globals.css:986), que precisam ser separados entre clássico e novo para evitar colisões.
- Classes estruturais usadas pelo JSX novo, como `queue-page`, `queue-kpi-grid`, `queue-control-panel`, `queue-lumora-panel`, `queue-lumora-grid`, `queue-lumora-card` e `queue-view-switch`, não possuem um bloco-base completo e coerente no CSS atual. Há somente regras responsivas isoladas, como [`.queue-lumora-progress`](../app/globals.css:1251), sem a fundação visual necessária.
- A regra mobile de [`.queue-hero-actions`](../app/globals.css:1249) força empilhamento e largura total em elementos que ainda não possuem comportamento-base consistente.
- Seletores genéricos e antigos afetam simultaneamente a visualização clássica, o modo novo, o CTA de postagem e o modal, tornando espaçamentos, larguras e botões imprevisíveis.
- A revisão deverá remover classes órfãs, duplicadas e sem uso; não será permitido apenas acrescentar mais regras no final de [`app/globals.css`](../app/globals.css).

### Problemas funcionais e de dados

- A ação `Limpar concluídas` não é persistente. O hook apenas oculta estados localmente em [`runQueueAction()`](../app/queue/use-publication-queue.ts:1), e a API atual devolve uma mensagem sem alterar dados em [`POST()`](../app/api/publications/queue-actions/route.ts:1).
- O resumo atual em [`GET()`](../app/api/publications/summary/route.ts:1) retorna totais gerais, mas não entrega agregações globais completas por conta, lote e grupo. O modo novo acaba dependendo apenas dos lotes paginados já carregados.
- Contagens, percentuais e estados podem divergir entre os KPIs e os cards porque não existe uma única resposta agregada usada como fonte de verdade.
- Ações destrutivas ou em massa precisam ter escopo explícito, confirmação e relatório do que foi alterado, ignorado ou recusado.

## Alvo visual obrigatório do modelo novo

### 1. Estrutura da página

A página será reconstruída nesta ordem:

1. Cabeçalho discreto da rota, sem competir com o painel da fila.
2. Chavinha de visualização com `Novo` selecionado por padrão e `Clássico` como alternativa secundária.
3. Card principal único da fila contendo:
   - título `Fila de Postagem`;
   - total real de itens;
   - ações operacionais alinhadas no canto superior direito;
   - quatro KPIs compactos;
   - progresso geral;
   - tabs de agrupamento.
4. Legenda operacional compacta.
5. Lista vertical de linhas agregadas.
6. Paginação ou carregamento incremental dos detalhes somente quando necessário.
7. Jobs de geração em uma seção secundária recolhível, sem misturar seus cards com as linhas da fila principal.

### 2. Cabeçalho e ações

As ações ficarão dentro do card principal, no mesmo nível visual do título, seguindo a referência:

- `Recarregar`;
- `Processar`;
- `Tirar travadas` com quantidade real;
- `Limpar concluídas`;
- `Cancelar`;
- `Limpar`.

Regras visuais:

- ações textuais compactas no desktop;
- ícones consistentes e rótulos sempre legíveis;
- sem botões grandes, gradientes excessivos ou blocos espalhados;
- estados de hover, foco, carregando, sucesso, erro e desabilitado;
- ações destrutivas com cor e confirmação próprias;
- no mobile, toolbar com rolagem horizontal ou menu de ações, evitando uma coluna de botões gigantes.

### 3. KPIs e progresso

Os quatro KPIs serão internos ao card principal:

- `OK`: itens publicados;
- `PENDENTES`: itens aguardando ou prontos;
- `ERROS`: itens com falha;
- `CONTAS NA FILA`: contas com itens ativos sobre o total de contas presentes na fila.

O progresso geral será calculado pela mesma fonte agregada dos KPIs. Cancelados, removidos e arquivados não serão apresentados como publicados. A fórmula e os denominadores serão documentados no código para impedir percentuais enganosos.

### 4. Tabs e linhas horizontais

Tabs principais:

- `Por conta` será a tab inicial;
- `Por lote` será a segunda tab;
- `Por grupo` será a adaptação real de `Por pasta`, porque o domínio atual possui grupos de perfis e não pastas equivalentes às da referência.

Cada linha será horizontal e compacta, contendo:

- avatar real ou iniciais;
- nome principal e identificação secundária;
- estado operacional em chip curto;
- barra fina de progresso;
- concluídos sobre total;
- quantidade de erros;
- próxima execução quando aplicável;
- affordance de detalhe;
- ações contextuais apenas quando houver uma operação válida para aquele agrupamento.

A lista não usará a grade de cards grandes existente hoje.

### 5. Detalhes sem contaminar o resumo

- Clique em uma conta aplicará o contexto da conta e abrirá detalhes sob demanda.
- Clique em um lote abrirá seus itens e ações reais.
- Clique em um grupo exibirá contas e itens daquele grupo.
- O modal atual será preservado para mídia, legenda, erro, tentativas, eventos e timeline em [`PublicationDetailsModal()`](../app/queue/queue-client.tsx:357), mas terá o CSS revisado e poderá ser extraído para um componente próprio.

## Revisão completa de CSS

Esta é uma frente obrigatória e bloqueante da correção.

### Auditoria e limpeza

1. Inventariar todas as classes `queue-*` usadas em [`app/queue/queue-client.tsx`](../app/queue/queue-client.tsx), [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx) e [`app/globals.css`](../app/globals.css).
2. Marcar cada classe como `novo`, `clássico`, `compartilhado`, `modal`, `jobs` ou `órfão`.
3. Remover regras órfãs e duplicadas.
4. Eliminar dependências acidentais entre o novo modo e classes genéricas do clássico.
5. Não alterar globalmente `.panel`, `.button` ou outros componentes-base apenas para corrigir `/queue`.

### Escopo dos estilos

- Todos os seletores do novo modo ficarão sob `.queue-reference-view`.
- Todos os seletores do clássico ficarão sob `.queue-classic-view`.
- Modal e jobs terão namespaces próprios.
- O CTA de [`PublishingClient()`](../app/postagem/publishing-client.tsx:115) não reutilizará classes estruturais da tela operacional.
- Se [`app/globals.css`](../app/globals.css) continuar causando colisões, os estilos específicos serão movidos para um CSS Module dedicado à fila, mantendo globais apenas tokens e componentes realmente compartilhados.

### Layout desktop

- Definir largura máxima, centralização e paddings coerentes com o shell existente.
- Fazer o card principal usar toda a largura útil sem ficar esticado além da referência.
- Usar grid somente nos KPIs; a fila agregada será uma lista vertical.
- Garantir alinhamento por colunas nas linhas horizontais.
- Padronizar alturas, raios, bordas, contraste e ritmo vertical.
- Evitar sombras, gradientes e brilhos mais fortes que os da referência.

### Layout responsivo

Validar pelo menos estes intervalos:

- desktop largo;
- notebook;
- tablet;
- celular.

Em telas menores:

- KPIs passam de quatro para dois e depois uma coluna somente se necessário;
- tabs podem rolar horizontalmente sem quebrar texto;
- linhas passam para composição compacta em blocos, preservando prioridade de nome, status e progresso;
- números e ações não podem sobrepor o avatar ou a barra;
- nenhum elemento pode produzir rolagem horizontal da página;
- modal deve ocupar a viewport com áreas roláveis corretas;
- alvos interativos e foco por teclado devem continuar acessíveis.

### Estados que terão CSS próprio

- carregamento inicial com skeleton na geometria final;
- atualização sem desmontar a lista;
- lista vazia;
- erro de carregamento;
- ação em andamento;
- sucesso e erro de ação;
- agrupamento sem avatar;
- progresso zero e progresso completo;
- item com falha;
- fila sem itens ativos;
- modo de seleção para cancelamento.

### Critério visual de aceite

- Comparar a implementação lado a lado com os prints de referência em desktop e mobile.
- Validar hierarquia, densidade, espaçamento, alinhamento, proporção dos cards, toolbar, KPIs, barras e linhas.
- Não aceitar como concluído apenas porque compila.
- Não aceitar classes sem regra-base, regras responsivas órfãs ou estilos que só funcionem em uma largura específica.

## Comportamento real de cada ação

### Recarregar

- Executar em paralelo o resumo, a lista detalhada visível e os jobs.
- Manter a interface anterior enquanto atualiza.
- Exibir data da última atualização e falha parcial quando apenas uma fonte falhar.

### Processar

- Chamar o dispatcher real já conectado por [`dispatchPublicationQueue()`](../lib/publications/dispatcher.ts:306).
- Restringir por permissão de gerenciamento.
- Impedir duplo clique e chamadas concorrentes do mesmo usuário.
- Mostrar quantos itens foram reivindicados, processados e em qual estado terminaram.
- Recarregar resumo e lista após a resposta.

### Tirar travadas

- Contar no backend somente leases expirados de itens em processamento.
- Exibir essa contagem no rótulo antes da ação.
- Liberar apenas itens realmente expirados; itens ainda processados por worker ativo não poderão ser tocados.
- Registrar evento operacional ou auditoria para cada liberação.
- Retornar quantidade liberada e atualizar a fila.

### Limpar concluídas

Será uma operação persistente de **arquivamento**, não exclusão física e não ocultação somente local.

1. Criar migração nova em `supabase/migrations/` adicionando marca de arquivamento e metadados de auditoria aos itens concluídos.
2. Criar operação atômica para arquivar somente estados terminais permitidos.
3. Excluir arquivados da visualização operacional padrão em [`GET()`](../app/api/publications/route.ts:114) e no resumo.
4. Preservar mídia, eventos, erros, autoria e histórico para auditoria.
5. Permitir consultar arquivados no modo clássico por filtro explícito, sem trazê-los de volta ao painel principal.
6. Exigir confirmação contendo a quantidade real que será arquivada.

### Cancelar

- Ativar modo de seleção para contas, lotes ou itens compatíveis com cancelamento.
- Exibir escopo e quantidade selecionada.
- Confirmar antes de executar.
- Usar as regras reais de cancelamento de item em [`PATCH()`](../app/api/publications/%5BitemId%5D/route.ts:13) e de lote em [`POST()`](../app/api/publications/batch/%5BbatchId%5D/cancel/route.ts:9).
- Para seleção cruzando vários lotes, criar endpoint bulk transacional ou coordenado; não disparar uma sequência opaca sem relatório.

### Limpar

- Limpar seleção, busca, filtros temporários e contexto expandido da tela.
- Não apagar publicações e não fingir alteração no backend.
- O rótulo receberá tooltip e estado desabilitado quando não houver contexto visual para limpar.

## Fonte de verdade e agregações

### Resumo global

Expandir [`GET()`](../app/api/publications/summary/route.ts:1) para retornar, em uma única estrutura consistente:

- totais por status;
- total operacional e total arquivado;
- progresso geral;
- contas ativas e total de contas na fila;
- quantidade de leases expirados;
- agregações pagináveis por conta;
- agregações pagináveis por lote;
- agregações pagináveis por grupo;
- próxima execução e erros por agrupamento;
- timestamp do snapshot.

Se as consultas diretas forem pesadas, criar uma RPC SQL com índices adequados. A UI não calculará números globais usando apenas a página detalhada carregada.

### Detalhes sob demanda

- O resumo carregará primeiro.
- Itens detalhados serão consultados ao expandir uma conta, lote ou grupo.
- URLs de mídia continuarão assinadas sob demanda.
- Polling adaptativo será usado apenas quando houver trabalho ativo; não haverá recarga agressiva da página inteira.

## Separação definitiva entre novo e clássico

### Modelo novo

- É o padrão e o foco da rota.
- Usa resumo global, tabs e linhas compactas.
- Contém a toolbar inspirada na referência.
- Não renderiza [`ClassicQueueList()`](../app/queue/queue-client.tsx:210) em sua árvore.

### Modelo clássico

- Só é montado quando a chavinha estiver em `Clássico`.
- Preserva filtros, lotes, paginação, detalhes, retry, cancelamento e eventos.
- Recebe namespace CSS próprio.
- Não duplica KPIs nem toolbar do modelo novo.
- Pode conter filtro de arquivados para auditoria.

### Chavinha

- `Novo` aparece primeiro e selecionado por padrão.
- `Clássico` aparece como alternativa secundária.
- A preferência salva só será respeitada depois que a pessoa escolher manualmente o clássico; valor ausente ou inválido volta para o novo.
- A chavinha não desmontará estado compartilhado necessário, mas cada modelo terá sua própria composição visual.

## Plano de alteração por arquivo

### [`app/queue/queue-client.tsx`](../app/queue/queue-client.tsx)

- Remover a renderização duplicada do clássico dentro do novo.
- Dividir o arquivo em componentes menores.
- Tornar o painel de referência o contêiner principal de título, ações, KPIs, progresso, tabs e lista.
- Extrair modal, jobs, clássico e novo para arquivos próprios quando a separação reduzir colisões.

### [`app/queue/use-publication-queue.ts`](../app/queue/use-publication-queue.ts)

- Separar estado de resumo, detalhes, seleção e ações.
- Remover a falsa limpeza local de concluídos.
- Adicionar invalidação coordenada após mutações.
- Controlar concorrência, mensagens de resultado e erros parciais.

### [`app/api/publications/summary/route.ts`](../app/api/publications/summary/route.ts)

- Entregar agregações globais reais por tab.
- Entregar contagem de travadas e progresso com fórmula única.
- Suportar paginação dos agrupamentos quando o volume exigir.

### [`app/api/publications/queue-actions/route.ts`](../app/api/publications/queue-actions/route.ts)

- Manter processamento real.
- Endurecer a liberação de travadas com auditoria e proteção de worker ativo.
- Substituir `clear_completed` sem persistência por arquivamento real.
- Padronizar resposta por ação com contagens e erros.

### [`app/api/publications/route.ts`](../app/api/publications/route.ts)

- Excluir arquivados por padrão.
- Adicionar filtro explícito de arquivados para o clássico.
- Preservar paginação por cursor.

### [`app/globals.css`](../app/globals.css)

- Executar auditoria completa dos seletores de fila.
- Remover estilos quebrados, órfãos e conflitantes.
- Criar namespaces separados para novo, clássico, jobs e modal.
- Reescrever desktop, tablet e mobile com base na estrutura final.
- Evitar qualquer correção global que degrade outras páginas.

### [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx)

- Manter apenas o compositor e um CTA visualmente independente para `/queue`.
- Remover qualquer dependência restante do CSS estrutural da fila.

### Migração Supabase nova

- Adicionar arquivamento persistente, índices, função atômica e políticas necessárias.
- Preservar histórico e impedir arquivamento de itens ainda ativos.

## Ordem de implementação após autorização

1. Registrar uma matriz visual e funcional baseada nos prints e, se necessário, revalidar a tela externa autenticada antes de escrever o novo JSX.
2. Corrigir a árvore de renderização para separar completamente novo e clássico.
3. Implementar fonte agregada global por conta, lote e grupo.
4. Implementar arquivamento real de concluídos e auditoria de destravamento.
5. Conectar todas as ações a respostas reais do backend.
6. Reconstruir o modelo novo com a hierarquia da referência.
7. Revisar integralmente e reorganizar o CSS da fila.
8. Ajustar o modelo clássico sem alterar suas funções existentes.
9. Validar responsividade, acessibilidade e estados de interação.
10. Executar validações técnicas e um roteiro manual de operações reais.

## Checklist de aceite

### Prioridade e composição

- [ ] `/queue` abre no modelo novo.
- [ ] O modelo novo aparece antes do clássico na chavinha.
- [ ] O clássico nunca é renderizado dentro ou abaixo do novo.
- [ ] O clássico só aparece após seleção explícita.

### Fidelidade visual

- [ ] Título, total, toolbar, KPIs e progresso estão no mesmo painel principal.
- [ ] Ações estão alinhadas e compactas como na referência.
- [ ] `Por conta` abre por padrão.
- [ ] Contas, lotes e grupos usam linhas horizontais, não grade de cards grandes.
- [ ] Avatar, status, progresso, próxima execução, totais e erros estão alinhados.
- [ ] Jobs aparecem como seção secundária e não poluem a lista principal.

### CSS

- [ ] Todas as classes usadas possuem regra-base coerente.
- [ ] Não existem regras responsivas órfãs.
- [ ] Novo e clássico têm namespaces separados.
- [ ] Classes antigas e órfãs foram removidas.
- [ ] Nenhum ajuste global quebre postagem, agenda, operação ou galeria.
- [ ] Desktop, notebook, tablet e celular foram validados visualmente.
- [ ] Não há overflow, sobreposição, botões gigantes ou espaçamento inconsistente.

### Funções reais

- [ ] Recarregar atualiza todas as fontes necessárias.
- [ ] Processar chama o dispatcher e mostra resultado real.
- [ ] Tirar travadas usa contagem real e só libera leases expirados.
- [ ] Limpar concluídas persiste arquivamento e preserva histórico.
- [ ] Cancelar respeita seleção, escopo, permissão e confirmação.
- [ ] Limpar redefine estado visual sem alegar alteração no backend.
- [ ] Retry, cancelar item, cancelar lote, detalhes, mídia, eventos e jobs continuam funcionando.

### Dados e qualidade

- [ ] KPIs e agrupamentos vêm de resumo global, não só da página carregada.
- [ ] Percentuais usam uma fórmula única e documentada.
- [ ] Permissões de organização continuam aplicadas.
- [ ] TypeScript passa sem erros.
- [ ] Build de produção passa.
- [ ] Roteiro manual valida cada ação com sucesso, erro e estado vazio.
- [ ] Comparação visual lado a lado com a referência foi aprovada antes de encerrar.

## Bloqueio de execução

Este documento é somente o plano de correção. Nenhuma alteração de implementação deve começar antes da autorização explícita do usuário.

# Plano de otimização de navegação e carregamento

## Objetivo

Deixar a navegação do painel mais leve e previsível, mantendo o menu lateral sempre visível e mostrando um skeleton discreto apenas na área de conteúdo enquanto a próxima página carrega.

## Preferência visual definida

- Skeleton leve dentro da área principal.
- Sem overlay escuro.
- Sem desmontar/sumir com o menu lateral.
- Sem remover funcionalidades existentes.

## Status geral

- [x] Fase 1 — Criar layout persistente para rotas protegidas.
- [x] Fase 2 — Reorganizar páginas sem mudar URLs.
- [x] Fase 3 — Criar skeleton global do painel.
- [x] Fase 4 — Criar skeletons reutilizáveis por tipo de página.
- [x] Fase 5 — Feedback imediato no clique do menu.
- [x] Fase 6 — Streaming com Suspense nas páginas pesadas.
- [x] Fase 7 — Reduzir peso inicial sem remover funções.
- [x] Fase 8 — CSS de skeleton e acessibilidade.
- [ ] Validação final completa.

---

## Fase 1 — Criar layout persistente para rotas protegidas

### O que fazer

Criar um grupo de rotas autenticadas, por exemplo `app/(painel)/layout.tsx`, responsável por:

- chamar `getOrganizationContext()` uma vez no layout;
- validar usuário e organização ativa;
- renderizar `AppShell` por fora das páginas;
- deixar o menu lateral persistente entre navegações.

Depois, as páginas protegidas deixam de envolver tudo com `AppShell`. Elas passam a renderizar apenas o conteúdo específico da rota.

### Resultado esperado

Ao clicar no menu, o layout lateral não desmonta mais.

### Status

- [x] Implementado em `app/(painel)/layout.tsx`.
- [x] `AppShell` passou a ficar no layout persistente.
- [x] `getOrganizationContext()` foi memoizado com `cache()` em `lib/organizations/server.ts`.

---

## Fase 2 — Reorganizar páginas sem mudar URLs

### O que fazer

Mover as páginas protegidas para dentro do grupo de rotas sem alterar o endereço público.

URLs que devem continuar iguais:

- `/`
- `/postagem`
- `/galeria`
- `/perfis`
- `/perfis/[profileId]`
- `/grupos`
- `/agenda`
- `/zernio`
- `/bulk-import`
- `/operacao`

O grupo de rotas do Next não muda a URL, então a experiência externa permanece igual.

### Status

- [x] Dashboard movido para `app/(painel)/page.tsx`.
- [x] Postagem movida para `app/(painel)/postagem/page.tsx`.
- [x] Galeria movida para `app/(painel)/galeria/page.tsx`.
- [x] Perfis movida para `app/(painel)/perfis/page.tsx`.
- [x] Detalhe de perfil movido para `app/(painel)/perfis/[profileId]/page.tsx`.
- [x] Grupos movida para `app/(painel)/grupos/page.tsx`.
- [x] Agenda movida para `app/(painel)/agenda/page.tsx`.
- [x] Zernio movida para `app/(painel)/zernio/page.tsx`.
- [x] Bulk Import movida para `app/(painel)/bulk-import/page.tsx`.
- [x] Status / Logs movida para `app/(painel)/operacao/page.tsx`.

---

## Fase 3 — Criar skeleton global do painel

### O que fazer

Criar um carregamento global em `app/(painel)/loading.tsx`, com skeleton leve dentro da área principal.

Esse skeleton deve imitar a estrutura básica das páginas:

- cabeçalho com título falso;
- barra de filtros falsa;
- cards falsos;
- grid/lista falsa;
- linhas shimmer discretas.

Ele não deve incluir menu lateral, porque o menu já estará persistente no layout.

### Status

- [x] Implementado em `app/(painel)/loading.tsx`.
- [x] Usa `PageLoadingSkeleton`.

---

## Fase 4 — Criar skeletons por tipo de página

### O que fazer

Criar componentes reutilizáveis com variações:

- skeleton de dashboard/analytics;
- skeleton de lista de cards;
- skeleton de galeria;
- skeleton de tabela/logs;
- skeleton de formulário/configuração;
- skeleton de detalhe de perfil.

Isso permite que `loading.tsx` mostre uma versão genérica e que cada rota possa ter um skeleton mais parecido com sua tela quando necessário.

### Status

- [x] Criado `app/components/page-loading-skeleton.tsx`.
- [x] Variações iniciais disponíveis: `dashboard`, `cards`, `gallery`, `logs`, `form`.

---

## Fase 5 — Feedback imediato no clique do menu

### O que fazer

Ajustar os links do menu em `AppShell` para marcar transição assim que o usuário clicar.

Comportamento planejado:

- usuário clica em Galeria;
- sidebar continua visível;
- área principal recebe estado visual de carregamento;
- quando `usePathname()` muda, o estado de carregamento é encerrado;
- se o clique for no link já ativo, não dispara loading.

Isso evita a sensação de “cliquei e nada aconteceu”.

### Status

- [x] Implementado em `app/components/app-shell.tsx`.
- [x] Estado `pendingHref` controla o skeleton imediato no conteúdo.
- [x] `aria-busy` aplicado na área principal.

---

## Fase 6 — Streaming com Suspense nas páginas pesadas

### O que fazer

Dividir páginas grandes em blocos menores com carregamento progressivo.

Prioridade:

1. `OperationPage()` — carregar resumo principal primeiro; logs, eventos, workers e throughput podem entrar em blocos separados.
2. `PublishingPage()` — carregar compositor primeiro; histórico/fila e métricas secundárias sob demanda ou em bloco separado.
3. `GalleryPage()` — mostrar estrutura da galeria cedo; URLs assinadas e estados de publicação podem ser otimizados.
4. `ProfilesPage()` — mostrar cards de perfis cedo; métricas analíticas e link espelho podem carregar sem travar a tela toda.
5. `ProfileDetailPage()` — dados básicos do perfil primeiro; analytics, publicações e histórico em seções separadas.

### Checklist da fase

- [x] Mapear blocos essenciais e blocos secundários de `OperationPage()`.
- [x] Criar skeleton específico para seções secundárias de operação.
- [x] Separar dados secundários de workers, jobs, alertas e throughput.
- [x] Mapear blocos essenciais e blocos secundários de `PublishingPage()`.
- [x] Garantir que fila/histórico continue sob demanda.
- [x] Mapear otimização segura para URLs assinadas na `GalleryPage()`.
- [x] Mapear métricas secundárias em `ProfilesPage()`.
- [x] Mapear analytics secundários em `ProfileDetailPage()`.

### Status

- [x] `DashboardPage()` agora usa `Suspense` com skeleton de analytics.
- [x] `OperationPage()` agora usa `Suspense` com skeleton de logs.
- [x] `PublishingPage()` agora usa `Suspense` com skeleton de formulário.
- [x] `GalleryPage()` agora usa `Suspense` com skeleton de galeria.
- [x] `ProfilesPage()` agora usa `Suspense` com skeleton de cards.
- [x] `ProfileDetailPage()` agora usa `Suspense` com skeleton de analytics/detalhe.
- [x] Build validado após as mudanças.

---

## Fase 7 — Reduzir peso inicial sem remover funções

### O que fazer

O foco é não tirar nenhuma função, só mudar o momento em que cada dado chega.

Ações recomendadas:

- manter no primeiro render apenas dados necessários para desenhar a tela inicial;
- paginar listas grandes já na entrada;
- evitar `select('*')` quando a tela não usa todas as colunas;
- adiar URLs assinadas de mídia quando não forem visíveis imediatamente;
- carregar contagens exatas só quando realmente aparecem na UI;
- mover dados de “histórico”, “logs”, “analytics detalhado” e “diagnóstico” para chamadas secundárias;
- reaproveitar padrões já existentes no cliente, como carregamento sob demanda em `refreshQueue()`, carregamento automático de galeria em `loadMoreAssets()` e carregamento da agenda em `loadAgendaPage()`.

### Ajustes já iniciados

- [x] Reduzido carregamento inicial de Status / Logs de 80 para 40 itens por lista inicial em `app/(painel)/operacao/page.tsx`.
- [x] Reduzido carregamento inicial de mídias do compositor de 30 para 18 itens em `app/(painel)/postagem/page.tsx`.
- [x] Reduzido carregamento inicial da galeria de 30 para 24 itens em `app/(painel)/galeria/page.tsx`.
- [x] Removido `select('*')` da tela Zernio em `app/(painel)/zernio/page.tsx`.
- [x] Reduzida janela/limite de dados analíticos do Dashboard em `lib/dashboard/server.ts`.

### Próximos passos da fase

- [x] Validar se todos os campos removidos de `select('*')` em Zernio cobrem a UI e ações.
- [x] Mover dados superuser de `OperationPage()` para um lote menor de carregamento inicial.
- [x] Avaliar se os estados de publicação da Galeria podem carregar após a primeira pintura.
- [x] Avaliar se métricas de perfil podem ser carregadas incrementalmente.
- [x] Medir build e navegação depois de cada lote de mudança.

---

## Fase 8 — CSS de skeleton e acessibilidade

### O que fazer

Atualizar `app/globals.css` com:

- classes globais de skeleton;
- animação shimmer discreta;
- fade leve só na área principal;
- estado `aria-busy` na área de conteúdo;
- mensagens com `aria-live` quando fizer sentido;
- regra para reduzir movimento com `prefers-reduced-motion`.

O visual deve seguir o estilo atual: fundo escuro, painéis arredondados e roxo discreto.

### Status

- [x] Implementado em `app/globals.css`.

---

## Ordem de trabalho daqui para frente

1. Validar as alterações já feitas na Fase 7 com build.
2. Seguir para Fase 6, começando por `OperationPage()`.
3. Depois aplicar progressivamente em `PublishingPage()`, `GalleryPage()`, `ProfilesPage()` e `DashboardPage()`.
4. Rodar build após cada bloco grande.
5. Fazer navegação manual entre as páginas principais.

---

## Validação final

Após implementar tudo, validar com:

- build pelo script `npm run build`;
- navegação manual entre Dashboard, Postagem, Galeria, Perfis, Grupos, Agenda, Zernio, Bulk Import e Status / Logs;
- teste de troca de organização pelo seletor em `switchOrganization()`;
- verificação de que upload, filtros, paginação, criação de postagem, edição de grupos e logs continuam funcionando.

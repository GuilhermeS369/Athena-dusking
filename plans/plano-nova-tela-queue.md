# Plano — Nova tela `/queue` com visual Lumora e alternância para modelo atual

## Objetivo

Criar uma nova tela `/queue` para concentrar a parte de **Histórico e operação / Fila de publicação** que hoje fica dentro de [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx). A tela nova deve:

- manter as funções operacionais atuais da nossa fila;
- priorizar a visualização inspirada na página de referência acessada em `https://icelab-saas.vercel.app/dashboard/queue`;
- adaptar o layout às nossas cores atuais de [`app/globals.css`](../app/globals.css);
- permitir alternar por uma chavinha entre:
  - **Modo novo / operacional por resumo**: inspirado na referência;
  - **Modo clássico / lote detalhado**: visualização atual reaproveitada de `/postagem`.

## O que foi confirmado na referência externa

A referência foi acessada com login de teste em navegador automatizado, em sessão temporária. O acesso autenticado abriu a tela `Fila de Postagem`.

### Estrutura visual principal

- Layout escuro, com fundo `#0a0a0a`, tipografia Geist e cartões estilo vidro.
- Sidebar recolhida em desktop, com largura aproximada de `68px`, expandindo no hover para `240px`.
- Item ativo da navegação com fundo branco translúcido e barra vertical roxa à esquerda.
- Conteúdo principal com um card superior grande em borda arredondada, borda sutil e gradiente vertical translúcido.
- Título: **Fila de Postagem**.
- Subtítulo/contador: **9.690 itens no total**.
- Toolbar textual no topo com ações:
  - `Recarregar`
  - `Processar`
  - `Tirar travadas (0)`
  - `Limpar concluídas`
  - `Cancelar`
  - `Limpar`

### KPIs do topo

A referência exibe quatro cards compactos:

- `OK` com total concluído/postado;
- `PENDENTES` com total pendente;
- `ERROS` com total de falhas;
- `CONTAS NA FILA` com fração `ativas/total`, exemplo `44/49`.

Logo abaixo há barra de progresso geral:

- label `Progresso geral`;
- percentual grande, exemplo `93%`;
- barra horizontal fina com preenchimento roxo.

### Modos de agrupamento da referência

A referência tem três abas em botões arredondados:

1. **Por conta 49**
   - Lista longa de cards por perfil.
   - Cada card mostra avatar, username, etiqueta de estado, próxima execução e progresso.
   - Exemplo de card: `@donizeti.decarvalho578`, `● Postando`, `próx 3min`, `215/225 · 1 erro(s)`.
   - Há barra de progresso por conta.

2. **Por lote 3**
   - Lista agregada por lote/campanha.
   - Exemplo de cards:
     - `LO`, `Looping · teste`, `7988/8709 · 39 erro(s)`;
     - `CA`, `Campanha`, `516/516`;
     - `SE`, `Sem campanha`, `425/425 · 1 erro(s)`.
   - Usa avatar textual circular com as iniciais do lote.

3. **Por pasta 2**
   - Lista agregada por pasta/status macro.
   - Exemplo de cards:
     - `PO`, `Postadas`, `7833/8554 · 35 erro(s)`;
     - `SU`, `Suspensas`, `1096/1096 · 5 erro(s)`.

### Legenda de estados

Na aba por conta existe legenda compacta:

- `● Postando — na ativa`
- `↻ Vai reabastecer — fila acabou mas o loop enche de novo (continua)`
- `⏸ Em pausa — bloqueada, volta sozinha`
- `■ Parada — loop desligado, não continua`

Para o nosso sistema, esses estados precisam ser traduzidos para o domínio atual da fila de publicação.

## Mapeamento com nossa fila atual

### Onde a fila está hoje

A UI de fila está embutida em [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx), a partir do estado e funções do componente `PublishingClient`.

Trechos/funções importantes a preservar:

- Tipos principais: `QueueItem`, `Batch`, `PublicationEvent`, `PublicationGenerationJob` em [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx).
- Carregamento paginado de lotes por `GET /api/publications` em [`refreshQueue`](../app/postagem/publishing-client.tsx).
- Filtros atuais:
  - status: todos, agendados, processamento, falha, publicados;
  - formato: imagem, reel, story, carrossel;
  - execução: imediata/agendada;
  - perfil;
  - grupo.
- Ações por item em [`handleQueueAction`](../app/postagem/publishing-client.tsx): cancelar e reprocessar.
- Ação por lote em [`cancelBatch`](../app/postagem/publishing-client.tsx): cancelar lote inteiro ou itens visíveis.
- Modal de detalhes da publicação, com mídia, histórico, eventos e erro mais recente.
- Jobs grandes de geração assíncrona em `GET /api/publication-generation-jobs` e cancelamento por `PATCH /api/publication-generation-jobs/[jobId]`.

### APIs atuais que devem continuar sendo fonte de verdade

- [`app/api/publications/route.ts`](../app/api/publications/route.ts)
  - `GET`: lista `publication_batches` com `publication_items`, eventos, mídia e perfil.
  - Já aceita filtros por status, formato, timing, perfil e grupo.
  - Já usa paginação por cursor `created_at/id`.
  - `POST`: cria publicações/lotes a partir do compositor; deve continuar em `/postagem`.
- [`app/api/publications/[itemId]/route.ts`](../app/api/publications/%5BitemId%5D/route.ts)
  - `PATCH cancel`: cancela item ativo/falhado.
  - `PATCH retry`: reenfileira item falhado dentro do limite de tentativas.
- [`app/api/publications/batch/[batchId]/cancel/route.ts`](../app/api/publications/batch/%5BbatchId%5D/cancel/route.ts)
  - `POST`: cancela lote inteiro ou itens visíveis e atualiza estados de mídia.
- [`app/api/publication-generation-jobs/route.ts`](../app/api/publication-generation-jobs/route.ts)
  - `GET`: lista jobs grandes recentes.

## Arquitetura proposta

### 1. Separar fila do compositor

Criar uma nova rota server:

- `app/(painel)/queue/page.tsx`

Responsabilidades:

- validar usuário/organização com `getOrganizationContext`, igual a [`app/(painel)/postagem/page.tsx`](../app/(painel)/postagem/page.tsx);
- carregar somente dados pequenos necessários para filtros iniciais:
  - organização ativa;
  - perfis (`id`, `username`, `display_name`, `profile_picture_url`, provider);
  - grupos (`id`, `name`, membros);
- não carregar a fila completa no server; manter lazy load/client fetch como já ocorre hoje.

Criar client novo:

- `app/queue/queue-client.tsx`

Esse client deve receber `activeOrganization`, `profiles`, `groups` e renderizar a nova experiência.

### 2. Extrair lógica compartilhada da fila

Hoje a fila está acoplada ao compositor em [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx). Para evitar duplicação e manter as funções, criar módulos/componentes compartilhados:

- `app/queue/publication-queue-types.ts`
  - `QueueItem`, `Batch`, `QueueProfile`, `PublicationEvent`, `PublicationGenerationJob`, `QueueCursor`.
- `app/queue/publication-queue-utils.ts`
  - `statusLabel`;
  - `providerLabel`;
  - `providerDescription`;
  - `formatShortDate`;
  - `batchScheduleSummary`;
  - `batchStatusSummary`;
  - `sortQueueItemsBySchedule`;
  - `isQueueItemCancelable`;
  - agregadores do modo novo.
- `app/queue/use-publication-queue.ts`
  - estado `batches`, `queueCursor`, `hasMoreBatches`, `refreshQueue`, `appendQueueFilterParams`;
  - filtros atuais;
  - `handleQueueAction` e `cancelBatch` chamando as APIs existentes.
- `app/queue/publication-details-modal.tsx`
  - modal atual de detalhes reaproveitado.
- `app/queue/generation-jobs-panel.tsx`
  - painel de jobs grandes movido de `/postagem` para `/queue` ou mantido como seção opcional.

Depois, [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx) deve ficar focado no compositor. A seção `Histórico e operação` sai de `/postagem`, podendo virar um CTA curto `Abrir fila` apontando para `/queue`.

### 3. Dois modos de visualização

Adicionar estado persistido no client:

```ts
type QueueViewMode = 'lumora' | 'classic';
```

Persistência sugerida:

- `localStorage['athena.queue.viewMode']` para preferência local;
- fallback `lumora`.

No header da nova tela:

- switch/chavinha: `Visual novo` / `Visual clássico`;
- texto: `Troque para o modo clássico para ver os lotes exatamente como antes.`

#### Modo `lumora`

Inspirado na referência, mas usando nossos dados:

Cards/KPIs:

- `OK`: quantidade de itens `published`;
- `PENDENTES`: `waiting + ready`;
- `ERROS`: `failed`;
- `CONTAS NA FILA`: perfis com itens ativos / total de perfis com fila.

Progresso geral:

```ts
progress = completed / totalTerminalOrKnown
completed = published + cancelled + removed
total = todos os itens carregados/filtrados
```

Obs.: como a listagem atual é paginada por lote, esse KPI inicialmente representa a página carregada. Para números globais reais, criar endpoint agregado posteriormente.

Abas internas:

- **Por conta**
  - Agrupar `QueueItem` por `profile_id`.
  - Mostrar avatar/fallback, username, etiqueta operacional, próxima execução, progresso `concluídos/total`, falhas.
  - Clique no card abre uma gaveta/lista com itens daquele perfil ou muda para lista filtrada.
- **Por lote**
  - Um card por `Batch`, com iniciais, nome, progresso, falhas e chips de status.
  - Ação rápida: abrir detalhes clássicos do lote, cancelar lote, ver itens.
- **Por grupo/pasta**
  - Como não temos “pasta” nativa igual à referência, mapear para `profile_groups`.
  - Cards por grupo: nome do grupo, total de perfis, itens, progresso e falhas.
  - Incluir card `Sem grupo` para perfis não associados.

Legenda adaptada:

- `● Publicando — há item em preparing/publishing`;
- `↻ Aguardando slot — há waiting/ready para horários futuros ou execução imediata pendente`;
- `⏸ Com falhas — há item failed aguardando ação`;
- `■ Encerrada — só published/cancelled/removed`.

#### Modo `classic`

Reutilizar a renderização atual dos cards de lote de [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx):

- filtros atuais completos;
- lista de lotes;
- limite inicial de itens por lote;
- botão `Ver mais 10 lotes`;
- modal de detalhes;
- botões cancelar/reprocessar;
- cancelamento de lote inteiro ou itens visíveis.

### 4. Endpoint agregado recomendado

Para o visual novo ficar rápido e correto com muitos itens, criar endpoint opcional:

- `app/api/publications/summary/route.ts`

Resposta sugerida:

```ts
type PublicationQueueSummary = {
  totals: {
    all: number;
    ok: number;
    pending: number;
    failed: number;
    processing: number;
    cancelled: number;
    removed: number;
  };
  accounts: Array<{
    profileId: string;
    username: string;
    displayName: string | null;
    profilePictureUrl: string | null;
    total: number;
    completed: number;
    failed: number;
    nextExecuteAt: string | null;
    statusKind: 'posting' | 'waiting' | 'failed' | 'stopped';
  }>;
  batches: Array<{
    batchId: string;
    name: string | null;
    total: number;
    completed: number;
    failed: number;
    createdAt: string;
  }>;
  groups: Array<{
    groupId: string | 'none';
    name: string;
    total: number;
    completed: number;
    failed: number;
  }>;
};
```

Pode ser implementado em duas etapas:

1. **Fase 1:** calcular agregados no client a partir dos lotes carregados pelo `GET /api/publications`.
2. **Fase 2:** criar RPC/endpoint para contagens globais sem depender da página carregada.

## Plano de implementação por fases

### Fase 1 — Nova rota e extração segura

1. Criar [`app/(painel)/queue/page.tsx`](../app/(painel)/queue/page.tsx).
2. Criar [`app/queue/queue-client.tsx`](../app/queue/queue-client.tsx).
3. Extrair tipos/helpers/hooks de [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx) para módulos em `app/queue/`.
4. Atualizar sidebar em [`app/components/app-shell.tsx`](../app/components/app-shell.tsx): adicionar item `Fila` ou `Queue` apontando para `/queue`.
5. Trocar links existentes que apontam para `/postagem#publication-queue` para `/queue`:
   - [`app/operacao/operation-client.tsx`](../app/operacao/operation-client.tsx), se presente no workspace final;
   - qualquer outro CTA operacional.

### Fase 2 — Modo clássico funcional

1. Migrar renderização atual de `queue-section` para componente `ClassicQueueView`.
2. Garantir que filtros e ações continuem chamando:
   - `GET /api/publications`;
   - `PATCH /api/publications/[itemId]`;
   - `POST /api/publications/batch/[batchId]/cancel`.
3. Manter modal de detalhes com mídia/eventos.
4. Validar que `/postagem` continua criando publicações sem depender da fila.

### Fase 3 — Modo novo inspirado na referência

1. Criar `LumoraQueueView` com:
   - header `Fila de publicação`;
   - contador total;
   - toolbar de ações;
   - KPIs;
   - progresso geral;
   - abas `Por conta`, `Por lote`, `Por grupo`.
2. Reaproveitar nossas cores:
   - roxo principal `--purple` / `--purple-bright`;
   - verde `--green` para ativo/publicado;
   - amarelo `--yellow` para aguardando/travado;
   - vermelho `--danger` para erro/cancelamento.
3. Incluir a chavinha `Visual novo` / `Visual clássico`.
4. Cada card do modo novo deve ter ação de detalhe:
   - conta: aplicar filtro de perfil ou abrir lista lateral;
   - lote: abrir detalhes do lote;
   - grupo: aplicar filtro de grupo.

### Fase 4 — Otimização e agregados globais

1. Criar endpoint agregado `GET /api/publications/summary`.
2. Se necessário, adicionar RPC SQL para evitar `select` pesado em `publication_items`.
3. Manter paginação detalhada separada: resumo rápido primeiro, detalhes sob demanda.
4. Adicionar polling leve:
   - 10s quando houver `preparing/publishing` ou generation job ativo;
   - 30s/60s quando somente agendados.

## Regras de UX

- `/postagem` deve ficar só para compor e enviar postagens.
- `/queue` deve ser a tela operacional principal.
- A visualização nova é a padrão.
- A visualização clássica precisa continuar disponível pela chavinha.
- Nenhuma função atual pode ser removida:
  - filtrar;
  - atualizar;
  - ver mais;
  - cancelar item;
  - reprocessar falha;
  - cancelar lote;
  - abrir detalhes;
  - ver histórico/eventos;
  - acompanhar jobs grandes.

## Riscos e cuidados

- A fila atual é paginada por lote; KPIs calculados somente no client podem não representar a base inteira.
- Assinatura de URLs de mídia deve continuar sob demanda para não encarecer carregamento.
- A extração do componente atual deve ser feita em partes pequenas, porque [`app/postagem/publishing-client.tsx`](../app/postagem/publishing-client.tsx) mistura compositor, jobs, fila e modal.
- Evitar copiar literalmente nomes/classes da referência; usar inspiração visual e adaptar ao design Athena.
- Não persistir credenciais ou dados temporários da referência no repositório.

## Checklist de aceite

- `/queue` abre no painel autenticado.
- Sidebar mostra item `Fila` ativo quando rota é `/queue`.
- `/postagem` não exibe mais a seção `Histórico e operação`; mostra no máximo CTA para `/queue`.
- Modo novo mostra KPIs, progresso e abas por conta/lote/grupo.
- Modo clássico reproduz a operação atual.
- Cancelar, reprocessar e cancelar lote funcionam igual ao comportamento atual.
- Modal de detalhes continua disponível.
- Jobs grandes continuam visíveis em `/queue`.
- Build passa sem erros de tipo.

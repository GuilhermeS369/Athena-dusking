# Plano detalhado de resolução: Storage Egress e lentidão

## 1. Objetivo e metas mensuráveis

Este plano corrige as duas causas que hoje se reforçam:

1. a página de postagem busca dados históricos e relações demais antes de renderizar o compositor;
2. os previews de mídia são assinados novamente a cada renderização dinâmica, fazendo o navegador baixar objetos que já tinha visto sob outra URL.

Metas após o rollout completo:

| Indicador | Meta |
| --- | --- |
| Renderização inicial de `/postagem` | p95 abaixo de 2 s |
| Bytes de Storage baixados ao entrar em `/postagem` | abaixo de 2 MB, sem abrir detalhes |
| Previews repetidos da mesma mídia | cache hit ou nenhum novo download |
| Dados carregados no compositor | máximo 24 assets por página |
| Dados carregados na fila | 20 lotes-resumo por página; detalhes sob demanda |
| Egress diário de previews | redução mínima de 70% em relação à baseline |
| Download para reparar thumbnail de vídeo | zero no navegador |

## 2. Princípios da implementação

1. **Não assinar nem baixar a mídia grande antes da intenção do usuário.** Uma grade só recebe thumbnail pequena.
2. **Uma página não pode carregar histórico completo.** Toda relação de fila, evento ou mídia precisa ser paginada, limitada ou buscada por item selecionado.
3. **URLs precisam ser reutilizáveis durante a mesma sessão e cacheáveis por versão.** Assinatura nova para cada SSR quebra o reaproveitamento do navegador.
4. **O banco agrega; o Node apenas apresenta.** Contagens, métricas e estados por asset/perfil saem de RPCs/views, não de arrays inteiros retornados ao servidor.
5. **Nenhuma alteração de cache reduz a autorização.** Originais permanecem privados; somente previews derivados recebem estratégia específica.

## 3. Fase 0 — baseline, telemetria e feature flags

### 3.1 Antes de alterar o fluxo

No dashboard do Supabase, capturar três dias de dados e registrar:

- Storage Egress por dia;
- objetos com mais bytes transferidos;
- requests por `User-Agent`, IP e status;
- número de requests no bucket `instagram-media`;
- tamanho médio e total de downloads de `mp4`, `mov`, thumbnails e imagens;
- Postgres API: requisições, latência p50/p95 e bytes de resposta.

No DevTools, em janela anônima e com cache desabilitado, salvar um HAR para:

1. primeira entrada em `/postagem`;
2. saída e retorno a `/postagem`;
3. abertura de um modal de detalhes;
4. entrada e troca de filtro em `/galeria`;
5. reparo de thumbnail de um vídeo legado, se houver.

### 3.2 Instrumentação de aplicação

Adicionar logs estruturados em todas as emissões de URL assinada. Cada log deve conter:

```ts
{
  event: 'storage_signed_url_issued',
  purpose: 'composer_thumbnail' | 'queue_detail' | 'gallery_card' | 'instagram_publish',
  organizationId,
  assetId,
  storagePath,
  kind: 'image' | 'video',
  requestedWidth: number | null,
  requestedHeight: number | null,
  ttlSeconds,
}
```

Para publicação Meta, registrar também `publicationItemId`, `attemptCount`, `creationId` e o resultado da chamada à Meta. Não registrar token nem URL assinada completa.

### 3.3 Feature flags de rollout

Criar flags de ambiente para permitir rollback seguro:

- `POSTING_LAZY_QUEUE_ENABLED`;
- `POSTING_PREVIEW_V2_ENABLED`;
- `GALLERY_PREVIEW_V2_ENABLED`;
- `VIDEO_THUMBNAIL_BROWSER_REPAIR_ENABLED=false`.

Ativar primeiro em uma organização interna. O rollback deve desligar a flag, sem exigir reversão de migration.

## 4. Fase 1 — reestruturar a página de Postagem

Esta é a etapa de maior impacto. A página atual mistura compositor, histórico, eventos, relações e previews em uma única renderização.

### 4.1 Separar responsabilidades de dados

Alterar a página de entrada para carregar apenas o necessário ao compositor:

- perfis ativos;
- grupos e membros;
- primeira página de assets elegíveis;
- atribuições somente desses assets;
- resumo de estado de publicação somente desses assets;
- métricas agregadas por perfil;
- nenhuma fila, nenhum evento e nenhuma mídia de lote na carga inicial.

Na prática, remover da consulta inicial:

- `publication_batches` com itens aninhados;
- `publication_item_events`;
- `publication_item_media` de toda a organização;
- métricas obtidas buscando todos os itens publicados;
- `media_group_assignments` de assets fora da página atual.

### 4.2 Novos contratos de API

Criar endpoints separados, todos autenticados e validados por organização ativa.

#### `GET /api/posting/assets`

Responsabilidade: página cursor-based de assets para o compositor.

Entrada:

```text
cursor=<cursor opcional>&limit=24&group=<id opcional>&kind=image|video
```

Saída:

```ts
{
  assets: Array<{
    id: string;
    original_name: string;
    kind: 'image' | 'video';
    size_bytes: number;
    preview: { url: string; width: number; height: number } | null;
    publication_state: {
      scheduled_count: number;
      next_scheduled_at: string | null;
      has_published: boolean;
    };
    group_ids: string[];
  }>;
  nextCursor: string | null;
  hasMore: boolean;
}
```

Regras:

- não retornar `storage_path` ao browser;
- não retornar `signed_url` de original;
- retornar no máximo 24 assets;
- usar cursor composto por `created_at,id`;
- usar uma função comum de emissão de preview para evitar regras divergentes entre página e API.

#### `GET /api/publications?view=summary`

Responsabilidade: listar lotes sem eventos, sem objetos de Storage e sem mídia detalhada.

Entrada:

```text
view=summary&cursor=<cursor opcional>&limit=20&status=<opcional>
```

Saída:

```ts
{
  batches: Array<{
    id: string;
    name: string | null;
    status: string;
    created_at: string;
    updated_at: string;
    created_by_name: string | null;
    summary: {
      total: number;
      waiting: number;
      processing: number;
      failed: number;
      published: number;
      next_execute_at: string | null;
    };
  }>;
  nextCursor: string | null;
}
```

#### `GET /api/publications/[itemId]?view=detail`

Responsabilidade: carregar uma publicação selecionada, seus eventos recentes e previews adequados ao modal.

Saída:

```ts
{
  item: {
    id: string;
    status: string;
    format: string;
    caption: string | null;
    events: PublicationEvent[]; // limitar a 20, cursor para o restante
    media: Array<{
      id: string;
      position: number;
      kind: 'image' | 'video';
      preview_url: string | null;
      original_url: string | null; // somente quando o modal solicitar expansão
    }>;
  };
}
```

O endpoint de detalhes deve emitir thumbnail para a faixa de mídia e, inicialmente, apenas preview de até 1.024px para a mídia ativa. Para vídeo, exibir thumbnail e não enviar MP4 automaticamente; vídeo só recebe URL de reprodução depois de clique explícito em "Reproduzir".

### 4.3 Alterações no frontend de Postagem

Em `PublishingClient`:

1. iniciar `batches` como vazio, com estado `queueLoaded=false`;
2. renderizar o compositor imediatamente;
3. carregar o resumo da fila somente quando a seção entrar no viewport, quando o usuário clicar em "Carregar fila" ou após criar/cancelar publicação;
4. substituir o refresh atual pela API `view=summary`;
5. ao clicar no item, buscar detalhes uma vez e armazenar em cache local por `itemId`;
6. invalidar somente o item/lote afetado após cancelar ou repetir; não recarregar 50 lotes completos;
7. colocar paginação "Carregar mais lotes", sem buscar histórico ilimitado;
8. para os assets do compositor, manter um cache em memória de páginas por cursor/filtro, com limite de páginas e deduplicação por `asset.id`.

### 4.4 Alterações de banco necessárias

Criar uma migration nova com:

1. RPC `get_publication_batch_summaries(...)` que retorna um lote por linha, com contagens agregadas e `next_execute_at`;
2. RPC `get_media_publication_states(p_organization_id, p_asset_ids uuid[])`, retornando uma linha por asset;
3. RPC `get_profile_publication_metrics(p_organization_id)`, retornando uma linha por profile e formato/status;
4. índices para listagem de lotes e detalhes:

```sql
create index if not exists publication_batches_org_created_page_idx
  on public.publication_batches (organization_id, created_at desc, id desc);

create index if not exists publication_items_org_batch_status_execute_idx
  on public.publication_items (organization_id, batch_id, status, execute_at);

create index if not exists publication_item_media_item_position_idx
  on public.publication_item_media (publication_item_id, position);
```

Confirmar com `EXPLAIN (ANALYZE, BUFFERS)` que as RPCs usam esses índices. Criar `security definer` somente se necessário, sempre com `set search_path = public` e verificação explícita da organização/membro.

### 4.5 Resultado esperado da Fase 1

A entrada em `/postagem` deixa de depender de:

- quantidade de lotes históricos;
- quantidade de eventos da fila;
- quantidade de vínculos de mídia de toda a organização;
- downloads das mídias associadas à fila.

O compositor abre com uma página de assets pequenos. Fila e detalhes custam rede apenas quando usados.

## 5. Fase 2 — previews pequenos, privados e reutilizáveis

### 5.1 Modelo de dados de preview

Adicionar a `media_assets`:

```sql
alter table public.media_assets
  add column if not exists preview_storage_path text,
  add column if not exists preview_version integer not null default 1,
  add column if not exists preview_width integer,
  add column if not exists preview_height integer;
```

Regras de objeto:

- imagem original: continua em `instagram-media/<organization>/<uuid>.<ext>`;
- thumbnail de vídeo: continua como imagem JPEG/WebP pequena;
- preview de imagem: objeto derivado, por exemplo `previews/<asset-id>/v1.webp`;
- nenhuma tela de lista usa o original;
- quando imagem é substituída ou preview regenerado, incrementar `preview_version` e mudar somente o caminho/versionamento do preview.

### 5.2 Estratégia de acesso

Há duas opções; escolher uma e não misturar no primeiro rollout.

#### Opção recomendada: bucket privado + proxy de preview autenticado

Criar `GET /api/media/[assetId]/preview?size=card|modal`.

O endpoint:

1. autentica o usuário e confere a organização;
2. consulta o asset uma única vez;
3. valida que é membro da organização dona do objeto;
4. redireciona para URL assinada com TTL mais longo (ex.: 24h) ou faz streaming controlado;
5. responde com cache privado, por exemplo `Cache-Control: private, max-age=86400, stale-while-revalidate=604800`;
6. inclui `ETag` com `assetId-previewVersion-size`.

A URL exibida pelo browser é estável por versão:

```text
/api/media/<asset-id>/preview?size=card&v=1
```

Como a URL não muda a cada SSR, o navegador pode reaproveitar o objeto. O endpoint ainda garante autorização antes do redirect/cache.

#### Alternativa: bucket público exclusivo para previews

Usar somente se previews puderem ser públicos com URLs não adivinháveis. Criar bucket separado, nunca tornar `instagram-media` público. Objetos devem usar IDs UUID/versionados e cabeçalho cacheável longo. Esta alternativa é mais barata e simples para CDN, mas muda o modelo de segurança.

### 5.3 Tamanhos obrigatórios

| Uso | Tipo | Limite |
| --- | --- | --- |
| Card de galeria/compositor | imagem e thumbnail de vídeo | 240px no maior lado, WebP/JPEG, qualidade 60–70 |
| Modal de detalhes | imagem | 1.024px no maior lado, qualidade 75–80 |
| Faixa de mídia | imagem e thumbnail | 96–160px |
| Reprodução de vídeo | vídeo original | somente após clique explícito |

Remover URLs 640px e 960px das listagens. Não usar `format: origin` nos cards: quando a plataforma aceitar, preferir formato moderno/otimizado. Validar transparência antes de converter PNG para JPEG.

### 5.4 Gerador de previews

Para uploads novos:

1. manter thumbnail local de vídeo, mas salvar em WebP/JPEG pequeno;
2. para imagem, gerar preview no backend/worker, não depender de transformação on-the-fly em toda navegação;
3. gravar `preview_storage_path`, dimensões e versão na mesma conclusão do upload.

Para legado:

1. criar job paginado para assets sem preview;
2. processar por lotes pequenos e persistir resultado;
3. registrar falhas em `processing_error`/tabela própria;
4. enquanto não houver preview, renderizar fallback, nunca carregar o original para uma grade.

## 6. Fase 3 — corrigir Galeria e uploads

### 6.1 Alterar a galeria para o novo endpoint de preview

Em vez de retornar URL assinada de objeto em `GET /api/media`, retornar `preview_url` estável.

Alterar o card para usar somente:

```ts
asset.preview_url
```

Não retornar nem renderizar `signed_url` original na grade. Preservar `loading="lazy"`, incluir `width`, `height` e `decoding="async"` para reduzir custo de layout/decodificação.

### 6.2 Cache de dados da galeria

Não usar `no-store` sem necessidade para toda resposta de leitura. Definir:

- API de listagem com `Cache-Control: private, max-age=30, stale-while-revalidate=60`;
- cache no cliente por `filterKey`, já existente, mas com TTL de 30–60 segundos;
- após upload, exclusão ou associação a grupo, invalidar somente filtros/páginas afetados;
- abortar requisições obsoletas, comportamento que já existe e deve ser preservado.

### 6.3 Trocar filtro por grupo

Substituir a busca de todos os `media_asset_id` do grupo seguida de `IN`/`NOT IN` por RPC com `EXISTS`, por exemplo:

```sql
where (
  p_group_id is null
  or exists (
    select 1
    from public.media_group_assignments mga
    where mga.organization_id = asset.organization_id
      and mga.media_asset_id = asset.id
      and mga.group_id = p_group_id
  )
)
```

Para `group=none`, usar `not exists`. Isso mantém paginação no banco e impede que grupos com milhares de assets virem arrays no servidor.

### 6.4 Contagens da galeria

Substituir os dois `count: 'exact'` iniciais por uma destas estratégias:

1. retornar total estimado; ou
2. manter uma tabela de contadores por organização atualizada por trigger/job; ou
3. buscar o total assíncrono após o primeiro paint.

O número exato não pode atrasar a renderização dos primeiros 30 cards.

### 6.5 Remover reparo de thumbnail no browser

Desativar a função que faz `fetch(asset.signed_url)` para baixar o vídeo inteiro ao navegador.

Substituir o botão por `POST /api/media/[assetId]/thumbnail/regenerate`, que coloca o asset numa fila server-side. A resposta é `202 Accepted`. O card exibe "Miniatura em processamento" e atualiza após o job gravar o preview.

Se ainda não houver worker de mídia, esconder esse botão e manter fallback visual até a implementação server-side. É preferível a gerar Egress de dezenas/centenas de MB por clique.

### 6.6 Fluxo de upload

Manter upload direto ao Storage para arquivos grandes. Porém:

- fazer o `complete` retornar só metadados e `preview_url`, nunca URL de original;
- criar thumbnail e preview antes de marcar o asset como `ready`, ou usar estado `processing` até ambos existirem;
- aplicar expiração/limpeza para objetos iniciados mas não confirmados;
- registrar tamanho e MIME real para auditoria de custo;
- não criar segunda transferência desnecessária do vídeo ao backend.

## 7. Fase 4 — corrigir consultas de todas as outras páginas

### Dashboard

Trocar listas de IDs usadas só para contagem por `head: true` ou RPC agregada. `getDashboardData` deve receber apenas:

- contagem de perfis por status;
- existe grupo;
- existe asset pronto;
- contagem de publicações por status;
- próxima execução.

### Perfis

Trocar a busca de todos os itens publicados/ativos por `get_profile_publication_metrics`. A RPC retorna apenas `profile_id`, formato, status agregado e próxima data.

### Agenda

Aplicar intervalo de data obrigatório (por exemplo mês atual + janela de 7 dias) e paginação. Buscar detalhes/legenda longa apenas quando o usuário seleciona o item.

### Operação / saúde da fila

Trocar até 1.000 linhas transferidas por uma RPC que devolve contagens agregadas de status, leases expirados e retries vencidos. Essa operação deve rodar inteiramente no Postgres.

## 8. Fase 5 — publicação Meta e Egress legítimo

Esta fase só começa após os logs demonstrarem a fração de Egress atribuída à Meta.

1. Classificar, por publicação, quantas vezes cada objeto foi requisitado pela Meta.
2. Conferir se retries reutilizam `creation_id` e não recriam containers desnecessariamente.
3. Diminuir a validade de 24h da URL temporária apenas após testar Reels e carrosséis. Começar com 6h; manter 24h se a Meta realmente precisar.
4. Salvar telemetria de tentativa/objeto para detectar re-downloads anormais.
5. Se downloads da Meta forem dominantes mesmo após reduzir previews, avaliar CDN/storage externo apenas para originais de publicação. Essa é uma decisão de custo, não a primeira correção.

## 9. Sequência de migrations e deploy

1. Migration de índices/RPCs de resumo e agregação.
2. Deploy que adiciona instrumentação, sem mudar comportamento.
3. Migration de colunas de preview e bucket/policies, se adotada.
4. Deploy do gerador de previews para novos uploads.
5. Backfill gradual dos previews legados.
6. Deploy do novo endpoint de preview atrás de flag.
7. Deploy do split de `/postagem` atrás de flag.
8. Ativação para organização de teste; comparar baseline por 24h.
9. Ativação progressiva para 10%, 50% e 100% das organizações.
10. Remoção do fluxo antigo de URL assinada em listagens apenas depois da confirmação de cache/Egress.

## 10. Testes obrigatórios

### Regressão funcional

- usuário de outra organização não acessa preview, detalhe, original ou lote de outra organização;
- compositor continua permitindo imagem, Reel, Story e carrossel;
- fila continua atualizando depois de criar, cancelar e repetir;
- navegação de detalhes só mostra mídia do item autorizado;
- upload direto, thumbnail e deduplicação seguem funcionando;
- vídeo sem thumbnail exibe fallback e não baixa original;
- publicação para Meta recebe URL válida pelo período configurado.

### Desempenho e custo

- comparar HAR antes/depois, incluindo retorno à mesma página;
- garantir que a entrada em `/postagem` não faça request de original de imagem/vídeo;
- garantir que apenas um preview seja baixado por card visível;
- confirmar que a abertura de fila não emite URLs de mídia;
- confirmar que detalhes geram URLs somente para mídia do item selecionado;
- comparar `EXPLAIN ANALYZE` das consultas antigas versus RPCs;
- comparar Egress por objeto/`User-Agent` durante 24h, 72h e 7 dias.

## 11. Critério de aceite para encerrar

O trabalho é considerado concluído apenas quando todos os itens abaixo forem verdadeiros:

- `/postagem` abre o compositor sem carregar fila histórica, eventos ou originais;
- previews de cards usam objeto derivado pequeno e URL estável/cacheável;
- fila é resumida, paginada e detalhes são sob demanda;
- galeria não usa URL do original para cards nem baixa vídeo para reparar thumbnail;
- contagens operacionais são agregadas no banco;
- logs permitem separar Egress de navegador, Meta e qualquer origem inesperada;
- a medição real mostra redução sustentada de Egress e tempo p95 dentro das metas.

# Auditoria de Storage Egress e desempenho do Supabase

## Escopo e conclusão executiva

Foi realizada uma leitura estática de todos os pontos da aplicação que criam clientes Supabase, consultam tabelas, assinam URLs de Storage, fazem upload e exibem mídia. O problema mais provável não é a criação das URLs assinadas em si (ela não transfere o arquivo), mas o carregamento repetido de previews pelo navegador por URLs novas e pouco cacheáveis.

A rota `/postagem` é o maior candidato a explicar simultaneamente a lentidão de 10–15 segundos e o Egress elevado. Em cada entrada ela:

1. executa oito consultas em paralelo, três delas sem limite temporal ou quantitativo;
2. carrega até 30 mídias para o compositor;
3. carrega até 20 lotes com todos os seus itens, eventos e mídias aninhadas;
4. emite URLs assinadas separadas para cada mídia desses dois conjuntos;
5. pede transformações de imagem maiores (640px e 960px) do que as previews de grade precisam; e
6. envia todas essas URLs ao cliente, que pode requisitar os arquivos ao renderizar previews.

Como a assinatura muda em toda renderização dinâmica, a URL resultante também muda. Isto reduz a chance de reaproveitamento pelo cache do navegador/CDN, mesmo quando é a mesma mídia. Cada navegação pode portanto baixar novamente uma imagem transformada (ou uma miniatura) já vista anteriormente.

## Evidências encontradas

### 1. Postagem: gargalo principal e risco alto de Egress

- [`app/postagem/page.tsx`](../app/postagem/page.tsx) é uma página `force-dynamic` e busca 8 conjuntos de dados logo na entrada.
- A consulta de `media_group_assignments` não é limitada aos 30 assets do compositor; ela lê todas as associações da organização.
- A consulta de `publication_item_media` não é limitada a lotes recentes ou a assets da página; ela lê todos os vínculos de mídia/publicação da organização, inclusive históricos.
- A consulta de métricas lê todos os itens de publicação, inclusive publicados antigos, e depois agrega os dados em memória no servidor.
- A consulta de lotes aninha `publication_items`, `publication_item_events` e `publication_item_media` em 20 lotes. Eventos e mídias de histórico aumentam o payload e o tempo de banco proporcionalmente ao histórico total.
- Cada asset do compositor recebe URL para a imagem de 640px/qualidade 75 e, quando aplicável, outra URL de thumbnail. Mídias presentes nos lotes recebem URLs de 960px/qualidade 82. O mesmo asset pode ser assinado e transferido mais de uma vez na mesma resposta.
- [`app/postagem/group-composer-next.tsx`](../app/postagem/group-composer-next.tsx) exibe previews para todos os assets disponíveis no compositor. Mesmo com `loading="lazy"`, os itens próximos ao viewport podem baixar em massa e cada URL nova invalida o cache HTTP do navegador.
- O botão de atualizar fila chama [`GET /api/publications`](../app/api/publications/route.ts), que piora o cenário: traz até 50 lotes completos, todos os eventos e mídias, e gera URLs de 960px para cada mídia relacionada.

### 2. Galeria: o plano recente melhorou o banco, mas ainda não elimina Egress

- A migration [`supabase/migrations/030_optimize_media_gallery_listing.sql`](../supabase/migrations/030_optimize_media_gallery_listing.sql) adicionou índices corretos para paginação por `(organization_id, created_at desc, id desc)` e para associações por asset. Isso é uma melhoria real de consulta.
- [`app/galeria/page.tsx`](../app/galeria/page.tsx) e [`app/api/media/route.ts`](../app/api/media/route.ts) agora limitam a página de assets a 30 e usam cursor; isso evita carregar a biblioteca inteira.
- Porém cada página ainda assina e expõe 30 imagens de 400px ou 30 thumbnails. Ao mudar de filtro, [`app/galeria/gallery-client.tsx`](../app/galeria/gallery-client.tsx) força `fetch(..., { cache: 'no-store' })`; a API também devolve `Cache-Control: no-store`. Isto impede cache da resposta JSON e gera novas URLs assinadas.
- As contagens iniciais usam `count: 'exact'` duas vezes. Elas não explicam Storage Egress, mas podem ficar caras com muitos registros e retardar a primeira renderização.
- O filtro por grupo consulta primeiro todos os IDs de assets daquele grupo e então faz `in(...)` ou `not in(...)`. Para grupos grandes, isso aumenta payload, pode superar limites de URL/consulta e não escala como `exists`/join no banco.
- A função de reparar miniatura baixa o vídeo integral do Storage para o navegador antes de extrair um frame. Esse fluxo é um download explícito de Egress igual ao tamanho completo do vídeo e deve ser removido ou estritamente excepcional.

### 3. Publicação no Instagram: Egress legítimo, mas precisa ser isolado

- [`lib/integrations/instagram-publisher.ts`](../lib/integrations/instagram-publisher.ts) gera URL assinada de cada mídia para a Meta baixar. Essa transferência é Storage Egress legítimo: um Reel de 300 MB publicado uma vez gera aproximadamente 300 MB de saída, sem contar retries/reprocessamentos.
- A URL válida por 24 horas não gera Egress sozinha. O risco é a Meta baixar novamente em falhas/retries, ou o mesmo conteúdo ser incluído em várias publicações/perfis. O dashboard do Supabase deve separar esses requests pelo `User-Agent`/logs para confirmar a participação real da Meta.

### 4. Consultas que crescem com o histórico

- [`app/perfis/page.tsx`](../app/perfis/page.tsx) busca todos os itens ativos e publicados para calcular métricas por perfil em memória.
- [`app/agenda/page.tsx`](../app/agenda/page.tsx) traz 250 itens e relações por navegação; é aceitável como limite, mas deveria ter intervalo de datas e paginação/visão mensal.
- [`lib/dashboard/server.ts`](../lib/dashboard/server.ts) transfere IDs de todos os assets, publicações e falhas para contar no Node. Esses totais devem ser `head: true`/RPC de agregação, não listas inteiras.
- [`app/api/publication-health/route.ts`](../app/api/publication-health/route.ts) transfere até 1.000 linhas para contar quatro métricas que o PostgreSQL pode devolver agregadas.

### 5. Navegação e cache de página

- Todas as páginas operacionais usam `force-dynamic`; isso é adequado para dados vivos, mas garante nova renderização e novas assinaturas a cada troca de página.
- [`app/components/app-shell.tsx`](../app/components/app-shell.tsx) define `prefetch={false}` em todos os links. Isso não causa Egress de Storage diretamente, mas deixa a navegação sempre dependente da renderização/consultas no momento do clique.
- Não foram encontrados intervalos de polling no cliente para a fila. O consumo recorrente não parece vir de polling do frontend; a maior hipótese continua sendo transferências de previews e downloads da Meta.

## Plano de otimização priorizado

### P0 — medir e interromper o desperdício (primeiras 24 horas)

1. No painel Supabase, exportar os logs de Storage de 24–72h e agrupar por objeto, IP, `User-Agent`, status e bytes enviados. Separar: navegador, crawler/Meta e origem desconhecida.
2. Criar alertas diários de Egress e de objeto mais transferido. Sem essa quebra não é possível afirmar quanto dos 5 GB/dia é preview versus download da Meta.
3. No DevTools, gravar uma navegação limpa para `/postagem`, `/galeria` e uma atualização de fila. Registrar quantidade de requests em `/storage/v1`, bytes transferidos, tamanho das imagens e waterfall. Repetir a mesma navegação: se os previews baixarem novamente, a invalidação por URL assinada está confirmada.
4. Desativar temporariamente a visualização de histórico completo na tela de postagem (feature flag) e comparar Egress/tempo. Essa é a forma mais segura de validar a principal hipótese sem tocar na publicação.

### P1 — corrigir `/postagem` (maior retorno)

1. Separar a tela em dois carregamentos independentes:
   - **compositor inicial:** perfis, grupos, apenas 24–30 assets recentes e apenas metadados/previews pequenos;
   - **fila/histórico:** carregar sob demanda quando o usuário abrir a seção, aplicar filtro ou clicar em "Atualizar fila".
2. Criar endpoints distintos e paginados: resumo de lotes (sem eventos e sem URLs de mídia), detalhes de um lote/item somente ao abrir o modal, e página cursor-based para histórico.
3. Remover eventos aninhados da listagem principal. Buscar no máximo 20 eventos do item selecionado quando o modal abre.
4. Gerar uma URL por asset por resposta com um mapa `assetId -> preview`, reutilizando-a entre compositor e fila. Nunca assinar repetidamente o mesmo objeto dentro da mesma renderização.
5. Para a grade do compositor, servir apenas thumbnail de 160–240px; imagem original/640–960px somente no preview de um item selecionado. Vídeos devem usar exclusivamente thumbnail.
6. Limitar `publication_item_media` e `media_group_assignments` aos IDs dos assets/lotes daquela resposta. Converter métricas de estado em RPC agregada que retorna uma linha por `media_asset_id`.
7. Mover métricas por perfil para SQL agregado/RPC, retornando apenas contagens e próximo horário por perfil, em vez de todos os itens publicados.

### P1 — tornar previews cacheáveis e pequenos

1. Preservar o bucket principal privado, mas criar um fluxo de preview separado: thumbnail derivada persistida, com nome/versionamento determinístico (`asset-id` + versão de atualização), baixa resolução e qualidade controlada.
2. Para thumbnails não sensíveis, avaliar bucket/CDN público exclusivo de previews. Para mídia que deve continuar privada, usar endpoint autenticado/proxy com `Cache-Control: private, max-age=...` e URL estável por versão, não uma assinatura curta regenerada em cada SSR.
3. Definir cabeçalhos de cache longos nos objetos versionados e não usar `no-store` nos dados que podem ser revalidados. A autorização deve continuar sendo validada na emissão/acesso, não sacrificando todo cache por padrão.
4. Usar [`next/image`](../next.config.mjs) ou CDN de imagens com tamanhos explícitos para imagens; restringir `srcset` ao tamanho real do card. Se permanecer com `<img>`, informar `width`, `height`, `decoding="async"` e manter `loading="lazy"`.
5. Nunca renderizar/baixar imagem de 960px para card de fila. Abrir a mídia maior apenas no modal, após intenção explícita do usuário.

### P1 — eliminar o download de vídeo para reparo de thumbnail

1. Remover a geração de thumbnail no navegador para vídeo armazenado. A ação atual faz download do arquivo inteiro do Storage antes de gerar uma imagem.
2. Gerar thumbnail no upload (já ocorre para uploads novos) e implementar backfill server-side/worker para legados, próximo ao Storage. Se o processamento exigir download, ele deve acontecer uma única vez, ser observável e persistir o resultado.
3. Exibir fallback visual para vídeos legados até o backfill completar, nunca baixar o MP4/MOV só para desenhar um card.

### P2 — reduzir carga do PostgreSQL e acelerar todas as páginas

1. Substituir contagens feitas transferindo arrays para `head: true` ou RPC agregada em dashboard, health, perfis e postagem.
2. Adicionar RPC/view de resumo de fila por organização, com índices para ordenação por criação e seleção de itens por lote. A listagem deve carregar lotes sem payload de eventos e sem joins de mídia.
3. Revisar com `EXPLAIN (ANALYZE, BUFFERS)` as consultas reais de `/postagem`, principalmente as que filtram por organização/status e as relações `publication_item_media`/`media_group_assignments`.
4. Trocar o filtro da galeria por grupo por `exists`/join em SQL ou RPC cursor-based. Evitar materializar todos os IDs no Node para fazer `IN`/`NOT IN`.
5. Substituir os dois `count: exact` da entrada da galeria por estimativa/counter cache se o total não precisar ser matematicamente exato em tempo real.
6. Paginar a agenda por intervalo de data e carregar detalhes do item sob demanda.

### P2 — publicação Meta e retries

1. Registrar por item o número de URLs assinadas emitidas, tentativas Meta, objeto, bytes conhecidos e resultado. Cruzar com logs de Storage.
2. Reduzir a validade de URL da Meta ao menor valor testado que cubra o processamento; 24h é robusto, mas amplia a janela de re-download não intencional. Validar com Reels primeiro.
3. Impor limite e deduplicação de retries por `creation_id`; a migration atual já limita polls de contêiner, mas a telemetria deve confirmar se a Meta está baixando novamente em cada tentativa.
4. Avaliar, separadamente, mover originais grandes para um CDN/object storage com custo de egress previsível se os downloads da Meta forem de fato a maior fonte. Não fazer essa migração antes dos logs comprovarem a causa.

## Critérios de sucesso e validação

| Métrica | Linha de base | Meta após P1 |
| --- | --- | --- |
| Egress diário de preview | medir por user-agent/objeto | queda de 70% ou mais |
| Transferência em primeira carga de `/postagem` | medir no DevTools | menor que 2 MB sem abrir modal |
| Transferência ao retornar a `/postagem` | medir no DevTools | próxima de 0 para previews já vistos |
| TTFB/tempo de renderização de `/postagem` | 10–15 s reportados | abaixo de 2 s para compositor inicial |
| Requests de Storage na entrada da fila | medir | nenhuma mídia full-size antes do modal |
| Linhas retornadas por consulta operacional | medir em logs | paginadas/agregadas, sem histórico integral |

## Ordem recomendada de implementação

1. Instrumentação e captura de baseline.
2. Split de `/postagem` + lazy-load de fila/detalhes.
3. Preview persistido pequeno, URL reutilizável/cacheável e remoção de 960px da lista.
4. Remoção do reparo de vídeo no browser.
5. RPCs agregadas, paginação e revisão de índices/planos.
6. Ajustes na publicação Meta somente depois de separar o Egress legítimo dela.

-- Cria a linha de rate limit do provedor `meta_official`.
--
-- O QUE ISSO EVITA. `reserve_publication_dispatch_capacity` busca a configuração
-- por especificidade decrescente: primeiro (organização, provedor), depois o que
-- casar mais genérico. Até aqui existiam exatamente duas linhas:
--
--   GLOBAL / *        -> max_provider_publications_per_minute = 50
--   GLOBAL / zernio   -> max_provider_publications_per_minute = 1200
--
-- A linha do zernio NÃO casa com `meta_official` (o provedor é diferente e não é
-- nulo), então todo perfil migrado para a Meta cairia na linha `*` e o teto da
-- frota inteira viraria 50 por minuto, contra os 1200 de hoje.
--
-- E 50 não são 50 publicações por minuto. O teto é comparado contra publicados no
-- último minuto MAIS as reservas ativas, e a seção 6 de
-- docs/fila-de-publicacao-mapa-de-controles.md mede que cada publicação/minuto
-- custa ~4 unidades por causa dos itens em voo. Na prática o teto de 50 entrega
-- algo perto de 12/min. A frota faz ~3.000/hora.
--
-- POR QUE 1200, o mesmo do zernio. Este número não é limite da Meta: é proteção
-- nossa, do banco. O gargalo real que ele protege é o mesmo nos dois provedores —
-- o pool de 41 conexões do PostgREST e a contenção no advisory lock — e 1200 foi
-- validado sob carga em 03/09, numa onda de 752 itens, depois do fatiamento do
-- lock da migration 360. Não há motivo para a Meta merecer um teto diferente do
-- que a mesma infraestrutura já sustenta.
--
-- O QUE ESTE NÚMERO NÃO PROTEGE, e precisa ser dito. O limite real da Meta é por
-- CONTA (100 publicações por 24 h, carrossel contando como uma, confirmado na
-- documentação de content publishing) e por APP. O limite por conta já está
-- coberto: `max_profile_publications_per_24h` está em 100, que bate exatamente.
-- O limite por app NÃO está coberto por nada — as reservas não têm coluna de app
-- e a contagem do minuto é por (organização, provedor), um número só para todos
-- os apps somados. Com um app para cada ~100 perfis, o app passa a ser o recurso
-- escasso, e é justamente o que o sistema não sabe contar. Ver
-- docs/migracao-meta-prontidao-da-fila.md, bloqueador 2.
--
-- Esta migration resolve o bloqueador 1. O 2 continua aberto de propósito: é
-- mudança de esquema na tabela de reservas e na função de capacidade, e merece
-- ser feita e medida separadamente.
insert into public.publication_rate_limit_settings (
  organization_id,
  provider,
  enabled,
  max_provider_publications_per_minute,
  metadata
) values (
  null,
  'meta_official',
  true,
  1200,
  jsonb_build_object(
    'minute_limit_note',
    'Criada em 04/09/2026, antes da migracao para a API da Meta. Sem esta linha '
    || 'meta_official cairia na linha generica de 50/min e a vazao da frota '
    || 'despencaria ~4x. 1200 espelha o teto do zernio porque o recurso que ele '
    || 'protege e o mesmo (pool de 41 conexoes do PostgREST), validado sob carga '
    || 'em 03/09 apos o fatiamento do lock da migration 360. NAO cobre o limite '
    || 'por APP da Meta, que nao existe no modelo ainda -- ver '
    || 'docs/migracao-meta-prontidao-da-fila.md, bloqueador 2.'
  )
)
on conflict (
  coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(provider, '*')
) do update
set enabled = excluded.enabled,
    max_provider_publications_per_minute = excluded.max_provider_publications_per_minute,
    metadata = public.publication_rate_limit_settings.metadata || excluded.metadata,
    updated_at = timezone('utc', now());

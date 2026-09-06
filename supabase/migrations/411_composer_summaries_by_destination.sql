-- As contagens do compositor passam a ser lidas por destino, e não pela
-- organização inteira na abertura da página.
--
-- O SINTOMA, medido em 06/09/2026 na organização Pomodoro: a tela /postagem
-- abria com TODOS os perfis marcando 0 agendadas e 0 publicadas, tendo 87.062
-- publicações na fila. Não havia erro na tela porque não podia haver: a página
-- coleta as falhas de leitura em `loadErrors`, registra no log e renderiza
-- assim mesmo, de propósito, para uma instabilidade de leitura não virar 500.
-- O preço desse acerto é que a falha aparece como zero.
--
-- A CAUSA. `get_posting_composer_profile_summaries` recebe só a organização, e
-- o lado publicado de `eligible_items` não tem corte nenhum de data:
--
--     item.status = 'published' or (agendadas futuras)
--
-- Ela agrega, portanto, a tabela quente inteira da organização. Quando a 356
-- foi escrita (02/09) eram 404.753 linhas e a função respondia. Hoje são
-- 536.592 -- a frota foi de 1.140 para 5.474 perfis e a publicação para ~68 mil
-- posts/dia -- e a chamada bate no `statement_timeout` de 8 s: 8.612 ms,
-- código 57014. O mesmo estouro derruba a fila em `get_publication_queue_
-- reference_page`, tratado na 412.
--
-- POR QUE NÃO RECORTAR A JANELA. Seria a correção óbvia (contar só as
-- publicadas das últimas 24 h) e foi recusada pela operação: a contagem por
-- perfil precisa cobrir a janela toda que a tabela quente guarda. O que muda
-- não é o QUANTO se conta, é QUANDO e PARA QUEM: em vez da organização inteira
-- no SSR, só os perfis do destino escolhido, depois da escolha.
--
-- É EXATAMENTE O CAMINHO QUE OS HORÁRIOS OCUPADOS JÁ FIZERAM na própria 356:
-- `get_posting_composer_profile_slots` nasceu ali para tirar 13,8 MiB de props
-- do SSR e ler sob demanda por destino. Esta função é a irmã que faltou -- as
-- contagens ficaram para trás naquele corte, e foram elas que estouraram
-- primeiro. A assinatura, o teto de 1.000 perfis e a checagem de associação são
-- os mesmos, para que as duas sejam chamadas lado a lado pelo mesmo laço de
-- blocos.
--
-- MEDIDO ANTES DE ESCREVER, com blocos de 250 perfis na mesma organização:
-- horários ocupados 1.044 ms, contagem de publicadas 919 ms, contagem de
-- agendadas 1.035 ms. O bloco cabe com folga nos 8 s; a organização inteira,
-- não. É o mesmo trabalho, cortado num tamanho que o banco entrega.
--
-- A VERSÃO DE DOIS ARGUMENTOS CONTINUA NO SCHEMA, intocada. Derrubá-la no mesmo
-- deploy que troca o chamador deixaria a página anterior, ainda aberta no
-- navegador de alguém, chamando função que não existe -- a mesma razão pela
-- qual a 356 preservou `get_posting_composer_profile_metrics`. Ela segue
-- estourando o tempo em organização grande, e é para não ser mais chamada.

create or replace function public.get_posting_composer_profile_summaries(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_slot_horizon_days integer default 90
)
returns table (
  profile_id uuid,
  scheduled_post_count integer,
  scheduled_counts jsonb,
  published_counts jsonb,
  scheduled_by_time jsonb,
  scheduled_by_format_and_time jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_slot_horizon_days not between 1 and 366 then
    raise exception using errcode = '22023', message = 'Horizonte de agenda deve estar entre 1 e 366 dias.';
  end if;

  -- Uma linha por perfil pedido: este teto também garante que a resposta nunca
  -- encoste no max_rows do PostgREST. Mesmo número da função de horários.
  if coalesce(array_length(p_profile_ids, 1), 0) > 1000 then
    raise exception using errcode = '22023', message = 'Máximo de 1.000 perfis por consulta de contagens.';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  return query
  -- A única diferença de verdade para a versão de dois argumentos está aqui, e
  -- ela se propaga sozinha: `eligible_items` entra por join nesta CTE, então
  -- recortar o conjunto de perfis recorta tudo o que vem depois. O índice
  -- publication_items_org_profile_status_execute_idx (057) é
  -- (organization_id, profile_id, status, execute_at) -- exatamente o prefixo
  -- que este recorte oferece, e o que faz o bloco custar ~1 s em vez de estourar.
  with profile_rows as materialized (
    select profile.id
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and profile.id = any (coalesce(p_profile_ids, array[]::uuid[]))
  ), eligible_items as materialized (
    select item.profile_id, item.format, item.status, item.execute_at
    from public.publication_items as item
    join profile_rows as profile on profile.id = item.profile_id
    where item.organization_id = p_organization_id
      and (
        item.status = 'published'
        or (
          item.status in ('waiting', 'ready', 'preparing', 'publishing')
          and (item.execute_at is null or item.execute_at > now())
        )
      )
  ), counted as (
    select
      item.profile_id,
      count(*) filter (
        where item.status in ('waiting', 'ready', 'preparing', 'publishing')
      )::integer as scheduled_post_count,
      jsonb_build_object(
        'reel', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'reel'),
        'story', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'story'),
        'image', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'image'),
        'carousel', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing') and item.format = 'carousel'),
        'total', count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing'))
      ) as scheduled_counts,
      jsonb_build_object(
        'reel', count(*) filter (where item.status = 'published' and item.format = 'reel'),
        'story', count(*) filter (where item.status = 'published' and item.format = 'story'),
        'image', count(*) filter (where item.status = 'published' and item.format = 'image'),
        'carousel', count(*) filter (where item.status = 'published' and item.format = 'carousel'),
        'total', count(*) filter (where item.status = 'published')
      ) as published_counts
    from eligible_items as item
    group by item.profile_id
  ), slot_rows as (
    select
      item.profile_id,
      item.format,
      public.posting_time_window(item.execute_at) as slot_window,
      count(*)::integer as slot_count
    from eligible_items as item
    where item.status in ('waiting', 'ready', 'preparing', 'publishing')
      and item.execute_at is not null
      and item.execute_at <= now() + make_interval(days => p_slot_horizon_days)
    group by item.profile_id, item.format, public.posting_time_window(item.execute_at)
  ), by_time as (
    select totals.profile_id, jsonb_object_agg(totals.slot_window, totals.slot_count) as counts
    from (
      select slot.profile_id, slot.slot_window, sum(slot.slot_count)::integer as slot_count
      from slot_rows as slot
      group by slot.profile_id, slot.slot_window
    ) as totals
    group by totals.profile_id
  ), by_format_and_time as (
    select nested.profile_id, jsonb_object_agg(nested.format::text, nested.counts) as counts
    from (
      select slot.profile_id, slot.format, jsonb_object_agg(slot.slot_window, slot.slot_count) as counts
      from slot_rows as slot
      group by slot.profile_id, slot.format
    ) as nested
    group by nested.profile_id
  )
  select
    profile.id as profile_id,
    coalesce(metric.scheduled_post_count, 0) as scheduled_post_count,
    coalesce(metric.scheduled_counts, jsonb_build_object('reel', 0, 'story', 0, 'image', 0, 'carousel', 0, 'total', 0)) as scheduled_counts,
    coalesce(metric.published_counts, jsonb_build_object('reel', 0, 'story', 0, 'image', 0, 'carousel', 0, 'total', 0)) as published_counts,
    coalesce(time_counts.counts, '{}'::jsonb) as scheduled_by_time,
    -- As quatro chaves de formato sempre presentes: o compositor lê
    -- scheduled_by_format_and_time[formato][horário] sem checar o nível do meio,
    -- e um formato ausente viraria TypeError na renderização do seletor.
    jsonb_build_object('reel', '{}'::jsonb, 'story', '{}'::jsonb, 'image', '{}'::jsonb, 'carousel', '{}'::jsonb)
      || coalesce(format_time_counts.counts, '{}'::jsonb) as scheduled_by_format_and_time
  from profile_rows as profile
  left join counted as metric on metric.profile_id = profile.id
  left join by_time as time_counts on time_counts.profile_id = profile.id
  left join by_format_and_time as format_time_counts on format_time_counts.profile_id = profile.id;
end;
$$;

revoke all on function public.get_posting_composer_profile_summaries(uuid, uuid[], integer) from public, anon;
grant execute on function public.get_posting_composer_profile_summaries(uuid, uuid[], integer) to authenticated, service_role;

notify pgrst, 'reload schema';

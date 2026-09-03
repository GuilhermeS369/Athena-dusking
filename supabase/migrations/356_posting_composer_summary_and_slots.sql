-- Compositor de /postagem: separa as contagens da abertura dos horários ocupados.
--
-- get_posting_composer_profile_metrics devolve, além das contagens, dois arrays
-- com TODOS os horários agendados de TODOS os perfis. Medido em 02/09/2026 na
-- organização Pomodoro (1.401 perfis online, 404.753 publication_items): 13,01
-- MiB por resposta e 367.744 timestamps. Como o PostgREST aplica o `.range()`
-- DEPOIS de a função ter calculado o conjunto inteiro, paginar em blocos de
-- 1.000 fazia a agregação inteira rodar duas vezes: 9,0 s dos 10,3 s que a
-- página levava para carregar os dados. Os mesmos 13,8 MiB ainda seguiam para o
-- navegador como props do compositor.
--
-- A divisão abaixo segue o que a tela realmente usa, e quando:
--
--   * get_posting_composer_profile_summaries — tudo que aparece ANTES de
--     escolher um destino: contagens por formato e as contagens por janela de
--     dez minutos que hoje a página deriva em JS a partir dos arrays. ~0,34 MiB
--     para os mesmos 1.401 perfis, e cabe numa única página do PostgREST.
--
--   * get_posting_composer_profile_slots — os horários ocupados, que só são
--     lidos DEPOIS de escolher um perfil ou grupo (detecção de conflito de
--     minuto e projeção de recorrência), e só para os perfis daquele destino.
--
-- get_posting_composer_profile_metrics continua existindo e intocada: derrubá-la
-- no mesmo deploy que troca os chamadores deixaria uma janela em que a versão
-- anterior da página, ainda aberta no navegador de alguém, chamaria uma função
-- que não existe mais.

-- Espelha lib/publications/composer.ts#postingTimeWindow: normaliza um instante
-- para a opção de dez minutos que o compositor exibe (12:07 pertence a 12:00),
-- no fuso da organização. `stable` e não `immutable` porque a conversão depende
-- do banco de fusos horários, que o Postgres pode atualizar.
create or replace function public.posting_time_window(p_at timestamptz)
returns text
language sql
stable
parallel safe
set search_path = public
as $$
  select to_char(local_at, 'HH24') || ':' || lpad(((extract(minute from local_at)::integer / 10) * 10)::text, 2, '0')
  from (select p_at at time zone 'America/Sao_Paulo' as local_at) as converted
  where p_at is not null;
$$;

revoke all on function public.posting_time_window(timestamptz) from public, anon;
grant execute on function public.posting_time_window(timestamptz) to authenticated, service_role;

create or replace function public.get_posting_composer_profile_summaries(
  p_organization_id uuid,
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

  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  return query
  with profile_rows as materialized (
    select profile.id
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
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
  ),
  -- Uma linha por (perfil, formato, janela de dez minutos). É o mesmo recorte do
  -- array scheduled_execute_ats_by_format da função antiga — instantes futuros
  -- dentro do horizonte —, só que contado no banco em vez de transportado em
  -- JSON para ser contado em JS na renderização da página.
  slot_rows as (
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

revoke all on function public.get_posting_composer_profile_summaries(uuid, integer) from public, anon;
grant execute on function public.get_posting_composer_profile_summaries(uuid, integer) to authenticated, service_role;

-- Horários ocupados dos perfis de UM destino. Não varre o histórico publicado
-- (40% da tabela) e é servida pelo índice
-- publication_items_org_profile_status_execute_idx (migration 057).
--
-- Devolve só o recorte por formato: o array plano que o compositor usa é a união
-- exata dos quatro, porque publication_format é um enum fechado nesses quatro
-- valores desde a migration 007. Mandar os dois dobraria a resposta para
-- transportar o mesmo conjunto duas vezes.
create or replace function public.get_posting_composer_profile_slots(
  p_organization_id uuid,
  p_profile_ids uuid[],
  p_slot_horizon_days integer default 90
)
returns table (
  profile_id uuid,
  scheduled_execute_ats_by_format jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_slot_horizon_days not between 1 and 366 then
    raise exception using errcode = '22023', message = 'Horizonte de agenda deve estar entre 1 e 366 dias.';
  end if;

  -- Uma linha por perfil pedido, então este teto também garante que a resposta
  -- nunca encoste no max_rows do PostgREST.
  if coalesce(array_length(p_profile_ids, 1), 0) > 1000 then
    raise exception using errcode = '22023', message = 'Máximo de 1.000 perfis por consulta de horários.';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  return query
  with requested as (
    select profile.id
    from public.instagram_profiles as profile
    where profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and profile.id = any (coalesce(p_profile_ids, array[]::uuid[]))
  ), slots as (
    select
      item.profile_id,
      item.format,
      jsonb_agg(item.execute_at order by item.execute_at) as execute_ats
    from public.publication_items as item
    join requested on requested.id = item.profile_id
    where item.organization_id = p_organization_id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing')
      and item.execute_at is not null
      and item.execute_at > now()
      and item.execute_at <= now() + make_interval(days => p_slot_horizon_days)
    group by item.profile_id, item.format
  ), by_format as (
    select slot.profile_id, jsonb_object_agg(slot.format::text, slot.execute_ats) as slots
    from slots as slot
    group by slot.profile_id
  )
  select
    requested.id as profile_id,
    jsonb_build_object('reel', '[]'::jsonb, 'story', '[]'::jsonb, 'image', '[]'::jsonb, 'carousel', '[]'::jsonb)
      || coalesce(by_format.slots, '{}'::jsonb) as scheduled_execute_ats_by_format
  from requested
  left join by_format on by_format.profile_id = requested.id;
end;
$$;

revoke all on function public.get_posting_composer_profile_slots(uuid, uuid[], integer) from public, anon;
grant execute on function public.get_posting_composer_profile_slots(uuid, uuid[], integer) to authenticated, service_role;

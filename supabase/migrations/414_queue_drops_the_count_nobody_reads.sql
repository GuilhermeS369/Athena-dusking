-- A fila cabe no tempo: sai a contagem que ninguém lê, e o join que só 48 linhas
-- precisavam.
--
-- A 412 estreitou a projeção de `operational_items` e não bastou: medido em
-- 06/09/2026, logo após aplicá-la, os três agrupamentos seguiam em 57014
-- (grupo 8.460 ms, lote 8.153 ms, conta 8.156 ms). Estreitar a linha ajudou, mas
-- o custo estava em outros dois lugares, e este é o registro de onde:
--
--   contagem de arquivados ......... 3.050 ms sobre 450.105 linhas
--   varredura do conjunto operacional 2.766 ms sobre  86.487 linhas
--   janela de publicados (24 h) .... 1.235 ms sobre  19.510 linhas
--
-- 1. `archived` SAI INTEIRA. Ela era `count(*)` sobre TODA linha arquivada da
--    organização — 450 mil — a cada chamada, e a tela faz polling de 1×/minuto
--    por aba aberta. O número ia no payload como `totals.archived`, e um grep
--    por `totals.archived` no cliente não acha um só uso: ele existe no tipo e
--    no objeto padrão, e nunca foi renderizado. Três segundos por chamada para
--    um número que ninguém vê. `pendingArchive`, que a tela USA no rótulo do
--    botão "Limpar encerradas", não é isto e continua — ele sai de
--    `operational_items`, que já está em memória, e não custa varredura nova.
--
--    Por que a contagem é cara mesmo com o índice parcial da 083
--    (organization_id, archived_at desc) where archived_at is not null: a tabela
--    recebe ~68 mil escritas por dia, então o mapa de visibilidade vive
--    desatualizado e o index-only scan degrada para acesso ao heap. Não é um
--    índice faltando; é a natureza da tabela.
--
-- 2. O LEFT JOIN DE RECONHECIMENTOS VIRA `exists` PREGUIÇOSO. `failure_
--    acknowledged` só significa alguma coisa para item com status 'failed' --
--    ele aparece exclusivamente em `filter (where status = 'failed' and ...)`.
--    O join, porém, era feito para as 86.487 linhas do conjunto operacional.
--    Linhas 'failed' não arquivadas na organização Pomodoro: 48.
--
--    O `case` não é enfeite de estilo, é o que garante a economia: `case`
--    avalia o ramo preguiçosamente, então o `exists` só roda nas 48. Escrito
--    como `status = 'failed' and exists (...)`, o planejador teria liberdade
--    para avaliar o `exists` antes do teste de status, e a economia poderia não
--    acontecer.
--
-- NENHUM NÚMERO DA TELA MUDA. `archived` não era exibido; `failure_acknowledged`
-- é falso para todo item não-'failed' tanto no join anterior (não havia
-- reconhecimento para item que nunca falhou) quanto no `case` novo, e para os
-- 'failed' a pergunta feita ao banco é a mesma.

create or replace function public.get_publication_queue_reference_page(
  p_organization_id uuid,
  p_scope text default 'account',
  p_limit integer default 25,
  p_offset integer default 0,
  p_history_hours integer default 24,
  p_group_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with authorized as (
    select p_organization_id as organization_id
    where auth.role() = 'service_role'
      or public.is_organization_member(p_organization_id)
  ), operational_items as materialized (
    select
      -- Sete colunas, e não `item.*`: ver o cabeçalho. A linha inteira de
      -- 87 mil itens era materializada para que os agregados lessem estas.
      item.profile_id,
      item.batch_id,
      item.status,
      item.execute_at,
      item.archived_at,
      item.lease_until,
      -- Ver o cabecalho: `case` garante avaliacao preguicosa, entao o `exists`
      -- roda so nas linhas 'failed' (48, contra 86.487 do conjunto).
      case
        when item.status = 'failed' then exists (
          select 1
          from public.publication_failure_acknowledgements acknowledgement
          where acknowledgement.publication_item_id = item.id
        )
        else false
      end as failure_acknowledged
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    where item.archived_at is null
      or (
        item.status = 'published'
        and item.published_at >= timezone('utc', now())
          - make_interval(hours => least(greatest(coalesce(p_history_hours, 24), 1), 168))
      )
  ), totals as (
    select
      count(*) filter (where status not in ('cancelled', 'removed', 'ignored'))::integer as total,
      count(*)::integer as historical_total,
      count(*) filter (where status = 'published')::integer as ok,
      count(*) filter (where status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where status in ('preparing', 'publishing'))::integer as processing,
      count(*) filter (where status = 'failed' and not failure_acknowledged)::integer as errors,
      count(*) filter (where status = 'failed' and failure_acknowledged)::integer as acknowledged_errors,
      count(*) filter (where status = 'suspended')::integer as suspended,
      count(*) filter (where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer as active,
      count(*) filter (where status in ('cancelled', 'removed', 'ignored'))::integer as closed,
      -- Saldo real de arquivamento: mesmo predicado de
      -- clean_publication_queue_finished. Alimenta o rótulo do botão "Limpar
      -- encerradas", que antes somava ok + errors + closed.
      count(*) filter (
        where archived_at is null
          and status in ('published', 'cancelled', 'removed', 'ignored')
      )::integer as pending_archive,
      count(*) filter (
        where status in ('preparing', 'publishing')
          and lease_until is not null
          and lease_until <= timezone('utc', now())
      )::integer as expired_leases,
      count(distinct profile_id) filter (
        where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')
      )::integer as active_accounts,
      count(distinct profile_id) filter (where status = 'suspended')::integer as suspended_accounts,
      count(distinct profile_id) filter (where status not in ('cancelled', 'removed', 'ignored'))::integer as total_accounts
    from operational_items
  ), profile_membership as materialized (
    select member.profile_id, member.group_id
    from public.profile_group_members member
    join authorized auth_org on auth_org.organization_id = member.organization_id
  ), rows as (
    select
      item.profile_id::text as id,
      null::text as title,
      profile.username::text as username,
      profile.display_name::text as display_name,
      profile.profile_picture_url::text as profile_picture_url,
      null::integer as profile_count,
      null::timestamptz as created_at,
      count(*) filter (where item.status not in ('cancelled', 'removed', 'ignored'))::integer as total,
      count(*)::integer as historical_total,
      count(*) filter (where item.status = 'published')::integer as completed,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer as errors,
      count(*) filter (where item.status = 'suspended')::integer as suspended,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer as pending,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer as processing,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer as active,
      count(*) filter (where item.status in ('cancelled', 'removed', 'ignored'))::integer as closed,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')) as next_at,
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end::text as tone
    from operational_items item
    join public.instagram_profiles profile on profile.id = item.profile_id
    where p_scope = 'account'
      -- O recorte por grupo vale SO aqui. `totals`, acima, segue lendo a
      -- fila inteira: os cartoes do topo sao da operacao, nao do grupo.
      and (
        p_group_id is null
        or exists (
          select 1 from profile_membership membership
          where membership.profile_id = item.profile_id
            and membership.group_id = p_group_id
        )
      )
    group by item.profile_id, profile.username, profile.display_name, profile.profile_picture_url

    union all

    select
      item.batch_id::text,
      coalesce(batch.name, 'Sem campanha')::text,
      null::text,
      null::text,
      null::text,
      null::integer,
      batch.created_at,
      count(*) filter (where item.status not in ('cancelled', 'removed', 'ignored'))::integer,
      count(*)::integer,
      count(*) filter (where item.status = 'published')::integer,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer,
      count(*) filter (where item.status = 'suspended')::integer,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer,
      count(*) filter (where item.status in ('cancelled', 'removed', 'ignored'))::integer,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')),
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end::text
    from operational_items item
    join public.publication_batches batch on batch.id = item.batch_id
    where p_scope = 'batch'
    group by item.batch_id, batch.name, batch.created_at

    union all

    select
      coalesce(membership.group_id::text, 'none'),
      coalesce(profile_group.name, 'Sem grupo')::text,
      null::text,
      null::text,
      null::text,
      count(distinct item.profile_id)::integer,
      null::timestamptz,
      count(*) filter (where item.status not in ('cancelled', 'removed', 'ignored'))::integer,
      count(*)::integer,
      count(*) filter (where item.status = 'published')::integer,
      count(*) filter (where item.status = 'failed' and not item.failure_acknowledged)::integer,
      count(*) filter (where item.status = 'suspended')::integer,
      count(*) filter (where item.status in ('waiting', 'ready'))::integer,
      count(*) filter (where item.status in ('preparing', 'publishing'))::integer,
      count(*) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended'))::integer,
      count(*) filter (where item.status in ('cancelled', 'removed', 'ignored'))::integer,
      min(item.execute_at) filter (where item.status in ('waiting', 'ready', 'preparing', 'publishing')),
      case
        when bool_or(item.status in ('preparing', 'publishing')) then 'posting'
        when bool_or(item.status = 'failed' and not item.failure_acknowledged) then 'error'
        when bool_or(item.status in ('waiting', 'ready')) then 'idle'
        when bool_or(item.status = 'suspended') then 'suspended'
        else 'done'
      end::text
    from operational_items item
    left join profile_membership membership on membership.profile_id = item.profile_id
    left join public.profile_groups profile_group on profile_group.id = membership.group_id
    where p_scope = 'group'
    group by membership.group_id, profile_group.name
  ), visible_rows as (
    select * from rows where total > 0
  ), paged_rows as (
    select *
    from visible_rows
    order by
      (errors > 0) desc,
      (processing > 0) desc,
      (pending > 0) desc,
      next_at nulls last,
      coalesce(username, title, '') asc,
      id asc
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    offset least(greatest(coalesce(p_offset, 0), 0), 1000000)
  )
  select jsonb_build_object(
    'snapshotAt', timezone('utc', now()),
    'historyHours', least(greatest(coalesce(p_history_hours, 24), 1), 168),
    'totals', jsonb_build_object(
      'total', totals.total,
      'historicalTotal', totals.historical_total,
      'ok', totals.ok,
      'pending', totals.pending,
      'processing', totals.processing,
      'errors', totals.errors,
      'acknowledgedErrors', totals.acknowledged_errors,
      'suspended', totals.suspended,
      'active', totals.active,
      'closed', totals.closed,
      'pendingArchive', totals.pending_archive,
      'expiredLeases', totals.expired_leases,
      'activeAccounts', totals.active_accounts,
      'suspendedAccounts', totals.suspended_accounts,
      'totalAccounts', totals.total_accounts,
      'progress', case when totals.total = 0 then 0 else round(totals.ok::numeric * 100 / totals.total)::integer end
    ),
    'rows', coalesce((select jsonb_agg(to_jsonb(paged_rows)) from paged_rows), '[]'::jsonb),
    'page', jsonb_build_object(
      'scope', p_scope,
      'offset', least(greatest(coalesce(p_offset, 0), 0), 1000000),
      'limit', least(greatest(coalesce(p_limit, 25), 1), 100),
      'totalCount', (select count(*)::integer from visible_rows),
      'hasMore', least(greatest(coalesce(p_offset, 0), 0), 1000000)
        + least(greatest(coalesce(p_limit, 25), 1), 100)
        < (select count(*) from visible_rows)
    )
  )
  from totals
  where p_scope in ('account', 'batch', 'group');
$$;

revoke all on function public.get_publication_queue_reference_page(uuid, text, integer, integer, integer, uuid)
  from public, anon;
grant execute on function public.get_publication_queue_reference_page(uuid, text, integer, integer, integer, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';

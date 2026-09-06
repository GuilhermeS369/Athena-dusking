-- Os totais da fila passam a caber numa varredura só: um agrupamento por perfil
-- no lugar de três ordenações distintas.
--
-- ONDE ESTÁVAMOS. Depois da 414, a aba de contas recortada por grupo passou a
-- responder (6.925 ms, contra estouro antes), mas os agrupamentos completos
-- seguiam em 57014: grupo 8.737 ms, lote 8.190 ms, conta 8.276 ms. A 412 tirou a
-- largura da linha, a 414 tirou a contagem de 450 mil arquivados e o join que só
-- 48 linhas usavam. O que sobrou, e é o assunto desta migration, são os três
--
--     count(distinct profile_id) filter (...)
--
-- de `totals`. Cada `count(distinct)` é uma passagem própria com ordenação sobre
-- as 86.487 linhas do conjunto operacional -- o `filter` não evita a ordenação,
-- só descarta linhas depois. São três ordenações de 86 mil valores para produzir
-- três inteiros.
--
-- A TROCA. Agrupa-se UMA vez por `profile_id` (hash aggregate, 86.487 linhas
-- entrando, 1.526 saindo) e todos os catorze números saem daí: os onze de
-- contagem viram `sum()` sobre 1.526 linhas, e os três de conta distinta viram
-- `count(*) filter (where ... > 0)` -- se o perfil tem ao menos um item naquele
-- estado, ele conta uma vez. É a definição de `count(distinct profile_id)`,
-- escrita de um jeito que o banco já resolveu no agrupamento.
--
-- O DETALHE QUE QUASE PASSA BATIDO, e que estaria errado se ninguém olhasse:
-- `active` e `active_accounts` NÃO usam o mesmo conjunto de estados. `active`
-- inclui 'suspended'; `active_accounts` não. Por isso o agrupamento por perfil
-- carrega duas colunas parecidas -- `active` e `active_for_accounts` -- em vez de
-- uma. Reaproveitar a primeira para as duas mudaria o número de "contas na
-- fila" toda vez que houvesse perfil suspenso, que é justamente quando alguém
-- olha para ele.
--
-- NENHUM NÚMERO MUDA. Cada agregado é a mesma pergunta sobre o mesmo conjunto,
-- reordenada. `sum()` de contagens parciais por perfil é a contagem total, e
-- `count(*) filter (where parcial > 0)` é a contagem de perfis distintos.
-- `sum()` devolve numeric e volta para integer no cast, como antes; sobre
-- conjunto vazio devolve null, daí o `coalesce` -- a versão anterior devolvia 0,
-- e sem ele uma organização de fila vazia veria null no lugar de zero.

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
  ), per_profile as (
    -- Um agrupamento, e nao tres ordenacoes: ver o cabecalho. 86.487 linhas
    -- entram, 1.526 saem, e os catorze numeros de `totals` saem destas.
    select
      profile_id,
      count(*) filter (where status not in ('cancelled', 'removed', 'ignored')) as total,
      count(*) as historical_total,
      count(*) filter (where status = 'published') as ok,
      count(*) filter (where status in ('waiting', 'ready')) as pending,
      count(*) filter (where status in ('preparing', 'publishing')) as processing,
      count(*) filter (where status = 'failed' and not failure_acknowledged) as errors,
      count(*) filter (where status = 'failed' and failure_acknowledged) as acknowledged_errors,
      count(*) filter (where status = 'suspended') as suspended,
      count(*) filter (where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')) as active,
      -- Sem 'suspended', de proposito: e o conjunto de `active_accounts`, que
      -- difere de `active`. Ver o cabecalho.
      count(*) filter (where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')) as active_for_accounts,
      count(*) filter (where status in ('cancelled', 'removed', 'ignored')) as closed,
      -- Saldo real de arquivamento: mesmo predicado de
      -- clean_publication_queue_finished. Alimenta o rotulo do botao "Limpar
      -- encerradas", que antes somava ok + errors + closed.
      count(*) filter (
        where archived_at is null
          and status in ('published', 'cancelled', 'removed', 'ignored')
      ) as pending_archive,
      count(*) filter (
        where status in ('preparing', 'publishing')
          and lease_until is not null
          and lease_until <= timezone('utc', now())
      ) as expired_leases
    from operational_items
    group by profile_id
  ), totals as (
    select
      coalesce(sum(total), 0)::integer as total,
      coalesce(sum(historical_total), 0)::integer as historical_total,
      coalesce(sum(ok), 0)::integer as ok,
      coalesce(sum(pending), 0)::integer as pending,
      coalesce(sum(processing), 0)::integer as processing,
      coalesce(sum(errors), 0)::integer as errors,
      coalesce(sum(acknowledged_errors), 0)::integer as acknowledged_errors,
      coalesce(sum(suspended), 0)::integer as suspended,
      coalesce(sum(active), 0)::integer as active,
      coalesce(sum(closed), 0)::integer as closed,
      coalesce(sum(pending_archive), 0)::integer as pending_archive,
      coalesce(sum(expired_leases), 0)::integer as expired_leases,
      count(*) filter (where active_for_accounts > 0)::integer as active_accounts,
      count(*) filter (where suspended > 0)::integer as suspended_accounts,
      count(*) filter (where total > 0)::integer as total_accounts
    from per_profile
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

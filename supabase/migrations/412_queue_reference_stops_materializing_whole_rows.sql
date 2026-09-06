-- A fila volta a carregar: ela materializava a linha inteira de 87 mil itens
-- para ler sete colunas.
--
-- O SINTOMA, em 06/09/2026: "Não foi possível carregar a fila" nos três
-- agrupamentos, com todos os cartões em 0 e progresso em 0%. Medido direto na
-- RPC: conta 8.703 ms, lote 8.409 ms, grupo 8.285 ms -- os três em 57014,
-- `canceling statement due to statement timeout`. Os três, e isso importa: não
-- adianta trocar a aba padrão, porque o custo é anterior à aba.
--
-- ONDE ELE ESTÁ. `operational_items` é `as materialized` e projeta `item.*`.
-- São todas as colunas de `publication_items` -- incluindo `caption`, que é
-- texto livre, e o resto do corpo da publicação -- para 87.098 linhas não
-- arquivadas da organização Pomodoro. O conjunto inteiro é escrito em memória
-- (ou em disco, quando não cabe) antes que qualquer agregado comece a rodar, e
-- os agregados leem SETE colunas: profile_id, batch_id, status, execute_at,
-- archived_at, lease_until e o `failure_acknowledged` calculado ao lado.
--
-- `as materialized` está certo e fica: sem ele a CTE seria recalculada em cada
-- um dos três ramos do `union all` e no `count` da paginação. O erro não é
-- materializar -- é o que se materializa.
--
-- POR QUE SÓ AGORA. A 337 anotou o dimensionamento no próprio cabeçalho:
-- "publication_items tem 85k-110k linhas por organização". Continua verdade
-- para o total NÃO ARQUIVADO, e era o número certo enquanto o não arquivado
-- fosse quase todo histórico curto. O que mudou não é a contagem de linhas, é a
-- largura útil de cada uma: a fila hoje tem 87 mil itens AGENDADOS -- 20.753
-- nas próximas 24 h, 66.302 depois --, cada um com legenda, e não uma dúzia de
-- publicações vivas mais o rastro do dia.
--
-- O QUE ESTA MIGRATION NÃO MUDA, e é deliberado: nenhum número da tela, nenhum
-- predicado, nenhuma janela. A janela de histórico publicado continua sendo
-- `p_history_hours` com teto de 168 h, pelo mesmo motivo da 337 (a 333 apaga da
-- tabela quente o que foi arquivado há mais de 7 dias, então acima disso a
-- resposta viria incompleta e calada). Só a lista de colunas da projeção muda.
-- Um `select` mais estreito não pode alterar contagem: as sete colunas que
-- sobram são as sete que os agregados já liam.
--
-- SEM ÍNDICE NOVO. A 334 já registrou que esta tabela tem índice demais, e o
-- caminho de leitura aqui não muda -- `publication_items_operational_org_status_idx`
-- (083) continua servindo o recorte `archived_at is null`.

create or replace function public.get_publication_queue_reference_page(
  p_organization_id uuid,
  p_scope text default 'account',
  p_limit integer default 25,
  p_offset integer default 0,
  p_history_hours integer default 24
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
      acknowledgement.publication_item_id is not null as failure_acknowledged
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    left join public.publication_failure_acknowledgements acknowledgement
      on acknowledgement.publication_item_id = item.id
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
  ), archived as (
    select count(*)::integer as total
    from public.publication_items item
    join authorized auth_org on auth_org.organization_id = item.organization_id
    where item.archived_at is not null
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
      'archived', archived.total,
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
  from totals cross join archived
  where p_scope in ('account', 'batch', 'group');
$$;

revoke all on function public.get_publication_queue_reference_page(uuid, text, integer, integer, integer)
  from public, anon;
grant execute on function public.get_publication_queue_reference_page(uuid, text, integer, integer, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';

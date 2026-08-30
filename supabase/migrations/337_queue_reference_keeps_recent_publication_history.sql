-- A /queue volta a mostrar o que foi publicado.
--
-- O QUE O USUÁRIO VIA. Progresso geral 0%, KPI "OK / publicadas" em 0, 0% em
-- toda linha, "0 publicadas" em todo card, e contas/lotes/grupos já concluídos
-- sumindo da lista inteira — nas três abas.
--
-- POR QUE. Toda a projeção desta tela sai de `operational_items`, que filtra
-- `archived_at is null`. Isso estava certo enquanto arquivar era um ato manual:
-- o operador clicava "Limpar encerradas" quando queria limpar. O commit 1eb7202
-- (29/08/2026) pôs o arquivamento em laço no media-maintenance-worker, a cada
-- 10 minutos, e ninguém ajustou a leitura junto. A janela de visibilidade de
-- uma publicação bem-sucedida virou 10 minutos. Como `visible_rows` ainda
-- filtra `total > 0`, a linha inteira desaparecia junto.
--
-- A CORREÇÃO. `operational_items` passa a admitir também o publicado recente,
-- arquivado ou não. Uma única mudança de predicado, e não contadores paralelos:
-- todos os `count(*) filter (...)` abaixo continuam lendo o mesmo conjunto de
-- linhas, então não há dupla contagem entre "publicado e ainda não arquivado" e
-- "publicado e já arquivado" — é a mesma linha, contada uma vez.
--
-- POR QUE UMA JANELA, E POR QUE ELA TERMINA EM 7 DIAS. Ler o histórico inteiro
-- não é opção: `publication_items` tem 85k–110k linhas por organização e esta
-- tela faz polling a cada 60 s por aba aberta. E acima de 7 dias a resposta
-- seria silenciosamente incompleta: a migration 333 move para o arquivo frio
-- tudo que foi arquivado há mais de 7 dias, apagando a linha da tabela quente.
-- Por isso o teto de 168 h é do tamanho exato da retenção — dentro dele a
-- tabela quente é completa por construção, e nada aqui precisa ler o frio.
-- Um teto maior devolveria número errado sem avisar, que é justamente o defeito
-- que esta migration existe para consertar.
--
-- SEM ÍNDICE NOVO. Os dois lados do OR já têm índice parcial:
-- `archived_at is null` cai no índice da 083 e o publicado na janela cai em
-- `publication_items_dispatch_telemetry_published_idx` (271), que é
-- (organization_id, published_at desc, profile_id) where status = 'published' —
-- exatamente o recorte e o agrupamento da aba "Por conta". A 334 já registrou
-- que esta tabela tem índice demais; nenhum é acrescentado aqui.
--
-- pendingArchive. O botão "Limpar encerradas" mostrava `ok + errors + closed`.
-- Com `ok` passando a contar publicado já arquivado, o rótulo viraria um número
-- grande para um botão que não tem o que fazer. O saldo real de arquivamento
-- agora vem pronto do banco, com o mesmo predicado de
-- `clean_publication_queue_finished` depois da 335 (falha retentável não conta:
-- ela não é lixo, é trabalho pendente).

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
      item.*,
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

-- A assinatura de quatro argumentos sobrevive ao `create or replace` que
-- acrescenta parâmetro, e o PostgREST resolve a RPC pelos argumentos enviados.
-- Se ela ficasse no schema, a rota — que manda scope/limit/offset — continuaria
-- caindo na versão antiga e a tela seguiria mostrando 0%.
drop function if exists public.get_publication_queue_reference_page(uuid, text, integer, integer);

notify pgrst, 'reload schema';

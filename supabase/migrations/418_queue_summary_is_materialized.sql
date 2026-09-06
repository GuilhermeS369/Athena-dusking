-- O resumo da fila para de ser recalculado a cada leitura.
--
-- O PROBLEMA, e ele e de ORDEM DE GRANDEZA, nao de constante. O plano medido em
-- 06/09/2026 para o agrupamento por grupo, ja depois de 412/414/415 e do vacuum:
--
--   Bitmap Heap Scan on publication_items ........ 3.770 ms / 105.702 linhas
--   HashAggregate (per_profile) .................. ~2.000 ms sobre as mesmas
--   Sort para o group by das linhas .............. 2.488 -> 2.921 ms
--   Execution Time ............................... 10.217 ms
--
-- Toda leitura da tela agregava 105 mil linhas para produzir 15 numeros e 9
-- linhas de grupo. Isso e O(tamanho da fila) por requisicao: com 87 mil
-- publicacoes agendadas ja custava dez segundos, e a conta piora sozinha
-- conforme a operacao cresce. Nenhuma reescrita da consulta muda a ordem -- ela
-- e inerente a recontar tudo a cada vez.
--
-- A TROCA. A agregacao passa a rodar UMA vez por organizacao por ciclo, fora do
-- caminho da requisicao, e grava o resultado. A tela le o resultado gravado:
-- uma linha de totais e algumas centenas de linhas de agrupamento, em vez de
-- 105 mil. O custo da leitura deixa de depender do tamanho da fila.
--
-- POR QUE SNAPSHOT, E NAO CONTADOR INCREMENTAL POR GATILHO. Foi a primeira
-- ideia, e ela e pior aqui, por tres motivos concretos:
--
--   1. Gatilho por linha em `publication_items` significa codigo novo no caminho
--      mais quente do sistema -- o que publica 68 mil posts por dia. Um erro ali
--      nao deixa a tela feia, deixa de publicar.
--   2. Contador unico por (organizacao, estado) vira ponto de contencao: toda
--      transicao de estado disputaria a mesma linha, serializando um pipeline
--      que hoje roda em paralelo.
--   3. Metade dos numeros NAO E CONTAVEL incrementalmente. `expired_leases`
--      depende de now(). `ok` depende de uma janela movel de horas.
--      `active_accounts` e contagem de perfis DISTINTOS -- saber que um item
--      saiu de 'waiting' nao diz se aquele perfil ainda tem outro.
--
-- O snapshot recalcula tudo, entao nao diverge nunca, e nao encosta no caminho
-- de publicacao.
--
-- O PRECO, dito com clareza: o numero na tela tem a idade do ultimo calculo. O
-- payload passa a devolver `snapshotAt` com o instante REAL do calculo (antes
-- devolvia `now()`, que era sempre "agora" e nao queria dizer nada), e a tela
-- pode mostra-lo. Para uma fila com 87 mil itens agendados, um resumo de um
-- minuto atras nao muda decisao nenhuma.
--
-- QUEM RECALCULA: o cron de um minuto da Vercel, via
-- /api/internal/queue-summary-refresh, e o worker da VPS a cada ciclo -- os dois,
-- pelo mesmo motivo registrado no commit f23d99e: rotina que existe so no painel
-- fica parada quando o painel nao e implantado. Se nao houver snapshot nenhum
-- (organizacao nova, ou primeiro deploy), a propria leitura manda calcular uma
-- vez, para a tela nunca abrir mentindo zero.

-- ---------------------------------------------------------------------------
-- 1. Onde o resultado mora
-- ---------------------------------------------------------------------------

create table if not exists public.publication_queue_summary_totals (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  history_hours integer not null,
  total integer not null default 0,
  historical_total integer not null default 0,
  ok integer not null default 0,
  pending integer not null default 0,
  processing integer not null default 0,
  errors integer not null default 0,
  acknowledged_errors integer not null default 0,
  suspended integer not null default 0,
  active integer not null default 0,
  closed integer not null default 0,
  pending_archive integer not null default 0,
  expired_leases integer not null default 0,
  active_accounts integer not null default 0,
  suspended_accounts integer not null default 0,
  total_accounts integer not null default 0,
  computed_at timestamptz not null default timezone('utc', now()),
  duration_ms integer not null default 0
);

comment on column public.publication_queue_summary_totals.duration_ms is
  'Quanto o ultimo recalculo levou. Existe para a degradacao ser visivel em vez de silenciosa: se este numero subir, a agregacao esta perdendo para o crescimento da fila.';

-- Uma linha por (organizacao, agrupamento, chave). Guarda so o que a tela
-- mostra, ja com o filtro `total > 0` aplicado -- na organizacao Pomodoro sao
-- 1.024 contas, 31 lotes e 9 grupos, contra as 105 mil linhas que produziam isso.
create table if not exists public.publication_queue_summary_rows (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope text not null check (scope in ('account', 'batch', 'group')),
  row_id text not null,
  title text,
  username text,
  display_name text,
  profile_picture_url text,
  profile_count integer,
  created_at timestamptz,
  total integer not null default 0,
  historical_total integer not null default 0,
  completed integer not null default 0,
  errors integer not null default 0,
  suspended integer not null default 0,
  pending integer not null default 0,
  processing integer not null default 0,
  active integer not null default 0,
  closed integer not null default 0,
  next_at timestamptz,
  tone text not null default 'idle',
  computed_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, scope, row_id)
);

-- O recorte por grupo da aba de contas junta por perfil; row_id guarda o id do
-- perfil como texto, e este indice evita a conversao linha a linha virar
-- varredura.
create index if not exists publication_queue_summary_rows_scope_idx
  on public.publication_queue_summary_rows (organization_id, scope, total desc);

alter table public.publication_queue_summary_totals enable row level security;
alter table public.publication_queue_summary_rows enable row level security;

drop policy if exists "membros leem os totais da propria organizacao" on public.publication_queue_summary_totals;
create policy "membros leem os totais da propria organizacao"
  on public.publication_queue_summary_totals for select to authenticated
  using (public.is_organization_member(organization_id));

drop policy if exists "membros leem as linhas da propria organizacao" on public.publication_queue_summary_rows;
create policy "membros leem as linhas da propria organizacao"
  on public.publication_queue_summary_rows for select to authenticated
  using (public.is_organization_member(organization_id));

-- Escrita e exclusiva das funcoes abaixo, que sao security definer. Nenhuma
-- politica de insert/update/delete: sem elas, `authenticated` nao escreve.
revoke all on public.publication_queue_summary_totals from anon, authenticated;
revoke all on public.publication_queue_summary_rows from anon, authenticated;
grant select on public.publication_queue_summary_totals to authenticated;
grant select on public.publication_queue_summary_rows to authenticated;

-- ---------------------------------------------------------------------------
-- 2. O recalculo
--
-- Uma unica leitura de publication_items alimenta os dois destinos. A tabela
-- temporaria existe justamente para isso: sem ela, cada `insert` refaria a
-- varredura de 105 mil linhas. Data-modifying CTEs resolveriam em um statement
-- so, mas `delete` e `insert` na MESMA tabela num statement so enxergam o mesmo
-- snapshot -- o insert nao ve o delete e bate na chave primaria.
--
-- statement_timeout proprio e generoso: isto roda fora do caminho da tela, e
-- ser cortado no meio deixaria o resumo velho sem ninguem saber por que.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_publication_queue_summary(
  p_organization_id uuid,
  p_history_hours integer default 24
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
declare
  started_at timestamptz := clock_timestamp();
  history_hours integer := least(greatest(coalesce(p_history_hours, 24), 1), 168);
  cutoff timestamptz;
  written integer := 0;
  elapsed integer;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  cutoff := timezone('utc', now()) - make_interval(hours => history_hours);

  create temporary table operational_snapshot on commit drop as
  select
    item.profile_id,
    item.batch_id,
    item.status,
    item.execute_at,
    item.archived_at,
    item.lease_until,
    -- `case` avalia preguicosamente: o `exists` so roda nas linhas 'failed'
    -- (48 das 86.487 na organizacao Pomodoro). Ver a migration 414.
    case
      when item.status = 'failed' then exists (
        select 1
        from public.publication_failure_acknowledgements acknowledgement
        where acknowledgement.publication_item_id = item.id
      )
      else false
    end as failure_acknowledged
  from public.publication_items item
  where item.organization_id = p_organization_id
    and (
      item.archived_at is null
      or (item.status = 'published' and item.published_at >= cutoff)
    );

  -- Sem isto o planejador trata a temporaria como se tivesse mil linhas e
  -- escolhe nested loop para os agrupamentos seguintes.
  analyze operational_snapshot;

  insert into public.publication_queue_summary_totals as target (
    organization_id, history_hours, total, historical_total, ok, pending, processing,
    errors, acknowledged_errors, suspended, active, closed, pending_archive,
    expired_leases, active_accounts, suspended_accounts, total_accounts,
    computed_at, duration_ms
  )
  select
    p_organization_id,
    history_hours,
    coalesce(sum(per.total), 0)::integer,
    coalesce(sum(per.historical_total), 0)::integer,
    coalesce(sum(per.ok), 0)::integer,
    coalesce(sum(per.pending), 0)::integer,
    coalesce(sum(per.processing), 0)::integer,
    coalesce(sum(per.errors), 0)::integer,
    coalesce(sum(per.acknowledged_errors), 0)::integer,
    coalesce(sum(per.suspended), 0)::integer,
    coalesce(sum(per.active), 0)::integer,
    coalesce(sum(per.closed), 0)::integer,
    coalesce(sum(per.pending_archive), 0)::integer,
    coalesce(sum(per.expired_leases), 0)::integer,
    count(*) filter (where per.active_for_accounts > 0)::integer,
    count(*) filter (where per.suspended > 0)::integer,
    count(*) filter (where per.total > 0)::integer,
    timezone('utc', now()),
    0
  from (
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
      -- Sem 'suspended', de proposito: conjunto de `active_accounts`, que difere
      -- de `active`. Ver a migration 415.
      count(*) filter (where status in ('waiting', 'ready', 'preparing', 'publishing', 'failed')) as active_for_accounts,
      count(*) filter (where status in ('cancelled', 'removed', 'ignored')) as closed,
      count(*) filter (
        where archived_at is null
          and status in ('published', 'cancelled', 'removed', 'ignored')
      ) as pending_archive,
      count(*) filter (
        where status in ('preparing', 'publishing')
          and lease_until is not null
          and lease_until <= timezone('utc', now())
      ) as expired_leases
    from operational_snapshot
    group by profile_id
  ) as per
  on conflict (organization_id) do update set
    history_hours = excluded.history_hours,
    total = excluded.total,
    historical_total = excluded.historical_total,
    ok = excluded.ok,
    pending = excluded.pending,
    processing = excluded.processing,
    errors = excluded.errors,
    acknowledged_errors = excluded.acknowledged_errors,
    suspended = excluded.suspended,
    active = excluded.active,
    closed = excluded.closed,
    pending_archive = excluded.pending_archive,
    expired_leases = excluded.expired_leases,
    active_accounts = excluded.active_accounts,
    suspended_accounts = excluded.suspended_accounts,
    total_accounts = excluded.total_accounts,
    computed_at = excluded.computed_at;

  delete from public.publication_queue_summary_rows where organization_id = p_organization_id;

  insert into public.publication_queue_summary_rows (
    organization_id, scope, row_id, title, username, display_name, profile_picture_url,
    profile_count, created_at, total, historical_total, completed, errors, suspended,
    pending, processing, active, closed, next_at, tone, computed_at
  )
  with agrupadas as (
    select
      'account'::text as scope,
      item.profile_id::text as row_id,
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
    from operational_snapshot item
    join public.instagram_profiles profile on profile.id = item.profile_id
    group by item.profile_id, profile.username, profile.display_name, profile.profile_picture_url

    union all

    select
      'batch',
      item.batch_id::text,
      coalesce(batch.name, 'Sem campanha')::text,
      null, null, null, null,
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
    from operational_snapshot item
    join public.publication_batches batch on batch.id = item.batch_id
    group by item.batch_id, batch.name, batch.created_at

    union all

    select
      'group',
      coalesce(membership.group_id::text, 'none'),
      coalesce(profile_group.name, 'Sem grupo')::text,
      null, null, null,
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
    from operational_snapshot item
    left join (
      select member.profile_id, member.group_id
      from public.profile_group_members member
      where member.organization_id = p_organization_id
    ) membership on membership.profile_id = item.profile_id
    left join public.profile_groups profile_group on profile_group.id = membership.group_id
    group by membership.group_id, profile_group.name
  )
  select
    p_organization_id, scope, row_id, title, username, display_name, profile_picture_url,
    profile_count, created_at, total, historical_total, completed, errors, suspended,
    pending, processing, active, closed, next_at, tone, timezone('utc', now())
  from agrupadas
  -- Mesmo filtro que `visible_rows` aplicava na leitura: agrupamento sem item
  -- ativo nem historico nao aparece na tela, entao nao precisa ser guardado.
  where total > 0;

  get diagnostics written = row_count;
  elapsed := greatest(0, extract(milliseconds from clock_timestamp() - started_at)::integer);
  update public.publication_queue_summary_totals
    set duration_ms = elapsed
    where organization_id = p_organization_id;

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'historyHours', history_hours,
    'rows', written,
    'durationMs', elapsed
  );
end;
$$;

revoke all on function public.refresh_publication_queue_summary(uuid, integer) from public, anon;
-- `authenticated` pode recalcular a PROPRIA organizacao: e o que permite a
-- leitura abaixo se auto-curar quando ainda nao existe snapshot nenhum.
grant execute on function public.refresh_publication_queue_summary(uuid, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. A leitura, agora barata
--
-- Sai o `set statement_timeout = '25s'` que a 416 pos aqui: ele era paliativo
-- para uma consulta de dez segundos, e nao ha mais consulta de dez segundos.
-- ---------------------------------------------------------------------------

create or replace function public.get_publication_queue_reference_page(
  p_organization_id uuid,
  p_scope text default 'account',
  p_limit integer default 25,
  p_offset integer default 0,
  p_history_hours integer default 24,
  p_group_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  page_offset integer := least(greatest(coalesce(p_offset, 0), 0), 1000000);
  totais public.publication_queue_summary_totals%rowtype;
  visiveis integer := 0;
  linhas jsonb;
begin
  if not (coalesce(auth.role(), '') = 'service_role' or public.is_organization_member(p_organization_id)) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_scope not in ('account', 'batch', 'group') then
    raise exception using errcode = '22023', message = 'Agrupamento da fila inválido.';
  end if;

  select * into totais from public.publication_queue_summary_totals
  where organization_id = p_organization_id;

  -- Primeira leitura de uma organizacao, ou primeiro deploy: calcula uma vez em
  -- vez de abrir a tela mostrando zero.
  if not found then
    perform public.refresh_publication_queue_summary(p_organization_id, p_history_hours);
    select * into totais from public.publication_queue_summary_totals
    where organization_id = p_organization_id;
  end if;

  with escopo as (
    select linha.*
    from public.publication_queue_summary_rows linha
    where linha.organization_id = p_organization_id
      and linha.scope = p_scope
      -- O recorte por grupo vale so na aba de contas. Ver a migration 413.
      and (
        p_scope <> 'account'
        or p_group_id is null
        or exists (
          select 1
          from public.profile_group_members member
          where member.organization_id = p_organization_id
            and member.group_id = p_group_id
            and member.profile_id::text = linha.row_id
        )
      )
  ), pagina as (
    select * from escopo
    order by
      (errors > 0) desc,
      (processing > 0) desc,
      (pending > 0) desc,
      next_at nulls last,
      coalesce(username, title, '') asc,
      row_id asc
    limit page_limit
    offset page_offset
  )
  select
    coalesce((select count(*)::integer from escopo), 0),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pagina.row_id,
        'title', pagina.title,
        'username', pagina.username,
        'display_name', pagina.display_name,
        'profile_picture_url', pagina.profile_picture_url,
        'profile_count', pagina.profile_count,
        'created_at', pagina.created_at,
        'total', pagina.total,
        'historical_total', pagina.historical_total,
        'completed', pagina.completed,
        'errors', pagina.errors,
        'suspended', pagina.suspended,
        'pending', pagina.pending,
        'processing', pagina.processing,
        'active', pagina.active,
        'closed', pagina.closed,
        'next_at', pagina.next_at,
        'tone', pagina.tone
      ))
      from pagina
    ), '[]'::jsonb)
  into visiveis, linhas;

  return jsonb_build_object(
    -- Agora este campo diz a verdade: e o instante do calculo, nao de agora.
    'snapshotAt', totais.computed_at,
    'historyHours', coalesce(totais.history_hours, least(greatest(coalesce(p_history_hours, 24), 1), 168)),
    'totals', jsonb_build_object(
      'total', coalesce(totais.total, 0),
      'historicalTotal', coalesce(totais.historical_total, 0),
      'ok', coalesce(totais.ok, 0),
      'pending', coalesce(totais.pending, 0),
      'processing', coalesce(totais.processing, 0),
      'errors', coalesce(totais.errors, 0),
      'acknowledgedErrors', coalesce(totais.acknowledged_errors, 0),
      'suspended', coalesce(totais.suspended, 0),
      'active', coalesce(totais.active, 0),
      'closed', coalesce(totais.closed, 0),
      'pendingArchive', coalesce(totais.pending_archive, 0),
      'expiredLeases', coalesce(totais.expired_leases, 0),
      'activeAccounts', coalesce(totais.active_accounts, 0),
      'suspendedAccounts', coalesce(totais.suspended_accounts, 0),
      'totalAccounts', coalesce(totais.total_accounts, 0),
      'progress', case when coalesce(totais.total, 0) = 0 then 0
        else round(totais.ok::numeric * 100 / totais.total)::integer end
    ),
    'rows', linhas,
    'page', jsonb_build_object(
      'scope', p_scope,
      'offset', page_offset,
      'limit', page_limit,
      'totalCount', visiveis,
      'hasMore', page_offset + page_limit < visiveis
    )
  );
end;
$$;

revoke all on function public.get_publication_queue_reference_page(uuid, text, integer, integer, integer, uuid)
  from public, anon;
grant execute on function public.get_publication_queue_reference_page(uuid, text, integer, integer, integer, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';

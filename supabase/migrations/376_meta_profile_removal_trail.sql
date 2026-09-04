-- Perfil removido pela Meta passa a deixar rastro, e a sair no XLSX.
--
-- O QUE JA FUNCIONAVA. `finalize_meta_profile_disconnection` (migrations 136 e
-- 137) ja fazia a remocao inteira: ignora as publicacoes, cancela chunks,
-- horizontes e planos, APAGA as linhas de `profile_group_members` e marca o
-- perfil com `deleted_at`. Isso nao muda aqui.
--
-- O QUE FALTAVA. Nada disso deixava rastro. Depois da remocao nao havia como
-- responder "de qual grupo esse perfil saiu, quando, e por que" -- e por isso o
-- perfil sumia da planilha em silencio, em vez de aparecer como caido. Do lado
-- da Zernio esse rastro existe desde as migrations 101, 183 e 203; do lado da
-- Meta, nao existia.
--
-- QUANDO ISSO DISPARA, e vale registrar porque a diferenca importa. A regra em
-- `lib/publications/dispatcher.ts#isMetaTerminalProfileDisconnection` exige
-- codigo 190 E uma mensagem de checkpoint/sessao invalidada ("log in to
-- www.instagram.com", "follow the instructions given", "checkpoint",
-- "session has been invalidated"). Token apenas EXPIRADO nao cai aqui: ele
-- devolve 190 com outra mensagem e fica com o worker de renovacao. Ou seja,
-- isto so remove perfil que a Meta exige verificacao para destravar -- que e o
-- caso que a operacao decidiu nao tratar.
--
-- POR QUE TABELAS PROPRIAS E NAO REAPROVEITAR AS DA ZERNIO. As da Zernio tem
-- `zernio_account_id text not null` e `signal in ('account_disconnected',
-- 'auth_expired')` -- sao Zernio por construcao. Afrouxar esses contratos numa
-- tabela viva, em producao, para acomodar um provedor que esta justamente
-- substituindo o outro, custa mais risco do que espelhar. Quando a Zernio sair,
-- as dela saem junto.

create table if not exists public.meta_profile_disconnection_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete restrict,
  meta_app_id uuid references public.meta_apps(id) on delete set null,
  username_snapshot text not null check (char_length(trim(username_snapshot)) between 1 and 80),
  meta_app_label_snapshot text,
  source_item_id uuid references public.publication_items(id) on delete set null,
  source_batch_id uuid references public.publication_batches(id) on delete set null,
  error_code text not null check (char_length(trim(error_code)) between 1 and 120),
  error_subcode integer,
  error_message text not null check (char_length(trim(error_message)) between 1 and 1200),
  -- Congelados no instante da queda: depois disso o perfil para de sincronizar e
  -- o numero corrente deixa de ser o dele. Mesma razao da migration 183.
  analytics_views_snapshot bigint,
  analytics_synced_at_snapshot timestamptz,
  ignored_item_count integer not null default 0 check (ignored_item_count >= 0),
  cancelled_plan_count integer not null default 0 check (cancelled_plan_count >= 0),
  detected_at timestamptz not null default timezone('utc', now()),
  finalized_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, profile_id)
);

create index if not exists meta_disconnection_incidents_org_detected_idx
  on public.meta_profile_disconnection_incidents(organization_id, detected_at desc);
create index if not exists meta_disconnection_incidents_org_app_idx
  on public.meta_profile_disconnection_incidents(organization_id, meta_app_id, detected_at desc);

-- Um perfil pode estar em varios grupos, e cada saida e uma linha. A tabela
-- existe porque `profile_group_members` e apagada de verdade: sem ela, a saida
-- nao deixa vestigio nenhum.
create table if not exists public.meta_group_profile_removal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  group_id uuid not null references public.profile_groups(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete restrict,
  incident_id uuid not null references public.meta_profile_disconnection_incidents(id) on delete cascade,
  removal_sequence integer not null check (removal_sequence >= 1),
  counted_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (incident_id, removal_sequence)
);

create index if not exists meta_group_profile_removal_events_group_count_idx
  on public.meta_group_profile_removal_events(organization_id, group_id, counted_at)
  where counted_at is not null;

drop trigger if exists meta_disconnection_incidents_set_updated_at on public.meta_profile_disconnection_incidents;
create trigger meta_disconnection_incidents_set_updated_at
before update on public.meta_profile_disconnection_incidents
for each row execute function public.set_updated_at();

alter table public.meta_profile_disconnection_incidents enable row level security;
alter table public.meta_group_profile_removal_events enable row level security;

drop policy if exists meta_disconnection_incidents_select_member on public.meta_profile_disconnection_incidents;
create policy meta_disconnection_incidents_select_member
  on public.meta_profile_disconnection_incidents for select to authenticated
  using (public.is_organization_member(organization_id));

drop policy if exists meta_group_profile_removal_events_select_member on public.meta_group_profile_removal_events;
create policy meta_group_profile_removal_events_select_member
  on public.meta_group_profile_removal_events for select to authenticated
  using (public.is_organization_member(organization_id));

revoke all on public.meta_profile_disconnection_incidents, public.meta_group_profile_removal_events from public, anon, authenticated;
grant select on public.meta_profile_disconnection_incidents, public.meta_group_profile_removal_events to authenticated;
grant all on public.meta_profile_disconnection_incidents, public.meta_group_profile_removal_events to service_role;

create or replace function public.finalize_meta_profile_disconnection(
  p_item_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_error_subcode integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_item public.publication_items%rowtype;
  profile_row public.instagram_profiles%rowtype;
  resolved_now timestamptz := timezone('utc', now());
  resolved_message text := left(coalesce(nullif(trim(p_error_message), ''),
    'Token Meta inválido; perfil removido automaticamente.'), 1200);
  ignored_count integer := 0;
  ignored_event_count integer := 0;
  cancelled_plan_count integer := 0;
  affected_batch uuid;
  incident_row public.meta_profile_disconnection_incidents%rowtype;
  app_label_snapshot text;
  views_snapshot bigint;
  views_synced_snapshot timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if nullif(trim(p_worker_id), '') is null then
    raise exception using errcode = '22023', message = 'Worker obrigatório.';
  end if;

  select item.* into source_item
  from public.publication_items item
  where item.id = p_item_id
    and item.claimed_by = trim(p_worker_id)
    and item.lease_until > resolved_now
    and item.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.';
  end if;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = source_item.profile_id
    and profile.organization_id = source_item.organization_id
  for update;
  if not found or profile_row.provider <> 'meta_official' then
    raise exception using errcode = '22023', message = 'Perfil Meta oficial ativo não encontrado.';
  end if;
  if trim(coalesce(p_error_code, '')) <> '190' then
    raise exception using errcode = '22023', message = 'Somente erro terminal Meta 190 pode remover automaticamente o perfil.';
  end if;

  if profile_row.deleted_at is not null then
    return jsonb_build_object(
      'completed', true, 'idempotent', true, 'profileId', profile_row.id,
      'ignoredItemCount', 0, 'cancelledPlanCount', 0
    );
  end if;

  with targets as (
    select item.id, item.status as previous_status
    from public.publication_items item
    where item.organization_id = profile_row.organization_id
      and item.profile_id = profile_row.id
      and item.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
      and item.meta_media_id is null
      and item.published_at is null
    for update
  ), ignored as (
    update public.publication_items item set
      status = 'ignored', claimed_by = null, lease_until = null,
      next_attempt_at = null,
      attempt_count = case
        when item.id = source_item.id and item.active_claim_consumed_attempt
          then greatest(item.attempt_count - 1, 0)
        else item.attempt_count
      end,
      active_claim_consumed_attempt = false,
      last_error_code = 'meta_profile_disconnected',
      last_error_message = 'Perfil Meta desconectado; publicação ignorada.'
    from targets
    where item.id = targets.id
    returning item.id, targets.previous_status
  ), events as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select profile_row.organization_id, ignored.id, 'ignored',
      ignored.previous_status, 'ignored', 'system: meta-profile-disconnection',
      'meta_profile_disconnected', 'Perfil Meta desconectado; publicação ignorada.',
      jsonb_build_object(
        'profile_id', profile_row.id,
        'source_item_id', source_item.id,
        'provider_error_code', left(trim(p_error_code), 120),
        'provider_error_subcode', p_error_subcode
      )
    from ignored
    returning publication_item_id
  )
  select
    (select count(*)::integer from ignored),
    (select count(*)::integer from events)
  into ignored_count, ignored_event_count;

  if ignored_count <> ignored_event_count then
    raise exception using errcode = 'P0001', message = 'Falha ao auditar publicações Meta ignoradas.';
  end if;

  delete from public.publication_profile_daily_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = profile_row.organization_id
    and item.profile_id = profile_row.id
    and item.status = 'ignored';

  delete from public.publication_dispatch_rate_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = profile_row.organization_id
    and item.profile_id = profile_row.id
    and item.status = 'ignored';

  update public.bulk_publication_generation_chunks chunk set
    status = 'cancelled', completed_at = coalesce(completed_at, resolved_now),
    claimed_by = null, lease_until = null,
    last_error_message = 'Perfil Meta desconectado; geração cancelada.'
  where chunk.organization_id = profile_row.organization_id
    and chunk.profile_id = profile_row.id
    and chunk.status in ('queued', 'processing', 'failed', 'paused');

  update public.bulk_publication_profile_horizons horizon set
    status = 'cancelled', released_at = coalesce(released_at, resolved_now)
  where horizon.organization_id = profile_row.organization_id
    and horizon.profile_id = profile_row.id
    and horizon.status = 'active';

  with cancelled_plans as (
    update public.bulk_publication_plan_profiles plan_profile set
      status = 'cancelled', suspended_at = coalesce(suspended_at, resolved_now),
      suspension_reason = 'Perfil Meta desconectado; removido automaticamente.'
    where plan_profile.organization_id = profile_row.organization_id
      and plan_profile.profile_id = profile_row.id
      and plan_profile.status in ('queued', 'generating', 'suspended')
    returning plan_profile.id
  ) select count(*)::integer into cancelled_plan_count from cancelled_plans;

  -- O INCIDENTE E OS EVENTOS DE GRUPO SAO GRAVADOS ANTES DO DELETE, e a ordem
  -- nao e estilo: depois que `profile_group_members` some, nao existe mais como
  -- saber de quais grupos o perfil saiu. Foi por isso que a Zernio precisou de
  -- tabela de evento (migration 203) -- a linha de grupo e apagada de verdade,
  -- entao o rastro tem que ser tirado antes.
  select app.label into app_label_snapshot
  from public.meta_apps app
  where app.id = profile_row.meta_app_id
    and app.organization_id = profile_row.organization_id;

  -- Snapshot das views no instante da queda. Depois disso o perfil para de
  -- sincronizar, entao o numero corrente congela num valor que nao e mais o
  -- dele -- a mesma razao da migration 183 no lado da Zernio.
  select analytics.views, analytics.current_synced_at
  into views_snapshot, views_synced_snapshot
  from public.profile_analytics_current analytics
  where analytics.organization_id = profile_row.organization_id
    and analytics.profile_id = profile_row.id
    and analytics.deleted_at is null;

  insert into public.meta_profile_disconnection_incidents (
    organization_id, profile_id, meta_app_id, username_snapshot, meta_app_label_snapshot,
    source_item_id, source_batch_id, error_code, error_subcode, error_message,
    analytics_views_snapshot, analytics_synced_at_snapshot,
    ignored_item_count, cancelled_plan_count, finalized_at
  ) values (
    profile_row.organization_id, profile_row.id, profile_row.meta_app_id,
    profile_row.username, app_label_snapshot,
    source_item.id, source_item.batch_id,
    left(trim(p_error_code), 120), p_error_subcode, resolved_message,
    views_snapshot, views_synced_snapshot,
    ignored_count, cancelled_plan_count, resolved_now
  )
  on conflict (organization_id, profile_id) do update
    set updated_at = timezone('utc', now())
  returning * into incident_row;

  -- `counted_at` ja entra preenchido: diferente da Zernio, aqui nao ha remocao
  -- remota para esperar -- a queda e terminal no instante em que e detectada.
  insert into public.meta_group_profile_removal_events (
    organization_id, group_id, profile_id, incident_id, removal_sequence, counted_at
  )
  select
    profile_row.organization_id, member.group_id, profile_row.id, incident_row.id,
    row_number() over (order by member.group_id), resolved_now
  from public.profile_group_members member
  where member.organization_id = profile_row.organization_id
    and member.profile_id = profile_row.id
  on conflict (incident_id, removal_sequence) do nothing;

  delete from public.profile_group_members
  where organization_id = profile_row.organization_id
    and profile_id = profile_row.id;

  update public.instagram_profiles set
    deleted_at = resolved_now,
    status = 'offline',
    last_error_code = 'meta_profile_disconnected',
    last_error_message = resolved_message
  where id = profile_row.id
    and organization_id = profile_row.organization_id
    and deleted_at is null;

  perform public.soft_delete_profile_analytics(profile_row.id);

  for affected_batch in
    select distinct item.batch_id
    from public.publication_items item
    where item.organization_id = profile_row.organization_id
      and item.profile_id = profile_row.id
  loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;

  return jsonb_build_object(
    'completed', true,
    'idempotent', false,
    'profileId', profile_row.id,
    'ignoredItemCount', ignored_count,
    'cancelledPlanCount', cancelled_plan_count,
    'incidentId', incident_row.id,
    'errorCode', 'meta_profile_disconnected',
    'providerErrorCode', trim(p_error_code),
    'providerErrorSubcode', p_error_subcode
  );
end;
$$;

notify pgrst, 'reload schema';

-- Exclusão de grupo com escopo, progresso durável e relatório de erros.
--
-- Até aqui DELETE /api/groups/[groupId] só carimbava profile_groups.deleted_at.
-- Nada mais saía: profile_group_members, media_group_assignments e as próprias
-- mídias continuavam apontando para um grupo soft-deletado, e os perfis daquele
-- grupo ficavam órfãos — contados como "agrupados" pela tela, mas sem grupo
-- visível para tirá-los de lá.
--
-- Esta migração NÃO cria um pipeline de exclusão novo. As duas metades pesadas
-- já existem e são drenadas por workers que já rodam:
--
--   mídia   -> media_deletion_jobs / _items (052) -> lib/media/deletion-worker.ts
--   perfis  -> enqueue_instagram_profile_removal (342) -> incidentes/jobs de
--              reciclagem (101/127) -> processZernioProfileRecyclingJobs
--
-- O que faltava era um ORQUESTRADOR: um id de operação que amarre as duas e dê
-- a elas um denominador exato. Sem ele, o único acompanhamento disponível seria
-- /api/profiles/removal-progress, que agrega por organização numa janela de 24h
-- — duas exclusões simultâneas viram uma barra só e o denominador nunca encolhe.
--
-- Três decisões que valem registro, porque não são óbvias no código:
--
-- 1. MÍDIA COMPARTILHADA NÃO É APAGADA. media_group_assignments tem chave
--    primária (media_asset_id, group_id): a mesma mídia pode estar em vários
--    grupos. Apagar "as mídias do grupo" pelo filtro da galeria levaria junto as
--    dos outros grupos. Aqui só morre quem é exclusiva (`not exists` de outra
--    atribuição); a compartilhada apenas perde o vínculo com este grupo.
--
-- 2. O GRUPO CONTINUA COM deleted_at NULL ENQUANTO A EXCLUSÃO ANDA. O card
--    precisa aparecer marcado como "excluindo…", e sumir só quando de fato
--    acabou. O soft-delete é o último passo, no finalize.
--
-- 3. O GRUPO NUNCA É HARD-DELETADO. recovery_exclusions (347) e
--    bulk_publication_plans (084) referenciam profile_groups com `on delete
--    restrict` de propósito, para uma exclusão acidental falhar alto em vez de
--    apagar histórico em silêncio. Nada aqui fura isso.

-- Tabelas ---------------------------------------------------------------------

create table if not exists public.profile_group_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- restrict pelo mesmo motivo do resto do schema: o job é a prova de que a
  -- exclusão aconteceu, e some junto com a organização, não com o grupo.
  group_id uuid not null references public.profile_groups (id) on delete restrict,
  -- O painel precisa nomear o grupo depois que ele saiu da listagem.
  group_name_snapshot text not null check (char_length(trim(group_name_snapshot)) between 1 and 160),
  scope text not null check (scope in ('media', 'media_profiles')),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'completed_with_errors', 'failed')),
  media_deletion_job_id uuid references public.media_deletion_jobs (id) on delete set null,
  media_exclusive_total integer not null default 0 check (media_exclusive_total >= 0),
  media_detached_total integer not null default 0 check (media_detached_total >= 0),
  media_skipped_total integer not null default 0 check (media_skipped_total >= 0),
  profile_total integer not null default 0 check (profile_total >= 0),
  history_items_deleted integer not null default 0 check (history_items_deleted >= 0),
  history_purged_at timestamptz,
  last_error_message text check (char_length(coalesce(last_error_message, '')) <= 1200),
  requested_by uuid references auth.users (id) on delete set null,
  requested_by_email text check (char_length(coalesce(requested_by_email, '')) <= 320),
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default timezone('utc', now())
);

-- Snapshot dos perfis que estavam no grupo quando a exclusão começou.
--
-- É o denominador exato da metade de perfis: sem ele, depois que
-- complete_zernio_profile_recycling apaga profile_group_members, não há mais
-- como saber quantos perfis a operação tinha. Também é a lista usada na purga
-- de histórico do escopo `media_profiles`.
create table if not exists public.profile_group_deletion_job_profiles (
  job_id uuid not null references public.profile_group_deletion_jobs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- cascade nunca dispara na prática: publication_items.profile_id é `restrict`,
  -- então perfil só sai por soft-delete. Fica declarado para o schema não
  -- mentir, não porque seja um caminho esperado.
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  username_snapshot text,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (job_id, profile_id)
);

-- Um job ativo por grupo. Dois cliques no botão não podem virar duas operações
-- concorrentes sobre as mesmas mídias.
create unique index if not exists profile_group_deletion_jobs_active_unique
  on public.profile_group_deletion_jobs (group_id)
  where status in ('pending', 'processing');

create index if not exists profile_group_deletion_jobs_org_status_idx
  on public.profile_group_deletion_jobs (organization_id, status, created_at desc);

create index if not exists profile_group_deletion_job_profiles_profile_idx
  on public.profile_group_deletion_job_profiles (organization_id, profile_id);

drop trigger if exists profile_group_deletion_jobs_set_updated_at on public.profile_group_deletion_jobs;
create trigger profile_group_deletion_jobs_set_updated_at
before update on public.profile_group_deletion_jobs
for each row execute function public.set_updated_at();

-- RLS: mesma política de media_deletion_jobs (052). É ela que permite a tela
-- acompanhar o progresso com o cliente do usuário, sem subir para admin.
alter table public.profile_group_deletion_jobs enable row level security;
alter table public.profile_group_deletion_job_profiles enable row level security;

drop policy if exists profile_group_deletion_jobs_select_member on public.profile_group_deletion_jobs;
create policy profile_group_deletion_jobs_select_member
on public.profile_group_deletion_jobs for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists profile_group_deletion_job_profiles_select_member on public.profile_group_deletion_job_profiles;
create policy profile_group_deletion_job_profiles_select_member
on public.profile_group_deletion_job_profiles for select to authenticated
using (public.is_organization_member(organization_id));

revoke all on table public.profile_group_deletion_jobs, public.profile_group_deletion_job_profiles from anon;
grant select on table public.profile_group_deletion_jobs, public.profile_group_deletion_job_profiles to authenticated;
grant select, insert, update, delete
  on table public.profile_group_deletion_jobs, public.profile_group_deletion_job_profiles to service_role;

-- Dry-run do modal ------------------------------------------------------------
--
-- Sem mutação. Devolve os números que a confirmação precisa mostrar ANTES de
-- alguém digitar EXCLUIR. Os pares `_media` / `_total` existem porque o mesmo
-- item de publicação pode ser atingido pelos dois lados (a mídia e o perfil):
-- somar os dois contaria duas vezes. `_media` é o escopo A; `_total` é o B.

create or replace function public.preview_profile_group_deletion(
  p_organization_id uuid,
  p_group_id uuid
)
returns table (
  profile_total integer,
  zernio_count integer,
  meta_count integer,
  already_queued integer,
  connection_labels text[],
  media_exclusive integer,
  media_shared integer,
  media_in_active_plan integer,
  scheduled_items_media integer,
  scheduled_items_total integer,
  history_items_media integer,
  history_items_total integer,
  active_plan_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  with allowed as (
    select coalesce(auth.role(), '') = 'service_role'
      or public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) as ok
  ),
  target_group as (
    select group_row.id
    from public.profile_groups group_row
    cross join allowed
    where allowed.ok
      and group_row.id = p_group_id
      and group_row.organization_id = p_organization_id
      and group_row.deleted_at is null
  ),
  members as (
    select profile.id
    from public.profile_group_members membership
    join target_group on target_group.id = membership.group_id
    join public.instagram_profiles profile
      on profile.id = membership.profile_id
      and profile.organization_id = p_organization_id
      and profile.deleted_at is null
    where membership.organization_id = p_organization_id
  ),
  -- Reaproveita o dry-run de /perfis em vez de recontar: é a mesma pergunta,
  -- e `pending_item_count` já é exatamente "quantos posts agendados caem".
  profile_preview as (
    select *
    from public.preview_instagram_profile_removal(
      p_organization_id,
      (select coalesce(array_agg(id), array[]::uuid[]) from members)
    )
  ),
  group_media as (
    select
      asset.id,
      not exists (
        select 1
        from public.media_group_assignments other
        where other.media_asset_id = asset.id
          and other.group_id <> p_group_id
      ) as exclusive
    from public.media_group_assignments mine
    join target_group on target_group.id = mine.group_id
    join public.media_assets asset
      on asset.id = mine.media_asset_id
      and asset.organization_id = p_organization_id
      and asset.deleted_at is null
    where mine.organization_id = p_organization_id
  ),
  -- A checagem de plano ativo fica NUMA CTE SEPARADA, aplicada so as exclusivas.
  -- media_asset_is_in_active_generation_job (358) expande jsonb dos planos por
  -- ativo; rodar isso na midia compartilhada, que nem candidata a exclusao e,
  -- seria trabalho jogado fora num dry-run que roda ao abrir o modal.
  exclusive_media as (
    select
      id,
      public.media_asset_is_in_active_generation_job(p_organization_id, id) as in_active_plan
    from group_media
    where exclusive
  ),
  deletable_media as (
    select id from exclusive_media where not in_active_plan
  ),
  media_item_ids as (
    select distinct link.publication_item_id as id
    from public.publication_item_media link
    join deletable_media on deletable_media.id = link.media_asset_id
    where link.organization_id = p_organization_id
  ),
  profile_item_ids as (
    select item.id
    from public.publication_items item
    join members on members.id = item.profile_id
    where item.organization_id = p_organization_id
  ),
  all_item_ids as (
    select id from media_item_ids union select id from profile_item_ids
  ),
  live_statuses as (
    select unnest(array['waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended']) as status
  )
  select
    coalesce((select preview.total from profile_preview preview), 0),
    coalesce((select preview.zernio_count from profile_preview preview), 0),
    coalesce((select preview.meta_count from profile_preview preview), 0),
    coalesce((select preview.already_queued from profile_preview preview), 0),
    coalesce((select preview.connection_labels from profile_preview preview), array[]::text[]),
    (select count(*)::integer from deletable_media),
    (select count(*)::integer from group_media where not exclusive),
    (select count(*)::integer from exclusive_media where in_active_plan),
    (select count(*)::integer from public.publication_items item
      where item.id in (select id from media_item_ids)
        and item.status::text in (select status from live_statuses)),
    (select count(*)::integer from public.publication_items item
      where item.id in (select id from all_item_ids)
        and item.status::text in (select status from live_statuses)),
    (select count(*)::integer from media_item_ids),
    (select count(*)::integer from all_item_ids),
    (select count(*)::integer from public.bulk_publication_plans plan
      where plan.organization_id = p_organization_id
        and plan.origin_group_id = p_group_id
        and plan.status in ('queued', 'generating', 'paused'));
$$;

revoke all on function public.preview_profile_group_deletion(uuid, uuid) from public, anon;
grant execute on function public.preview_profile_group_deletion(uuid, uuid) to authenticated, service_role;

-- Abertura da operação --------------------------------------------------------

create or replace function public.start_profile_group_deletion(
  p_organization_id uuid,
  p_group_id uuid,
  p_scope text,
  p_actor_label text default 'operator: /grupos'
)
returns table (job_id uuid, group_name text, profile_total integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  group_row public.profile_groups%rowtype;
  new_job public.profile_group_deletion_jobs%rowtype;
  scope_value text := case when p_scope = 'media_profiles' then 'media_profiles' else 'media' end;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Somente administradores e operadores podem excluir grupos.';
  end if;

  -- `for update` porque duas abas clicando juntas precisam serializar aqui, e
  -- nao no indice parcial: o erro de unicidade e a rede de seguranca, nao o
  -- mecanismo.
  select * into group_row
  from public.profile_groups
  where id = p_group_id
    and organization_id = p_organization_id
    and deleted_at is null
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Grupo não encontrado ou já excluído.';
  end if;

  insert into public.profile_group_deletion_jobs (
    organization_id, group_id, group_name_snapshot, scope, status,
    requested_by, requested_by_email, started_at
  ) values (
    p_organization_id, group_row.id, group_row.name, scope_value, 'processing',
    auth.uid(), nullif(auth.jwt() ->> 'email', ''), timezone('utc', now())
  )
  returning * into new_job;

  -- O snapshot e gravado nos DOIS escopos. No escopo `media` os perfis nao sao
  -- excluidos, mas o finalize precisa saber quais vinculos desfazer, e o
  -- relatorio precisa dizer quantos perfis ficaram sem grupo.
  insert into public.profile_group_deletion_job_profiles (
    job_id, organization_id, profile_id, username_snapshot
  )
  select new_job.id, p_organization_id, profile.id, profile.username
  from public.profile_group_members membership
  join public.instagram_profiles profile
    on profile.id = membership.profile_id
    and profile.organization_id = p_organization_id
    and profile.deleted_at is null
  where membership.organization_id = p_organization_id
    and membership.group_id = p_group_id;

  update public.profile_group_deletion_jobs
  set profile_total = (
    select count(*)::integer
    from public.profile_group_deletion_job_profiles snapshot
    where snapshot.job_id = new_job.id
  )
  where id = new_job.id
  returning * into new_job;

  job_id := new_job.id;
  group_name := group_row.name;
  profile_total := new_job.profile_total;
  return next;
end;
$$;

revoke all on function public.start_profile_group_deletion(uuid, uuid, text, text) from public, anon;
grant execute on function public.start_profile_group_deletion(uuid, uuid, text, text) to authenticated, service_role;

-- Metade da midia -------------------------------------------------------------
--
-- Espelha create_media_deletion_job (052), trocando a lista de ids por uma
-- selecao: so as midias EXCLUSIVAS deste grupo. `security definer` e obrigatorio
-- porque media_asset_is_in_active_generation_job so tem execute para
-- service_role (066).

create or replace function public.create_group_media_deletion_job(
  p_organization_id uuid,
  p_group_id uuid,
  p_deletion_job_id uuid
)
returns table (media_job_id uuid, exclusive_total integer, skipped_total integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  new_job public.media_deletion_jobs%rowtype;
  request_time timestamptz := timezone('utc', now());
  skipped integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  insert into public.media_deletion_jobs (organization_id, requested_by, requested_by_email, status)
  values (p_organization_id, auth.uid(), nullif(auth.jwt() ->> 'email', ''), 'pending')
  returning * into new_job;

  insert into public.media_deletion_job_items (job_id, organization_id, media_asset_id)
  select new_job.id, p_organization_id, asset.id
  from public.media_group_assignments mine
  join public.media_assets asset
    on asset.id = mine.media_asset_id
    and asset.organization_id = p_organization_id
    and asset.deleted_at is null
    and asset.deletion_requested_at is null
  where mine.organization_id = p_organization_id
    and mine.group_id = p_group_id
    and not exists (
      select 1
      from public.media_group_assignments other
      where other.media_asset_id = asset.id
        and other.group_id <> p_group_id
    )
    and not public.media_asset_is_in_active_generation_job(p_organization_id, asset.id);

  -- Midia exclusiva que ficou de fora por estar presa num plano de agendamento
  -- ainda ativo, ou por ja ter exclusao pedida. Contada a parte porque o painel
  -- precisa dizer o motivo: uma exclusao que deixa midia para tras em silencio
  -- parece completa.
  select count(*)::integer into skipped
  from public.media_group_assignments mine
  join public.media_assets asset
    on asset.id = mine.media_asset_id
    and asset.organization_id = p_organization_id
    and asset.deleted_at is null
  where mine.organization_id = p_organization_id
    and mine.group_id = p_group_id
    and not exists (
      select 1
      from public.media_group_assignments other
      where other.media_asset_id = asset.id
        and other.group_id <> p_group_id
    )
    and not exists (
      select 1
      from public.media_deletion_job_items item
      where item.job_id = new_job.id
        and item.media_asset_id = asset.id
    );

  update public.media_assets asset
  set deletion_requested_at = request_time,
      deletion_requested_by = auth.uid()
  where asset.organization_id = p_organization_id
    and asset.deleted_at is null
    and asset.deletion_requested_at is null
    and asset.id in (
      select item.media_asset_id
      from public.media_deletion_job_items item
      where item.job_id = new_job.id
    );

  update public.media_deletion_jobs job
  set total_count = (
        select count(*)::integer
        from public.media_deletion_job_items item
        where item.job_id = new_job.id
      ),
      status = case when exists (
        select 1 from public.media_deletion_job_items item where item.job_id = new_job.id
      ) then 'pending' else 'completed' end,
      finished_at = case when exists (
        select 1 from public.media_deletion_job_items item where item.job_id = new_job.id
      ) then null else request_time end
  where job.id = new_job.id
  returning job.* into new_job;

  update public.profile_group_deletion_jobs
  set media_deletion_job_id = new_job.id,
      media_exclusive_total = new_job.total_count,
      media_skipped_total = skipped
  where id = p_deletion_job_id
    and organization_id = p_organization_id;

  media_job_id := new_job.id;
  exclusive_total := new_job.total_count;
  skipped_total := skipped;
  return next;
end;
$$;

revoke all on function public.create_group_media_deletion_job(uuid, uuid, uuid) from public, anon;
grant execute on function public.create_group_media_deletion_job(uuid, uuid, uuid) to authenticated, service_role;

-- Midia compartilhada: so perde o vinculo -------------------------------------

create or replace function public.detach_shared_group_media(
  p_organization_id uuid,
  p_group_id uuid,
  p_deletion_job_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  detached integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  with removed as (
    delete from public.media_group_assignments assignment
    where assignment.organization_id = p_organization_id
      and assignment.group_id = p_group_id
      and exists (
        select 1
        from public.media_group_assignments other
        where other.media_asset_id = assignment.media_asset_id
          and other.group_id <> p_group_id
      )
    returning assignment.media_asset_id
  )
  select count(*)::integer into detached from removed;

  update public.profile_group_deletion_jobs
  set media_detached_total = detached
  where id = p_deletion_job_id
    and organization_id = p_organization_id;

  return detached;
end;
$$;

revoke all on function public.detach_shared_group_media(uuid, uuid, uuid) from public, anon;
grant execute on function public.detach_shared_group_media(uuid, uuid, uuid) to authenticated, service_role;

-- Purga do historico ----------------------------------------------------------
--
-- FATIADA, e isso nao e opcional. A licao das migrations 323/324 vale igual
-- aqui: uma mutacao em massa sobre publication_items aborta no statement_timeout
-- de ~8s, e "a unica forma de fazer mais trabalho do que cabe em 8s e dividir em
-- varias chamadas separadas, cada uma com seu proprio orcamento de tempo".
--
-- Nenhuma FK que aponta para publication_items e `restrict` (todas sao cascade
-- ou set null), entao o delete nao trava. publication_item_media.media_asset_id
-- e restrict, mas aponta para media_assets, que so e soft-deletada.

create or replace function public.purge_group_publication_history(
  p_job_id uuid,
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.profile_group_deletion_jobs%rowtype;
  removed_count integer := 0;
  batch_ids uuid[];
  affected_batch uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not exists (
      select 1 from public.profile_group_deletion_jobs job
      where job.id = p_job_id
        and public.has_organization_role(job.organization_id, array['admin', 'operator']::public.organization_role[])
    ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  select * into job_row from public.profile_group_deletion_jobs where id = p_job_id;
  if not found then
    return 0;
  end if;

  with victims as (
    select item.id, item.batch_id
    from public.publication_items item
    where item.organization_id = job_row.organization_id
      and (
        exists (
          select 1
          from public.publication_item_media link
          join public.media_deletion_job_items media_item
            on media_item.media_asset_id = link.media_asset_id
            and media_item.job_id = job_row.media_deletion_job_id
          where link.publication_item_id = item.id
        )
        or (
          job_row.scope = 'media_profiles'
          and exists (
            select 1
            from public.profile_group_deletion_job_profiles snapshot
            where snapshot.job_id = job_row.id
              and snapshot.profile_id = item.profile_id
          )
        )
      )
    limit greatest(1, least(coalesce(p_limit, 500), 2000))
  ), removed as (
    delete from public.publication_items item
    using victims
    where item.id = victims.id
    returning victims.batch_id as batch_id
  )
  select count(*)::integer, array_agg(distinct removed.batch_id)
  into removed_count, batch_ids
  from removed;

  if batch_ids is not null then
    foreach affected_batch in array batch_ids loop
      perform public.sync_publication_batch_status(affected_batch);
    end loop;
  end if;

  if removed_count > 0 then
    update public.profile_group_deletion_jobs
    set history_items_deleted = history_items_deleted + removed_count
    where id = p_job_id;
  end if;

  return removed_count;
end;
$$;

revoke all on function public.purge_group_publication_history(uuid, integer) from public, anon;
grant execute on function public.purge_group_publication_history(uuid, integer) to authenticated, service_role;

-- Fechamento ------------------------------------------------------------------
--
-- Idempotente e resumivel. Chamado de dois lugares, os dois de proposito:
--
--   /api/internal/media-deletion-dispatch  a cada ciclo do worker de midia, que
--     e quem termina a metade de midia. Cobre quem fechou a aba.
--   GET /api/groups/deletion-jobs          a cada poll da tela. Quem esta
--     olhando ve o job fechar na hora, sem esperar o worker.
--
-- A purga anda UMA rodada de fatias por chamada, nao ate o fim: um grupo grande
-- estouraria o orcamento de tempo de quem chamou. O job so fecha quando a fatia
-- volta vazia.

create or replace function public.finalize_profile_group_deletion_jobs(
  p_organization_id uuid default null,
  p_history_slices integer default 10
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.profile_group_deletion_jobs%rowtype;
  media_status text;
  pending_profiles integer;
  failed_media integer;
  failed_profiles integer;
  purged integer;
  slice integer;
  closed integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and (p_organization_id is null
      or not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[])) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  for job_row in
    select *
    from public.profile_group_deletion_jobs
    where status = 'processing'
      and (p_organization_id is null or organization_id = p_organization_id)
    order by created_at
    for update skip locked
  loop
    -- Metade da midia: ainda drenando?
    if job_row.media_deletion_job_id is not null then
      select job.status into media_status
      from public.media_deletion_jobs job
      where job.id = job_row.media_deletion_job_id;

      if coalesce(media_status, 'completed') not in
        ('completed', 'completed_with_errors', 'failed', 'cancelled') then
        continue;
      end if;
    end if;

    -- Metade dos perfis: algum incidente ainda vivo?
    if job_row.scope = 'media_profiles' then
      select count(*)::integer into pending_profiles
      from public.profile_group_deletion_job_profiles snapshot
      join public.zernio_profile_disconnection_incidents incident
        on incident.organization_id = snapshot.organization_id
        and incident.profile_id = snapshot.profile_id
      where snapshot.job_id = job_row.id
        and incident.state in ('remote_removal_pending', 'retry_scheduled', 'deferred');

      if pending_profiles > 0 then
        continue;
      end if;
    end if;

    -- Historico, uma rodada de fatias por chamada.
    if job_row.history_purged_at is null then
      purged := null;
      for slice in 1..greatest(1, least(coalesce(p_history_slices, 10), 40)) loop
        purged := public.purge_group_publication_history(job_row.id, 500);
        exit when purged = 0;
      end loop;

      if coalesce(purged, 0) > 0 then
        -- Ainda ha o que apagar: volta na proxima chamada.
        continue;
      end if;

      update public.profile_group_deletion_jobs
      set history_purged_at = timezone('utc', now())
      where id = job_row.id;
    end if;

    -- Perfis que sobreviveram ficam sem grupo. No escopo `media_profiles` o
    -- complete_zernio_profile_recycling ja apagou os vinculos um a um; esta
    -- linha e a limpeza do que restou.
    delete from public.profile_group_members
    where organization_id = job_row.organization_id
      and group_id = job_row.group_id;

    update public.profile_groups
    set deleted_at = timezone('utc', now())
    where id = job_row.group_id
      and organization_id = job_row.organization_id
      and deleted_at is null;

    select coalesce(job.failed_count, 0) into failed_media
    from public.media_deletion_jobs job
    where job.id = job_row.media_deletion_job_id;

    select count(*)::integer into failed_profiles
    from public.profile_group_deletion_job_profiles snapshot
    join public.zernio_profile_disconnection_incidents incident
      on incident.organization_id = snapshot.organization_id
      and incident.profile_id = snapshot.profile_id
    where snapshot.job_id = job_row.id
      and incident.state = 'dead_letter';

    update public.profile_group_deletion_jobs
    set status = case
          when coalesce(failed_media, 0) + coalesce(failed_profiles, 0) > 0
          then 'completed_with_errors'
          else 'completed'
        end,
        finished_at = timezone('utc', now())
    where id = job_row.id;

    closed := closed + 1;
  end loop;

  return closed;
end;
$$;

revoke all on function public.finalize_profile_group_deletion_jobs(uuid, integer) from public, anon;
grant execute on function public.finalize_profile_group_deletion_jobs(uuid, integer) to authenticated, service_role;

-- Retry de perfil em dead-letter ----------------------------------------------
--
-- O evento `reopened` ja existe no vocabulario de
-- zernio_profile_recycling_job_events desde a migration 127; faltava o caminho
-- que o dispara a pedido de uma pessoa. Sem isto, "tentar novamente" nao teria o
-- que fazer com um perfil terminal: o job so sai de dead_letter por script.

create or replace function public.reopen_zernio_profile_recycling_job(
  p_organization_id uuid,
  p_incident_id uuid,
  p_reason text default 'Retomada pedida pelo operador na exclusão do grupo.'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  job_row public.zernio_profile_recycling_jobs%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  select job.* into job_row
  from public.zernio_profile_recycling_jobs job
  join public.zernio_profile_disconnection_incidents incident on incident.id = job.incident_id
  where job.incident_id = p_incident_id
    and incident.organization_id = p_organization_id
    and job.status = 'dead_letter'
  for update;

  if not found then
    return false;
  end if;

  update public.zernio_profile_recycling_jobs
  set status = 'pending',
      attempt_count = 0,
      next_attempt_at = timezone('utc', now()),
      claimed_by = null,
      lease_until = null,
      dead_letter_at = null,
      deferred_reason = null,
      reopened_count = reopened_count + 1
  where id = job_row.id;

  update public.zernio_profile_disconnection_incidents
  set state = 'remote_removal_pending',
      defer_reason = null,
      finalized_at = null,
      reopened_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = p_incident_id;

  insert into public.zernio_profile_recycling_job_events (
    organization_id, job_id, incident_id, event_type,
    previous_status, status, attempt_count, reason
  ) values (
    p_organization_id, job_row.id, p_incident_id, 'reopened',
    'dead_letter', 'pending', 0, left(coalesce(nullif(trim(p_reason), ''), 'Retomada pedida pelo operador.'), 1200)
  );

  return true;
end;
$$;

revoke all on function public.reopen_zernio_profile_recycling_job(uuid, uuid, text) from public, anon;
grant execute on function public.reopen_zernio_profile_recycling_job(uuid, uuid, text) to authenticated, service_role;

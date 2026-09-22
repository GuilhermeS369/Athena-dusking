-- 438 — Meta `9` "User is performing too many actions": cancela os REELS do perfil,
-- deixa o lote seguir e avisa na Fila.
--
-- O QUE ACONTECEU. Em 21/09/2026 a Meta devolveu `9` para 848 reels de 189 perfis em
-- 3 lotes da mesma organizacao (CAI MANOOOO 05h, CAI LOGO 06h, CAI MANO 12h BRT).
-- O codigo nao conhecia o erro: `failed` na 1a tentativa, e 5 seguidas pausavam o
-- LOTE INTEIRO pelo disjuntor. O CAI MANO pausou as 12:16 BRT e 2.971 posts venceram
-- sem nenhuma tentativa.
--
-- O QUE O ERRO E. Bloqueio TEMPORARIO de acao da conta, nao queda: os 189 perfis
-- seguiram `online` e todos voltaram a publicar reel sozinhos (mediana de 3 h 18 min,
-- p90 de 4 h 07 min depois do ultimo erro). Nao e o `190`/`25` (seções 5 e 6.1 do
-- mestre), que removem o perfil.
--
-- DECISAO DO DONO (21/09/2026): quando aparecer "too many actions", cancelar a fila
-- inteira de reels SO daquele perfil; os outros perfis do lote seguem; a Fila mostra
-- a lista de perfis (grupo e lote) com um botao de limpar o aviso, para saber que o
-- perfil so precisa de um intervalo. Limpar nao recria nada: cancelado fica cancelado.
--
-- Nenhuma coluna nem gatilho novo em publication_items; claim_publication_items
-- intocada. A RPC nova so roda quando o erro acontece.

set lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 1. Aviso por perfil
-- ---------------------------------------------------------------------------

create table if not exists public.meta_profile_action_blocks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete cascade,
  username_snapshot text,
  -- Snapshot: o operador pode mudar o perfil de grupo depois, e o aviso tem de
  -- dizer onde ele estava quando a Meta o limitou.
  group_ids uuid[] not null default '{}',
  group_names text[] not null default '{}',
  source_item_id uuid,
  source_batch_id uuid,
  batch_name_snapshot text,
  error_code text,
  error_subcode integer,
  error_message text,
  first_detected_at timestamptz not null default timezone('utc', now()),
  last_detected_at timestamptz not null default timezone('utc', now()),
  occurrences integer not null default 1,
  cancelled_reel_count integer not null default 0,
  cancelled_batch_names text[] not null default '{}',
  cleared_at timestamptz,
  cleared_by uuid,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

comment on table public.meta_profile_action_blocks is
  '438: perfis que receberam da Meta o erro 9 "User is performing too many actions". Uma linha aberta por perfil (cleared_at null); repeticoes antes da limpeza somam na mesma linha. Limpar so tira o aviso da Fila.';

-- Uma linha aberta por perfil: dois publicadores batendo no mesmo perfil somam.
create unique index if not exists meta_profile_action_blocks_open_profile_idx
  on public.meta_profile_action_blocks (profile_id)
  where cleared_at is null;

create index if not exists meta_profile_action_blocks_open_org_idx
  on public.meta_profile_action_blocks (organization_id, last_detected_at desc)
  where cleared_at is null;

drop trigger if exists meta_profile_action_blocks_set_updated_at on public.meta_profile_action_blocks;
create trigger meta_profile_action_blocks_set_updated_at
before update on public.meta_profile_action_blocks
for each row execute function public.set_updated_at();

alter table public.meta_profile_action_blocks enable row level security;

drop policy if exists meta_profile_action_blocks_select_member on public.meta_profile_action_blocks;
create policy meta_profile_action_blocks_select_member
  on public.meta_profile_action_blocks for select to authenticated
  using (public.is_organization_member(organization_id));

revoke all on public.meta_profile_action_blocks from public, anon, authenticated;
grant select on public.meta_profile_action_blocks to authenticated;
grant all on public.meta_profile_action_blocks to service_role;

-- ---------------------------------------------------------------------------
-- 2. O worker: cancela os reels do perfil e registra o aviso
-- ---------------------------------------------------------------------------

create or replace function public.cancel_meta_action_blocked_profile_reels(
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
  resolved_now timestamptz := timezone('utc', now());
  cancel_code constant text := 'meta_action_blocked';
  cancel_message constant text := 'Meta limitou as ações da conta; reels do perfil cancelados.';
  source_item public.publication_items%rowtype;
  profile_row public.instagram_profiles%rowtype;
  resolved_provider_message text := left(coalesce(nullif(trim(p_error_message), ''),
    'User is performing too many actions'), 1200);
  cancelled_count integer := 0;
  cancelled_event_count integer := 0;
  cancelled_batches uuid[] := '{}';
  cancelled_names text[] := '{}';
  source_batch_name text;
  snapshot_group_ids uuid[];
  snapshot_group_names text[];
  block_row public.meta_profile_action_blocks%rowtype;
  affected_batch uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if nullif(trim(p_worker_id), '') is null then
    raise exception using errcode = '22023', message = 'Worker obrigatório.';
  end if;
  if trim(coalesce(p_error_code, '')) <> '9'
    and coalesce(p_error_message, '') not ilike '%performing too many actions%' then
    raise exception using errcode = '22023', message = 'Somente o erro Meta 9 (too many actions) cancela os reels do perfil.';
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

  -- Trava o perfil: dois publicadores com o mesmo perfil em voo entram em fila aqui
  -- e o segundo so soma na linha aberta.
  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = source_item.profile_id
    and profile.organization_id = source_item.organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Perfil do item não encontrado.';
  end if;

  -- O item de origem (qualquer formato) + os reels abertos do perfil. Fica de fora o
  -- que ja tem conteiner na Meta (pode publicar) e o que outro publicador tem sob
  -- lease vigente (termina sozinho; se der 9 tambem, chama esta mesma funcao).
  with targets as (
    select item.id, item.status as previous_status, item.batch_id
    from public.publication_items item
    where item.organization_id = profile_row.organization_id
      and item.profile_id = profile_row.id
      and item.archived_at is null
      and (
        item.id = source_item.id
        or (
          item.format = 'reel'
          and item.status in ('waiting', 'ready', 'failed', 'suspended')
          and item.creation_id is null
          and item.meta_media_id is null
          and item.published_at is null
          and (item.lease_until is null or item.lease_until <= resolved_now)
        )
      )
    for update of item skip locked
  ), cancelled as (
    update public.publication_items item set
      status = 'cancelled',
      cancelled_at = resolved_now,
      next_attempt_at = null,
      claimed_by = null,
      lease_until = null,
      creation_id = case when item.id = source_item.id then item.creation_id else null end,
      attempt_count = case
        when item.id = source_item.id and item.active_claim_consumed_attempt
          then greatest(item.attempt_count - 1, 0)
        else item.attempt_count
      end,
      active_claim_consumed_attempt = false,
      last_error_code = cancel_code,
      last_error_message = cancel_message
    from targets
    where item.id = targets.id
    returning item.id, targets.previous_status, item.batch_id
  ), events as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select profile_row.organization_id, cancelled.id, 'cancelled',
      cancelled.previous_status, 'cancelled', 'system: meta-action-block',
      cancel_code, cancel_message,
      jsonb_build_object(
        'profile_id', profile_row.id,
        'source_item_id', source_item.id,
        'provider_error_code', left(trim(coalesce(p_error_code, '')), 120),
        'provider_error_subcode', p_error_subcode,
        'provider_error_message', left(resolved_provider_message, 300)
      )
    from cancelled
    returning publication_item_id
  )
  select
    (select count(*)::integer from cancelled),
    (select count(*)::integer from events),
    coalesce((select array_agg(distinct batch_id) from cancelled), '{}')
  into cancelled_count, cancelled_event_count, cancelled_batches;

  if cancelled_count <> cancelled_event_count then
    raise exception using errcode = 'P0001', message = 'Falha ao auditar reels cancelados por limite de ações.';
  end if;

  delete from public.publication_profile_daily_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = profile_row.organization_id
    and item.profile_id = profile_row.id
    and item.status = 'cancelled'
    and item.last_error_code = cancel_code;

  delete from public.publication_dispatch_rate_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.organization_id = profile_row.organization_id
    and item.profile_id = profile_row.id
    and item.status = 'cancelled'
    and item.last_error_code = cancel_code;

  -- Planos de REEL param de gerar para este perfil (sem isto o gerador criaria reels
  -- novos logo em seguida). Planos de story do perfil seguem.
  update public.bulk_publication_generation_chunks chunk set
    status = 'cancelled', completed_at = coalesce(chunk.completed_at, resolved_now),
    claimed_by = null, lease_until = null,
    last_error_message = 'Meta limitou as ações da conta; geração de reels cancelada.'
  from public.bulk_publication_plans plan
  where plan.id = chunk.plan_id
    and plan.format = 'reel'
    and chunk.organization_id = profile_row.organization_id
    and chunk.profile_id = profile_row.id
    and chunk.status in ('queued', 'processing', 'failed', 'paused');

  update public.bulk_publication_profile_horizons horizon set
    status = 'cancelled', released_at = coalesce(horizon.released_at, resolved_now)
  from public.bulk_publication_plans plan
  where plan.id = horizon.plan_id
    and plan.format = 'reel'
    and horizon.organization_id = profile_row.organization_id
    and horizon.profile_id = profile_row.id
    and horizon.status = 'active';

  update public.bulk_publication_plan_profiles plan_profile set
    status = 'cancelled', suspended_at = coalesce(plan_profile.suspended_at, resolved_now),
    suspension_reason = 'Meta limitou as ações da conta (erro 9); reels do perfil cancelados.'
  from public.bulk_publication_plans plan
  where plan.id = plan_profile.plan_id
    and plan.format = 'reel'
    and plan_profile.organization_id = profile_row.organization_id
    and plan_profile.profile_id = profile_row.id
    and plan_profile.status in ('queued', 'generating', 'suspended');

  -- Snapshots do aviso.
  select coalesce(plan.name, batch.name, 'Sem campanha') into source_batch_name
  from public.publication_batches batch
  left join public.bulk_publication_plans plan on plan.batch_id = batch.id
  where batch.id = source_item.batch_id;

  select coalesce(array_agg(grp.id order by grp.name), '{}'),
         coalesce(array_agg(grp.name order by grp.name), '{}')
  into snapshot_group_ids, snapshot_group_names
  from public.profile_group_members member
  join public.profile_groups grp on grp.id = member.group_id and grp.deleted_at is null
  where member.organization_id = profile_row.organization_id
    and member.profile_id = profile_row.id;

  select coalesce(array_agg(distinct coalesce(plan.name, batch.name, 'Sem campanha')), '{}')
  into cancelled_names
  from unnest(cancelled_batches) as affected(batch_id)
  join public.publication_batches batch on batch.id = affected.batch_id
  left join public.bulk_publication_plans plan on plan.batch_id = batch.id;

  update public.meta_profile_action_blocks block set
    last_detected_at = resolved_now,
    occurrences = block.occurrences + 1,
    cancelled_reel_count = block.cancelled_reel_count + cancelled_count,
    cancelled_batch_names = (
      select coalesce(array_agg(distinct name order by name), '{}')
      from unnest(block.cancelled_batch_names || cancelled_names) as merged(name)
    ),
    username_snapshot = coalesce(profile_row.username, block.username_snapshot),
    group_ids = snapshot_group_ids,
    group_names = snapshot_group_names,
    error_code = left(trim(coalesce(p_error_code, '')), 120),
    error_subcode = p_error_subcode,
    error_message = resolved_provider_message
  where block.profile_id = profile_row.id
    and block.cleared_at is null
  returning block.* into block_row;

  if block_row.id is null then
    insert into public.meta_profile_action_blocks (
      organization_id, profile_id, username_snapshot, group_ids, group_names,
      source_item_id, source_batch_id, batch_name_snapshot, error_code, error_subcode,
      error_message, first_detected_at, last_detected_at, occurrences,
      cancelled_reel_count, cancelled_batch_names
    ) values (
      profile_row.organization_id, profile_row.id, profile_row.username,
      snapshot_group_ids, snapshot_group_names,
      source_item.id, source_item.batch_id, source_batch_name,
      left(trim(coalesce(p_error_code, '')), 120), p_error_subcode, resolved_provider_message,
      resolved_now, resolved_now, 1, cancelled_count, cancelled_names
    )
    returning * into block_row;
  end if;

  foreach affected_batch in array cancelled_batches loop
    perform public.sync_publication_batch_status(affected_batch);
  end loop;

  return jsonb_build_object(
    'completed', true,
    'profileId', profile_row.id,
    'cancelledReels', cancelled_count,
    'batches', to_jsonb(cancelled_names),
    'blockId', block_row.id,
    'occurrences', block_row.occurrences
  );
end;
$$;

revoke all on function public.cancel_meta_action_blocked_profile_reels(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.cancel_meta_action_blocked_profile_reels(uuid, text, text, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. A tela: listar e limpar
-- ---------------------------------------------------------------------------

create or replace function public.get_meta_profile_action_blocks(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  return jsonb_build_object(
    'snapshotAt', timezone('utc', now()),
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', block.id,
        'profileId', block.profile_id,
        'username', coalesce(profile.username, block.username_snapshot),
        'profileStatus', profile.status,
        'groupNames', to_jsonb(block.group_names),
        'batchName', block.batch_name_snapshot,
        'cancelledBatchNames', to_jsonb(block.cancelled_batch_names),
        'errorCode', block.error_code,
        'errorMessage', block.error_message,
        'firstDetectedAt', block.first_detected_at,
        'lastDetectedAt', block.last_detected_at,
        'occurrences', block.occurrences,
        'cancelledReelCount', block.cancelled_reel_count
      ) order by block.last_detected_at desc, block.id)
      from (
        select * from public.meta_profile_action_blocks open_block
        where open_block.organization_id = p_organization_id
          and open_block.cleared_at is null
        order by open_block.last_detected_at desc, open_block.id
        limit 500
      ) block
      left join public.instagram_profiles profile on profile.id = block.profile_id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.clear_meta_profile_action_blocks(p_block_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_now timestamptz := timezone('utc', now());
  cleared_count integer := 0;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_block_ids is null or cardinality(p_block_ids) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'Lista de avisos inválida.';
  end if;
  if exists (
    select 1 from public.meta_profile_action_blocks block
    where block.id = any(p_block_ids)
      and not public.has_organization_role(block.organization_id, array['admin', 'operator']::public.organization_role[])
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  update public.meta_profile_action_blocks block set
    cleared_at = resolved_now,
    cleared_by = auth.uid()
  where block.id = any(p_block_ids)
    and block.cleared_at is null;
  get diagnostics cleared_count = row_count;

  return jsonb_build_object('cleared', cleared_count);
end;
$$;

revoke all on function public.get_meta_profile_action_blocks(uuid) from public, anon;
revoke all on function public.clear_meta_profile_action_blocks(uuid[]) from public, anon;
-- Licao da 433: sem grant explicito o painel recebe 42501 e o service_role esconde.
grant execute on function public.get_meta_profile_action_blocks(uuid) to authenticated, service_role;
grant execute on function public.clear_meta_profile_action_blocks(uuid[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Disjuntor de lote: o 9 nao pausa o lote (mesmo molde da 430)
-- ---------------------------------------------------------------------------

create or replace function public.is_publication_non_pausing_failure(
  p_error_code text,
  p_error_message text
) returns boolean
language sql
stable
parallel safe
as $$
  select public.is_publication_infrastructure_error(p_error_code, p_error_message)
    or public.is_publication_duplicate_content_failure(p_error_code, p_error_message)
    or lower(trim(coalesce(p_error_code, ''))) in (
      '42804',
      'zernio_creation_outcome_unknown',
      'publication_outcome_unknown',
      'zernio_recovery_confirmation_timeout',
      -- Meta 25/2207050: restrição de escrita da conta (16/09/2026).
      '25',
      -- Meta 9: "User is performing too many actions", bloqueio temporario da
      -- conta (21/09/2026). Problema do perfil, nao do lote.
      '9',
      'meta_action_blocked'
    )
    or coalesce(p_error_message, '') ilike '%User access is restricted%'
    or coalesce(p_error_message, '') ilike '%performing too many actions%';
$$;

-- O ledger e derivado; os eventos completos continuam preservados. Nao despausa
-- lote nenhum: lote pausado volta pelo botao "Continuar lote".
delete from public.publication_batch_terminal_outcomes outcome
using public.publication_item_events event
where outcome.event_id = event.id
  and outcome.outcome = 'failed'
  and public.is_publication_non_pausing_failure(event.error_code, event.error_message);

revoke all on function public.is_publication_non_pausing_failure(text, text)
  from public, anon, authenticated;
grant execute on function public.is_publication_non_pausing_failure(text, text)
  to service_role;

notify pgrst, 'reload schema';

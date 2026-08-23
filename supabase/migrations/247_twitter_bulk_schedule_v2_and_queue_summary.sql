-- Agenda V2 do X: nomes de programa, confirmação protegida contra drift de fila
-- e agregados compactos para o compositor. Programas existentes não são alterados.

alter table public.twitter_programs
  add column if not exists name text,
  add column if not exists schedule_version smallint not null default 1;

alter table public.twitter_programs
  drop constraint if exists twitter_programs_name_check;
alter table public.twitter_programs
  add constraint twitter_programs_name_check
  check (name is null or char_length(trim(name)) between 1 and 160);

alter table public.twitter_programs
  drop constraint if exists twitter_programs_schedule_version_check;
alter table public.twitter_programs
  add constraint twitter_programs_schedule_version_check
  check (schedule_version in (1, 2));

create or replace function public.twitter_bulk_profile_queue_summary(
  p_organization_id uuid
)
returns table(
  profile_id uuid,
  text_count bigint,
  image_count bigint,
  gif_count bigint,
  video_count bigint,
  pending_count bigint,
  blocking_count bigint,
  next_execute_at timestamptz,
  last_execute_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    item.profile_id,
    count(*) filter (where item.media_set_client_key is null)::bigint as text_count,
    count(*) filter (where media_set.media_kind = 'images')::bigint as image_count,
    count(*) filter (where media_set.media_kind = 'gif')::bigint as gif_count,
    count(*) filter (where media_set.media_kind = 'video')::bigint as video_count,
    count(*)::bigint as pending_count,
    count(*) filter (where item.status in ('claimed', 'processing', 'outcome_unknown'))::bigint as blocking_count,
    min(coalesce(item.next_attempt_at, item.execute_at)) as next_execute_at,
    max(greatest(item.execute_at, coalesce(item.next_attempt_at, item.execute_at))) as last_execute_at
  from public.twitter_publication_items item
  left join public.twitter_program_media_sets media_set
    on media_set.program_id = item.program_id
   and media_set.client_key = item.media_set_client_key
  where item.organization_id = p_organization_id
    and item.status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown')
  group by item.profile_id;
$$;

revoke all on function public.twitter_bulk_profile_queue_summary(uuid) from public, anon, authenticated;
grant execute on function public.twitter_bulk_profile_queue_summary(uuid) to service_role;

create or replace function public.twitter_confirm_bulk_program_v2(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_review_digest text,
  p_rate_card_version integer,
  p_wallet_snapshots jsonb,
  p_program jsonb,
  p_texts jsonb,
  p_media_sets jsonb,
  p_items jsonb,
  p_shortfalls jsonb,
  p_schedule_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_program public.twitter_programs;
  requested_profile uuid;
  snapshot jsonb;
  current_tail timestamptz;
  result jsonb;
  program_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role confirma programas X.';
  end if;
  if coalesce((p_program ->> 'scheduleVersion')::integer, 0) <> 2 then
    raise exception using errcode = '22023', message = 'Versão da agenda X inválida.';
  end if;
  if char_length(trim(coalesce(p_program ->> 'name', ''))) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'Nome do programa X inválido.';
  end if;

  -- O replay precisa ser reconhecido antes da comparação com a cauda, pois os
  -- próprios itens da primeira confirmação já alteraram a fila.
  select * into existing_program
  from public.twitter_programs existing
  where existing.organization_id = p_organization_id
    and existing.idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'programId', existing_program.id,
      'idempotentReplay', true,
      'fundedCount', existing_program.funded_count,
      'reservedMicros', existing_program.reserved_micros,
      'name', coalesce(existing_program.name, trim(p_program ->> 'name')),
      'scheduleVersion', existing_program.schedule_version
    );
  end if;

  -- A ordem fixa evita deadlock quando dois programas compartilham perfis.
  for requested_profile in
    select distinct (entry ->> 'profile_id')::uuid
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) entry
    order by 1
  loop
    perform 1
    from public.twitter_profiles profile
    where profile.id = requested_profile
      and profile.organization_id = p_organization_id
      and profile.deleted_at is null
      and profile.status = 'active'
      and profile.can_post
    for update;
    if not found then
      raise exception using errcode = '40001', message = 'Perfil ou conexão mudou; revise novamente.';
    end if;

    if exists (
      select 1 from public.twitter_publication_items active
      where active.organization_id = p_organization_id
        and active.profile_id = requested_profile
        and active.status in ('claimed', 'processing', 'outcome_unknown')
    ) then
      raise exception using errcode = '40001', message = 'Perfil possui envio em processamento; revise após a reconciliação.';
    end if;

    if (p_program ->> 'scheduleKind') = 'interval' then
      select value into snapshot
      from jsonb_array_elements(coalesce(p_schedule_snapshot, '[]'::jsonb))
      where (value ->> 'profileId')::uuid = requested_profile;
      if snapshot is null then
        raise exception using errcode = '22023', message = 'Snapshot de agenda X incompleto.';
      end if;

      select max(greatest(item.execute_at, coalesce(item.next_attempt_at, item.execute_at)))
      into current_tail
      from public.twitter_publication_items item
      where item.organization_id = p_organization_id
        and item.profile_id = requested_profile
        and item.status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown');

      if current_tail is distinct from nullif(snapshot ->> 'queueTailAt', '')::timestamptz then
        raise exception using errcode = '40001', message = 'A fila X mudou; revise novamente.';
      end if;
    end if;
  end loop;

  result := public.twitter_confirm_bulk_program(
    p_organization_id, p_actor_user_id, p_idempotency_key, p_review_digest,
    p_rate_card_version, p_wallet_snapshots, p_program, p_texts,
    p_media_sets, p_items, p_shortfalls
  );
  program_id := (result ->> 'programId')::uuid;
  update public.twitter_programs
  set name = trim(p_program ->> 'name'), schedule_version = 2
  where id = program_id and organization_id = p_organization_id;
  return result || jsonb_build_object('name', trim(p_program ->> 'name'), 'scheduleVersion', 2);
end;
$$;

revoke all on function public.twitter_confirm_bulk_program_v2(uuid,uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.twitter_confirm_bulk_program_v2(uuid,uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;

create or replace function public.twitter_program_queue_overview(
  p_organization_id uuid
)
returns table(
  id uuid,
  name text,
  status text,
  funded_count integer,
  unfunded_count bigint,
  reserved_micros bigint,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz,
  schedule_version smallint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    program.id,
    program.name,
    case
      when program.status = 'cancelled' then 'cancelled'
      when exists (
        select 1 from public.twitter_publication_items item
        where item.program_id = program.id
          and item.status = 'outcome_unknown'
      ) then 'attention'
      when exists (
        select 1 from public.twitter_publication_items item
        where item.program_id = program.id
          and item.status in ('ready', 'retry', 'claimed', 'processing')
      ) then 'confirmed'
      when exists (
        select 1 from public.twitter_publication_items item
        where item.program_id = program.id
      ) then 'completed'
      else program.status::text
    end as status,
    program.funded_count,
    program.unfunded_count,
    program.reserved_micros,
    program.starts_at,
    program.ends_at,
    program.created_at,
    program.schedule_version
  from public.twitter_programs program
  where program.organization_id = p_organization_id
  order by program.created_at desc
  limit 200;
$$;

revoke all on function public.twitter_program_queue_overview(uuid) from public, anon, authenticated;
grant execute on function public.twitter_program_queue_overview(uuid) to service_role;

notify pgrst, 'reload schema';

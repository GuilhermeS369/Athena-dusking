-- Analytics X passa a ser uma preferência por perfil. A conexão permanece
-- apenas como infraestrutura compartilhada e Inbox continua sempre desligado.

alter table public.twitter_profiles
  add column if not exists analytics_enabled boolean not null default true;

update public.twitter_connections connection
set analytics_enabled = true,
    inbox_enabled = false
where connection.status <> 'deleted'
  and connection.deleted_at is null
  and exists (
    select 1
    from public.twitter_profiles profile
    where profile.current_connection_id = connection.id
      and profile.deleted_at is null
  );

create or replace function public.twitter_cancel_reserved_profile_analytics()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
  reservation_row public.twitter_wallet_reservations;
begin
  if old.analytics_enabled and not new.analytics_enabled then
    for item in
      select analytics_item.*
      from public.twitter_analytics_items analytics_item
      where analytics_item.profile_id = new.id
        and analytics_item.status = 'reserved'
      order by analytics_item.created_at, analytics_item.id
      for update
    loop
      select reservation.* into reservation_row
      from public.twitter_analytics_job_reservations job_reservation
      join public.twitter_wallet_reservations reservation
        on reservation.id = job_reservation.reservation_id
      where job_reservation.job_id = item.job_id
        and job_reservation.identity_id = item.identity_id
        and job_reservation.category = item.category
      for update of reservation;

      update public.twitter_wallet_reservations
      set remaining_micros = remaining_micros - item.amount_micros,
          released_micros = released_micros + item.amount_micros,
          status = case
            when remaining_micros - item.amount_micros = 0 and settled_micros > 0 then 'settled'::public.twitter_reservation_status
            when remaining_micros - item.amount_micros = 0 then 'released'::public.twitter_reservation_status
            else 'partially_settled'::public.twitter_reservation_status
          end,
          resolved_at = case when remaining_micros - item.amount_micros = 0 then timezone('utc', now()) else resolved_at end
      where id = reservation_row.id;

      update public.twitter_wallets
      set reserved_micros = reserved_micros - item.amount_micros,
          version = version + 1
      where identity_id = item.identity_id
        and organization_id = item.organization_id;

      insert into public.twitter_reservation_events (
        reservation_id, organization_id, event_type, amount_micros,
        idempotency_key, reason, metadata
      ) values (
        reservation_row.id, item.organization_id, 'released', item.amount_micros,
        'profile-analytics-disabled:' || item.id,
        'Analytics do perfil desabilitado antes do claim.',
        jsonb_build_object('analyticsItemId', item.id, 'profileId', new.id, 'connectionId', item.connection_id)
      );

      update public.twitter_analytics_items
      set status = 'cancelled',
          result_code = 'profile_analytics_disabled',
          error_message = 'Analytics do perfil desabilitado antes do claim.',
          released_micros = item.amount_micros
      where id = item.id;
    end loop;

    update public.twitter_analytics_jobs job
    set status = case
          when exists(select 1 from public.twitter_analytics_items x where x.job_id = job.id and x.status in ('reserved','processing')) then 'processing'::public.twitter_analytics_job_status
          when exists(select 1 from public.twitter_analytics_items x where x.job_id = job.id and x.status = 'outcome_unknown') then 'outcome_unknown'::public.twitter_analytics_job_status
          when exists(select 1 from public.twitter_analytics_items x where x.job_id = job.id and x.status = 'succeeded') then 'partially_succeeded'::public.twitter_analytics_job_status
          else 'cancelled'::public.twitter_analytics_job_status
        end,
        finished_at = case
          when not exists(select 1 from public.twitter_analytics_items x where x.job_id = job.id and x.status in ('reserved','processing')) then timezone('utc', now())
          else null
        end
    where job.id in (
      select distinct analytics_item.job_id
      from public.twitter_analytics_items analytics_item
      where analytics_item.profile_id = new.id
        and analytics_item.status = 'cancelled'
        and analytics_item.result_code = 'profile_analytics_disabled'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists twitter_profiles_cancel_reserved_analytics on public.twitter_profiles;
create trigger twitter_profiles_cancel_reserved_analytics
after update of analytics_enabled on public.twitter_profiles
for each row when (old.analytics_enabled is true and new.analytics_enabled is false)
execute function public.twitter_cancel_reserved_profile_analytics();

create or replace function public.twitter_guard_profile_analytics_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.twitter_profiles profile
    where profile.id = new.profile_id
      and profile.organization_id = new.organization_id
      and profile.analytics_enabled
      and profile.can_fetch_analytics
      and profile.deleted_at is null
  ) then
    raise exception using errcode = '22023', message = 'Perfil X sem Analytics habilitado.';
  end if;
  return new;
end;
$$;

drop trigger if exists twitter_analytics_items_require_enabled_profile on public.twitter_analytics_items;
create trigger twitter_analytics_items_require_enabled_profile
before insert on public.twitter_analytics_items
for each row execute function public.twitter_guard_profile_analytics_item();

create or replace function public.twitter_set_profile_analytics_enabled(
  p_organization_id uuid,
  p_profile_id uuid,
  p_enabled boolean,
  p_actor_user_id uuid,
  p_actor_email text,
  p_idempotency_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_row public.twitter_profiles;
  connection_row public.twitter_connections;
  event_row public.twitter_connection_events;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role pode alterar o Analytics do perfil X.';
  end if;
  if char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 255
    or char_length(trim(coalesce(p_reason, ''))) not between 8 and 1000
  then
    raise exception using errcode = '22023', message = 'Auditoria do Analytics do perfil inválida.';
  end if;

  select * into event_row
  from public.twitter_connection_events
  where organization_id = p_organization_id
    and idempotency_key = trim(p_idempotency_key);
  if found then
    if event_row.profile_id <> p_profile_id or event_row.event_type <> 'capabilities_changed' then
      raise exception using errcode = '23505', message = 'Idempotency key já utilizada em outra operação.';
    end if;
    select * into profile_row from public.twitter_profiles where id = p_profile_id;
    return jsonb_build_object(
      'profileId', profile_row.id,
      'analyticsEnabled', profile_row.analytics_enabled,
      'idempotentReplay', true
    );
  end if;

  select * into profile_row
  from public.twitter_profiles
  where id = p_profile_id
    and organization_id = p_organization_id
    and deleted_at is null
  for update;
  if not found or profile_row.current_connection_id is null or profile_row.current_epoch_id is null then
    raise exception using errcode = 'P0002', message = 'Perfil X sem conexão ativa.';
  end if;

  select * into connection_row
  from public.twitter_connections
  where id = profile_row.current_connection_id
    and organization_id = p_organization_id
    and status = 'active'
    and deleted_at is null
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Conexão ativa do perfil X não encontrada.';
  end if;

  update public.twitter_connections
  set analytics_enabled = true,
      inbox_enabled = false
  where id = connection_row.id;

  update public.twitter_profiles
  set analytics_enabled = p_enabled,
      can_fetch_analytics = case when p_enabled then true else can_fetch_analytics end
  where id = profile_row.id
  returning * into profile_row;

  insert into public.twitter_connection_events (
    organization_id, connection_id, profile_id, event_type,
    actor_user_id, actor_email, message, metadata, idempotency_key
  ) values (
    p_organization_id, connection_row.id, profile_row.id, 'capabilities_changed',
    p_actor_user_id, nullif(trim(coalesce(p_actor_email, '')), ''),
    case when p_enabled then 'Analytics do perfil X ativado; Inbox permanece desligado.' else 'Analytics do perfil X desativado; Inbox permanece desligado.' end,
    jsonb_build_object('analyticsEnabled', p_enabled, 'inboxEnabled', false, 'scope', 'profile', 'reason', trim(p_reason)),
    trim(p_idempotency_key)
  );

  return jsonb_build_object(
    'profileId', profile_row.id,
    'analyticsEnabled', profile_row.analytics_enabled,
    'canFetchAnalytics', profile_row.can_fetch_analytics,
    'idempotentReplay', false
  );
end;
$$;

drop function if exists public.twitter_claim_analytics_items(text, integer);
create function public.twitter_claim_analytics_items(p_worker_id text, p_limit integer)
returns table(item_id uuid,attempt_id uuid,organization_id uuid,job_id uuid,resource_type public.twitter_analytics_resource_type,resource_id uuid,profile_id uuid,connection_id uuid,zernio_post_id text,amount_micros bigint,collection_stage public.twitter_analytics_collection_stage,requested_from date,requested_to date,force_refresh boolean)
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  return query with candidates as (
    select i.id from public.twitter_analytics_items i
    join public.twitter_connections c on c.id=i.connection_id and c.organization_id=i.organization_id
    join public.twitter_profiles p on p.id=i.profile_id and p.organization_id=i.organization_id
    join public.twitter_profile_connection_epochs e on e.id=p.current_epoch_id and e.connection_id=c.id and e.ended_at is null
    where i.status='reserved' and c.analytics_enabled and c.status='active' and c.deleted_at is null
      and p.analytics_enabled and p.can_fetch_analytics and p.deleted_at is null and p.current_connection_id=c.id
      and i.id=(select queued.id from public.twitter_analytics_items queued where queued.connection_id=i.connection_id and queued.status='reserved' order by queued.created_at,queued.id limit 1)
      and not exists(select 1 from public.twitter_analytics_items a where a.connection_id=i.connection_id and a.status in('processing','outcome_unknown'))
    order by i.created_at,i.id for update of i skip locked limit least(greatest(p_limit,1),50)
  ),updated as (
    update public.twitter_analytics_items i set status='processing',claimed_at=timezone('utc',now()),claimed_by=p_worker_id,attempt_count=attempt_count+1 from candidates c where i.id=c.id returning i.*
  ),attempts(attempt_id_value,attempt_item_id) as (
    insert into public.twitter_analytics_attempts(organization_id,item_id,attempt_number,worker_id,idempotency_key)
    select u.organization_id,u.id,u.attempt_count,p_worker_id,'analytics-attempt:'||u.id||':'||u.attempt_count from updated u
    returning public.twitter_analytics_attempts.id,public.twitter_analytics_attempts.item_id
  )
  update public.twitter_analytics_jobs j set status='processing',started_at=coalesce(j.started_at,timezone('utc',now())) from updated u where j.id=u.job_id
  returning u.id,(select attempts.attempt_id_value from attempts where attempts.attempt_item_id=u.id),u.organization_id,u.job_id,u.resource_type,case when u.resource_type='post' then u.publication_item_id else u.profile_id end,u.profile_id,u.connection_id,u.zernio_post_id,u.amount_micros,u.collection_stage,u.requested_from,u.requested_to,u.force_refresh;
end $$;

revoke all on function public.twitter_cancel_reserved_profile_analytics(), public.twitter_guard_profile_analytics_item() from public, anon, authenticated;
revoke all on function public.twitter_set_profile_analytics_enabled(uuid,uuid,boolean,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.twitter_claim_analytics_items(text,integer) from public, anon, authenticated;
grant execute on function public.twitter_set_profile_analytics_enabled(uuid,uuid,boolean,uuid,text,text,text) to service_role;
grant execute on function public.twitter_claim_analytics_items(text,integer) to service_role;

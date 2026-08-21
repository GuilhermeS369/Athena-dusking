-- Controles iniciais de rate limit e justiça para a fila de publicação.
-- Esta etapa não aumenta throughput; ela cria guardrails conservadores para que
-- workers externos possam publicar continuamente sem deixar uma organização,
-- provedor ou perfil monopolizar a fila.

create table if not exists public.publication_rate_limit_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  provider text check (provider is null or provider in ('meta_official', 'zernio')),
  enabled boolean not null default true,
  max_provider_publications_per_minute integer not null default 50 check (max_provider_publications_per_minute between 1 and 10000),
  max_provider_publications_per_hour integer not null default 3000 check (max_provider_publications_per_hour between 1 and 200000),
  max_provider_publications_per_day integer not null default 72000 check (max_provider_publications_per_day between 1 and 2000000),
  max_profile_publications_per_24h integer not null default 100 check (max_profile_publications_per_24h between 1 and 1000),
  min_seconds_between_profile_publications integer not null default 45 check (min_seconds_between_profile_publications between 0 and 3600),
  reservation_seconds integer not null default 300 check (reservation_seconds between 60 and 900),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists publication_rate_limit_settings_scope_idx
  on public.publication_rate_limit_settings (
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(provider, '*')
  );

create index if not exists publication_rate_limit_settings_lookup_idx
  on public.publication_rate_limit_settings (organization_id, provider, enabled);

drop trigger if exists publication_rate_limit_settings_set_updated_at on public.publication_rate_limit_settings;
create trigger publication_rate_limit_settings_set_updated_at
before update on public.publication_rate_limit_settings
for each row execute function public.set_updated_at();

alter table public.publication_rate_limit_settings enable row level security;

drop policy if exists publication_rate_limit_settings_select_admin on public.publication_rate_limit_settings;
create policy publication_rate_limit_settings_select_admin
on public.publication_rate_limit_settings for select to authenticated
using (organization_id is not null and public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

drop policy if exists publication_rate_limit_settings_update_admin on public.publication_rate_limit_settings;
create policy publication_rate_limit_settings_update_admin
on public.publication_rate_limit_settings for update to authenticated
using (organization_id is not null and public.has_organization_role(organization_id, array['admin']::public.organization_role[]))
with check (organization_id is not null and public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

drop policy if exists publication_rate_limit_settings_insert_admin on public.publication_rate_limit_settings;
create policy publication_rate_limit_settings_insert_admin
on public.publication_rate_limit_settings for insert to authenticated
with check (organization_id is not null and public.has_organization_role(organization_id, array['admin']::public.organization_role[]));

revoke all on table public.publication_rate_limit_settings from public, anon, authenticated;
grant select, insert, update on table public.publication_rate_limit_settings to authenticated;
grant all on table public.publication_rate_limit_settings to service_role;

insert into public.publication_rate_limit_settings (
  organization_id,
  provider,
  enabled,
  max_provider_publications_per_minute,
  max_provider_publications_per_hour,
  max_provider_publications_per_day,
  max_profile_publications_per_24h,
  min_seconds_between_profile_publications,
  reservation_seconds,
  metadata
) values (
  null,
  null,
  true,
  50,
  3000,
  72000,
  100,
  45,
  300,
  jsonb_build_object('source', '062_publication_rate_limit_fairness', 'scope', 'global_default')
)
on conflict do nothing;

create table if not exists public.publication_dispatch_rate_reservations (
  publication_item_id uuid primary key references public.publication_items (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  provider text not null check (provider in ('meta_official', 'zernio')),
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists publication_dispatch_rate_reservations_provider_idx
  on public.publication_dispatch_rate_reservations (organization_id, provider, expires_at);

create index if not exists publication_dispatch_rate_reservations_profile_idx
  on public.publication_dispatch_rate_reservations (profile_id, expires_at);

alter table public.publication_dispatch_rate_reservations enable row level security;
revoke all on table public.publication_dispatch_rate_reservations from public, anon, authenticated;
grant all on table public.publication_dispatch_rate_reservations to service_role;

create or replace function public.reserve_publication_dispatch_capacity(
  p_item_id uuid,
  p_worker_id text,
  p_reservation_seconds integer default null
)
returns table (
  allowed boolean,
  reason text,
  provider text,
  current_count integer,
  limit_value integer,
  next_attempt_at timestamptz,
  settings jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  profile_provider text;
  setting_row public.publication_rate_limit_settings%rowtype;
  effective_reservation_seconds integer;
  now_at timestamptz := timezone('utc', now());
  check_reason text;
  check_message text;
  check_count integer := 0;
  check_limit integer := 0;
  retry_at timestamptz;
  last_profile_publication_at timestamptz;
begin
  if char_length(trim(coalesce(p_worker_id, ''))) not between 3 and 120 then
    raise exception using errcode = '22023', message = 'Identificador de worker inválido.';
  end if;
  if p_reservation_seconds is not null and p_reservation_seconds not between 60 and 900 then
    raise exception using errcode = '22023', message = 'Duração de reserva inválida.';
  end if;

  select item_source.* into item_row
  from public.publication_items as item_source
  where item_source.id = p_item_id
    and item_source.claimed_by = trim(p_worker_id)
    and item_source.lease_until > now_at
    and item_source.status in ('preparing', 'publishing')
  for update;

  if item_row.id is null then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.';
  end if;

  select profile.provider::text into profile_provider
  from public.instagram_profiles as profile
  where profile.id = item_row.profile_id
    and profile.organization_id = item_row.organization_id
    and profile.deleted_at is null;

  if profile_provider is null then
    raise exception using errcode = 'P0002', message = 'Perfil da publicação não encontrado.';
  end if;

  select setting_source.* into setting_row
  from public.publication_rate_limit_settings as setting_source
  where setting_source.enabled = true
    and (setting_source.organization_id = item_row.organization_id or setting_source.organization_id is null)
    and (setting_source.provider = profile_provider or setting_source.provider is null)
  order by (setting_source.organization_id is not null) desc,
           (setting_source.provider is not null) desc,
           setting_source.updated_at desc,
           setting_source.id desc
  limit 1;

  if setting_row.id is null then
    insert into public.publication_rate_limit_settings (organization_id, provider)
    values (null, null)
    on conflict do nothing;

    select setting_source.* into setting_row
    from public.publication_rate_limit_settings as setting_source
    where setting_source.organization_id is null
      and setting_source.provider is null
    limit 1;
  end if;

  effective_reservation_seconds := coalesce(p_reservation_seconds, setting_row.reservation_seconds, 300);

  perform pg_advisory_xact_lock(hashtextextended(item_row.organization_id::text || ':' || profile_provider, 4));
  perform pg_advisory_xact_lock(hashtextextended(item_row.profile_id::text, 5));

  delete from public.publication_dispatch_rate_reservations
  where expires_at <= now_at;

  if exists (
    select 1
    from public.publication_dispatch_rate_reservations as reservation
    where reservation.publication_item_id = item_row.id
  ) then
    return query select true, null::text, profile_provider, 0, 0, null::timestamptz, to_jsonb(setting_row);
    return;
  end if;

  select max(published_at) into last_profile_publication_at
  from public.publication_items as published_item
  where published_item.profile_id = item_row.profile_id
    and published_item.status = 'published'
    and published_item.published_at is not null;

  if setting_row.min_seconds_between_profile_publications > 0
    and last_profile_publication_at is not null
    and last_profile_publication_at + make_interval(secs => setting_row.min_seconds_between_profile_publications) > now_at
  then
    check_reason := 'profile_min_interval';
    check_message := 'Publicação adiada para respeitar intervalo mínimo entre publicações do mesmo perfil.';
    check_count := 1;
    check_limit := 1;
    retry_at := last_profile_publication_at + make_interval(secs => setting_row.min_seconds_between_profile_publications);
  end if;

  if check_reason is null then
    select count(*)::integer into check_count
    from public.publication_items as published_item
    where published_item.profile_id = item_row.profile_id
      and published_item.status = 'published'
      and published_item.published_at >= now_at - interval '24 hours';

    check_count := check_count + (
      select count(*)::integer
      from public.publication_dispatch_rate_reservations as reservation
      where reservation.profile_id = item_row.profile_id
    );
    check_limit := setting_row.max_profile_publications_per_24h;

    if check_count >= check_limit then
      check_reason := 'profile_24h_limit';
      check_message := 'Publicação adiada pelo limite de publicações do perfil em 24 horas.';
      select min(expiry) into retry_at
      from (
        select published_item.published_at + interval '24 hours' as expiry
        from public.publication_items as published_item
        where published_item.profile_id = item_row.profile_id
          and published_item.status = 'published'
          and published_item.published_at >= now_at - interval '24 hours'
        union all
        select reservation.expires_at as expiry
        from public.publication_dispatch_rate_reservations as reservation
        where reservation.profile_id = item_row.profile_id
      ) as expirations;
    end if;
  end if;

  if check_reason is null then
    select count(*)::integer into check_count
    from public.publication_items as published_item
    join public.instagram_profiles as profile on profile.id = published_item.profile_id
    where published_item.organization_id = item_row.organization_id
      and profile.provider::text = profile_provider
      and published_item.status = 'published'
      and published_item.published_at >= now_at - interval '1 minute';

    check_count := check_count + (
      select count(*)::integer
      from public.publication_dispatch_rate_reservations as reservation
      where reservation.organization_id = item_row.organization_id
        and reservation.provider = profile_provider
    );
    check_limit := setting_row.max_provider_publications_per_minute;

    if check_count >= check_limit then
      check_reason := 'provider_minute_limit';
      check_message := 'Publicação adiada pelo limite por minuto do provedor nesta organização.';
      select min(expiry) into retry_at
      from (
        select published_item.published_at + interval '1 minute' as expiry
        from public.publication_items as published_item
        join public.instagram_profiles as profile on profile.id = published_item.profile_id
        where published_item.organization_id = item_row.organization_id
          and profile.provider::text = profile_provider
          and published_item.status = 'published'
          and published_item.published_at >= now_at - interval '1 minute'
        union all
        select reservation.expires_at as expiry
        from public.publication_dispatch_rate_reservations as reservation
        where reservation.organization_id = item_row.organization_id
          and reservation.provider = profile_provider
      ) as expirations;
    end if;
  end if;

  if check_reason is null then
    select count(*)::integer into check_count
    from public.publication_items as published_item
    join public.instagram_profiles as profile on profile.id = published_item.profile_id
    where published_item.organization_id = item_row.organization_id
      and profile.provider::text = profile_provider
      and published_item.status = 'published'
      and published_item.published_at >= now_at - interval '1 hour';

    check_count := check_count + (
      select count(*)::integer
      from public.publication_dispatch_rate_reservations as reservation
      where reservation.organization_id = item_row.organization_id
        and reservation.provider = profile_provider
    );
    check_limit := setting_row.max_provider_publications_per_hour;

    if check_count >= check_limit then
      check_reason := 'provider_hour_limit';
      check_message := 'Publicação adiada pelo limite por hora do provedor nesta organização.';
      select min(expiry) into retry_at
      from (
        select published_item.published_at + interval '1 hour' as expiry
        from public.publication_items as published_item
        join public.instagram_profiles as profile on profile.id = published_item.profile_id
        where published_item.organization_id = item_row.organization_id
          and profile.provider::text = profile_provider
          and published_item.status = 'published'
          and published_item.published_at >= now_at - interval '1 hour'
        union all
        select reservation.expires_at as expiry
        from public.publication_dispatch_rate_reservations as reservation
        where reservation.organization_id = item_row.organization_id
          and reservation.provider = profile_provider
      ) as expirations;
    end if;
  end if;

  if check_reason is null then
    select count(*)::integer into check_count
    from public.publication_items as published_item
    join public.instagram_profiles as profile on profile.id = published_item.profile_id
    where published_item.organization_id = item_row.organization_id
      and profile.provider::text = profile_provider
      and published_item.status = 'published'
      and published_item.published_at >= now_at - interval '24 hours';

    check_count := check_count + (
      select count(*)::integer
      from public.publication_dispatch_rate_reservations as reservation
      where reservation.organization_id = item_row.organization_id
        and reservation.provider = profile_provider
    );
    check_limit := setting_row.max_provider_publications_per_day;

    if check_count >= check_limit then
      check_reason := 'provider_24h_limit';
      check_message := 'Publicação adiada pelo limite diário do provedor nesta organização.';
      select min(expiry) into retry_at
      from (
        select published_item.published_at + interval '24 hours' as expiry
        from public.publication_items as published_item
        join public.instagram_profiles as profile on profile.id = published_item.profile_id
        where published_item.organization_id = item_row.organization_id
          and profile.provider::text = profile_provider
          and published_item.status = 'published'
          and published_item.published_at >= now_at - interval '24 hours'
        union all
        select reservation.expires_at as expiry
        from public.publication_dispatch_rate_reservations as reservation
        where reservation.organization_id = item_row.organization_id
          and reservation.provider = profile_provider
      ) as expirations;
    end if;
  end if;

  if check_reason is not null then
    retry_at := coalesce(retry_at, now_at + interval '1 minute');

    update public.publication_items as item_update
    set status = 'waiting',
        claimed_by = null,
        lease_until = null,
        next_attempt_at = retry_at,
        last_error_code = check_reason,
        last_error_message = check_message
    where item_update.id = item_row.id;

    perform public.log_publication_item_event(
      item_row.id,
      'processing_deferred',
      item_row.status,
      'waiting',
      null,
      trim(p_worker_id),
      check_reason,
      check_message,
      jsonb_build_object(
        'provider', profile_provider,
        'current_count', check_count,
        'limit_value', check_limit,
        'next_attempt_at', retry_at,
        'settings', to_jsonb(setting_row)
      )
    );

    return query select false, check_reason, profile_provider, check_count, check_limit, retry_at, to_jsonb(setting_row);
    return;
  end if;

  insert into public.publication_dispatch_rate_reservations (
    publication_item_id,
    organization_id,
    profile_id,
    provider,
    expires_at
  ) values (
    item_row.id,
    item_row.organization_id,
    item_row.profile_id,
    profile_provider,
    now_at + make_interval(secs => effective_reservation_seconds)
  )
  on conflict (publication_item_id) do update
  set expires_at = excluded.expires_at,
      organization_id = excluded.organization_id,
      profile_id = excluded.profile_id,
      provider = excluded.provider;

  return query select true, null::text, profile_provider, check_count, check_limit, null::timestamptz, to_jsonb(setting_row);
end;
$$;

revoke all on function public.reserve_publication_dispatch_capacity(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.reserve_publication_dispatch_capacity(uuid, text, integer) to service_role;

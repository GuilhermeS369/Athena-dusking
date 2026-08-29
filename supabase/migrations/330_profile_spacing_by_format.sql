-- Espaçamento mínimo entre publicações do mesmo perfil, por formato.
--
-- MEDIDO EM PRODUÇÃO (48h, 2026-08-29): 68.472 intervalos entre reels do mesmo
-- perfil, dos quais 1.861 (2,72%) abaixo de 30 minutos e 124 abaixo de 5
-- minutos, com mínimo absoluto de 0 segundos. Nenhuma publicação saiu ANTES do
-- horário — toda a compressão vem de atraso variável de despacho: o post das
-- 17:45 sai 17:55, o das 18:45 sai no horário, e o intervalo real vira 50 min.
--
-- Stories não têm o problema: 2.329 intervalos, zero abaixo de 30 min, mínimo
-- 42 min, máximo 2 por dia por perfil. São uma trilha separada, de baixo volume.
-- Por isso o espaçamento passa a ser POR FORMATO: contar story junto com reel
-- inflaria o problema de 1.861 para 5.517 casos e adiaria 3.846 publicações que
-- estavam corretas.
--
-- A guarda já existia (min_seconds_between_profile_publications = 45s) e tinha
-- três furos, corrigidos aqui:
--
-- 1. `published_at` é gravado tarde. No Zernio o `publishNow` já põe o post no
--    ar, mas `published_at` só é escrito quando o polling confirma — 2+ minutos
--    depois (primeiro poll em 120s), enquanto a reserva dura 60s e expira antes.
--    A guarda comparava com um passado defasado. É a explicação direta dos
--    intervalos de 0 minuto.
-- 2. A checagem de intervalo ignorava reservas em voo, ao contrário das outras
--    duas checagens da mesma função, que as somam. Com 32 despachos concorrentes
--    e sem espaçamento por perfil na seleção do lote, itens irmãos passavam juntos.
-- 3. A comparação não filtrava por formato.
--
-- ESCOPO: a checagem é e continua sendo POR PERFIL (`profile_id = item.profile_id`).
-- O perfil A em cooldown não bloqueia o B. O `organization_id` em
-- `publication_rate_limit_settings` decide apenas QUAL VALOR se aplica, permitindo
-- cadência diferente por organização — não é o escopo da contagem.

alter table public.publication_rate_limit_settings
  add column if not exists min_seconds_between_profile_publications_by_format jsonb
    not null default '{}'::jsonb;

alter table public.publication_rate_limit_settings
  drop constraint if exists publication_rate_limit_settings_by_format_is_object;
alter table public.publication_rate_limit_settings
  add constraint publication_rate_limit_settings_by_format_is_object
  check (jsonb_typeof(min_seconds_between_profile_publications_by_format) = 'object');

comment on column public.publication_rate_limit_settings.min_seconds_between_profile_publications_by_format is
  'Espaçamento mínimo por formato, ex.: {"reel": 1500}. Cai para min_seconds_between_profile_publications quando o formato não está presente. O valor precisa ser MENOR que o menor intervalo de plano em uso na organização: se guarda e intervalo forem iguais, qualquer atraso de 1s no post anterior adia o seguinte, e o adiamento se propaga indefinidamente.';

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
  effective_min_seconds integer;
  now_at timestamptz := timezone('utc', now());
  check_reason text;
  check_message text;
  check_count integer := 0;
  check_limit integer := 0;
  retry_at timestamptz;
  last_profile_publication_at timestamptz;
  sibling_reservation_expires_at timestamptz;
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

  -- Valor do formato deste item, caindo para o escalar quando não houver entrada.
  effective_min_seconds := coalesce(
    nullif(setting_row.min_seconds_between_profile_publications_by_format ->> item_row.format::text, '')::integer,
    setting_row.min_seconds_between_profile_publications,
    0
  );

  perform pg_advisory_xact_lock(hashtextextended(item_row.organization_id::text || ':' || profile_provider, 4));
  perform pg_advisory_xact_lock(hashtextextended(item_row.profile_id::text, 5));

  delete from public.publication_dispatch_rate_reservations
  where expires_at <= now_at;

  -- Reentrância: o próprio item já reservou capacidade nesta janela e portanto já
  -- passou pelas checagens. Não é um bypass — é o mesmo item repetindo a tentativa.
  if exists (
    select 1
    from public.publication_dispatch_rate_reservations as reservation
    where reservation.publication_item_id = item_row.id
  ) then
    return query select true, null::text, profile_provider, 0, 0, null::timestamptz, to_jsonb(setting_row);
    return;
  end if;

  -- O momento em que este perfil publicou algo deste formato pela última vez.
  -- Precisa considerar o envio já aceito e ainda não confirmado: no Zernio o post
  -- já está no ar, mas published_at só aparece 2+ minutos depois. Comparar só com
  -- published_at deixava passar tudo que acontecesse nessa janela cega.
  select greatest(
    coalesce((
      select max(published_item.published_at)
      from public.publication_items as published_item
      where published_item.profile_id = item_row.profile_id
        and published_item.format = item_row.format
        and published_item.status = 'published'
        and published_item.published_at is not null
    ), '-infinity'::timestamptz),
    coalesce((
      select max(accepted_item.provider_creation_started_at)
      from public.publication_items as accepted_item
      where accepted_item.profile_id = item_row.profile_id
        and accepted_item.format = item_row.format
        and accepted_item.id <> item_row.id
        and accepted_item.creation_id is not null
        and accepted_item.status in ('preparing', 'publishing')
        and accepted_item.provider_creation_started_at is not null
    ), '-infinity'::timestamptz)
  ) into last_profile_publication_at;

  -- Reserva viva de OUTRO item do mesmo perfil e formato: há uma publicação em
  -- voo agora. Sem isto, 32 despachos concorrentes leem o mesmo estado e passam
  -- todos juntos — o advisory lock serializa as transações, mas não impede a
  -- decisão duplicada quando ambas leem um passado que ainda não mudou.
  select max(reservation.expires_at) into sibling_reservation_expires_at
  from public.publication_dispatch_rate_reservations as reservation
  join public.publication_items as reserved_item
    on reserved_item.id = reservation.publication_item_id
  where reservation.profile_id = item_row.profile_id
    and reservation.publication_item_id <> item_row.id
    and reserved_item.format = item_row.format;

  if effective_min_seconds > 0 then
    if last_profile_publication_at > '-infinity'::timestamptz
      and last_profile_publication_at + make_interval(secs => effective_min_seconds) > now_at
    then
      check_reason := 'profile_min_interval';
      check_message := 'Publicação adiada para respeitar intervalo mínimo entre publicações do mesmo perfil.';
      check_count := 1;
      check_limit := effective_min_seconds;
      retry_at := last_profile_publication_at + make_interval(secs => effective_min_seconds);
    elsif sibling_reservation_expires_at is not null then
      check_reason := 'profile_min_interval';
      check_message := 'Publicação adiada: outra publicação do mesmo perfil e formato está em andamento.';
      check_count := 1;
      check_limit := effective_min_seconds;
      retry_at := greatest(sibling_reservation_expires_at, now_at + make_interval(secs => effective_min_seconds));
    end if;
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
        'format', item_row.format,
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
  set expires_at = excluded.expires_at;

  return query select true, null::text, profile_provider, check_count, check_limit, null::timestamptz, to_jsonb(setting_row);
end;
$$;

-- 25 minutos para reel, não 30. A regra de negócio é "30 min entre reels", mas há
-- intenção de testar planos com intervalo de 30 min — e se a guarda for igual ao
-- intervalo, qualquer atraso de 1s no post anterior adia o seguinte, e o
-- adiamento se propaga indefinidamente. 25 min pega os 1.861 casos medidos
-- (todos abaixo de 30) e deixa 5 min de folga.
-- Story e imagem seguem o escalar de 45s, que os dados mostram nunca ser atingido.
update public.publication_rate_limit_settings
set min_seconds_between_profile_publications_by_format =
      min_seconds_between_profile_publications_by_format || jsonb_build_object('reel', 1500),
    updated_at = timezone('utc', now())
where organization_id is null;

-- Torna a checagem por perfil+formato barata conforme publication_items cresce.
create index if not exists publication_items_profile_format_published_idx
  on public.publication_items (profile_id, format, published_at desc)
  where status = 'published' and published_at is not null;

create index if not exists publication_items_profile_format_accepted_idx
  on public.publication_items (profile_id, format, provider_creation_started_at desc)
  where creation_id is not null
    and status in ('preparing', 'publishing')
    and provider_creation_started_at is not null;

revoke all on function public.reserve_publication_dispatch_capacity(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.reserve_publication_dispatch_capacity(uuid, text, integer) to service_role;

notify pgrst, 'reload schema';

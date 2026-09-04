-- Cota por app da Meta na reserva de capacidade de despacho.
--
-- POR QUE ISSO PRECISA EXISTIR. A topologia inverteu. Com a Zernio eram 2.166
-- chaves, uma por conta, e nenhuma chegava perto do proprio limite (25 posts/hora
-- por conta contra um pico medido de 4) -- entao uma cota agregada por
-- organizacao era aproximacao boa o bastante. Com a Meta e um app para ~100
-- perfis, o APP passa a ser o recurso escasso, e era exatamente o que o sistema
-- nao sabia contar: as reservas tinham (organizacao, perfil, provedor) e o teto
-- por minuto era um numero so para todos os apps somados.
--
-- Consequencias disso, que esta migration fecha: um app movimentado consumia a
-- cota inteira enquanto os outros ficavam ociosos, e a cota da organizacao nao
-- protegia app nenhum do limite real da Meta.
--
-- O QUE MUDA, e o que deliberadamente NAO muda:
--
--   * a checagem da ORGANIZACAO continua identica. Ela protege o NOSSO banco --
--     o pool de 41 conexoes do PostgREST -- e foi validada sob carga em 03/09.
--     A cota por app e ADITIVA: um item precisa passar nas duas.
--   * as checagens por perfil (intervalo minimo, 24 h) seguem intocadas.
--   * o zernio nao e afetado em nada: o caminho novo so roda para
--     `meta_official` com `meta_app_id` preenchido.
--
-- O LOCK PRECISA ACOMPANHAR A COTA, e este e o ponto que mais importa aqui.
-- Contar por app dentro de um lock que fatia por hash de perfil (o da migration
-- 360) deixaria dois baldes do mesmo app lendo a mesma contagem e passando
-- juntos. A 360 aceitou essa corrida de proposito para a cota da organizacao,
-- porque o excesso e limitado a N-1 e o teto e protecao NOSSA, com folga de 6x.
-- Aqui e diferente: estourar limite de PROVEDOR nao e excesso nosso para gastar.
-- Por isso, quando ha app, o lock passa a ser por app.
--
-- Numero de locks: um por app (~33 previstos) contra os 8 baldes de hoje. A
-- contencao nao piora -- melhora.
--
-- Perfis legados com `meta_app_id` nulo (14 hoje) continuam no balde por perfil
-- da 360 e na cota da organizacao. Eles nao consomem vaga de app na tela nem
-- cota de app aqui; quando a reautorizacao deles passar por um app cadastrado,
-- migram sozinhos.
--
-- POR QUE O LIMITE NASCE NULO. `max_publications_per_minute` e nulo por padrao e
-- com nulo o comportamento e IDENTICO ao de hoje. O limite real de chamadas por
-- app da Meta e dinamico e so aparece no cabecalho `X-App-Usage` da resposta --
-- nao ha numero publicado para cravar. Inventar um daria falsa sensacao de
-- protecao e estrangularia a fila por engano; o certo e deixar a alavanca pronta
-- e configura-la quando o numero real for observado. Ver
-- docs/migracao-meta-prontidao-da-fila.md.
--
-- COMO ATIVAR: `update public.meta_apps set max_publications_per_minute = N
-- where id = ...`. Efeito imediato na proxima chamada. Voltar para nulo desliga.

alter table public.meta_apps
  add column if not exists max_publications_per_minute integer
    check (max_publications_per_minute is null or max_publications_per_minute between 1 and 10000);

comment on column public.meta_apps.max_publications_per_minute is
  'Teto de publicacoes por minuto deste app. NULO = sem cota por app (comportamento anterior a 371). Aditivo a cota da organizacao, que continua valendo. O limite real da Meta e dinamico (X-App-Usage) e nao tem numero publicado -- por isso nasce nulo.';

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
  shard_count integer;
  lock_bucket integer;
  profile_meta_app_id uuid;
  app_minute_limit integer;
  app_check_count integer;
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

  select profile.provider::text, profile.meta_app_id
  into profile_provider, profile_meta_app_id
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

  -- O balde vem do PERFIL, entao dois despachos do mesmo perfil caem sempre no
  -- mesmo balde e continuam serializados entre si. O que deixa de disputar sao
  -- perfis diferentes da mesma organizacao -- que era toda a contencao.
  --
  -- coalesce para 1, e nao para o default da coluna: valor ausente degrada para
  -- o comportamento conhecido (lock unico), nunca para o novo.
  shard_count := greatest(coalesce(setting_row.dispatch_lock_shards, 1), 1);
  lock_bucket := public.publication_dispatch_lock_bucket(item_row.profile_id, shard_count);

  -- Quando existe cota POR APP, o lock precisa ser POR APP. Contar por app
  -- dentro de um lock que fatia por perfil deixaria dois baldes do mesmo app
  -- lendo a mesma contagem e passando juntos -- a corrida que a 360 aceitou de
  -- proposito para a cota da organizacao (excesso limitado, protecao nossa) mas
  -- que aqui estouraria limite de PROVEDOR, que nao e nosso para gastar.
  --
  -- Perfil sem app (os legados, com meta_app_id nulo) continua no balde por
  -- perfil: eles nao consomem cota de app nenhum, entao nao ha o que serializar
  -- alem do que a 360 ja serializa.
  if profile_provider = 'meta_official' and profile_meta_app_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      item_row.organization_id::text || ':meta_app:' || profile_meta_app_id::text, 4));
  else
    perform pg_advisory_xact_lock(hashtextextended(
      item_row.organization_id::text || ':' || profile_provider || ':' || lock_bucket::text, 4));
  end if;
  perform pg_advisory_xact_lock(hashtextextended(item_row.profile_id::text, 5));

  -- Reentrância: o próprio item já reservou capacidade nesta janela e portanto já
  -- passou pelas checagens. Não é um bypass — é o mesmo item repetindo a tentativa.
  if exists (
    select 1
    from public.publication_dispatch_rate_reservations as reservation
    where reservation.publication_item_id = item_row.id
      and reservation.expires_at > now_at
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
    and reservation.expires_at > now_at
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
        and reservation.expires_at > now_at
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
          and reservation.expires_at > now_at
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
        and reservation.expires_at > now_at
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
          and reservation.expires_at > now_at
      ) as expirations;
    end if;
  end if;


  -- COTA POR APP DA META. Existe porque a topologia inverteu: com a Zernio eram
  -- milhares de chaves e nenhuma chegava perto do proprio limite, entao uma cota
  -- agregada por organizacao era aproximacao boa. Com um app para ~100 perfis, o
  -- APP passa a ser o recurso escasso -- e era exatamente o que o sistema nao
  -- sabia contar.
  --
  -- E ADITIVA: a checagem da organizacao acima continua valendo e segue sendo a
  -- que protege o nosso banco. Esta protege o limite do PROVEDOR, que e outro
  -- eixo. Um item precisa passar nas duas.
  --
  -- SO VALE QUANDO CONFIGURADA. `meta_apps.max_publications_per_minute` nasce
  -- nulo de proposito: o limite real de chamadas por app da Meta e dinamico e
  -- so aparece no cabecalho X-App-Usage. Cravar um numero inventado aqui daria
  -- falsa sensacao de protecao e estrangularia a fila por engano. Com nulo o
  -- comportamento e identico ao de hoje, e a alavanca fica pronta para quando o
  -- numero real for medido.
  if check_reason is null
     and profile_provider = 'meta_official'
     and profile_meta_app_id is not null then
    select app_row.max_publications_per_minute into app_minute_limit
    from public.meta_apps as app_row
    where app_row.id = profile_meta_app_id
      and app_row.organization_id = item_row.organization_id
      and app_row.deleted_at is null;

    if app_minute_limit is not null then
      select count(*)::integer into app_check_count
      from public.publication_items as published_item
      join public.instagram_profiles as profile on profile.id = published_item.profile_id
      where published_item.organization_id = item_row.organization_id
        and profile.meta_app_id = profile_meta_app_id
        and published_item.status = 'published'
        and published_item.published_at >= now_at - interval '1 minute';

      app_check_count := app_check_count + (
        select count(*)::integer
        from public.publication_dispatch_rate_reservations as reservation
        join public.instagram_profiles as reserved_profile
          on reserved_profile.id = reservation.profile_id
        where reservation.organization_id = item_row.organization_id
          and reserved_profile.meta_app_id = profile_meta_app_id
          and reservation.expires_at > now_at
      );

      if app_check_count >= app_minute_limit then
        check_reason := 'meta_app_minute_limit';
        check_message := 'Publicação adiada pelo limite por minuto do app da Meta.';
        check_count := app_check_count;
        check_limit := app_minute_limit;
        retry_at := now_at + interval '1 minute';
      end if;
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

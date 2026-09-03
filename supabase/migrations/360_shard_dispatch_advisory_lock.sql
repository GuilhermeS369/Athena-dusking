-- Fatia o advisory lock de despacho por organizacao em N baldes por perfil.
--
-- INCIDENTES DE 31/08 E 02/09/2026, o mesmo mecanismo nas duas vezes.
-- `reserve_publication_dispatch_capacity` pegava pg_advisory_xact_lock por
-- (organizacao, provedor). O lock e de transacao: fica preso ate o commit. Uma
-- onda inteira e de uma organizacao so, entao TODOS os despachos concorrentes
-- serializavam nele -- cada um segurando uma conexao do pool enquanto esperava.
--
-- O pool do PostgREST tem 41 conexoes. Um unico athena-publication-worker esta
-- provisionado para 64+8+8 = 80 requisicoes simultaneas. Quando a onda enche, a
-- espera migra para dentro do Postgres e o pool acaba: 31/08 custou 3.315
-- publicacoes; 02/09 tirou o painel do ar por horas. Ver secoes 3-A e 3-B de
-- docs/fila-de-publicacao-mapa-de-controles.md.
--
-- O QUE MUDA: so a chave do lock. As quatro checagens da funcao continuam
-- identicas, e em particular as CONTAGENS DO LIMITE POR MINUTO seguem varrendo a
-- organizacao inteira. A cota continua global.
--
-- POR QUE NAO DIVIDIR A COTA JUNTO, que era o esboco original: 600 em 8 baldes
-- da 75 por balde, e uma onda balanceada de 733 itens da ~92 por balde. Passaria
-- a adiar ANTES do que o teto unico de 600 adia -- uma regressao de vazao
-- vendida como correcao de contencao.
--
-- O CUSTO ACEITO: sem o lock unico, ate N-1 transacoes leem a mesma contagem e
-- passam juntas, excedendo o teto em ~1% com N=8. Nao e limite do provedor: a
-- migration 355 registra que este numero e protecao nossa, do banco, e que a
-- Zernio limita 25 posts/hora por conta contra um pico medido de 4/hora -- folga
-- de 6x. O excesso tambem nao acumula: assim que essas N transacoes commitam, a
-- proxima leitura ja ve a contagem verdadeira.
--
-- COMO REVERTER: `update public.publication_rate_limit_settings set
-- dispatch_lock_shards = 1`. Com 1 balde a chave volta a ser uma so por
-- organizacao, que e o comportamento anterior. Sem migration reversa, sem deploy.

alter table public.publication_rate_limit_settings
  add column if not exists dispatch_lock_shards integer not null default 8;

do $shards$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'publication_rate_limit_settings_dispatch_lock_shards_check'
  ) then
    alter table public.publication_rate_limit_settings
      add constraint publication_rate_limit_settings_dispatch_lock_shards_check
      check (dispatch_lock_shards between 1 and 64);
  end if;
end;
$shards$;

comment on column public.publication_rate_limit_settings.dispatch_lock_shards is
  'Baldes do advisory lock de despacho, por perfil. 1 = lock unico por organizacao (comportamento anterior a 360). Cota NAO e dividida: segue global por organizacao.';

-- A aritmetica do balde vive aqui, e nao embutida na funcao de reserva, para o
-- bloco de teste no fim desta migration validar exatamente o codigo que roda em
-- producao em vez de uma copia que pode divergir dele.
--
-- `((h % n) + n) % n` e NAO `abs(h) % n`: hashtextextended devolve bigint, e
-- abs(-9223372036854775808) levanta 22003 (bigint out of range), porque o menor
-- bigint nao tem positivo correspondente. Seria um perfil especifico travando
-- para sempre, so em producao, sem reproduzir.
--
-- Semente 7, diferente da 5 usada no lock por perfil, para os dois nao
-- correlacionarem. Sem `set search_path` e com corpo de expressao unica, pelo
-- mesmo motivo da migration 357: e o que permite ao planner fazer inline.
create or replace function public.publication_dispatch_lock_bucket(
  p_profile_id uuid,
  p_shards integer
)
returns integer
language sql
immutable
parallel safe
as $$
  select ((pg_catalog.hashtextextended(p_profile_id::text, 7) % greatest(p_shards, 1))
          + greatest(p_shards, 1)) % greatest(p_shards, 1);
$$;

revoke all on function public.publication_dispatch_lock_bucket(uuid, integer) from public, anon;
grant execute on function public.publication_dispatch_lock_bucket(uuid, integer) to authenticated, service_role;

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

  -- O balde vem do PERFIL, entao dois despachos do mesmo perfil caem sempre no
  -- mesmo balde e continuam serializados entre si. O que deixa de disputar sao
  -- perfis diferentes da mesma organizacao -- que era toda a contencao.
  --
  -- coalesce para 1, e nao para o default da coluna: valor ausente degrada para
  -- o comportamento conhecido (lock unico), nunca para o novo.
  shard_count := greatest(coalesce(setting_row.dispatch_lock_shards, 1), 1);
  lock_bucket := public.publication_dispatch_lock_bucket(item_row.profile_id, shard_count);

  perform pg_advisory_xact_lock(hashtextextended(
    item_row.organization_id::text || ':' || profile_provider || ':' || lock_bucket::text, 4));
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


-- Validacao das invariantes. Roda na mesma transacao da migration: qualquer
-- falha aqui aborta tudo e nada e aplicado pela metade.
--
-- Os perfis de teste vem de `md5(n::text)::uuid` e nao de `gen_random_uuid()`:
-- um LATERAL que nao referencia a linha externa e avaliado UMA vez pelo planner,
-- e as 10.000 amostras saiam com o mesmo UUID. Os tres primeiros testes passavam
-- assim mesmo -- so o de distribuicao pegou. Derivar do contador resolve as duas
-- coisas: varia por linha e o teste fica reproduzivel.
do $tests$
declare
  total integer := 10000;
  fora_do_intervalo integer;
  instavel integer;
  fora_do_balde_zero integer;
  menor_balde integer;
  maior_balde integer;
begin
  -- 1. Balde sempre dentro de [0, N). E o teste que pega o erro de sinal: com
  --    `abs(h) % n` no lugar da aritmetica atual, o menor bigint estouraria aqui.
  select count(*) into fora_do_intervalo
  from generate_series(1, total) as serie(n)
  cross join lateral (select (md5(serie.n::text))::uuid as profile_id) as amostra
  where public.publication_dispatch_lock_bucket(amostra.profile_id, 8) not between 0 and 7;
  if fora_do_intervalo <> 0 then
    raise exception 'balde fora de [0,8) em % de % perfis', fora_do_intervalo, total;
  end if;

  -- 2. Estavel: o mesmo perfil cai sempre no mesmo balde. Se isto falhar, dois
  --    despachos do mesmo perfil pegam locks diferentes e a serializacao por
  --    perfil -- de que dependem as checagens de intervalo minimo e de 24h --
  --    deixa de existir.
  select count(*) into instavel
  from generate_series(1, total) as serie(n)
  cross join lateral (select (md5(serie.n::text))::uuid as profile_id) as amostra
  where public.publication_dispatch_lock_bucket(amostra.profile_id, 8)
     is distinct from public.publication_dispatch_lock_bucket(amostra.profile_id, 8);
  if instavel <> 0 then
    raise exception 'balde instavel para % perfis', instavel;
  end if;

  -- 3. shards = 1 colapsa tudo no balde 0, isto e, a reversao documentada no
  --    cabecalho realmente reproduz o lock unico por organizacao.
  select count(*) into fora_do_balde_zero
  from generate_series(1, total) as serie(n)
  cross join lateral (select (md5(serie.n::text))::uuid as profile_id) as amostra
  where public.publication_dispatch_lock_bucket(amostra.profile_id, 1) <> 0;
  if fora_do_balde_zero <> 0 then
    raise exception 'shards=1 nao colapsou: % perfis fora do balde 0', fora_do_balde_zero;
  end if;

  -- 4. Distribuicao nao degenerada. Um hash que jogasse tudo em poucos baldes
  --    passaria nos tres testes acima sem dividir contencao nenhuma.
  select min(quantos), max(quantos) into menor_balde, maior_balde
  from (
    select count(*) as quantos
    from generate_series(1, total) as serie(n)
    cross join lateral (select (md5(serie.n::text))::uuid as profile_id) as amostra
    group by public.publication_dispatch_lock_bucket(amostra.profile_id, 8)
  ) as distribuicao;

  if menor_balde < total / 8 / 2 or maior_balde > total / 8 * 2 then
    raise exception 'distribuicao degenerada: menor balde %, maior %, esperado ~%',
      menor_balde, maior_balde, total / 8;
  end if;

  raise notice 'balde de despacho validado: % perfis, menor balde %, maior %, esperado ~%',
    total, menor_balde, maior_balde, total / 8;
end;
$tests$;

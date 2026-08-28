-- Analytics X v2: projeções tipadas, coletas identificáveis e eligibility em profundidade.

create type public.twitter_analytics_collection_stage as enum (
  'followers_daily', 'd1', 'd7', 'd30', 'forced'
);

alter table public.twitter_analytics_items
  add column collection_key text,
  add column collection_stage public.twitter_analytics_collection_stage,
  add column requested_from date,
  add column requested_to date,
  add column force_refresh boolean not null default false;

update public.twitter_analytics_items
set collection_stage = case
      when resource_type = 'profile' then 'followers_daily'::public.twitter_analytics_collection_stage
      else 'd1'::public.twitter_analytics_collection_stage
    end,
    requested_from = (created_at at time zone 'America/Sao_Paulo')::date,
    requested_to = (created_at at time zone 'America/Sao_Paulo')::date,
    collection_key = 'legacy:' || id::text;

alter table public.twitter_analytics_items
  alter column collection_key set not null,
  alter column collection_stage set not null,
  add constraint twitter_analytics_items_collection_key_check
    check (char_length(trim(collection_key)) between 8 and 500),
  add constraint twitter_analytics_items_requested_window_check
    check (requested_from is null or requested_to is null or requested_from <= requested_to),
  add constraint twitter_analytics_items_stage_resource_check check (
    (resource_type = 'profile' and collection_stage in ('followers_daily', 'forced'))
    or (resource_type = 'post' and collection_stage in ('d1', 'd7', 'd30', 'forced'))
  );

create index twitter_analytics_items_collection_lookup_idx
  on public.twitter_analytics_items (organization_id, collection_key, created_at desc);

create unique index twitter_analytics_one_normal_collection_idx
  on public.twitter_analytics_items (organization_id, collection_key)
  where force_refresh = false and status in ('reserved', 'processing', 'succeeded', 'outcome_unknown');

create table public.twitter_profile_follower_daily_metrics (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  profile_id uuid not null references public.twitter_profiles(id) on delete restrict,
  connection_id uuid not null references public.twitter_connections(id) on delete restrict,
  metric_date date not null,
  snapshot_date date generated always as (metric_date) stored,
  followers_count bigint not null check (followers_count >= 0),
  analytics_item_id uuid not null references public.twitter_analytics_items(id) on delete restrict,
  snapshot_id uuid not null references public.twitter_analytics_snapshots(id) on delete restrict,
  provider_updated_at timestamptz,
  captured_at timestamptz not null,
  raw_metric jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_metric) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, profile_id, metric_date)
);

create index twitter_profile_follower_daily_metrics_profile_idx
  on public.twitter_profile_follower_daily_metrics (organization_id, profile_id, metric_date desc);

create table public.twitter_post_analytics_current (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  publication_item_id uuid not null references public.twitter_publication_items(id) on delete restrict,
  profile_id uuid not null references public.twitter_profiles(id) on delete restrict,
  connection_id uuid not null references public.twitter_connections(id) on delete restrict,
  published_at timestamptz not null,
  content text not null,
  platform_post_url text,
  collection_stage public.twitter_analytics_collection_stage not null
    check (collection_stage in ('d1', 'd7', 'd30', 'forced')),
  impressions bigint not null default 0 check (impressions >= 0),
  views bigint not null default 0 check (views >= 0),
  likes bigint not null default 0 check (likes >= 0),
  comments bigint not null default 0 check (comments >= 0),
  shares bigint not null default 0 check (shares >= 0),
  replies bigint not null default 0 check (replies >= 0),
  bookmarks bigint not null default 0 check (bookmarks >= 0),
  quotes bigint not null default 0 check (quotes >= 0),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  analytics_item_id uuid not null references public.twitter_analytics_items(id) on delete restrict,
  snapshot_id uuid not null references public.twitter_analytics_snapshots(id) on delete restrict,
  provider_updated_at timestamptz,
  captured_at timestamptz not null,
  raw_metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_metrics) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, publication_item_id)
);

create index twitter_post_analytics_current_ranking_idx
  on public.twitter_post_analytics_current (organization_id, impressions desc, captured_at desc);
create index twitter_post_analytics_current_profile_idx
  on public.twitter_post_analytics_current (organization_id, profile_id, captured_at desc);

create trigger twitter_profile_follower_daily_metrics_updated
  before update on public.twitter_profile_follower_daily_metrics
  for each row execute function public.set_updated_at();
create trigger twitter_post_analytics_current_updated
  before update on public.twitter_post_analytics_current
  for each row execute function public.set_updated_at();

create function public.twitter_analytics_post_metrics(p_metrics jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare source jsonb;
begin
  if jsonb_typeof(p_metrics -> 'data') = 'object' then return p_metrics -> 'data'; end if;
  if jsonb_typeof(p_metrics -> 'analytics') = 'object' then return p_metrics -> 'analytics'; end if;
  if jsonb_typeof(p_metrics -> 'platformAnalytics') = 'array' then
    select value -> 'analytics' into source
    from jsonb_array_elements(p_metrics -> 'platformAnalytics')
    where value ->> 'platform' = 'twitter' and jsonb_typeof(value -> 'analytics') = 'object'
    limit 1;
    if source is not null then return source; end if;
  end if;
  return p_metrics;
end $$;

create function public.twitter_analytics_metric_bigint(p_metrics jsonb, p_keys text[])
returns bigint language plpgsql immutable set search_path = public as $$
declare key text; value_text text; source jsonb;
begin
  source := public.twitter_analytics_post_metrics(p_metrics);
  foreach key in array p_keys loop
    value_text := coalesce(source ->> key, p_metrics ->> key);
    if value_text ~ '^\s*[0-9]+\s*$' then return trim(value_text)::bigint; end if;
  end loop;
  return 0;
end $$;

create function public.twitter_project_analytics_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  item public.twitter_analytics_items;
  publication public.twitter_publication_items;
  series jsonb;
  point jsonb;
  metric_day date;
  metric_count bigint;
  normalized_post_metrics jsonb;
begin
  select * into item from public.twitter_analytics_items where id = new.analytics_item_id;
  if not found or jsonb_typeof(new.metrics) <> 'object' then return new; end if;
  if item.resource_type = 'profile' then
    if jsonb_typeof(new.metrics #> '{metrics,follower_count,values}') = 'array' then
      series := new.metrics #> '{metrics,follower_count,values}';
    elsif jsonb_typeof(new.metrics -> 'data') = 'array' then series := new.metrics -> 'data';
    elsif jsonb_typeof(new.metrics -> 'data') = 'object' then series := jsonb_build_array(new.metrics -> 'data');
    elsif jsonb_typeof(new.metrics -> 'stats') = 'array' then series := new.metrics -> 'stats';
    elsif jsonb_typeof(new.metrics -> 'stats') = 'object' then
      select value into series from jsonb_each(new.metrics -> 'stats') where jsonb_typeof(value) = 'array' limit 1;
    elsif jsonb_typeof(new.metrics -> 'followers') = 'array' then series := new.metrics -> 'followers';
    elsif jsonb_typeof(new.metrics -> 'history') = 'array' then series := new.metrics -> 'history';
    elsif jsonb_typeof(new.metrics -> 'accounts') = 'array' then series := new.metrics -> 'accounts';
    elsif public.twitter_analytics_metric_bigint(new.metrics #> '{metrics,follower_count}', array['total']) > 0 then
      series := jsonb_build_array(jsonb_build_object(
        'date', coalesce(new.metrics #>> '{dateRange,until}', new.metrics ->> 'until', new.metrics ->> 'toDate'),
        'value', public.twitter_analytics_metric_bigint(new.metrics #> '{metrics,follower_count}', array['total'])
      ));
    elsif public.twitter_analytics_metric_bigint(new.metrics, array['followers_count', 'followersCount', 'follower_count', 'followerCount', 'current_followers', 'currentFollowers', 'followers', 'count', 'value']) > 0 then
      series := jsonb_build_array(new.metrics);
    else series := '[]'::jsonb;
    end if;
    for point in select value from jsonb_array_elements(series) where jsonb_typeof(value) = 'object' loop
      begin
        metric_day := coalesce(
          nullif(point ->> 'date', '')::date,
          nullif(point ->> 'day', '')::date,
          nullif(point ->> 'metric_date', '')::date,
          (coalesce(new.provider_updated_at, new.captured_at) at time zone 'America/Sao_Paulo')::date
        );
      exception when invalid_datetime_format or datetime_field_overflow then
        metric_day := (coalesce(new.provider_updated_at, new.captured_at) at time zone 'America/Sao_Paulo')::date;
      end;
      metric_count := public.twitter_analytics_metric_bigint(
        point, array['followers_count', 'followersCount', 'follower_count', 'followerCount', 'current_followers', 'currentFollowers', 'followers', 'count', 'value']
      );
      insert into public.twitter_profile_follower_daily_metrics(
        organization_id, profile_id, connection_id, metric_date, followers_count, analytics_item_id,
        snapshot_id, provider_updated_at, captured_at, raw_metric
      ) values (
        new.organization_id, new.profile_id, item.connection_id, metric_day, metric_count, item.id,
        new.id, new.provider_updated_at, new.captured_at, point
      )
      on conflict (organization_id, profile_id, metric_date) do update set
        connection_id = excluded.connection_id,
        followers_count = excluded.followers_count,
        analytics_item_id = excluded.analytics_item_id,
        snapshot_id = excluded.snapshot_id,
        provider_updated_at = excluded.provider_updated_at,
        captured_at = excluded.captured_at,
        raw_metric = excluded.raw_metric
      where excluded.captured_at >= public.twitter_profile_follower_daily_metrics.captured_at;
    end loop;
  elsif item.publication_item_id is not null then
    select * into publication from public.twitter_publication_items where id = item.publication_item_id;
    normalized_post_metrics := public.twitter_analytics_post_metrics(new.metrics);
    insert into public.twitter_post_analytics_current(
      organization_id, publication_item_id, profile_id, connection_id, published_at,
      content, platform_post_url, collection_stage,
      impressions, views, likes, comments, shares, replies, bookmarks, quotes,
      metrics, analytics_item_id, snapshot_id, provider_updated_at, captured_at, raw_metrics
    ) values (
      new.organization_id, item.publication_item_id, new.profile_id, item.connection_id,
      publication.execute_at, coalesce(new.metrics ->> 'content', publication.content),
      nullif(coalesce(new.metrics ->> 'platformPostUrl', new.metrics ->> 'platform_post_url'), ''),
      case when item.force_refresh then 'forced'::public.twitter_analytics_collection_stage else item.collection_stage end,
      public.twitter_analytics_metric_bigint(new.metrics, array['impressions', 'impression_count']),
      public.twitter_analytics_metric_bigint(new.metrics, array['views', 'view_count']),
      public.twitter_analytics_metric_bigint(new.metrics, array['likes', 'like_count']),
      public.twitter_analytics_metric_bigint(new.metrics, array['comments', 'comment_count']),
      public.twitter_analytics_metric_bigint(new.metrics, array['shares', 'share_count', 'retweets', 'retweet_count']),
      public.twitter_analytics_metric_bigint(new.metrics, array['replies', 'reply_count']),
      public.twitter_analytics_metric_bigint(new.metrics, array['bookmarks', 'bookmark_count']),
      public.twitter_analytics_metric_bigint(new.metrics, array['quotes', 'quote_count']),
      normalized_post_metrics, item.id, new.id, new.provider_updated_at, new.captured_at, new.metrics
    )
    on conflict (organization_id, publication_item_id) do update set
      profile_id = excluded.profile_id, connection_id = excluded.connection_id,
      published_at = excluded.published_at, content = excluded.content,
      platform_post_url = excluded.platform_post_url, collection_stage = excluded.collection_stage,
      impressions = excluded.impressions, views = excluded.views, likes = excluded.likes,
      comments = excluded.comments, shares = excluded.shares, replies = excluded.replies,
      bookmarks = excluded.bookmarks, quotes = excluded.quotes,
      metrics = excluded.metrics,
      analytics_item_id = excluded.analytics_item_id, snapshot_id = excluded.snapshot_id,
      provider_updated_at = excluded.provider_updated_at, captured_at = excluded.captured_at,
      raw_metrics = excluded.raw_metrics
    where excluded.captured_at >= public.twitter_post_analytics_current.captured_at;
  end if;
  return new;
end $$;

create trigger twitter_analytics_snapshots_project_typed
  after insert or update of metrics, provider_updated_at, captured_at on public.twitter_analytics_snapshots
  for each row execute function public.twitter_project_analytics_snapshot();

-- Projeta também o histórico bruto anterior à instalação desta migration.
update public.twitter_analytics_snapshots set metrics = metrics;

create or replace function public.twitter_confirm_analytics_job(
  p_organization_id uuid, p_actor_user_id uuid, p_idempotency_key text,
  p_quote_digest text, p_rate_card_version integer, p_wallet_snapshots jsonb, p_resources jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  existing public.twitter_analytics_jobs; job public.twitter_analytics_jobs; card public.twitter_rate_cards;
  requested jsonb; normalized_resource jsonb; normalized jsonb := '[]'::jsonb; row record;
  wallet public.twitter_wallets; expected_version bigint; reservation jsonb; reservation_id uuid;
  total bigint := 0; count_resources integer := 0; stage public.twitter_analytics_collection_stage;
  requested_from date; requested_to date; force_refresh boolean; collection_key text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception using errcode = '42501'; end if;
  select * into existing from public.twitter_analytics_jobs
  where organization_id = p_organization_id and idempotency_key = trim(p_idempotency_key);
  if found then return jsonb_build_object('jobId', existing.id, 'idempotentReplay', true, 'reservedMicros', existing.reserved_micros); end if;
  if jsonb_typeof(p_resources) <> 'array' or jsonb_array_length(p_resources) = 0 or jsonb_array_length(p_resources) > 1000 then
    raise exception using errcode = '22023', message = 'Recursos de analytics inválidos.';
  end if;
  select * into card from public.twitter_rate_cards where active and version = p_rate_card_version;
  if not found then raise exception using errcode = '40001', message = 'Tabela de preços mudou; revise novamente.'; end if;

  for requested in select value from jsonb_array_elements(p_resources) loop
    force_refresh := coalesce((requested ->> 'forceRefresh')::boolean, (requested ->> 'force_refresh')::boolean, false);
    begin requested_from := coalesce(requested ->> 'requestedFrom', requested ->> 'requested_from')::date;
    exception when invalid_datetime_format or datetime_field_overflow then raise exception using errcode = '22023', message = 'Janela de analytics inválida.'; end;
    begin requested_to := coalesce(requested ->> 'requestedTo', requested ->> 'requested_to')::date;
    exception when invalid_datetime_format or datetime_field_overflow then raise exception using errcode = '22023', message = 'Janela de analytics inválida.'; end;

    if requested ->> 'type' = 'post' then
      stage := coalesce(
        nullif(lower(coalesce(requested ->> 'collectionStage', requested ->> 'collection_stage', requested ->> 'stage', '')), '')::public.twitter_analytics_collection_stage,
        'd1'
      );
      if stage not in ('d1', 'd7', 'd30', 'forced') then raise exception using errcode = '22023', message = 'Estágio de post inválido.'; end if;
      if force_refresh then stage := 'forced'; end if;
      requested_from := coalesce(requested_from, (timezone('America/Sao_Paulo', now()))::date);
      requested_to := coalesce(requested_to, requested_from);
      select jsonb_build_object(
        'resource_type','post','resource_key','post:'||i.id,'identity_id',i.identity_id,
        'connection_id',i.connection_id,'profile_id',i.profile_id,'publication_item_id',i.id,
        'zernio_post_id',a.post_id,'category','post_read','unit_cost_micros',r.unit_cost_micros,
        'reserved_units',9,'amount_micros',r.unit_cost_micros*9
      ) into normalized_resource
      from public.twitter_publication_items i
      join public.twitter_profiles p on p.id = i.profile_id and p.organization_id = i.organization_id
      join public.twitter_profile_connection_epochs e on e.id = p.current_epoch_id and e.connection_id = i.connection_id and e.ended_at is null
      join public.twitter_connections c on c.id = e.connection_id and c.organization_id = i.organization_id
      join lateral (select pa.post_id from public.twitter_publication_attempts pa where pa.item_id=i.id and pa.status='published' and pa.post_id is not null order by pa.created_at desc limit 1) a on true
      join public.twitter_cost_rates r on r.rate_card_id=card.id and r.category='post_read'
      where i.id=(requested->>'id')::uuid and i.organization_id=p_organization_id and i.status='published'
        and p.deleted_at is null and p.can_fetch_analytics and p.current_connection_id=c.id
        and c.analytics_enabled and c.status='active' and c.deleted_at is null;
      collection_key := coalesce(nullif(trim(requested ->> 'collectionKey'), ''), nullif(trim(requested ->> 'collection_key'), ''), 'post:'||(requested->>'id')||':'||stage::text);
    elsif requested ->> 'type' = 'profile' then
      stage := case when force_refresh then 'forced'::public.twitter_analytics_collection_stage else 'followers_daily'::public.twitter_analytics_collection_stage end;
      requested_to := coalesce(requested_to, (timezone('America/Sao_Paulo', now()))::date - 1);
      requested_from := coalesce(requested_from, requested_to);
      select jsonb_build_object(
        'resource_type','profile','resource_key','profile:'||p.id,'identity_id',c.identity_id,
        'connection_id',e.connection_id,'profile_id',p.id,'publication_item_id',null,
        'zernio_post_id',null,'category','user_read_follow_article','unit_cost_micros',r.unit_cost_micros,
        'reserved_units',1,'amount_micros',r.unit_cost_micros
      ) into normalized_resource
      from public.twitter_profiles p
      join public.twitter_profile_connection_epochs e on e.id=p.current_epoch_id and e.ended_at is null
      join public.twitter_connections c on c.id=e.connection_id and c.organization_id=p.organization_id
      join public.twitter_cost_rates r on r.rate_card_id=card.id and r.category='user_read_follow_article'
      where p.id=(requested->>'id')::uuid and p.organization_id=p_organization_id and p.deleted_at is null
        and p.can_fetch_analytics and p.current_connection_id=c.id
        and c.analytics_enabled and c.status='active' and c.deleted_at is null;
      collection_key := coalesce(nullif(trim(requested ->> 'collectionKey'), ''), nullif(trim(requested ->> 'collection_key'), ''), 'profile:'||(requested->>'id')||':followers:'||requested_from||':'||requested_to);
    else raise exception using errcode='22023',message='Tipo de analytics inválido.'; end if;
    if normalized_resource is null then raise exception using errcode='22023',message='Recurso de analytics indisponível ou sem eligibility.'; end if;
    if requested_from > requested_to or char_length(collection_key) not between 8 and 500 then raise exception using errcode='22023',message='Identidade ou janela da coleta inválida.'; end if;
    if not force_refresh and exists(select 1 from public.twitter_analytics_items i where i.organization_id=p_organization_id and i.collection_key=collection_key and i.force_refresh=false and i.status in('reserved','processing','succeeded','outcome_unknown')) then
      raise exception using errcode='23505',message='Esta coleta normal já está ativa ou concluída.';
    end if;
    normalized_resource := normalized_resource || jsonb_build_object('collection_key',collection_key,'collection_stage',stage,'requested_from',requested_from,'requested_to',requested_to,'force_refresh',force_refresh);
    normalized := normalized || jsonb_build_array(normalized_resource); total := total + (normalized_resource->>'amount_micros')::bigint; count_resources := count_resources + 1;
  end loop;
  if (select count(distinct value->>'collection_key') from jsonb_array_elements(normalized)) <> count_resources then raise exception using errcode='22023',message='Coletas duplicadas.'; end if;

  insert into public.twitter_analytics_jobs(organization_id,resource_count,reserved_micros,rate_card_id,rate_card_version,quote_digest,idempotency_key,created_by)
  values(p_organization_id,count_resources,total,card.id,card.version,p_quote_digest,trim(p_idempotency_key),p_actor_user_id) returning * into job;
  for row in select x.identity_id,x.connection_id,x.category,sum(x.amount_micros)::bigint cost from jsonb_to_recordset(normalized) as x(identity_id uuid,connection_id uuid,category public.twitter_price_category,amount_micros bigint) group by x.identity_id,x.connection_id,x.category order by x.identity_id,x.category loop
    select * into wallet from public.twitter_wallets where identity_id=row.identity_id and organization_id=p_organization_id for update;
    if not found then raise exception using errcode='P0002',message='Carteira de analytics ausente.'; end if;
    select (s->>'walletVersion')::bigint into expected_version from jsonb_array_elements(p_wallet_snapshots)s where s->>'identityId'=row.identity_id::text;
    if expected_version is null or expected_version<>wallet.version then raise exception using errcode='40001',message='Carteira mudou; revise novamente.'; end if;
    if wallet.posted_balance_micros-wallet.reserved_micros-row.cost<5000000 then raise exception using errcode='P0001',message='Piso protegido de US$ 5,00 impede esta análise.'; end if;
    reservation:=public.twitter_create_wallet_reservation(p_organization_id,row.identity_id,row.connection_id,card.version,row.category,'analytics',job.id,row.cost,wallet.version,'analytics:'||job.id||':'||row.identity_id||':'||row.category);
    reservation_id:=(reservation->>'reservationId')::uuid;
    insert into public.twitter_analytics_job_reservations values(job.id,reservation_id,row.identity_id,row.category);
    select * into wallet from public.twitter_wallets where identity_id=row.identity_id for update;
    p_wallet_snapshots:=coalesce((select jsonb_agg(case when s->>'identityId'=row.identity_id::text then jsonb_set(s,'{walletVersion}',to_jsonb(wallet.version)) else s end) from jsonb_array_elements(p_wallet_snapshots)s),'[]');
  end loop;
  insert into public.twitter_analytics_items(job_id,organization_id,resource_type,resource_key,identity_id,connection_id,profile_id,publication_item_id,zernio_post_id,category,amount_micros,unit_cost_micros,reserved_units,billing_contract_version,collection_key,collection_stage,requested_from,requested_to,force_refresh)
  select job.id,p_organization_id,x.resource_type,x.resource_key,x.identity_id,x.connection_id,x.profile_id,x.publication_item_id,x.zernio_post_id,x.category,x.amount_micros,x.unit_cost_micros,x.reserved_units,2,x.collection_key,x.collection_stage,x.requested_from,x.requested_to,x.force_refresh
  from jsonb_to_recordset(normalized) as x(resource_type public.twitter_analytics_resource_type,resource_key text,identity_id uuid,connection_id uuid,profile_id uuid,publication_item_id uuid,zernio_post_id text,category public.twitter_price_category,amount_micros bigint,unit_cost_micros bigint,reserved_units integer,collection_key text,collection_stage public.twitter_analytics_collection_stage,requested_from date,requested_to date,force_refresh boolean);
  return jsonb_build_object('jobId',job.id,'resourceCount',count_resources,'reservedMicros',total,'idempotentReplay',false);
end $$;

drop function public.twitter_claim_analytics_items(text,integer);
create function public.twitter_claim_analytics_items(p_worker_id text,p_limit integer)
returns table(item_id uuid,attempt_id uuid,organization_id uuid,job_id uuid,resource_type public.twitter_analytics_resource_type,resource_id uuid,profile_id uuid,connection_id uuid,zernio_post_id text,amount_micros bigint,collection_stage public.twitter_analytics_collection_stage,requested_from date,requested_to date,force_refresh boolean)
language plpgsql security definer set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
 return query with candidates as (
  select i.id from public.twitter_analytics_items i
  join public.twitter_connections c on c.id=i.connection_id and c.organization_id=i.organization_id
  join public.twitter_profiles p on p.id=i.profile_id and p.organization_id=i.organization_id
  join public.twitter_profile_connection_epochs e on e.id=p.current_epoch_id and e.connection_id=c.id and e.ended_at is null
  where i.status='reserved' and c.analytics_enabled and c.status='active' and c.deleted_at is null
    and p.can_fetch_analytics and p.deleted_at is null and p.current_connection_id=c.id
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

-- Desligar analytics cancela apenas itens ainda não enviados. Processing/outcome_unknown
-- permanecem intactos para não liberar dinheiro cujo resultado financeiro seja incerto.
create function public.twitter_cancel_reserved_analytics_on_disable()
returns trigger language plpgsql security definer set search_path=public as $$
declare item record; reservation_row public.twitter_wallet_reservations;
begin
 if old.analytics_enabled and not new.analytics_enabled then
  for item in select i.* from public.twitter_analytics_items i where i.connection_id=new.id and i.status='reserved' order by i.created_at,i.id for update loop
   select wr.* into reservation_row from public.twitter_analytics_job_reservations jr join public.twitter_wallet_reservations wr on wr.id=jr.reservation_id where jr.job_id=item.job_id and jr.identity_id=item.identity_id and jr.category=item.category for update;
   update public.twitter_wallet_reservations set remaining_micros=remaining_micros-item.amount_micros,released_micros=released_micros+item.amount_micros,status=case when remaining_micros-item.amount_micros=0 and settled_micros>0 then 'settled'::public.twitter_reservation_status when remaining_micros-item.amount_micros=0 then 'released'::public.twitter_reservation_status else 'partially_settled'::public.twitter_reservation_status end,resolved_at=case when remaining_micros-item.amount_micros=0 then timezone('utc',now()) else resolved_at end where id=reservation_row.id;
   update public.twitter_wallets set reserved_micros=reserved_micros-item.amount_micros,version=version+1 where identity_id=item.identity_id and organization_id=item.organization_id;
   insert into public.twitter_reservation_events(reservation_id,organization_id,event_type,amount_micros,idempotency_key,reason,metadata) values(reservation_row.id,item.organization_id,'released',item.amount_micros,'analytics-disabled:'||item.id,'Analytics desabilitado antes do claim.',jsonb_build_object('analyticsItemId',item.id,'connectionId',new.id));
   update public.twitter_analytics_items set status='cancelled',result_code='analytics_disabled',error_message='Analytics desabilitado antes do claim.',released_micros=item.amount_micros where id=item.id;
  end loop;
  update public.twitter_analytics_jobs j set status=case when exists(select 1 from public.twitter_analytics_items x where x.job_id=j.id and x.status in('reserved','processing')) then 'processing'::public.twitter_analytics_job_status when exists(select 1 from public.twitter_analytics_items x where x.job_id=j.id and x.status='outcome_unknown') then 'outcome_unknown'::public.twitter_analytics_job_status when exists(select 1 from public.twitter_analytics_items x where x.job_id=j.id and x.status='succeeded') then 'partially_succeeded'::public.twitter_analytics_job_status else 'cancelled'::public.twitter_analytics_job_status end,finished_at=case when not exists(select 1 from public.twitter_analytics_items x where x.job_id=j.id and x.status in('reserved','processing')) then timezone('utc',now()) else null end where j.id in(select distinct i.job_id from public.twitter_analytics_items i where i.connection_id=new.id and i.status='cancelled');
 end if;
 return new;
end $$;

create trigger twitter_connections_cancel_reserved_analytics
  after update of analytics_enabled on public.twitter_connections
  for each row when (old.analytics_enabled is true and new.analytics_enabled is false)
  execute function public.twitter_cancel_reserved_analytics_on_disable();

alter table public.twitter_profile_follower_daily_metrics enable row level security;
alter table public.twitter_post_analytics_current enable row level security;
create policy twitter_profile_follower_daily_metrics_select on public.twitter_profile_follower_daily_metrics for select to authenticated using(public.is_organization_member(organization_id));
create policy twitter_post_analytics_current_select on public.twitter_post_analytics_current for select to authenticated using(public.is_organization_member(organization_id));
revoke all on table public.twitter_profile_follower_daily_metrics,public.twitter_post_analytics_current from anon,authenticated;
grant select on public.twitter_profile_follower_daily_metrics,public.twitter_post_analytics_current to authenticated;
grant all on public.twitter_profile_follower_daily_metrics,public.twitter_post_analytics_current to service_role;
revoke all on function public.twitter_analytics_post_metrics(jsonb),public.twitter_analytics_metric_bigint(jsonb,text[]),public.twitter_project_analytics_snapshot(),public.twitter_cancel_reserved_analytics_on_disable() from public,anon,authenticated;
revoke all on function public.twitter_confirm_analytics_job(uuid,uuid,text,text,integer,jsonb,jsonb),public.twitter_claim_analytics_items(text,integer) from public,anon,authenticated;
grant execute on function public.twitter_confirm_analytics_job(uuid,uuid,text,text,integer,jsonb,jsonb),public.twitter_claim_analytics_items(text,integer) to service_role;

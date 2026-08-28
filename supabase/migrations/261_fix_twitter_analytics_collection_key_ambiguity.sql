-- Qualifica a chave local da coleta para evitar colisão com a coluna homônima.

create or replace function public.twitter_confirm_analytics_job(
  p_organization_id uuid, p_actor_user_id uuid, p_idempotency_key text,
  p_quote_digest text, p_rate_card_version integer, p_wallet_snapshots jsonb, p_resources jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  existing public.twitter_analytics_jobs; job public.twitter_analytics_jobs; card public.twitter_rate_cards;
  requested jsonb; normalized_resource jsonb; normalized jsonb := '[]'::jsonb; row record;
  wallet public.twitter_wallets; expected_version bigint; reservation jsonb; reservation_id uuid;
  total bigint := 0; count_resources integer := 0; stage public.twitter_analytics_collection_stage;
  requested_from date; requested_to date; force_refresh boolean; v_collection_key text;
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
      v_collection_key := coalesce(nullif(trim(requested ->> 'collectionKey'), ''), nullif(trim(requested ->> 'collection_key'), ''), 'post:'||(requested->>'id')||':'||stage::text);
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
      v_collection_key := coalesce(nullif(trim(requested ->> 'collectionKey'), ''), nullif(trim(requested ->> 'collection_key'), ''), 'profile:'||(requested->>'id')||':followers:'||requested_from||':'||requested_to);
    else raise exception using errcode='22023',message='Tipo de analytics inválido.'; end if;
    if normalized_resource is null then raise exception using errcode='22023',message='Recurso de analytics indisponível ou sem eligibility.'; end if;
    if requested_from > requested_to or char_length(v_collection_key) not between 8 and 500 then raise exception using errcode='22023',message='Identidade ou janela da coleta inválida.'; end if;
    if not force_refresh and exists(select 1 from public.twitter_analytics_items i where i.organization_id=p_organization_id and i.collection_key=v_collection_key and i.force_refresh=false and i.status in('reserved','processing','succeeded','outcome_unknown')) then
      raise exception using errcode='23505',message='Esta coleta normal já está ativa ou concluída.';
    end if;
    normalized_resource := normalized_resource || jsonb_build_object('collection_key',v_collection_key,'collection_stage',stage,'requested_from',requested_from,'requested_to',requested_to,'force_refresh',force_refresh);
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


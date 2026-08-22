-- Módulo X/Twitter: programas em massa, itens financiados e excedente compacto.

create type public.twitter_program_status as enum ('confirmed','cancelled','completed');
create type public.twitter_schedule_kind as enum ('interval','daily');
create type public.twitter_item_status as enum ('ready','claimed','retry','outcome_unknown','published','failed','cancelled');
create type public.twitter_program_media_kind as enum ('images','gif','video');

create table public.twitter_programs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  status public.twitter_program_status not null default 'confirmed',
  schedule_kind public.twitter_schedule_kind not null,
  timezone text not null default 'America/Sao_Paulo' check (timezone = 'America/Sao_Paulo'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  interval_minutes integer check (interval_minutes is null or interval_minutes >= 1),
  daily_time time,
  total_requested bigint not null check (total_requested >= 0),
  funded_count integer not null check (funded_count >= 0),
  unfunded_count bigint not null check (unfunded_count >= 0),
  reserved_micros bigint not null check (reserved_micros >= 0),
  rate_card_id uuid not null references public.twitter_rate_cards(id) on delete restrict,
  rate_card_version integer not null,
  review_digest text not null check (review_digest ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 255),
  created_by uuid not null references auth.users(id) on delete restrict,
  cancelled_at timestamptz,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now()),
  unique(organization_id,idempotency_key),
  check (ends_at >= starts_at),
  check (funded_count::bigint + unfunded_count = total_requested),
  check ((schedule_kind='interval' and interval_minutes is not null and daily_time is null) or (schedule_kind='daily' and daily_time is not null and interval_minutes is null))
);

create table public.twitter_program_texts (
  program_id uuid not null references public.twitter_programs(id) on delete restrict,
  text_index integer not null check (text_index >= 0),
  content text not null check (char_length(content) > 0),
  weighted_characters integer not null check (weighted_characters between 1 and 25000),
  contains_url boolean not null,
  primary key(program_id,text_index)
);

create table public.twitter_program_media_sets (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.twitter_programs(id) on delete restrict,
  client_key text not null check (char_length(client_key) between 1 and 100),
  set_index integer not null check (set_index >= 0),
  media_kind public.twitter_program_media_kind not null,
  unique(program_id,client_key), unique(program_id,set_index)
);

create table public.twitter_program_media_set_assets (
  media_set_id uuid not null references public.twitter_program_media_sets(id) on delete restrict,
  asset_id uuid not null references public.twitter_media_assets(id) on delete restrict,
  position integer not null check (position between 0 and 3),
  primary key(media_set_id,position), unique(media_set_id,asset_id)
);

create table public.twitter_program_shortfalls (
  program_id uuid not null references public.twitter_programs(id) on delete restrict,
  profile_id uuid not null references public.twitter_profiles(id) on delete restrict,
  requested_count bigint not null check(requested_count >= 0),
  funded_count integer not null check(funded_count >= 0),
  unfunded_count bigint not null check(unfunded_count >= 0),
  first_unfunded_at timestamptz,
  last_unfunded_at timestamptz,
  interval_minutes integer,
  primary key(program_id,profile_id),
  check(funded_count::bigint + unfunded_count = requested_count)
);

create table public.twitter_program_reservations (
  program_id uuid not null references public.twitter_programs(id) on delete restrict,
  reservation_id uuid not null unique references public.twitter_wallet_reservations(id) on delete restrict,
  identity_id uuid not null references public.twitter_global_identities(id) on delete restrict,
  category public.twitter_price_category not null,
  primary key(program_id,identity_id,category)
);

create table public.twitter_publication_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  program_id uuid not null references public.twitter_programs(id) on delete restrict,
  profile_id uuid not null references public.twitter_profiles(id) on delete restrict,
  connection_epoch_id uuid not null references public.twitter_profile_connection_epochs(id) on delete restrict,
  connection_id uuid not null references public.twitter_connections(id) on delete restrict,
  identity_id uuid not null references public.twitter_global_identities(id) on delete restrict,
  slot_index bigint not null check(slot_index >= 0),
  execute_at timestamptz not null,
  content text not null,
  weighted_characters integer not null check(weighted_characters between 1 and 25000),
  media_set_client_key text,
  category public.twitter_price_category not null check(category in ('post_dm_create','post_create_url')),
  amount_micros bigint not null check(amount_micros in (15000,200000)),
  status public.twitter_item_status not null default 'ready',
  attempt_count integer not null default 0 check(attempt_count >= 0),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  claimed_by text,
  idempotency_key text not null unique,
  cancelled_at timestamptz,
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now())
);
create index twitter_publication_items_claim_idx on public.twitter_publication_items(status,execute_at,id) where status in ('ready','retry');
create index twitter_publication_items_program_idx on public.twitter_publication_items(program_id,profile_id,execute_at);

create trigger twitter_programs_set_updated_at before update on public.twitter_programs for each row execute function public.set_updated_at();
create trigger twitter_publication_items_set_updated_at before update on public.twitter_publication_items for each row execute function public.set_updated_at();

create or replace function public.twitter_confirm_bulk_program(
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
  p_shortfalls jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  existing_program public.twitter_programs;
  program_row public.twitter_programs;
  rate_card public.twitter_rate_cards;
  snapshot jsonb;
  wallet public.twitter_wallets;
  set_payload jsonb;
  set_row public.twitter_program_media_sets;
  reservation_group record;
  reservation_id uuid;
  item_count integer := jsonb_array_length(coalesce(p_items,'[]'::jsonb));
  reserved_total bigint := 0;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501',message='Apenas service_role confirma programas X.'; end if;
  if char_length(coalesce(p_idempotency_key,'')) not between 8 and 255 or coalesce(p_review_digest,'') !~ '^[a-f0-9]{64}$' then raise exception using errcode='22023',message='Confirmação X inválida.'; end if;
  select * into existing_program from public.twitter_programs where organization_id=p_organization_id and idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('programId',existing_program.id,'idempotentReplay',true,'fundedCount',existing_program.funded_count,'reservedMicros',existing_program.reserved_micros); end if;
  if item_count < 1 or item_count > 20000 then raise exception using errcode='22023',message='Quantidade financiada inválida.'; end if;
  if (p_program->>'totalRequested')::bigint <> item_count::bigint + (p_program->>'unfundedCount')::bigint then raise exception using errcode='22023',message='Totais do programa X inválidos.'; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) i(category public.twitter_price_category,amount_micros bigint) where (i.category='post_dm_create' and i.amount_micros<>15000) or (i.category='post_create_url' and i.amount_micros<>200000)) then raise exception using errcode='22023',message='Preço de item X inválido.'; end if;
  select * into rate_card from public.twitter_rate_cards where active for share;
  if not found or rate_card.version <> p_rate_card_version then raise exception using errcode='40001',message='Tabela de preços mudou; revise novamente.'; end if;

  for snapshot in select value from jsonb_array_elements(coalesce(p_wallet_snapshots,'[]'::jsonb)) loop
    select * into wallet from public.twitter_wallets where identity_id=(snapshot->>'identityId')::uuid and organization_id=p_organization_id for update;
    if not found or wallet.version <> (snapshot->>'walletVersion')::bigint or wallet.posted_balance_micros-wallet.reserved_micros <> (snapshot->>'availableMicros')::bigint then
      raise exception using errcode='40001',message='Saldo ou reservas mudaram; revise novamente.';
    end if;
  end loop;

  if exists (
    select 1 from jsonb_to_recordset(p_items) as i(profile_id uuid,connection_id uuid,connection_epoch_id uuid,identity_id uuid)
    left join public.twitter_profiles p on p.id=i.profile_id and p.organization_id=p_organization_id and p.deleted_at is null and p.current_epoch_id=i.connection_epoch_id
    left join public.twitter_profile_connection_epochs e on e.id=i.connection_epoch_id and e.connection_id=i.connection_id and e.profile_id=i.profile_id and e.ended_at is null
    left join public.twitter_connections c on c.id=i.connection_id and c.identity_id=i.identity_id and c.organization_id=p_organization_id and c.deleted_at is null
    where p.id is null or e.id is null or c.id is null
  ) then raise exception using errcode='40001',message='Perfil ou conexão mudou; revise novamente.'; end if;

  for reservation_group in
    select i.identity_id,i.connection_id,i.category,sum(i.amount_micros)::bigint amount
    from jsonb_to_recordset(p_items) as i(identity_id uuid,connection_id uuid,category public.twitter_price_category,amount_micros bigint)
    group by i.identity_id,i.connection_id,i.category order by i.identity_id,i.category
  loop
    select * into wallet from public.twitter_wallets where identity_id=reservation_group.identity_id for update;
    if wallet.posted_balance_micros-wallet.reserved_micros < reservation_group.amount then raise exception using errcode='40001',message='Saldo insuficiente após concorrência; revise novamente.'; end if;
    reserved_total := reserved_total + reservation_group.amount;
  end loop;

  insert into public.twitter_programs(organization_id,schedule_kind,starts_at,ends_at,interval_minutes,daily_time,total_requested,funded_count,unfunded_count,reserved_micros,rate_card_id,rate_card_version,review_digest,idempotency_key,created_by)
  values(p_organization_id,(p_program->>'scheduleKind')::public.twitter_schedule_kind,(p_program->>'startsAt')::timestamptz,(p_program->>'endsAt')::timestamptz,nullif(p_program->>'intervalMinutes','')::integer,nullif(p_program->>'dailyTime','')::time,(p_program->>'totalRequested')::bigint,item_count,(p_program->>'unfundedCount')::bigint,reserved_total,rate_card.id,rate_card.version,p_review_digest,p_idempotency_key,p_actor_user_id)
  returning * into program_row;

  insert into public.twitter_program_texts(program_id,text_index,content,weighted_characters,contains_url)
  select program_row.id,x.text_index,x.content,x.weighted_characters,x.contains_url from jsonb_to_recordset(p_texts) x(text_index integer,content text,weighted_characters integer,contains_url boolean);
  for set_payload in select value from jsonb_array_elements(coalesce(p_media_sets,'[]'::jsonb)) loop
    if jsonb_array_length(coalesce(set_payload->'assetIds','[]'::jsonb)) < 1
      or ((set_payload->>'mediaKind')='images' and jsonb_array_length(set_payload->'assetIds') > 4)
      or ((set_payload->>'mediaKind') in ('gif','video') and jsonb_array_length(set_payload->'assetIds') <> 1)
      or exists(
        select 1 from jsonb_array_elements_text(set_payload->'assetIds') requested(asset_id)
        left join public.twitter_media_assets asset on asset.id=requested.asset_id::uuid and asset.organization_id=p_organization_id and asset.status='ready' and asset.deleted_at is null
        where asset.id is null or (set_payload->>'mediaKind') <> case asset.media_kind when 'image' then 'images' else asset.media_kind::text end
      )
    then raise exception using errcode='22023',message='Conjunto de mídia X inválido.'; end if;
    insert into public.twitter_program_media_sets(program_id,client_key,set_index,media_kind) values(program_row.id,set_payload->>'clientKey',(set_payload->>'setIndex')::integer,(set_payload->>'mediaKind')::public.twitter_program_media_kind) returning * into set_row;
    insert into public.twitter_program_media_set_assets(media_set_id,asset_id,position)
    select set_row.id,(value#>>'{}')::uuid,(ordinality-1)::integer from jsonb_array_elements(coalesce(set_payload->'assetIds','[]'::jsonb)) with ordinality;
  end loop;
  insert into public.twitter_program_shortfalls(program_id,profile_id,requested_count,funded_count,unfunded_count,first_unfunded_at,last_unfunded_at,interval_minutes)
  select program_row.id,x.profile_id,x.requested_count,x.funded_count,x.unfunded_count,x.first_unfunded_at,x.last_unfunded_at,x.interval_minutes from jsonb_to_recordset(coalesce(p_shortfalls,'[]'::jsonb)) x(profile_id uuid,requested_count bigint,funded_count integer,unfunded_count bigint,first_unfunded_at timestamptz,last_unfunded_at timestamptz,interval_minutes integer);

  for reservation_group in
    select i.identity_id,i.connection_id,i.category,sum(i.amount_micros)::bigint amount
    from jsonb_to_recordset(p_items) as i(identity_id uuid,connection_id uuid,category public.twitter_price_category,amount_micros bigint)
    group by i.identity_id,i.connection_id,i.category order by i.identity_id,i.category
  loop
    reservation_id := gen_random_uuid();
    insert into public.twitter_wallet_reservations(id,identity_id,organization_id,connection_id,rate_card_id,category,origin,source_id,initial_micros,remaining_micros,idempotency_key,created_by)
    values(reservation_id,reservation_group.identity_id,p_organization_id,reservation_group.connection_id,rate_card.id,reservation_group.category,'publication',program_row.id,reservation_group.amount,reservation_group.amount,'program:'||program_row.id::text||':'||reservation_group.identity_id::text||':'||reservation_group.category::text,p_actor_user_id);
    update public.twitter_wallets set reserved_micros=reserved_micros+reservation_group.amount,version=version+1 where identity_id=reservation_group.identity_id;
    insert into public.twitter_reservation_events(reservation_id,organization_id,event_type,amount_micros,idempotency_key,actor_user_id,metadata) values(reservation_id,p_organization_id,'created',reservation_group.amount,'created:'||reservation_id::text,p_actor_user_id,jsonb_build_object('programId',program_row.id));
    insert into public.twitter_program_reservations(program_id,reservation_id,identity_id,category) values(program_row.id,reservation_id,reservation_group.identity_id,reservation_group.category);
  end loop;

  insert into public.twitter_publication_items(organization_id,program_id,profile_id,connection_epoch_id,connection_id,identity_id,slot_index,execute_at,content,weighted_characters,media_set_client_key,category,amount_micros,idempotency_key)
  select p_organization_id,program_row.id,x.profile_id,x.connection_epoch_id,x.connection_id,x.identity_id,x.slot_index,x.execute_at,x.content,x.weighted_characters,x.media_set_client_key,x.category,x.amount_micros,'twitter-item:'||program_row.id::text||':'||x.profile_id::text||':'||x.slot_index::text
  from jsonb_to_recordset(p_items) x(profile_id uuid,connection_epoch_id uuid,connection_id uuid,identity_id uuid,slot_index bigint,execute_at timestamptz,content text,weighted_characters integer,media_set_client_key text,category public.twitter_price_category,amount_micros bigint);
  return jsonb_build_object('programId',program_row.id,'idempotentReplay',false,'fundedCount',item_count,'unfundedCount',program_row.unfunded_count,'reservedMicros',reserved_total);
end; $$;

alter table public.twitter_programs enable row level security; alter table public.twitter_program_texts enable row level security; alter table public.twitter_program_media_sets enable row level security; alter table public.twitter_program_media_set_assets enable row level security; alter table public.twitter_program_shortfalls enable row level security; alter table public.twitter_program_reservations enable row level security; alter table public.twitter_publication_items enable row level security;
create policy twitter_programs_select_member on public.twitter_programs for select to authenticated using(public.is_organization_member(organization_id));
create policy twitter_program_texts_select_member on public.twitter_program_texts for select to authenticated using(exists(select 1 from public.twitter_programs p where p.id=program_id and public.is_organization_member(p.organization_id)));
create policy twitter_program_media_sets_select_member on public.twitter_program_media_sets for select to authenticated using(exists(select 1 from public.twitter_programs p where p.id=program_id and public.is_organization_member(p.organization_id)));
create policy twitter_program_media_assets_select_member on public.twitter_program_media_set_assets for select to authenticated using(exists(select 1 from public.twitter_program_media_sets s join public.twitter_programs p on p.id=s.program_id where s.id=media_set_id and public.is_organization_member(p.organization_id)));
create policy twitter_program_shortfalls_select_member on public.twitter_program_shortfalls for select to authenticated using(exists(select 1 from public.twitter_programs p where p.id=program_id and public.is_organization_member(p.organization_id)));
create policy twitter_program_reservations_select_member on public.twitter_program_reservations for select to authenticated using(exists(select 1 from public.twitter_programs p where p.id=program_id and public.is_organization_member(p.organization_id)));
create policy twitter_publication_items_select_member on public.twitter_publication_items for select to authenticated using(public.is_organization_member(organization_id));
revoke all on table public.twitter_programs,public.twitter_program_texts,public.twitter_program_media_sets,public.twitter_program_media_set_assets,public.twitter_program_shortfalls,public.twitter_program_reservations,public.twitter_publication_items from anon;
grant select on table public.twitter_programs,public.twitter_program_texts,public.twitter_program_media_sets,public.twitter_program_media_set_assets,public.twitter_program_shortfalls,public.twitter_program_reservations,public.twitter_publication_items to authenticated;
grant select,insert,update,delete on table public.twitter_programs,public.twitter_program_texts,public.twitter_program_media_sets,public.twitter_program_media_set_assets,public.twitter_program_shortfalls,public.twitter_program_reservations,public.twitter_publication_items to service_role;
revoke all on function public.twitter_confirm_bulk_program(uuid,uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.twitter_confirm_bulk_program(uuid,uuid,text,text,integer,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb) to service_role;

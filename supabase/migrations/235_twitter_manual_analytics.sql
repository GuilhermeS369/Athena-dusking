-- Analytics X: exclusivamente manual, cotação sem mutação e confirmação atômica.
create type public.twitter_analytics_resource_type as enum('post','profile');
create type public.twitter_analytics_job_status as enum('reserved','processing','partially_succeeded','succeeded','failed','outcome_unknown','cancelled');
create type public.twitter_analytics_item_status as enum('reserved','processing','succeeded','failed','outcome_unknown','cancelled');

create table public.twitter_analytics_jobs(
  id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete restrict,
  status public.twitter_analytics_job_status not null default 'reserved',resource_count integer not null check(resource_count>0),
  reserved_micros bigint not null check(reserved_micros>0),rate_card_id uuid not null references public.twitter_rate_cards(id) on delete restrict,
  rate_card_version integer not null,quote_digest text not null check(quote_digest~'^[a-f0-9]{64}$'),
  idempotency_key text not null,created_by uuid not null references auth.users(id) on delete restrict,
  started_at timestamptz,finished_at timestamptz,created_at timestamptz not null default timezone('utc',now()),updated_at timestamptz not null default timezone('utc',now()),
  unique(organization_id,idempotency_key)
);
create table public.twitter_analytics_job_reservations(job_id uuid not null references public.twitter_analytics_jobs(id) on delete restrict,reservation_id uuid not null unique references public.twitter_wallet_reservations(id) on delete restrict,identity_id uuid not null references public.twitter_global_identities(id) on delete restrict,category public.twitter_price_category not null,primary key(job_id,identity_id,category));
create table public.twitter_analytics_items(
  id uuid primary key default gen_random_uuid(),job_id uuid not null references public.twitter_analytics_jobs(id) on delete restrict,organization_id uuid not null references public.organizations(id) on delete restrict,
  resource_type public.twitter_analytics_resource_type not null,resource_key text not null,identity_id uuid not null references public.twitter_global_identities(id) on delete restrict,
  connection_id uuid not null references public.twitter_connections(id) on delete restrict,profile_id uuid not null references public.twitter_profiles(id) on delete restrict,
  publication_item_id uuid references public.twitter_publication_items(id) on delete restrict,zernio_post_id text,
  category public.twitter_price_category not null check(category in('post_read','user_read_follow_article')),amount_micros bigint not null check(amount_micros in(5000,10000)),
  status public.twitter_analytics_item_status not null default 'reserved',attempt_count integer not null default 0,claimed_at timestamptz,claimed_by text,
  result_code text,error_message text,created_at timestamptz not null default timezone('utc',now()),updated_at timestamptz not null default timezone('utc',now()),unique(job_id,resource_key)
);
create table public.twitter_analytics_snapshots(
  id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id) on delete restrict,analytics_item_id uuid not null unique references public.twitter_analytics_items(id) on delete restrict,
  resource_type public.twitter_analytics_resource_type not null,profile_id uuid not null references public.twitter_profiles(id) on delete restrict,publication_item_id uuid references public.twitter_publication_items(id) on delete restrict,
  metrics jsonb not null default '{}',provider_updated_at timestamptz,captured_at timestamptz not null default timezone('utc',now())
);
create index twitter_analytics_claim_idx on public.twitter_analytics_items(status,created_at)where status='reserved';
create index twitter_analytics_snapshots_org_idx on public.twitter_analytics_snapshots(organization_id,captured_at desc);
create trigger twitter_analytics_jobs_updated before update on public.twitter_analytics_jobs for each row execute function public.set_updated_at();
create trigger twitter_analytics_items_updated before update on public.twitter_analytics_items for each row execute function public.set_updated_at();

create or replace function public.twitter_confirm_analytics_job(p_organization_id uuid,p_actor_user_id uuid,p_idempotency_key text,p_quote_digest text,p_rate_card_version integer,p_wallet_snapshots jsonb,p_resources jsonb)returns jsonb language plpgsql security definer set search_path=public as $$
declare existing public.twitter_analytics_jobs;job public.twitter_analytics_jobs;card public.twitter_rate_cards;resource jsonb;normalized jsonb:='[]'::jsonb;row record;wallet public.twitter_wallets;expected_version bigint;reservation jsonb;reservation_id uuid;total bigint:=0;count_resources integer:=0;
begin
 if coalesce(auth.role(),'')<>'service_role'then raise exception using errcode='42501';end if;
 select * into existing from public.twitter_analytics_jobs where organization_id=p_organization_id and idempotency_key=trim(p_idempotency_key);if found then return jsonb_build_object('jobId',existing.id,'idempotentReplay',true,'reservedMicros',existing.reserved_micros);end if;
 if jsonb_typeof(p_resources)<>'array' or jsonb_array_length(p_resources)=0 or jsonb_array_length(p_resources)>1000 then raise exception using errcode='22023',message='Recursos de analytics inválidos.';end if;
 select * into card from public.twitter_rate_cards where active and version=p_rate_card_version;if not found then raise exception using errcode='40001',message='Tabela de preços mudou; revise novamente.';end if;
 for resource in select value from jsonb_array_elements(p_resources)loop
  if resource->>'type'='post'then
   select jsonb_build_object('resource_type','post','resource_key','post:'||i.id,'identity_id',i.identity_id,'connection_id',i.connection_id,'profile_id',i.profile_id,'publication_item_id',i.id,'zernio_post_id',a.post_id,'category','post_read','amount_micros',r.unit_cost_micros) into resource
   from public.twitter_publication_items i join lateral(select pa.post_id from public.twitter_publication_attempts pa where pa.item_id=i.id and pa.status='published' and pa.post_id is not null order by pa.created_at desc limit 1)a on true join public.twitter_cost_rates r on r.rate_card_id=card.id and r.category='post_read'
   where i.id=(resource->>'id')::uuid and i.organization_id=p_organization_id and i.status='published';
  elsif resource->>'type'='profile'then
   select jsonb_build_object('resource_type','profile','resource_key','profile:'||p.id,'identity_id',c.identity_id,'connection_id',e.connection_id,'profile_id',p.id,'publication_item_id',null,'zernio_post_id',null,'category','user_read_follow_article','amount_micros',r.unit_cost_micros) into resource
   from public.twitter_profiles p join public.twitter_profile_connection_epochs e on e.id=p.current_epoch_id join public.twitter_connections c on c.id=e.connection_id join public.twitter_cost_rates r on r.rate_card_id=card.id and r.category='user_read_follow_article'
   where p.id=(resource->>'id')::uuid and p.organization_id=p_organization_id and p.deleted_at is null and e.ended_at is null and c.deleted_at is null;
  else raise exception using errcode='22023',message='Tipo de analytics inválido.';end if;
  if resource is null then raise exception using errcode='22023',message='Recurso de analytics indisponível.';end if;
  normalized:=normalized||jsonb_build_array(resource);total:=total+(resource->>'amount_micros')::bigint;count_resources:=count_resources+1;
 end loop;
 if(select count(distinct value->>'resource_key')from jsonb_array_elements(normalized))<>count_resources then raise exception using errcode='22023',message='Recursos duplicados.';end if;
 insert into public.twitter_analytics_jobs(organization_id,resource_count,reserved_micros,rate_card_id,rate_card_version,quote_digest,idempotency_key,created_by)values(p_organization_id,count_resources,total,card.id,card.version,p_quote_digest,trim(p_idempotency_key),p_actor_user_id)returning * into job;
 for row in select x.identity_id,x.connection_id,x.category,sum(x.amount_micros)::bigint cost from jsonb_to_recordset(normalized)as x(identity_id uuid,connection_id uuid,category public.twitter_price_category,amount_micros bigint)group by x.identity_id,x.connection_id,x.category order by x.identity_id,x.category loop
  select * into wallet from public.twitter_wallets where identity_id=row.identity_id and organization_id=p_organization_id for update;if not found then raise exception using errcode='P0002',message='Carteira de analytics ausente.';end if;
  select (s->>'walletVersion')::bigint into expected_version from jsonb_array_elements(p_wallet_snapshots)s where s->>'identityId'=row.identity_id::text;if expected_version is null or expected_version<>wallet.version then raise exception using errcode='40001',message='Carteira mudou; revise novamente.';end if;
  if wallet.posted_balance_micros-wallet.reserved_micros-row.cost<5000000 then raise exception using errcode='P0001',message='Piso protegido de US$ 5,00 impede esta análise.';end if;
  reservation:=public.twitter_create_wallet_reservation(p_organization_id,row.identity_id,row.connection_id,card.version,row.category,'analytics',job.id,row.cost,wallet.version,'analytics:'||job.id||':'||row.identity_id||':'||row.category);reservation_id:=(reservation->>'reservationId')::uuid;
  insert into public.twitter_analytics_job_reservations values(job.id,reservation_id,row.identity_id,row.category);
  select * into wallet from public.twitter_wallets where identity_id=row.identity_id for update;
  p_wallet_snapshots:=coalesce((select jsonb_agg(case when s->>'identityId'=row.identity_id::text then jsonb_set(s,'{walletVersion}',to_jsonb(wallet.version))else s end)from jsonb_array_elements(p_wallet_snapshots)s),'[]');
 end loop;
 insert into public.twitter_analytics_items(job_id,organization_id,resource_type,resource_key,identity_id,connection_id,profile_id,publication_item_id,zernio_post_id,category,amount_micros)
 select job.id,p_organization_id,x.resource_type,x.resource_key,x.identity_id,x.connection_id,x.profile_id,x.publication_item_id,x.zernio_post_id,x.category,x.amount_micros from jsonb_to_recordset(normalized)as x(resource_type public.twitter_analytics_resource_type,resource_key text,identity_id uuid,connection_id uuid,profile_id uuid,publication_item_id uuid,zernio_post_id text,category public.twitter_price_category,amount_micros bigint);
 return jsonb_build_object('jobId',job.id,'resourceCount',count_resources,'reservedMicros',total,'idempotentReplay',false);
end$$;

alter table public.twitter_analytics_jobs enable row level security;alter table public.twitter_analytics_job_reservations enable row level security;alter table public.twitter_analytics_items enable row level security;alter table public.twitter_analytics_snapshots enable row level security;
create policy twitter_analytics_jobs_select on public.twitter_analytics_jobs for select to authenticated using(public.is_organization_member(organization_id));create policy twitter_analytics_items_select on public.twitter_analytics_items for select to authenticated using(public.is_organization_member(organization_id));create policy twitter_analytics_snapshots_select on public.twitter_analytics_snapshots for select to authenticated using(public.is_organization_member(organization_id));
revoke all on table public.twitter_analytics_jobs,public.twitter_analytics_job_reservations,public.twitter_analytics_items,public.twitter_analytics_snapshots from anon,authenticated;grant select on public.twitter_analytics_jobs,public.twitter_analytics_items,public.twitter_analytics_snapshots to authenticated;grant all on public.twitter_analytics_jobs,public.twitter_analytics_job_reservations,public.twitter_analytics_items,public.twitter_analytics_snapshots to service_role;
revoke all on function public.twitter_confirm_analytics_job(uuid,uuid,text,text,integer,jsonb,jsonb)from public,anon,authenticated;grant execute on function public.twitter_confirm_analytics_job(uuid,uuid,text,text,integer,jsonb,jsonb)to service_role;

-- Esteira X escalável: pontualidade, preparação local, fencing e claim horizontal.
-- A migração é estrutural. Itens antigos permanecem sem deadline até o backfill
-- explícito, impedindo que sejam publicados antes do dry-run operacional.

do $$ begin
  create type public.twitter_preparation_status as enum ('pending','preparing','ready','blocked');
exception when duplicate_object then null; end $$;

alter table public.twitter_publication_items
  add column if not exists dispatch_deadline_at timestamptz,
  add column if not exists preparation_status public.twitter_preparation_status not null default 'pending',
  add column if not exists preparation_version integer not null default 1 check (preparation_version > 0),
  add column if not exists preparation_claimed_at timestamptz,
  add column if not exists preparation_claimed_by text,
  add column if not exists preparation_next_attempt_at timestamptz,
  add column if not exists prepared_at timestamptz,
  add column if not exists preparation_error text,
  add column if not exists payload_snapshot jsonb,
  add column if not exists media_manifest jsonb not null default '[]'::jsonb,
  add column if not exists missed_at timestamptz,
  add column if not exists missed_reason text;

alter table public.twitter_publication_attempts
  add column if not exists fencing_token uuid;

create index if not exists twitter_items_preparation_claim_idx
  on public.twitter_publication_items(preparation_status,execute_at,id)
  where status in ('ready','retry') and preparation_status in ('pending','blocked');
create index if not exists twitter_items_dispatch_deadline_idx
  on public.twitter_publication_items(dispatch_deadline_at,id)
  where status in ('ready','retry');
create index if not exists twitter_items_connection_active_idx
  on public.twitter_publication_items(connection_id,status,id)
  where status in('claimed','processing','outcome_unknown');
create index if not exists twitter_attempts_http_created_idx
  on public.twitter_publication_attempts(http_status,created_at desc)
  where http_status=429;

create table if not exists public.twitter_dispatch_fences(
  stream text primary key check(stream='publication'),
  owner_plane text not null check(owner_plane in('vps','fallback')),
  fencing_token uuid not null default gen_random_uuid(),
  lease_until timestamptz not null,
  last_worker_id text not null,
  epoch bigint not null default 1,
  updated_at timestamptz not null default timezone('utc',now())
);

create table if not exists public.twitter_connection_dispatch_limits(
  connection_id uuid primary key references public.twitter_connections(id) on delete cascade,
  current_limit smallint not null default 8 check(current_limit between 1 and 16),
  success_streak integer not null default 0 check(success_streak >= 0),
  throttled_until timestamptz,
  last_signal text,
  rate_limit_count bigint not null default 0,
  updated_at timestamptz not null default timezone('utc',now())
);

create table if not exists public.twitter_profile_disconnection_incidents(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  profile_id uuid not null references public.twitter_profiles(id) on delete restrict,
  connection_id uuid not null references public.twitter_connections(id) on delete restrict,
  item_id uuid references public.twitter_publication_items(id) on delete restrict,
  attempt_id uuid references public.twitter_publication_attempts(id) on delete restrict,
  signal text not null check(signal in('account_disconnected','auth_expired')),
  provider_code text,
  provider_message text,
  status text not null default 'scheduled' check(status in('scheduled','recycling','recovered','closed')),
  occurrence_count integer not null default 1 check(occurrence_count>0),
  created_at timestamptz not null default timezone('utc',now()),
  updated_at timestamptz not null default timezone('utc',now())
);
create unique index if not exists twitter_profile_disconnection_active_idx
  on public.twitter_profile_disconnection_incidents(profile_id)
  where status in('scheduled','recycling');

create table if not exists public.twitter_queue_cancellation_targets(
  operation_id uuid not null references public.twitter_queue_cancellation_operations(id) on delete cascade,
  profile_id uuid not null references public.twitter_profiles(id) on delete restrict,
  primary key(operation_id,profile_id)
);

alter table public.twitter_dispatch_fences enable row level security;
alter table public.twitter_connection_dispatch_limits enable row level security;
alter table public.twitter_profile_disconnection_incidents enable row level security;
alter table public.twitter_queue_cancellation_targets enable row level security;
revoke all on public.twitter_dispatch_fences,public.twitter_connection_dispatch_limits,public.twitter_profile_disconnection_incidents from public,anon,authenticated;
grant select,insert,update on public.twitter_dispatch_fences,public.twitter_connection_dispatch_limits,public.twitter_profile_disconnection_incidents to service_role;
revoke all on public.twitter_queue_cancellation_targets from public,anon,authenticated;
grant all on public.twitter_queue_cancellation_targets to service_role;

create or replace view public.twitter_connection_dispatch_health with(security_invoker=true) as
select l.connection_id,l.current_limit,l.success_streak,l.throttled_until,l.rate_limit_count,l.updated_at,
  count(distinct i.id) filter(where i.status in('claimed','processing','outcome_unknown'))::integer as active_count,
  count(distinct a.id) filter(where a.http_status=429 and a.created_at>=timezone('utc',now())-interval '24 hours')::integer as rate_limit_24h
from public.twitter_connection_dispatch_limits l
left join public.twitter_publication_items i on i.connection_id=l.connection_id
left join public.twitter_publication_attempts a on a.item_id=i.id
group by l.connection_id,l.current_limit,l.success_streak,l.throttled_until,l.rate_limit_count,l.updated_at;
revoke all on public.twitter_connection_dispatch_health from public,anon,authenticated;
grant select on public.twitter_connection_dispatch_health to service_role;

create or replace function public.twitter_set_publication_deadline()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.dispatch_deadline_at is null then new.dispatch_deadline_at:=new.execute_at+interval '15 minutes'; end if;
  if new.dispatch_deadline_at<>new.execute_at+interval '15 minutes' then
    raise exception using errcode='22023',message='A janela X deve ser exatamente 15 minutos.';
  end if;
  return new;
end $$;
drop trigger if exists twitter_set_publication_deadline on public.twitter_publication_items;
create trigger twitter_set_publication_deadline before insert or update of execute_at,dispatch_deadline_at
on public.twitter_publication_items for each row execute function public.twitter_set_publication_deadline();

create or replace function public.twitter_acquire_dispatch_fence(
  p_plane text,p_worker_id text,p_lease_seconds integer default 30
) returns jsonb language plpgsql security definer set search_path=public as $$
declare f public.twitter_dispatch_fences;now_at timestamptz:=timezone('utc',now());lease_seconds integer:=least(greatest(p_lease_seconds,10),120);
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  if p_plane not in('vps','fallback') or char_length(trim(coalesce(p_worker_id,'')))<3 then raise exception using errcode='22023'; end if;
  insert into public.twitter_dispatch_fences(stream,owner_plane,lease_until,last_worker_id)
  values('publication',p_plane,now_at+make_interval(secs=>lease_seconds),left(p_worker_id,160))
  on conflict(stream) do nothing;
  select * into f from public.twitter_dispatch_fences where stream='publication' for update;
  if f.owner_plane=p_plane then
    update public.twitter_dispatch_fences set lease_until=now_at+make_interval(secs=>lease_seconds),last_worker_id=left(p_worker_id,160),updated_at=now_at where stream='publication' returning * into f;
  elsif f.lease_until<=now_at then
    update public.twitter_dispatch_fences set owner_plane=p_plane,fencing_token=gen_random_uuid(),lease_until=now_at+make_interval(secs=>lease_seconds),last_worker_id=left(p_worker_id,160),epoch=epoch+1,updated_at=now_at where stream='publication' returning * into f;
  else
    return jsonb_build_object('allowed',false,'ownerPlane',f.owner_plane,'leaseUntil',f.lease_until,'epoch',f.epoch);
  end if;
  return jsonb_build_object('allowed',true,'ownerPlane',f.owner_plane,'fencingToken',f.fencing_token,'leaseUntil',f.lease_until,'epoch',f.epoch);
end $$;

create or replace function public.twitter_validate_dispatch_fence(p_fencing_token uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.twitter_dispatch_fences where stream='publication' and fencing_token=p_fencing_token and lease_until>timezone('utc',now()));
$$;

create or replace function public.twitter_publication_scale_audit()
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'capturedAt',timezone('utc',now()),
    'total',count(*),
    'byStatus',coalesce((select jsonb_object_agg(status,total) from(select status::text,count(*) total from public.twitter_publication_items group by status)s),'{}'::jsonb),
    'withoutDeadline',count(*) filter(where dispatch_deadline_at is null),
    'pastDueUnstarted',count(*) filter(where status in('ready','retry','claimed') and execute_at<=timezone('utc',now())),
    'futureUnstarted',count(*) filter(where status in('ready','retry') and execute_at>timezone('utc',now())),
    'processingOrUnknown',count(*) filter(where status in('processing','outcome_unknown')),
    'reservedHoldMicros',coalesce((select sum(amount_micros) from public.twitter_item_holds where status='reserved'),0),
    'activeOrUnknownHoldMicros',coalesce((select sum(amount_micros) from public.twitter_item_holds where status in('active','outcome_unknown')),0),
    'scheduleDigest',encode(extensions.digest(convert_to(coalesce(string_agg(id::text||':'||execute_at::text||':'||status::text,'|' order by id),''),'UTF8'),'sha256'),'hex')
  ) from public.twitter_publication_items;
$$;

create or replace function public.twitter_backfill_publication_scale(p_limit integer default 5000)
returns jsonb language plpgsql security definer set search_path=public as $$
declare row record;future_count integer:=0;missed_count integer:=0;released bigint:=0;now_at timestamptz:=timezone('utc',now());max_rows integer:=least(greatest(p_limit,1),20000);
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  for row in
    select i.id,i.status,a.external_started_at,h.status hold_status
    from public.twitter_publication_items i
    left join lateral(select external_started_at from public.twitter_publication_attempts where item_id=i.id order by attempt_number desc limit 1)a on true
    left join public.twitter_item_holds h on h.item_id=i.id
    where i.dispatch_deadline_at is null and i.status in('ready','retry','claimed')
    order by i.execute_at,i.id for update of i skip locked limit max_rows
  loop
    update public.twitter_publication_items set dispatch_deadline_at=execute_at+interval '15 minutes' where id=row.id;
    if (select dispatch_deadline_at<=now_at from public.twitter_publication_items where id=row.id) and row.external_started_at is null then
      if row.hold_status='active' then update public.twitter_item_holds set status='reserved',activated_at=null where item_id=row.id; end if;
      if row.hold_status in('reserved','active') then released:=released+public.twitter_release_item_hold(row.id,'Janela de publicação X vencida no backfill.','twitter-missed-backfill:'||row.id::text); end if;
      update public.twitter_publication_items set status='missed',missed_at=now_at,missed_reason='migration_deadline_elapsed',claimed_at=null,claimed_by=null,next_attempt_at=null where id=row.id;
      missed_count:=missed_count+1;
    else
      update public.twitter_publication_items set preparation_status='pending',preparation_next_attempt_at=null where id=row.id;
      future_count:=future_count+1;
    end if;
  end loop;
  return jsonb_build_object('futurePreparedForPipeline',future_count,'missed',missed_count,'releasedMicros',released,'remaining',(select count(*) from public.twitter_publication_items where dispatch_deadline_at is null and status in('ready','retry','claimed')));
end $$;

create or replace function public.twitter_expire_dispatch_deadlines(p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path=public as $$
declare row record;affected integer:=0;released bigint:=0;now_at timestamptz:=timezone('utc',now());
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  for row in select i.id from public.twitter_publication_items i join public.twitter_item_holds h on h.item_id=i.id
    where i.status in('ready','retry') and i.dispatch_deadline_at is not null and i.dispatch_deadline_at<now_at and h.status='reserved'
    order by i.dispatch_deadline_at,i.id for update of i,h skip locked limit least(greatest(p_limit,1),5000)
  loop
    released:=released+public.twitter_release_item_hold(row.id,'Janela de publicação X vencida.','twitter-missed:'||row.id::text);
    update public.twitter_publication_items set status='missed',missed_at=now_at,missed_reason='dispatch_deadline_elapsed',next_attempt_at=null,claimed_at=null,claimed_by=null where id=row.id;
    affected:=affected+1;
    insert into public.twitter_operation_logs(organization_id,item_id,connection_id,profile_id,phase,estimated_micros,settled_micros,message,metadata)
    select organization_id,id,connection_id,profile_id,'dispatch_deadline_missed',amount_micros,0,'Item X não publicado após perder a janela de 15 minutos.',jsonb_build_object('dispatchDeadlineAt',dispatch_deadline_at) from public.twitter_publication_items where id=row.id;
  end loop;
  return jsonb_build_object('affectedItems',affected,'releasedMicros',released);
end $$;

create or replace function public.twitter_recover_expired_claims(p_lease_seconds integer default 300)
returns jsonb language plpgsql security definer set search_path=public as $$
declare row record;retried integer:=0;unknown_count integer:=0;missed_count integer:=0;released bigint:=0;now_at timestamptz:=timezone('utc',now());
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  for row in select i.id item_id,i.dispatch_deadline_at,a.id attempt_id,a.external_started_at
    from public.twitter_publication_items i join public.twitter_publication_attempts a on a.item_id=i.id and a.attempt_number=i.attempt_count
    where i.status='claimed' and i.claimed_at<now_at-make_interval(secs=>least(greatest(p_lease_seconds,60),3600)) for update of i,a
  loop
    if row.external_started_at is not null then
      update public.twitter_item_holds set status='outcome_unknown' where item_id=row.item_id and status='active';
      update public.twitter_publication_items set status='outcome_unknown' where id=row.item_id;
      update public.twitter_publication_attempts set status='outcome_unknown',finished_at=now_at,error_message='Lease expirou após início da chamada externa.' where id=row.attempt_id;
      insert into public.twitter_operation_logs(organization_id,item_id,attempt_id,connection_id,profile_id,phase,message) select organization_id,id,row.attempt_id,connection_id,profile_id,'dispatcher_lease_recovered','Lease expirou após início externo; item mantido para reconciliação.' from public.twitter_publication_items where id=row.item_id;unknown_count:=unknown_count+1;
    elsif row.dispatch_deadline_at is null or row.dispatch_deadline_at<=now_at then
      update public.twitter_item_holds set status='reserved',activated_at=null where item_id=row.item_id and status='active';
      released:=released+public.twitter_release_item_hold(row.item_id,'Lease expirou depois da janela X.','twitter-missed-lease:'||row.item_id::text);
      update public.twitter_publication_items set status='missed',missed_at=now_at,missed_reason='expired_lease_after_deadline',next_attempt_at=null,claimed_at=null,claimed_by=null where id=row.item_id;
      update public.twitter_publication_attempts set status='failed',finished_at=now_at,provider_code='dispatch_deadline_missed',error_message='Lease expirou depois da janela X.' where id=row.attempt_id;missed_count:=missed_count+1;
    else
      update public.twitter_item_holds set status='reserved',activated_at=null where item_id=row.item_id and status='active';
      update public.twitter_publication_items set status='retry',next_attempt_at=now_at,claimed_at=null,claimed_by=null where id=row.item_id;
      update public.twitter_publication_attempts set status='failed',finished_at=now_at,error_message='Lease expirou antes da chamada externa.' where id=row.attempt_id;
      insert into public.twitter_operation_logs(organization_id,item_id,attempt_id,connection_id,profile_id,phase,message) select organization_id,id,row.attempt_id,connection_id,profile_id,'dispatcher_lease_recovered','Lease expirou antes do início externo; item devolvido à fila dentro do prazo.' from public.twitter_publication_items where id=row.item_id;retried:=retried+1;
    end if;
  end loop;
  update public.twitter_publication_items set preparation_status='blocked',preparation_error='Lease de preparação expirou.',preparation_next_attempt_at=now_at,preparation_claimed_at=null,preparation_claimed_by=null
    where preparation_status='preparing' and preparation_claimed_at<now_at-make_interval(secs=>least(greatest(p_lease_seconds,60),3600));
  return jsonb_build_object('retried',retried,'outcomeUnknown',unknown_count,'missed',missed_count,'releasedMicros',released);
end $$;

create or replace function public.twitter_claim_preparation_items(p_worker_id text,p_limit integer default 500)
returns table(item_id uuid,organization_id uuid,program_id uuid,profile_id uuid,connection_id uuid,connection_epoch_id uuid,content text,weighted_characters integer,media_set_client_key text,category public.twitter_price_category,amount_micros bigint,execute_at timestamptz,dispatch_deadline_at timestamptz,preparation_version integer)
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  return query with candidates as(
    select i.id from public.twitter_publication_items i
    where i.status in('ready','retry') and i.dispatch_deadline_at>timezone('utc',now())
      and i.execute_at<=timezone('utc',now())+interval '24 hours'
      and i.preparation_status in('pending','blocked')
      and coalesce(i.preparation_next_attempt_at,'-infinity'::timestamptz)<=timezone('utc',now())
    order by i.execute_at,i.id for update skip locked limit least(greatest(p_limit,1),500)
  ),updated as(
    update public.twitter_publication_items i set preparation_status='preparing',preparation_claimed_at=timezone('utc',now()),preparation_claimed_by=left(p_worker_id,160),preparation_error=null
    from candidates c where i.id=c.id returning i.*
  ) select u.id,u.organization_id,u.program_id,u.profile_id,u.connection_id,u.connection_epoch_id,u.content,u.weighted_characters,u.media_set_client_key,u.category,u.amount_micros,u.execute_at,u.dispatch_deadline_at,u.preparation_version from updated u;
end $$;

create or replace function public.twitter_complete_preparation_item(p_item_id uuid,p_worker_id text,p_ready boolean,p_payload_snapshot jsonb default null,p_media_manifest jsonb default '[]',p_error text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare item public.twitter_publication_items;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  select * into item from public.twitter_publication_items where id=p_item_id for update;
  if not found then raise exception using errcode='P0002'; end if;
  if item.preparation_status<>'preparing' or item.preparation_claimed_by<>left(p_worker_id,160) then raise exception using errcode='55000',message='Lease de preparação X inválido.'; end if;
  if item.status not in('ready','retry') then
    update public.twitter_publication_items set preparation_status='pending',preparation_claimed_at=null,preparation_claimed_by=null where id=p_item_id;
    return jsonb_build_object('itemId',p_item_id,'status','cancelled_or_terminal');
  end if;
  if p_ready then
    if p_payload_snapshot is null or jsonb_typeof(coalesce(p_media_manifest,'[]'))<>'array' then raise exception using errcode='22023'; end if;
    update public.twitter_publication_items set preparation_status='ready',prepared_at=timezone('utc',now()),payload_snapshot=p_payload_snapshot,media_manifest=coalesce(p_media_manifest,'[]'),preparation_error=null,preparation_next_attempt_at=null,preparation_claimed_at=null,preparation_claimed_by=null where id=p_item_id;
  else
    update public.twitter_publication_items set preparation_status='blocked',preparation_error=left(coalesce(p_error,'Falha na preparação X.'),1000),preparation_next_attempt_at=timezone('utc',now())+interval '15 minutes',preparation_claimed_at=null,preparation_claimed_by=null where id=p_item_id;
  end if;
  return jsonb_build_object('itemId',p_item_id,'status',case when p_ready then 'ready' else 'blocked' end);
end $$;

create or replace function public.twitter_claim_publication_items_v2(p_worker_id text,p_limit integer,p_fencing_token uuid)
returns table(item_id uuid,attempt_id uuid,organization_id uuid,profile_id uuid,connection_id uuid,content text,execute_at timestamptz,dispatch_deadline_at timestamptz,amount_micros bigint,payload_snapshot jsonb,media_manifest jsonb,fencing_token uuid)
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  if not public.twitter_validate_dispatch_fence(p_fencing_token) then raise exception using errcode='55000',message='Fencing X inválido ou vencido.'; end if;
  insert into public.twitter_connection_dispatch_limits(connection_id) select id from public.twitter_connections where deleted_at is null on conflict do nothing;
  return query with active as(
    select active_item.connection_id,count(*)::integer total
    from public.twitter_publication_items active_item
    where active_item.status in('claimed','processing','outcome_unknown')
    group by active_item.connection_id
  ),eligible as(
    select i.id,row_number() over(partition by i.connection_id order by i.execute_at,i.id) connection_rank
    from public.twitter_publication_items i join public.twitter_connection_dispatch_limits l on l.connection_id=i.connection_id left join active a on a.connection_id=i.connection_id
    where i.status in('ready','retry') and i.preparation_status='ready' and i.dispatch_deadline_at>timezone('utc',now())
      and coalesce(i.next_attempt_at,i.execute_at)<=timezone('utc',now()) and coalesce(l.throttled_until,'-infinity'::timestamptz)<=timezone('utc',now())
      and not exists(select 1 from public.twitter_publication_items x where x.profile_id=i.profile_id and x.status in('claimed','processing','outcome_unknown'))
      and i.id=(select f.id from public.twitter_publication_items f where f.profile_id=i.profile_id and f.status in('ready','retry') order by case when f.status='retry' then 0 else 1 end,coalesce(f.next_attempt_at,f.execute_at),f.id limit 1)
      and coalesce(a.total,0)<l.current_limit
  ),candidates as(
    select e.id from eligible e join public.twitter_publication_items i on i.id=e.id join public.twitter_connection_dispatch_limits l on l.connection_id=i.connection_id left join active a on a.connection_id=i.connection_id
    where e.connection_rank<=l.current_limit-coalesce(a.total,0)
    order by e.connection_rank,i.execute_at,i.organization_id,i.connection_id,i.id for update of i skip locked limit least(greatest(p_limit,1),50)
  ),updated as(
    update public.twitter_publication_items i set status='claimed',claimed_at=timezone('utc',now()),claimed_by=left(p_worker_id,160),attempt_count=attempt_count+1 from candidates c where i.id=c.id returning i.*
  ),attempts as(
    insert into public.twitter_publication_attempts(organization_id,item_id,attempt_number,worker_id,idempotency_key,fencing_token)
    select u.organization_id,u.id,u.attempt_count,left(p_worker_id,160),'twitter-attempt:'||u.id::text||':'||u.attempt_count::text,p_fencing_token from updated u
    returning twitter_publication_attempts.id,twitter_publication_attempts.item_id
  ),holds as(
    update public.twitter_item_holds h set status='active',activated_at=timezone('utc',now()) from updated u where h.item_id=u.id returning h.item_id
  ) select u.id,(select a.id from attempts a where a.item_id=u.id),u.organization_id,u.profile_id,u.connection_id,u.content,u.execute_at,u.dispatch_deadline_at,u.amount_micros,u.payload_snapshot,u.media_manifest,p_fencing_token from updated u;
end $$;

-- Shadow must be observational: it may measure the candidate set, but it must
-- never claim an item, activate a financial hold or create an attempt.
create or replace function public.twitter_preview_publication_candidates_v2(p_limit integer)
returns table(item_id uuid,organization_id uuid,profile_id uuid,connection_id uuid,execute_at timestamptz,dispatch_deadline_at timestamptz)
language plpgsql stable security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  return query with active as(
    select i.connection_id,count(*)::integer total
    from public.twitter_publication_items i
    where i.status in('claimed','processing','outcome_unknown')
    group by i.connection_id
  ),eligible as(
    select i.*,row_number() over(partition by i.connection_id order by i.execute_at,i.id) connection_rank
    from public.twitter_publication_items i
    join public.twitter_connection_dispatch_limits l on l.connection_id=i.connection_id
    left join active a on a.connection_id=i.connection_id
    where i.status in('ready','retry') and i.preparation_status='ready'
      and i.dispatch_deadline_at>timezone('utc',now())
      and coalesce(i.next_attempt_at,i.execute_at)<=timezone('utc',now())
      and coalesce(l.throttled_until,'-infinity'::timestamptz)<=timezone('utc',now())
      and coalesce(a.total,0)<l.current_limit
      and not exists(select 1 from public.twitter_publication_items x where x.profile_id=i.profile_id and x.status in('claimed','processing','outcome_unknown'))
      and i.id=(select f.id from public.twitter_publication_items f where f.profile_id=i.profile_id and f.status in('ready','retry') order by case when f.status='retry' then 0 else 1 end,coalesce(f.next_attempt_at,f.execute_at),f.id limit 1)
  )
  select e.id,e.organization_id,e.profile_id,e.connection_id,e.execute_at,e.dispatch_deadline_at
  from eligible e
  join public.twitter_connection_dispatch_limits l on l.connection_id=e.connection_id
  left join active a on a.connection_id=e.connection_id
  where e.connection_rank<=l.current_limit-coalesce(a.total,0)
  order by e.connection_rank,e.execute_at,e.organization_id,e.connection_id,e.id
  limit least(greatest(p_limit,1),50);
end $$;

create or replace function public.twitter_profile_queue_summary_page(p_organization_id uuid,p_profile_ids uuid[])
returns table(profile_id uuid,pending_count bigint,text_count bigint,image_count bigint,gif_count bigint,video_count bigint)
language sql stable security definer set search_path=public as $$
  select p.id,
    count(i.id) filter(where i.status in('ready','retry','claimed','processing','outcome_unknown')),
    count(i.id) filter(where i.status in('ready','retry','claimed','processing','outcome_unknown') and i.media_set_client_key is null),
    count(i.id) filter(where i.status in('ready','retry','claimed','processing','outcome_unknown') and media_set.media_kind='images'),
    count(i.id) filter(where i.status in('ready','retry','claimed','processing','outcome_unknown') and media_set.media_kind='gif'),
    count(i.id) filter(where i.status in('ready','retry','claimed','processing','outcome_unknown') and media_set.media_kind='video')
  from public.twitter_profiles p
  left join public.twitter_publication_items i on i.profile_id=p.id and i.organization_id=p.organization_id
  left join public.twitter_program_media_sets media_set on media_set.program_id=i.program_id and media_set.client_key=i.media_set_client_key
  where p.organization_id=p_organization_id and p.id=any(coalesce(p_profile_ids,'{}'::uuid[]))
  group by p.id
$$;

create or replace function public.twitter_start_external_attempt_v2(p_attempt_id uuid,p_idempotency_key text,p_fencing_token uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.twitter_publication_attempts;i public.twitter_publication_items;released bigint:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  if not public.twitter_validate_dispatch_fence(p_fencing_token) then raise exception using errcode='55000',message='Fencing X vencido antes do envio.'; end if;
  select * into a from public.twitter_publication_attempts where id=p_attempt_id for update;
  if not found or a.fencing_token is distinct from p_fencing_token then raise exception using errcode='55000',message='Tentativa X não pertence ao fencing atual.'; end if;
  select * into i from public.twitter_publication_items where id=a.item_id for update;
  if a.status='claimed' and i.dispatch_deadline_at<=timezone('utc',now()) then
    update public.twitter_item_holds set status='reserved',activated_at=null where item_id=i.id and status='active';
    released:=public.twitter_release_item_hold(i.id,'Janela X venceu antes do início externo.','twitter-missed-before-start:'||i.id::text);
    update public.twitter_publication_items set status='missed',missed_at=timezone('utc',now()),missed_reason='deadline_before_external_start',claimed_at=null,claimed_by=null where id=i.id;
    update public.twitter_publication_attempts set status='failed',finished_at=timezone('utc',now()),provider_code='dispatch_deadline_missed',error_message='Janela X venceu antes do início externo.' where id=a.id;
    return jsonb_build_object('attemptId',a.id,'status','missed','releasedMicros',released);
  end if;
  return public.twitter_start_external_attempt(p_attempt_id,p_idempotency_key);
end $$;

create or replace function public.twitter_validate_attempt_fence(p_attempt_id uuid,p_fencing_token uuid)
returns boolean language sql stable security definer set search_path=public as $$select exists(select 1 from public.twitter_publication_attempts where id=p_attempt_id and fencing_token=p_fencing_token)$$;

create or replace function public.twitter_record_connection_dispatch_signal(p_connection_id uuid,p_signal text,p_retry_after_seconds integer default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare row public.twitter_connection_dispatch_limits;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  insert into public.twitter_connection_dispatch_limits(connection_id) values(p_connection_id) on conflict do nothing;
  select * into row from public.twitter_connection_dispatch_limits where connection_id=p_connection_id for update;
  if p_signal='rate_limited' then
    update public.twitter_connection_dispatch_limits set current_limit=greatest(1,ceil(current_limit/2.0)::integer),success_streak=0,rate_limit_count=rate_limit_count+1,throttled_until=timezone('utc',now())+make_interval(secs=>greatest(coalesce(p_retry_after_seconds,240),240)),last_signal=p_signal,updated_at=timezone('utc',now()) where connection_id=p_connection_id returning * into row;
  elsif p_signal='success' then
    update public.twitter_connection_dispatch_limits set success_streak=success_streak+1,current_limit=case when success_streak+1>=20 then least(16,current_limit+1) else current_limit end,success_streak=case when success_streak+1>=20 then 0 else success_streak+1 end,throttled_until=null,last_signal=p_signal,updated_at=timezone('utc',now()) where connection_id=p_connection_id returning * into row;
  else
    update public.twitter_connection_dispatch_limits set success_streak=0,last_signal=left(p_signal,80),updated_at=timezone('utc',now()) where connection_id=p_connection_id returning * into row;
  end if;
  return jsonb_build_object('connectionId',row.connection_id,'currentLimit',row.current_limit,'successStreak',row.success_streak,'throttledUntil',row.throttled_until);
end $$;

create or replace function public.twitter_finalize_expired_rate_limit(
  p_attempt_id uuid,p_idempotency_key text,p_retry_after_seconds integer,p_http_status integer,p_provider_code text,p_request_id text,p_message text,p_evidence jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.twitter_publication_attempts;i public.twitter_publication_items;h public.twitter_item_holds;retry_seconds integer:=greatest(coalesce(p_retry_after_seconds,0),240);released bigint:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  if exists(select 1 from public.twitter_financial_resolutions where idempotency_key=p_idempotency_key) then return jsonb_build_object('handled',true,'idempotentReplay',true); end if;
  select * into a from public.twitter_publication_attempts where id=p_attempt_id for update;
  if not found then raise exception using errcode='P0002'; end if;
  select * into i from public.twitter_publication_items where id=a.item_id for update;
  if i.dispatch_deadline_at is null or timezone('utc',now())+make_interval(secs=>retry_seconds)<=i.dispatch_deadline_at then return jsonb_build_object('handled',false); end if;
  if a.external_started_at is null then raise exception using errcode='55000'; end if;
  select * into h from public.twitter_item_holds where item_id=i.id for update;
  if h.status='active' then update public.twitter_item_holds set status='reserved',activated_at=null where item_id=i.id; end if;
  if h.status in('active','reserved') then released:=public.twitter_release_item_hold(i.id,'Retry X ultrapassaria a janela de 15 minutos.',p_idempotency_key||':release'); end if;
  update public.twitter_publication_items set status='missed',missed_at=timezone('utc',now()),missed_reason='rate_limit_after_deadline',next_attempt_at=null,claimed_at=null,claimed_by=null where id=i.id;
  update public.twitter_publication_attempts set status='failed',finished_at=timezone('utc',now()),http_status=p_http_status,provider_code=left(p_provider_code,120),request_id=left(p_request_id,255),retry_after_seconds=retry_seconds,error_message=left(p_message,1000),evidence=coalesce(p_evidence,'{}') where id=a.id;
  insert into public.twitter_financial_resolutions(organization_id,item_id,attempt_id,resolution,justification,evidence,idempotency_key)
  values(i.organization_id,i.id,a.id,'rate_limited','Retry não cabia na janela de publicação de 15 minutos.',coalesce(p_evidence,'{}'),p_idempotency_key);
  insert into public.twitter_operation_logs(organization_id,item_id,attempt_id,connection_id,profile_id,phase,http_status,provider_code,request_id,estimated_micros,settled_micros,message,metadata)
  values(i.organization_id,i.id,a.id,i.connection_id,i.profile_id,'dispatch_deadline_missed',p_http_status,left(p_provider_code,120),left(p_request_id,255),i.amount_micros,0,'Retry não executado porque ultrapassaria a janela.',jsonb_build_object('retryAfterSeconds',retry_seconds,'releasedMicros',released));
  return jsonb_build_object('handled',true,'itemId',i.id,'resolution','missed','releasedMicros',released,'retryAfterSeconds',retry_seconds,'idempotentReplay',false);
end $$;

create or replace function public.twitter_schedule_profile_disconnection(p_attempt_id uuid,p_signal text,p_provider_code text,p_provider_message text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.twitter_publication_attempts;i public.twitter_publication_items;incident public.twitter_profile_disconnection_incidents;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  if p_signal not in('account_disconnected','auth_expired') then raise exception using errcode='22023',message='Sinal de desconexão X não homologado.'; end if;
  select * into a from public.twitter_publication_attempts where id=p_attempt_id;
  if not found then raise exception using errcode='P0002'; end if;
  select * into i from public.twitter_publication_items where id=a.item_id;
  insert into public.twitter_profile_disconnection_incidents(organization_id,profile_id,connection_id,item_id,attempt_id,signal,provider_code,provider_message)
  values(i.organization_id,i.profile_id,i.connection_id,i.id,a.id,p_signal,left(p_provider_code,120),left(p_provider_message,1000))
  on conflict(profile_id) where status in('scheduled','recycling') do update set occurrence_count=public.twitter_profile_disconnection_incidents.occurrence_count+1,attempt_id=excluded.attempt_id,item_id=excluded.item_id,signal=excluded.signal,provider_code=excluded.provider_code,provider_message=excluded.provider_message,updated_at=timezone('utc',now()) returning * into incident;
  update public.twitter_profiles set status='offline',can_post=false,token_valid=false,needs_reconnect=true where id=i.profile_id and organization_id=i.organization_id;
  insert into public.twitter_operation_logs(organization_id,item_id,attempt_id,connection_id,profile_id,phase,provider_code,message,metadata)
  values(i.organization_id,i.id,a.id,i.connection_id,i.profile_id,'profile_disconnection_scheduled',left(p_provider_code,120),'Perfil X retirado da publicação após sinal terminal homologado.',jsonb_build_object('signal',p_signal,'incidentId',incident.id));
  return jsonb_build_object('incidentId',incident.id,'profileId',i.profile_id,'signal',p_signal,'status',incident.status);
end $$;

create or replace function public.twitter_process_queue_cancellation_operation(p_operation_id uuid,p_limit integer default 500)
returns jsonb language plpgsql security definer set search_path=public as $$
declare op public.twitter_queue_cancellation_operations;row record;affected integer:=0;released bigint:=0;remaining bigint:=0;pending bigint:=0;prior_affected bigint:=0;prior_released bigint:=0;chunk integer:=least(greatest(p_limit,1),500);
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  select * into op from public.twitter_queue_cancellation_operations where id=p_operation_id for update;
  if not found then raise exception using errcode='P0002'; end if;
  if op.status<>'running' then return jsonb_build_object('status',op.status,'result',op.result); end if;
  prior_affected:=coalesce((op.result->>'affectedItems')::bigint,0);prior_released:=coalesce((op.result->>'releasedMicros')::bigint,0);
  for row in
    select i.id,i.status,h.status hold_status,a.id attempt_id,a.external_started_at
    from public.twitter_publication_items i join public.twitter_item_holds h on h.item_id=i.id
    left join lateral(select pa.id,pa.external_started_at from public.twitter_publication_attempts pa where pa.item_id=i.id order by pa.attempt_number desc limit 1)a on true
    where i.organization_id=op.organization_id
      and (op.scope<>'item' or i.id=op.target_id) and (op.scope<>'batch' or i.program_id=op.target_id) and (op.scope<>'account' or i.profile_id=op.target_id)
      and (op.scope<>'group' or exists(select 1 from public.twitter_queue_cancellation_targets t where t.operation_id=op.id and t.profile_id=i.profile_id))
      and ((i.status in('ready','retry') and h.status='reserved') or(i.status='claimed' and h.status='active' and a.external_started_at is null))
    order by i.id for update of i,h skip locked limit chunk
  loop
    if row.hold_status='active' then update public.twitter_item_holds set status='reserved',activated_at=null where item_id=row.id and status='active'; end if;
    released:=released+public.twitter_release_item_hold(row.id,op.reason,op.idempotency_key||':'||row.id::text);
    update public.twitter_publication_items set status='cancelled',cancelled_at=timezone('utc',now()),claimed_at=null,claimed_by=null where id=row.id;
    if row.attempt_id is not null then update public.twitter_publication_attempts set status='cancelled',finished_at=timezone('utc',now()) where id=row.attempt_id and external_started_at is null and status in('claimed','retry'); end if;
    affected:=affected+1;
  end loop;
  select count(*) into remaining from public.twitter_publication_items i join public.twitter_item_holds h on h.item_id=i.id left join lateral(select pa.external_started_at from public.twitter_publication_attempts pa where pa.item_id=i.id order by pa.attempt_number desc limit 1)a on true
  where i.organization_id=op.organization_id and (op.scope<>'item' or i.id=op.target_id) and (op.scope<>'batch' or i.program_id=op.target_id) and (op.scope<>'account' or i.profile_id=op.target_id) and (op.scope<>'group' or exists(select 1 from public.twitter_queue_cancellation_targets t where t.operation_id=op.id and t.profile_id=i.profile_id)) and ((i.status in('ready','retry') and h.status='reserved') or(i.status='claimed' and h.status='active' and a.external_started_at is null));
  if remaining=0 then
    select count(*) into pending from public.twitter_publication_items i where i.organization_id=op.organization_id and (op.scope<>'item' or i.id=op.target_id) and (op.scope<>'batch' or i.program_id=op.target_id) and (op.scope<>'account' or i.profile_id=op.target_id) and (op.scope<>'group' or exists(select 1 from public.twitter_queue_cancellation_targets t where t.operation_id=op.id and t.profile_id=i.profile_id)) and i.status in('processing','outcome_unknown','claimed');
    update public.twitter_queue_cancellation_operations set status='completed',progress=100,result=jsonb_build_object('affectedItems',prior_affected+affected,'releasedMicros',prior_released+released,'pendingReconciliation',pending,'verified',true),completed_at=timezone('utc',now()),updated_at=timezone('utc',now()) where id=op.id returning * into op;
    if op.scope='batch' then update public.twitter_programs set status='cancelled',cancelled_at=timezone('utc',now()) where id=op.target_id and organization_id=op.organization_id; end if;
  else
    update public.twitter_queue_cancellation_operations set progress=least(95,greatest(10,progress+10)),result=jsonb_build_object('affectedItems',prior_affected+affected,'releasedMicros',prior_released+released,'pendingReconciliation',0,'remaining',remaining),updated_at=timezone('utc',now()) where id=op.id returning * into op;
  end if;
  return jsonb_build_object('status',op.status,'progress',op.progress,'result',op.result);
end $$;

do $$ declare definition text; begin
  select pg_get_functiondef('public.twitter_queue_operational_summary(uuid)'::regprocedure) into definition;
  definition:=replace(definition,'item.status = ''cancelled''','item.status in (''cancelled'', ''missed'')');
  definition:=replace(definition,'status = ''cancelled''','status in (''cancelled'', ''missed'')');
  definition:=replace(definition,'item.status in (''failed'', ''outcome_unknown'')','item.status in (''failed'', ''outcome_unknown'', ''missed'')');
  definition:=replace(definition,'status in (''failed'', ''outcome_unknown'')','status in (''failed'', ''outcome_unknown'', ''missed'')');
  execute definition;
end $$;

revoke all on function public.twitter_acquire_dispatch_fence(text,text,integer),public.twitter_validate_dispatch_fence(uuid),public.twitter_publication_scale_audit(),public.twitter_backfill_publication_scale(integer),public.twitter_expire_dispatch_deadlines(integer),public.twitter_claim_preparation_items(text,integer),public.twitter_complete_preparation_item(uuid,text,boolean,jsonb,jsonb,text),public.twitter_claim_publication_items_v2(text,integer,uuid),public.twitter_preview_publication_candidates_v2(integer),public.twitter_profile_queue_summary_page(uuid,uuid[]),public.twitter_start_external_attempt_v2(uuid,text,uuid),public.twitter_validate_attempt_fence(uuid,uuid),public.twitter_record_connection_dispatch_signal(uuid,text,integer),public.twitter_finalize_expired_rate_limit(uuid,text,integer,integer,text,text,text,jsonb),public.twitter_schedule_profile_disconnection(uuid,text,text,text),public.twitter_process_queue_cancellation_operation(uuid,integer) from public,anon,authenticated;
grant execute on function public.twitter_acquire_dispatch_fence(text,text,integer),public.twitter_validate_dispatch_fence(uuid),public.twitter_publication_scale_audit(),public.twitter_backfill_publication_scale(integer),public.twitter_expire_dispatch_deadlines(integer),public.twitter_claim_preparation_items(text,integer),public.twitter_complete_preparation_item(uuid,text,boolean,jsonb,jsonb,text),public.twitter_claim_publication_items_v2(text,integer,uuid),public.twitter_preview_publication_candidates_v2(integer),public.twitter_profile_queue_summary_page(uuid,uuid[]),public.twitter_start_external_attempt_v2(uuid,text,uuid),public.twitter_validate_attempt_fence(uuid,uuid),public.twitter_record_connection_dispatch_signal(uuid,text,integer),public.twitter_finalize_expired_rate_limit(uuid,text,integer,integer,text,text,text,jsonb),public.twitter_schedule_profile_disconnection(uuid,text,text,text),public.twitter_process_queue_cancellation_operation(uuid,integer) to service_role;

notify pgrst,'reload schema';

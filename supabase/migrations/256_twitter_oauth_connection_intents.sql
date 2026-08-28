-- Fila OAuth durável e isolada para conexões X/Twitter.
-- A reserva de capacidade acontece no enqueue; chamadas externas ficam no worker.

create table public.twitter_connection_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  connection_id uuid not null references public.twitter_connections(id) on delete restrict,
  group_id uuid references public.twitter_groups(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null check (char_length(trim(idempotency_key)) between 8 and 255),
  access_token_hash text not null check (access_token_hash ~ '^[a-f0-9]{64}$'),
  callback_token_hash text not null check (callback_token_hash ~ '^[a-f0-9]{64}$'),
  encrypted_callback_token text not null check (char_length(encrypted_callback_token) >= 32),
  status text not null default 'queued' check (status in (
    'queued','preparing','ready','callback_received','reconciling',
    'completed','failed','expired','cancelled'
  )),
  zernio_profile_id text not null check (char_length(trim(zernio_profile_id)) between 1 and 255),
  returned_account_id text,
  returned_username text,
  profile_id uuid references public.twitter_profiles(id) on delete set null,
  encrypted_auth_url text,
  auth_url_delivered_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_by text,
  claim_token uuid,
  claimed_at timestamptz,
  lease_until timestamptz,
  retry_after timestamptz,
  ready_at timestamptz,
  callback_received_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null,
  error_code text,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique(organization_id, idempotency_key),
  check (expires_at > created_at),
  check (returned_account_id is null or char_length(trim(returned_account_id)) between 1 and 255),
  check (returned_username is null or char_length(returned_username) <= 255)
);

create index twitter_connection_intents_claim_idx
  on public.twitter_connection_intents(status, lease_until, created_at, id);
create index twitter_connection_intents_connection_active_idx
  on public.twitter_connection_intents(connection_id, expires_at)
  where status in ('queued','preparing','ready','callback_received','reconciling');
create unique index twitter_connection_intents_callback_hash_idx
  on public.twitter_connection_intents(callback_token_hash);

create trigger twitter_connection_intents_set_updated_at
before update on public.twitter_connection_intents
for each row execute function public.set_updated_at();

alter table public.twitter_connection_events
  drop constraint if exists twitter_connection_events_event_type_check;
alter table public.twitter_connection_events
  add constraint twitter_connection_events_event_type_check check (event_type in (
    'credential_created','credential_rotated','oauth_started','oauth_completed',
    'oauth_queued','oauth_ready','oauth_callback_received','oauth_failed',
    'sync_enqueued','sync_completed','sync_failed','profile_connected',
    'profile_reauthenticated','profile_epoch_changed','connection_deleted',
    'capabilities_changed'
  ));

create or replace function public.twitter_enqueue_connection_intent(
  p_intent_id uuid,
  p_organization_id uuid,
  p_connection_id uuid,
  p_group_id uuid,
  p_created_by uuid,
  p_idempotency_key text,
  p_access_token_hash text,
  p_callback_token_hash text,
  p_encrypted_callback_token text,
  p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  connection_row public.twitter_connections;
  existing public.twitter_connection_intents;
  local_count integer;
  active_count integer;
  used_count integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  if char_length(trim(coalesce(p_idempotency_key,''))) not between 8 and 255
    or p_access_token_hash !~ '^[a-f0-9]{64}$'
    or p_callback_token_hash !~ '^[a-f0-9]{64}$'
    or char_length(coalesce(p_encrypted_callback_token,'')) < 32
    or p_expires_at <= timezone('utc',now())
  then raise exception using errcode='22023',message='Solicitação OAuth X inválida.'; end if;

  select * into existing from public.twitter_connection_intents
  where organization_id=p_organization_id and idempotency_key=trim(p_idempotency_key);
  if found then
    return jsonb_build_object('intentId',existing.id,'status',existing.status,'idempotentReplay',true);
  end if;

  select * into connection_row from public.twitter_connections
  where id=p_connection_id and organization_id=p_organization_id
    and deleted_at is null and status <> 'deleted'
  for update;
  if not found or connection_row.zernio_profile_id is null then
    raise exception using errcode='P0002',message='Conexão Zernio X não encontrada.';
  end if;
  if connection_row.remote_inventory_checked_at is null or connection_row.remote_twitter_account_count is null
    or connection_row.remote_twitter_account_count < 0 or connection_row.last_error_code is not null then
    raise exception using errcode='55000',message='Inventário remoto desta conexão X está indisponível. Sincronize antes de conectar.';
  end if;
  if p_group_id is not null and not exists(
    select 1 from public.twitter_groups
    where id=p_group_id and organization_id=p_organization_id and deleted_at is null
  ) then raise exception using errcode='P0002',message='Grupo X não encontrado.'; end if;

  update public.twitter_connection_intents set status='expired',completed_at=timezone('utc',now()),lease_until=null,claim_token=null,
    error_code='intent_expired',error_message='A autorização não foi concluída dentro do prazo.'
  where connection_id=p_connection_id
    and status in ('queued','preparing','ready') and expires_at <= timezone('utc',now());
  update public.twitter_connection_oauth_attempts set status='expired',error_code='oauth_expired',error_message='Reserva OAuth expirada.'
  where connection_id=p_connection_id and status='pending' and expires_at <= timezone('utc',now());

  select count(*)::integer into local_count from public.twitter_profile_connection_epochs
  where connection_id=p_connection_id and ended_at is null;
  select count(*)::integer into active_count from public.twitter_connection_intents
  where connection_id=p_connection_id
    and status in ('queued','preparing','ready','callback_received','reconciling')
    and expires_at > timezone('utc',now());
  active_count := active_count + (select count(*)::integer from public.twitter_connection_oauth_attempts
    where connection_id=p_connection_id and status='pending' and expires_at > timezone('utc',now()));
  used_count := greatest(coalesce(connection_row.remote_twitter_account_count,0),local_count);
  if used_count + active_count >= connection_row.twitter_slot_limit then
    raise exception using errcode='23514',message='Esta conexão Zernio X não possui vaga livre agora.';
  end if;

  insert into public.twitter_connection_intents(
    id,organization_id,connection_id,group_id,created_by,idempotency_key,
    access_token_hash,callback_token_hash,encrypted_callback_token,zernio_profile_id,expires_at
  ) values(
    p_intent_id,p_organization_id,p_connection_id,p_group_id,p_created_by,trim(p_idempotency_key),
    p_access_token_hash,p_callback_token_hash,p_encrypted_callback_token,connection_row.zernio_profile_id,p_expires_at
  );
  insert into public.twitter_connection_events(
    organization_id,connection_id,event_type,actor_user_id,message,metadata
  ) values(
    p_organization_id,p_connection_id,'oauth_queued',p_created_by,
    'Conexão X adicionada à fila OAuth.',jsonb_build_object('intentId',p_intent_id,'groupId',p_group_id)
  );
  return jsonb_build_object('intentId',p_intent_id,'status','queued','idempotentReplay',false);
exception when unique_violation then
  select * into existing from public.twitter_connection_intents
  where organization_id=p_organization_id and idempotency_key=trim(p_idempotency_key);
  if found then return jsonb_build_object('intentId',existing.id,'status',existing.status,'idempotentReplay',true); end if;
  raise;
end $$;

create or replace function public.twitter_claim_connection_intents(
  p_worker_id text,p_limit integer default 1,p_lease_seconds integer default 300
) returns table(
  intent_id uuid,organization_id uuid,connection_id uuid,zernio_profile_id text,
  returned_account_id text,encrypted_api_key text,encrypted_callback_token text,
  phase text,claim_token uuid,attempt_count integer
) language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  return query
  with expired as (
    update public.twitter_connection_intents intent set status='expired',completed_at=timezone('utc',now()),lease_until=null,claim_token=null,
      error_code='intent_expired',error_message='A autorização não foi concluída dentro do prazo.'
    where intent.status in ('queued','preparing','ready') and intent.expires_at <= timezone('utc',now())
    returning intent.id
  ), candidates as (
    select intent.id
    from public.twitter_connection_intents intent
    where (
      intent.status in ('queued','callback_received')
      or (intent.status in ('preparing','reconciling') and intent.lease_until < timezone('utc',now()))
    ) and intent.expires_at > timezone('utc',now())
      and coalesce(intent.retry_after,timezone('utc',now())) <= timezone('utc',now())
      and (
        intent.status in ('callback_received','reconciling')
        or (
          not exists(
            select 1 from public.twitter_connection_intents preparing
            where preparing.connection_id=intent.connection_id and preparing.status='preparing'
              and preparing.lease_until>=timezone('utc',now())
          )
          and intent.id=(
            select queued.id from public.twitter_connection_intents queued
            where queued.connection_id=intent.connection_id
              and (queued.status='queued' or (queued.status='preparing' and queued.lease_until<timezone('utc',now())))
              and queued.expires_at>timezone('utc',now())
              and coalesce(queued.retry_after,timezone('utc',now())) <= timezone('utc',now())
            order by queued.created_at,queued.id limit 1
          )
        )
      )
    order by case when intent.status in ('callback_received','reconciling') then 0 else 1 end,
      intent.created_at,intent.id
    for update skip locked
    limit least(greatest(coalesce(p_limit,1),1),100)
  ), claimed as (
    update public.twitter_connection_intents intent set
      status=case when intent.status in ('callback_received','reconciling') then 'reconciling' else 'preparing' end,
      claimed_by=left(trim(p_worker_id),255),claim_token=gen_random_uuid(),
      claimed_at=timezone('utc',now()),
      lease_until=timezone('utc',now())+make_interval(secs=>least(greatest(coalesce(p_lease_seconds,300),60),900)),
      attempt_count=intent.attempt_count+1,error_code=null,error_message=null
    from candidates where intent.id=candidates.id returning intent.*
  )
  select claimed.id,claimed.organization_id,claimed.connection_id,claimed.zernio_profile_id,
    claimed.returned_account_id,secret.encrypted_api_key,claimed.encrypted_callback_token,
    case when claimed.status='reconciling' then 'reconcile' else 'prepare' end,
    claimed.claim_token,claimed.attempt_count
  from claimed join public.twitter_connection_secrets secret on secret.connection_id=claimed.connection_id;
end $$;

create or replace function public.twitter_retry_connection_intent(
  p_intent_id uuid,p_claim_token uuid,p_error_code text,p_error_message text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare intent public.twitter_connection_intents;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  select * into intent from public.twitter_connection_intents where id=p_intent_id for update;
  if not found then raise exception using errcode='P0002'; end if;
  if intent.status not in ('preparing','reconciling') or intent.claim_token is distinct from p_claim_token then
    raise exception using errcode='55000',message='Claim OAuth X expirado.';
  end if;
  if intent.attempt_count >= 6 or intent.expires_at <= timezone('utc',now()) + interval '3 seconds' then
    raise exception using errcode='54000',message='Tentativas OAuth X esgotadas.';
  end if;
  update public.twitter_connection_intents set
    status=case when intent.status='reconciling' then 'callback_received' else 'queued' end,
    retry_after=timezone('utc',now())+make_interval(secs=>least(60,greatest(2,power(2,intent.attempt_count)::integer))),
    lease_until=null,claim_token=null,claimed_by=null,claimed_at=null,
    error_code=left(coalesce(p_error_code,'temporary_failure'),120),
    error_message=left(coalesce(p_error_message,'Falha temporária na conexão X.'),700)
  where id=intent.id returning * into intent;
  return jsonb_build_object('intentId',intent.id,'status',intent.status,'retryAfter',intent.retry_after);
end $$;

create or replace function public.twitter_mark_connection_intent_ready(
  p_intent_id uuid,p_claim_token uuid,p_encrypted_auth_url text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare intent public.twitter_connection_intents;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  select * into intent from public.twitter_connection_intents where id=p_intent_id for update;
  if not found then raise exception using errcode='P0002'; end if;
  if intent.status='ready' then return jsonb_build_object('intentId',intent.id,'status',intent.status,'idempotentReplay',true); end if;
  if intent.status<>'preparing' or intent.claim_token is distinct from p_claim_token then
    raise exception using errcode='55000',message='Claim OAuth X expirado.';
  end if;
  update public.twitter_connection_intents set status='ready',encrypted_auth_url=p_encrypted_auth_url,
    ready_at=timezone('utc',now()),lease_until=null,claim_token=null
  where id=intent.id returning * into intent;
  insert into public.twitter_connection_events(organization_id,connection_id,event_type,message,metadata)
  values(intent.organization_id,intent.connection_id,'oauth_ready','URL OAuth X preparada.',jsonb_build_object('intentId',intent.id));
  return jsonb_build_object('intentId',intent.id,'status',intent.status,'idempotentReplay',false);
end $$;

create or replace function public.twitter_record_connection_intent_callback(
  p_intent_id uuid,p_callback_token_hash text,p_zernio_profile_id text,
  p_account_id text,p_username text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare intent public.twitter_connection_intents;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  select * into intent from public.twitter_connection_intents where id=p_intent_id for update;
  if not found or intent.callback_token_hash<>p_callback_token_hash then
    raise exception using errcode='42501',message='Callback OAuth X inválida.';
  end if;
  if intent.status in ('completed','callback_received','reconciling') then
    if intent.returned_account_id is distinct from trim(p_account_id) then
      raise exception using errcode='23505',message='Callback OAuth X divergente.';
    end if;
    return jsonb_build_object('intentId',intent.id,'status',intent.status,'idempotentReplay',true);
  end if;
  if intent.status not in ('ready','preparing') or intent.expires_at<=timezone('utc',now())
    or intent.zernio_profile_id<>trim(p_zernio_profile_id)
    or char_length(trim(coalesce(p_account_id,''))) not between 1 and 255
  then raise exception using errcode='22023',message='Callback OAuth X não corresponde à solicitação.'; end if;
  update public.twitter_connection_intents set status='callback_received',
    returned_account_id=trim(p_account_id),returned_username=left(nullif(trim(coalesce(p_username,'')),''),255),
    callback_received_at=timezone('utc',now()),encrypted_auth_url=null,lease_until=null,claim_token=null
  where id=intent.id returning * into intent;
  insert into public.twitter_connection_events(organization_id,connection_id,event_type,message,metadata)
  values(intent.organization_id,intent.connection_id,'oauth_callback_received','Callback OAuth X recebida.',
    jsonb_build_object('intentId',intent.id,'accountId',intent.returned_account_id));
  return jsonb_build_object('intentId',intent.id,'status',intent.status,'idempotentReplay',false);
end $$;

create or replace function public.twitter_complete_connection_intent(
  p_intent_id uuid,p_claim_token uuid,p_succeeded boolean,p_profile_id uuid,
  p_error_code text default null,p_error_message text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare intent public.twitter_connection_intents;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  select * into intent from public.twitter_connection_intents where id=p_intent_id for update;
  if not found then raise exception using errcode='P0002'; end if;
  if intent.status in ('completed','failed','expired','cancelled') then
    return jsonb_build_object('intentId',intent.id,'status',intent.status,'idempotentReplay',true);
  end if;
  if intent.status not in ('preparing','reconciling') or intent.claim_token is distinct from p_claim_token then
    raise exception using errcode='55000',message='Claim OAuth X expirado.';
  end if;
  if p_succeeded and (p_profile_id is null or intent.status<>'reconciling') then
    raise exception using errcode='22023',message='Conclusão OAuth X inválida.';
  end if;
  if p_succeeded and intent.group_id is not null then
    insert into public.twitter_group_members(organization_id,group_id,profile_id,added_by)
    values(intent.organization_id,intent.group_id,p_profile_id,intent.created_by)
    on conflict(group_id,profile_id) do nothing;
  end if;
  update public.twitter_connection_intents set
    status=case when p_succeeded then 'completed' else 'failed' end,
    completed_at=timezone('utc',now()),lease_until=null,claim_token=null,encrypted_auth_url=null,
    profile_id=case when p_succeeded then p_profile_id else intent.profile_id end,
    error_code=case when p_succeeded then null else left(coalesce(p_error_code,'oauth_failed'),120) end,
    error_message=case when p_succeeded then null else left(coalesce(p_error_message,'Falha na conexão X.'),700) end
  where id=intent.id returning * into intent;
  insert into public.twitter_connection_events(organization_id,connection_id,profile_id,event_type,message,error_code,metadata)
  values(intent.organization_id,intent.connection_id,p_profile_id,
    case when p_succeeded then 'oauth_completed' else 'oauth_failed' end,
    case when p_succeeded then 'Conexão X concluída pela fila.' else 'Conexão X falhou na fila.' end,
    intent.error_code,jsonb_build_object('intentId',intent.id,'accountId',intent.returned_account_id));
  return jsonb_build_object('intentId',intent.id,'status',intent.status,'profileId',p_profile_id,'idempotentReplay',false);
end $$;

alter table public.twitter_connection_intents enable row level security;
create policy twitter_connection_intents_select_admin
on public.twitter_connection_intents for select to authenticated
using(public.has_organization_role(organization_id,array['admin']::public.organization_role[]));

revoke all on table public.twitter_connection_intents from public,anon,authenticated;
grant select on table public.twitter_connection_intents to authenticated;
grant all on table public.twitter_connection_intents to service_role;
revoke all on function public.twitter_enqueue_connection_intent(uuid,uuid,uuid,uuid,uuid,text,text,text,text,timestamptz),
  public.twitter_claim_connection_intents(text,integer,integer),
  public.twitter_mark_connection_intent_ready(uuid,uuid,text),
  public.twitter_retry_connection_intent(uuid,uuid,text,text),
  public.twitter_record_connection_intent_callback(uuid,text,text,text,text),
  public.twitter_complete_connection_intent(uuid,uuid,boolean,uuid,text,text)
from public,anon,authenticated;
grant execute on function public.twitter_enqueue_connection_intent(uuid,uuid,uuid,uuid,uuid,text,text,text,text,timestamptz),
  public.twitter_claim_connection_intents(text,integer,integer),
  public.twitter_mark_connection_intent_ready(uuid,uuid,text),
  public.twitter_retry_connection_intent(uuid,uuid,text,text),
  public.twitter_record_connection_intent_callback(uuid,text,text,text,text),
  public.twitter_complete_connection_intent(uuid,uuid,boolean,uuid,text,text)
to service_role;

create or replace view public.twitter_connection_intent_health as
select
  count(*) filter(where status in ('queued','preparing','ready','callback_received','reconciling'))::bigint as queue_depth,
  min(created_at) filter(where status in ('queued','preparing')) as oldest_queued_at,
  count(*) filter(where status='expired' and completed_at>=timezone('utc',now())-interval '24 hours')::bigint as expired_24h,
  count(*) filter(where attempt_count>1)::bigint as recovered_leases,
  avg(extract(epoch from (ready_at-created_at))) filter(where ready_at is not null) as avg_seconds_to_ready,
  avg(extract(epoch from (completed_at-callback_received_at))) filter(where status='completed' and callback_received_at is not null) as avg_seconds_callback_to_completion
from public.twitter_connection_intents;

create or replace view public.twitter_connection_intent_errors_by_connection as
select connection_id,error_code,count(*)::bigint as error_count,max(updated_at) as last_error_at
from public.twitter_connection_intents
where status='failed' and updated_at>=timezone('utc',now())-interval '24 hours'
group by connection_id,error_code;

revoke all on public.twitter_connection_intent_health,public.twitter_connection_intent_errors_by_connection from public,anon,authenticated;
grant select on public.twitter_connection_intent_health,public.twitter_connection_intent_errors_by_connection to service_role;

notify pgrst,'reload schema';

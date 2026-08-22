-- Forward-only rollout safety corrections for the isolated X/Twitter module.

do $$
declare constraint_name text;
begin
  select conname into constraint_name from pg_constraint
  where conrelid='public.twitter_financial_rules'::regclass and contype='u'
    and pg_get_constraintdef(oid) ilike '%organization_id%phase%http_status%provider_code%active%'
  limit 1;
  if constraint_name is not null then execute format('alter table public.twitter_financial_rules drop constraint %I',constraint_name); end if;
end $$;
create unique index twitter_financial_rules_one_active_exact_idx
on public.twitter_financial_rules(organization_id,phase,http_status,provider_code)
nulls not distinct where active;

create table public.twitter_financial_rule_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  rule_id uuid not null references public.twitter_financial_rules(id) on delete restrict,
  event_type text not null check (event_type in ('created', 'disabled')),
  actor_user_id uuid references auth.users(id) on delete set null,
  justification text not null check (char_length(trim(justification)) between 8 and 1000),
  snapshot jsonb not null,
  created_at timestamptz not null default timezone('utc', now())
);

create trigger twitter_financial_rule_events_immutable
before update or delete on public.twitter_financial_rule_events
for each row execute function public.prevent_twitter_immutable_mutation();

alter table public.twitter_financial_rule_events enable row level security;
create policy twitter_financial_rule_events_select_admin
on public.twitter_financial_rule_events for select to authenticated
using (public.has_organization_role(organization_id, array['admin']::public.organization_role[]));
revoke all on public.twitter_financial_rule_events from anon, authenticated;
grant select on public.twitter_financial_rule_events to authenticated;
grant select, insert on public.twitter_financial_rule_events to service_role;

create or replace function public.twitter_create_financial_rule(
  p_organization_id uuid,
  p_phase text,
  p_http_status integer,
  p_provider_code text,
  p_action public.twitter_financial_rule_action,
  p_justification text,
  p_actor_user_id uuid
) returns public.twitter_financial_rules
language plpgsql security definer set search_path = public as $$
declare created_rule public.twitter_financial_rules;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception using errcode='42501'; end if;
  if char_length(trim(coalesce(p_justification, ''))) < 8 then raise exception using errcode='22023', message='Justificativa obrigatória.'; end if;
  insert into public.twitter_financial_rules(organization_id,phase,http_status,provider_code,action,justification,created_by)
  values(p_organization_id,trim(p_phase),p_http_status,trim(p_provider_code),p_action,trim(p_justification),p_actor_user_id)
  returning * into created_rule;
  insert into public.twitter_financial_rule_events(organization_id,rule_id,event_type,actor_user_id,justification,snapshot)
  values(p_organization_id,created_rule.id,'created',p_actor_user_id,trim(p_justification),to_jsonb(created_rule));
  return created_rule;
end $$;

create or replace function public.twitter_disable_financial_rule(
  p_organization_id uuid,
  p_rule_id uuid,
  p_justification text,
  p_actor_user_id uuid
) returns public.twitter_financial_rules
language plpgsql security definer set search_path = public as $$
declare disabled_rule public.twitter_financial_rules;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception using errcode='42501'; end if;
  if char_length(trim(coalesce(p_justification, ''))) < 8 then raise exception using errcode='22023', message='Justificativa obrigatória.'; end if;
  update public.twitter_financial_rules
  set active=false, disabled_at=timezone('utc',now()), disabled_by=p_actor_user_id
  where id=p_rule_id and organization_id=p_organization_id and active
  returning * into disabled_rule;
  if not found then raise exception using errcode='P0002', message='Regra ativa não encontrada.'; end if;
  insert into public.twitter_financial_rule_events(organization_id,rule_id,event_type,actor_user_id,justification,snapshot)
  values(p_organization_id,disabled_rule.id,'disabled',p_actor_user_id,trim(p_justification),to_jsonb(disabled_rule));
  return disabled_rule;
end $$;

revoke all on function public.twitter_create_financial_rule(uuid,text,integer,text,public.twitter_financial_rule_action,text,uuid) from public,anon,authenticated;
revoke all on function public.twitter_disable_financial_rule(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.twitter_create_financial_rule(uuid,text,integer,text,public.twitter_financial_rule_action,text,uuid) to service_role;
grant execute on function public.twitter_disable_financial_rule(uuid,uuid,text,uuid) to service_role;

create or replace function public.twitter_recover_expired_analytics_claims(p_lease_seconds integer default 300)
returns integer language plpgsql security definer set search_path=public as $$
declare affected integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  with expired as (
    select i.id, a.id attempt_id
    from public.twitter_analytics_items i
    join public.twitter_analytics_attempts a on a.item_id=i.id and a.status='claimed'
    where i.status='processing'
      and i.claimed_at < timezone('utc',now())-make_interval(secs=>least(greatest(p_lease_seconds,30),3600))
    for update of i,a skip locked
  ), attempts as (
    update public.twitter_analytics_attempts a set status='outcome_unknown',finished_at=timezone('utc',now()),
      provider_code='lease_expired',error_message='Lease expirado após claim; cobrança externa é incerta.'
    from expired e where a.id=e.attempt_id returning a.item_id
  )
  update public.twitter_analytics_items i set status='outcome_unknown',result_code='lease_expired',
    error_message='Lease expirado após claim; requer reconciliação.'
  from attempts a where i.id=a.item_id;
  get diagnostics affected=row_count;
  return affected;
end $$;
revoke all on function public.twitter_recover_expired_analytics_claims(integer) from public,anon,authenticated;
grant execute on function public.twitter_recover_expired_analytics_claims(integer) to service_role;

create or replace function public.twitter_worker_circuit_breaker(
  p_scope_key text,
  p_operation text,
  p_reason text default null,
  p_threshold integer default 5,
  p_cooldown_seconds integer default 300
) returns jsonb language plpgsql security definer set search_path=public as $$
declare breaker public.twitter_circuit_breakers; allowed boolean:=true;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  if p_operation not in ('check','success','failure') then raise exception using errcode='22023'; end if;
  insert into public.twitter_circuit_breakers(scope_key,state) values(trim(p_scope_key),'closed') on conflict do nothing;
  select * into breaker from public.twitter_circuit_breakers where scope_key=trim(p_scope_key) for update;
  if p_operation='success' then
    update public.twitter_circuit_breakers set state='closed',failure_count=0,opened_at=null,reason=null,updated_at=timezone('utc',now()) where scope_key=breaker.scope_key;
  elsif p_operation='failure' then
    update public.twitter_circuit_breakers set
      failure_count=failure_count+1,
      state=case when failure_count+1>=least(greatest(p_threshold,2),20) then 'open' else state end,
      opened_at=case when failure_count+1>=least(greatest(p_threshold,2),20) then timezone('utc',now()) else opened_at end,
      reason=left(p_reason,500),updated_at=timezone('utc',now())
    where scope_key=breaker.scope_key;
  else
    if breaker.state='open' and breaker.opened_at <= timezone('utc',now())-make_interval(secs=>least(greatest(p_cooldown_seconds,30),3600)) then
      update public.twitter_circuit_breakers set state='half_open',updated_at=timezone('utc',now()) where scope_key=breaker.scope_key;
      allowed:=true;
    else allowed:=breaker.state<>'open'; end if;
  end if;
  select * into breaker from public.twitter_circuit_breakers where scope_key=trim(p_scope_key);
  return jsonb_build_object('scopeKey',breaker.scope_key,'state',breaker.state,'failureCount',breaker.failure_count,'allowed',case when p_operation='check' then allowed else breaker.state<>'open' end);
end $$;
revoke all on function public.twitter_worker_circuit_breaker(text,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.twitter_worker_circuit_breaker(text,text,text,integer,integer) to service_role;

-- Connection deletion releases only never-started item holds. Active/unknown holds remain for reconciliation.
create or replace function public.twitter_soft_delete_connection(
  p_organization_id uuid,p_connection_id uuid,p_reason text,p_actor_user_id uuid,p_actor_email text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare connection_row public.twitter_connections; item_row record; released_total bigint:=0; profile_count integer:=0; pending integer:=0;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  if char_length(trim(coalesce(p_reason,'')))<3 then raise exception using errcode='22023',message='Motivo obrigatório.'; end if;
  select * into connection_row from public.twitter_connections where id=p_connection_id and organization_id=p_organization_id for update;
  if not found then raise exception using errcode='P0002',message='Conexão não encontrada.'; end if;
  if connection_row.status='deleted' then return jsonb_build_object('connectionId',p_connection_id,'idempotentReplay',true,'releasedMicros',0); end if;
  for item_row in select i.id,i.status,h.status hold_status from public.twitter_publication_items i join public.twitter_item_holds h on h.item_id=i.id where i.connection_id=p_connection_id and i.organization_id=p_organization_id and i.status in('ready','retry','claimed','processing','outcome_unknown') for update of i,h loop
    if item_row.status in('ready','retry') and item_row.hold_status='reserved' then
      released_total:=released_total+public.twitter_release_item_hold(item_row.id,trim(p_reason),'connection-delete:'||item_row.id::text);
      update public.twitter_publication_items set status='cancelled',cancelled_at=timezone('utc',now()) where id=item_row.id;
    else pending:=pending+1; end if;
  end loop;
  update public.twitter_profile_connection_epochs set ended_at=timezone('utc',now()),end_reason='connection_deleted' where connection_id=p_connection_id and ended_at is null;
  update public.twitter_profiles set status='deleted',deleted_at=timezone('utc',now()),can_post=false,current_connection_id=null,current_epoch_id=null where organization_id=p_organization_id and current_connection_id=p_connection_id and deleted_at is null;
  get diagnostics profile_count=row_count;
  update public.twitter_connection_oauth_attempts set status='expired',error_code='connection_deleted',error_message='Conexão removida.' where connection_id=p_connection_id and status='pending';
  delete from public.twitter_connection_secrets where connection_id=p_connection_id;
  update public.twitter_connections set status='deleted',deleted_at=timezone('utc',now()),analytics_enabled=false,inbox_enabled=false,last_error_code='connection_deleted',last_error_message=trim(p_reason) where id=p_connection_id;
  insert into public.twitter_connection_events(organization_id,connection_id,event_type,actor_user_id,actor_email,message,metadata) values(p_organization_id,p_connection_id,'connection_deleted',p_actor_user_id,nullif(trim(coalesce(p_actor_email,'')),''),trim(p_reason),jsonb_build_object('releasedMicros',released_total,'profilesDeleted',profile_count,'pendingReconciliation',pending));
  return jsonb_build_object('connectionId',p_connection_id,'idempotentReplay',false,'releasedMicros',released_total,'profilesDeleted',profile_count,'pendingReconciliation',pending);
end $$;

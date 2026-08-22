-- Resultado financeiro por item X. A reserva agregada continua aberta enquanto houver holds.
alter type public.twitter_item_status add value if not exists 'processing';

create type public.twitter_financial_resolution as enum (
  'local_failure', 'confirmed_failure', 'rate_limited', 'accepted',
  'published', 'existing_post', 'outcome_unknown'
);

create type public.twitter_financial_rule_action as enum ('release', 'retry', 'hold', 'settle');

create table public.twitter_financial_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete restrict,
  phase text not null check (char_length(trim(phase)) between 1 and 80),
  http_status integer not null check (http_status between 100 and 599),
  provider_code text not null check (char_length(trim(provider_code)) between 1 and 120),
  action public.twitter_financial_rule_action not null,
  active boolean not null default true,
  justification text not null check (char_length(trim(justification)) between 8 and 1000),
  created_by uuid references auth.users(id) on delete set null,
  disabled_by uuid references auth.users(id) on delete set null,
  disabled_at timestamptz,
  created_at timestamptz not null default timezone('utc',now()),
  unique nulls not distinct (organization_id, phase, http_status, provider_code, active),
  check (active = (disabled_at is null))
);

create table public.twitter_financial_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  item_id uuid not null references public.twitter_publication_items(id) on delete restrict,
  attempt_id uuid not null references public.twitter_publication_attempts(id) on delete restrict,
  resolution public.twitter_financial_resolution not null,
  justification text not null check (char_length(trim(justification)) between 8 and 2000),
  evidence jsonb not null default '{}',
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 255),
  created_at timestamptz not null default timezone('utc',now())
);

create trigger twitter_financial_resolutions_immutable before update or delete on public.twitter_financial_resolutions
for each row execute function public.prevent_twitter_immutable_mutation();

create or replace function public.twitter_start_external_attempt(
  p_attempt_id uuid, p_idempotency_key text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare attempt_row public.twitter_publication_attempts;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  select * into attempt_row from public.twitter_publication_attempts where id=p_attempt_id for update;
  if not found then raise exception using errcode='P0002',message='Tentativa X ausente.'; end if;
  if attempt_row.status <> 'claimed' then
    return jsonb_build_object('attemptId',attempt_row.id,'idempotentReplay',true,'status',attempt_row.status);
  end if;
  update public.twitter_publication_attempts set status='external_started',external_started_at=timezone('utc',now()) where id=attempt_row.id;
  insert into public.twitter_operation_logs(organization_id,item_id,attempt_id,phase,message,metadata)
  select i.organization_id,i.id,attempt_row.id,'external_started','Chamada externa Zernio iniciada.',jsonb_build_object('idempotencyKey',p_idempotency_key)
  from public.twitter_publication_items i where i.id=attempt_row.item_id;
  return jsonb_build_object('attemptId',attempt_row.id,'idempotentReplay',false,'status','external_started');
end $$;

create or replace function public.twitter_resolve_publication_attempt(
  p_attempt_id uuid,
  p_resolution public.twitter_financial_resolution,
  p_idempotency_key text,
  p_http_status integer default null,
  p_provider_code text default null,
  p_request_id text default null,
  p_post_id text default null,
  p_retry_after_seconds integer default null,
  p_message text default null,
  p_evidence jsonb default '{}',
  p_manual boolean default false,
  p_justification text default null,
  p_actor_user_id uuid default null,
  p_actor_email text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  attempt_row public.twitter_publication_attempts;
  item_row public.twitter_publication_items;
  hold_row public.twitter_item_holds;
  released bigint:=0;
  settled bigint:=0;
  retry_seconds integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  if char_length(trim(coalesce(p_idempotency_key,''))) not between 8 and 255 then raise exception using errcode='22023'; end if;
  if p_manual and char_length(trim(coalesce(p_justification,''))) < 8 then raise exception using errcode='22023',message='Justificativa obrigatória.'; end if;
  if exists(select 1 from public.twitter_financial_resolutions where idempotency_key=trim(p_idempotency_key)) then
    return jsonb_build_object('idempotentReplay',true);
  end if;

  select * into attempt_row from public.twitter_publication_attempts where id=p_attempt_id for update;
  if not found then raise exception using errcode='P0002',message='Tentativa X ausente.'; end if;
  select * into item_row from public.twitter_publication_items where id=attempt_row.item_id for update;
  select * into hold_row from public.twitter_item_holds where item_id=item_row.id for update;
  if hold_row.status in ('settled','released') then
    return jsonb_build_object('idempotentReplay',true,'holdStatus',hold_row.status);
  end if;
  if not p_manual and attempt_row.status not in ('claimed','external_started') then
    raise exception using errcode='55000',message='Tentativa X já possui resultado terminal.';
  end if;

  if p_resolution in ('local_failure','confirmed_failure') then
    if p_resolution='local_failure' and attempt_row.external_started_at is not null then
      raise exception using errcode='55000',message='Falha local inválida após chamada externa.';
    end if;
    update public.twitter_item_holds set status='reserved',activated_at=null where item_id=item_row.id;
    released:=public.twitter_release_item_hold(item_row.id,coalesce(p_message,'falha confirmada'),trim(p_idempotency_key)||':release');
    update public.twitter_publication_items set status='failed',claimed_at=null,claimed_by=null where id=item_row.id;
    update public.twitter_publication_attempts set status='failed',finished_at=timezone('utc',now()) where id=attempt_row.id;
  elsif p_resolution='rate_limited' then
    if attempt_row.external_started_at is null then raise exception using errcode='55000',message='429 exige chamada externa iniciada.'; end if;
    retry_seconds:=greatest(coalesce(p_retry_after_seconds,0),240);
    update public.twitter_item_holds set status='reserved',activated_at=null where item_id=item_row.id;
    update public.twitter_publication_items set status='retry',next_attempt_at=timezone('utc',now())+make_interval(secs=>retry_seconds),claimed_at=null,claimed_by=null where id=item_row.id;
    update public.twitter_publication_attempts set status='retry',retry_after_seconds=retry_seconds,finished_at=timezone('utc',now()) where id=attempt_row.id;
  elsif p_resolution='accepted' then
    if attempt_row.external_started_at is null then raise exception using errcode='55000',message='Aceite exige chamada externa iniciada.'; end if;
    update public.twitter_publication_items set status='processing' where id=item_row.id;
  elsif p_resolution in ('published','existing_post') then
    if attempt_row.external_started_at is null and not p_manual then raise exception using errcode='55000',message='Liquidação exige chamada externa iniciada.'; end if;
    perform public.twitter_settle_wallet_reservation(hold_row.reservation_id,hold_row.amount_micros,trim(p_idempotency_key)||':debit',jsonb_build_object('itemId',item_row.id,'attemptId',attempt_row.id,'postId',p_post_id,'resolution',p_resolution));
    settled:=hold_row.amount_micros;
    update public.twitter_item_holds set status='settled',resolved_at=timezone('utc',now()) where item_id=item_row.id;
    update public.twitter_publication_items set status='published',claimed_at=null,claimed_by=null where id=item_row.id;
    update public.twitter_publication_attempts set status='published',finished_at=timezone('utc',now()) where id=attempt_row.id;
  elsif p_resolution='outcome_unknown' then
    if attempt_row.external_started_at is null then raise exception using errcode='55000',message='Resultado incerto exige chamada externa iniciada.'; end if;
    update public.twitter_item_holds set status='outcome_unknown' where item_id=item_row.id;
    update public.twitter_publication_items set status='outcome_unknown' where id=item_row.id;
    update public.twitter_publication_attempts set status='outcome_unknown',finished_at=timezone('utc',now()) where id=attempt_row.id;
  end if;

  update public.twitter_publication_attempts set http_status=p_http_status,provider_code=nullif(trim(p_provider_code),''),request_id=nullif(trim(p_request_id),''),post_id=nullif(trim(p_post_id),''),retry_after_seconds=coalesce(retry_seconds,p_retry_after_seconds),error_message=left(p_message,1000),evidence=coalesce(p_evidence,'{}') where id=attempt_row.id;
  insert into public.twitter_financial_resolutions(organization_id,item_id,attempt_id,resolution,justification,evidence,actor_user_id,actor_email,idempotency_key)
  values(item_row.organization_id,item_row.id,attempt_row.id,p_resolution,case when p_manual then trim(p_justification) else 'Resultado classificado pelo worker.' end,coalesce(p_evidence,'{}'),p_actor_user_id,left(p_actor_email,320),trim(p_idempotency_key));
  insert into public.twitter_operation_logs(organization_id,item_id,attempt_id,connection_id,profile_id,phase,http_status,provider_code,request_id,post_id,estimated_micros,settled_micros,message,metadata)
  values(item_row.organization_id,item_row.id,attempt_row.id,item_row.connection_id,item_row.profile_id,p_resolution::text,p_http_status,nullif(trim(p_provider_code),''),nullif(trim(p_request_id),''),nullif(trim(p_post_id),''),item_row.amount_micros,settled,left(p_message,1000),jsonb_build_object('manual',p_manual,'releasedMicros',released));
  return jsonb_build_object('itemId',item_row.id,'resolution',p_resolution,'releasedMicros',released,'settledMicros',settled,'retryAfterSeconds',retry_seconds,'idempotentReplay',false);
end $$;

alter table public.twitter_financial_rules enable row level security;
alter table public.twitter_financial_resolutions enable row level security;
create policy twitter_financial_rules_select_member on public.twitter_financial_rules for select to authenticated using(organization_id is null or public.is_organization_member(organization_id));
create policy twitter_financial_resolutions_select_member on public.twitter_financial_resolutions for select to authenticated using(public.is_organization_member(organization_id));
revoke all on table public.twitter_financial_rules,public.twitter_financial_resolutions from anon,authenticated;
grant select on public.twitter_financial_rules,public.twitter_financial_resolutions to authenticated;
grant select,insert,update on public.twitter_financial_rules to service_role;
grant select,insert on public.twitter_financial_resolutions to service_role;
revoke all on function public.twitter_start_external_attempt(uuid,text),public.twitter_resolve_publication_attempt(uuid,public.twitter_financial_resolution,text,integer,text,text,text,integer,text,jsonb,boolean,text,uuid,text) from public,anon,authenticated;
grant execute on function public.twitter_start_external_attempt(uuid,text),public.twitter_resolve_publication_attempt(uuid,public.twitter_financial_resolution,text,integer,text,text,text,integer,text,jsonb,boolean,text,uuid,text) to service_role;

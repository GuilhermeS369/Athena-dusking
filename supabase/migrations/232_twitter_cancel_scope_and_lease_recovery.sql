-- Escopos explícitos de cancelamento e recuperação sem retry cego.
create or replace function public.twitter_cancel_publication_scope(
  p_organization_id uuid,
  p_item_id uuid default null,
  p_program_id uuid default null,
  p_profile_id uuid default null,
  p_group_profile_ids uuid[] default null,
  p_reason text default null,
  p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare row record;released bigint:=0;affected integer:=0;pending integer:=0;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  if p_item_id is null and p_program_id is null and p_profile_id is null and coalesce(cardinality(p_group_profile_ids),0)=0 then raise exception using errcode='22023',message='Escopo de cancelamento X obrigatório.'; end if;
  if char_length(trim(coalesce(p_reason,'')))<4 or char_length(trim(coalesce(p_idempotency_key,'')))<8 then raise exception using errcode='22023'; end if;
  for row in
    select i.id,i.status,h.status hold_status,a.id attempt_id,a.status attempt_status,a.external_started_at
    from public.twitter_publication_items i join public.twitter_item_holds h on h.item_id=i.id
    left join lateral(select pa.* from public.twitter_publication_attempts pa where pa.item_id=i.id order by pa.attempt_number desc limit 1)a on true
    where i.organization_id=p_organization_id
      and (p_item_id is null or i.id=p_item_id)
      and (p_program_id is null or i.program_id=p_program_id)
      and (p_profile_id is null or i.profile_id=p_profile_id)
      and (coalesce(cardinality(p_group_profile_ids),0)=0 or i.profile_id=any(p_group_profile_ids))
      and i.status in('ready','retry','claimed','processing','outcome_unknown')
    for update of i,h
  loop
    if row.hold_status='reserved' and row.status in('ready','retry') then
      released:=released+public.twitter_release_item_hold(row.id,p_reason,trim(p_idempotency_key)||':'||row.id::text);
      update public.twitter_publication_items set status='cancelled',cancelled_at=timezone('utc',now()),claimed_at=null,claimed_by=null where id=row.id;
      if row.attempt_id is not null then update public.twitter_publication_attempts set status='cancelled',finished_at=timezone('utc',now()) where id=row.attempt_id and status='retry'; end if;
      affected:=affected+1;
    elsif row.hold_status='active' and row.status='claimed' and row.external_started_at is null then
      update public.twitter_item_holds set status='reserved',activated_at=null where item_id=row.id;
      released:=released+public.twitter_release_item_hold(row.id,p_reason,trim(p_idempotency_key)||':'||row.id::text);
      update public.twitter_publication_items set status='cancelled',cancelled_at=timezone('utc',now()),claimed_at=null,claimed_by=null where id=row.id;
      update public.twitter_publication_attempts set status='cancelled',finished_at=timezone('utc',now()) where id=row.attempt_id;
      affected:=affected+1;
    else pending:=pending+1;
    end if;
  end loop;
  return jsonb_build_object('affectedItems',affected,'releasedMicros',released,'pendingReconciliation',pending,'idempotentReplay',affected=0 and pending=0);
end $$;

create or replace function public.twitter_recover_expired_claims(
  p_lease_seconds integer default 300
) returns jsonb language plpgsql security definer set search_path=public as $$
declare row record;retried integer:=0;unknown integer:=0;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception using errcode='42501'; end if;
  for row in
    select i.id item_id,a.id attempt_id,a.external_started_at
    from public.twitter_publication_items i join public.twitter_publication_attempts a on a.item_id=i.id and a.attempt_number=i.attempt_count
    where i.status='claimed' and i.claimed_at<timezone('utc',now())-make_interval(secs=>least(greatest(p_lease_seconds,60),3600))
    for update of i,a
  loop
    if row.external_started_at is null then
      update public.twitter_item_holds set status='reserved',activated_at=null where item_id=row.item_id and status='active';
      update public.twitter_publication_items set status='retry',next_attempt_at=timezone('utc',now()),claimed_at=null,claimed_by=null where id=row.item_id;
      update public.twitter_publication_attempts set status='failed',finished_at=timezone('utc',now()),error_message='Lease expirou antes da chamada externa.' where id=row.attempt_id;
      retried:=retried+1;
    else
      update public.twitter_item_holds set status='outcome_unknown' where item_id=row.item_id and status='active';
      update public.twitter_publication_items set status='outcome_unknown' where id=row.item_id;
      update public.twitter_publication_attempts set status='outcome_unknown',finished_at=timezone('utc',now()),error_message='Lease expirou após início da chamada externa.' where id=row.attempt_id;
      unknown:=unknown+1;
    end if;
  end loop;
  return jsonb_build_object('retried',retried,'outcomeUnknown',unknown);
end $$;

revoke all on function public.twitter_cancel_publication_scope(uuid,uuid,uuid,uuid,uuid[],text,text),public.twitter_recover_expired_claims(integer) from public,anon,authenticated;
grant execute on function public.twitter_cancel_publication_scope(uuid,uuid,uuid,uuid,uuid[],text,text),public.twitter_recover_expired_claims(integer) to service_role;

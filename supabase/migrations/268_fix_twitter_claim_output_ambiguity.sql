-- PostgreSQL exposes RETURNS TABLE names as PL/pgSQL variables. Qualify every
-- column that shares an output name so a live claim cannot fail with 42702.
create or replace function public.twitter_claim_publication_items_v2(p_worker_id text,p_limit integer,p_fencing_token uuid)
returns table(item_id uuid,attempt_id uuid,organization_id uuid,profile_id uuid,connection_id uuid,content text,execute_at timestamptz,dispatch_deadline_at timestamptz,amount_micros bigint,payload_snapshot jsonb,media_manifest jsonb,fencing_token uuid)
language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501'; end if;
  if not public.twitter_validate_dispatch_fence(p_fencing_token) then raise exception using errcode='55000',message='Fencing X inválido ou vencido.'; end if;
  insert into public.twitter_connection_dispatch_limits(connection_id)
  select connection_row.id from public.twitter_connections connection_row where connection_row.deleted_at is null
  on conflict do nothing;
  return query with active as(
    select active_item.connection_id,count(*)::integer total
    from public.twitter_publication_items active_item
    where active_item.status in('claimed','processing','outcome_unknown')
    group by active_item.connection_id
  ),eligible as(
    select candidate_item.id,row_number() over(partition by candidate_item.connection_id order by candidate_item.execute_at,candidate_item.id) connection_rank
    from public.twitter_publication_items candidate_item
    join public.twitter_connection_dispatch_limits connection_limit on connection_limit.connection_id=candidate_item.connection_id
    left join active active_count on active_count.connection_id=candidate_item.connection_id
    where candidate_item.status in('ready','retry') and candidate_item.preparation_status='ready' and candidate_item.dispatch_deadline_at>timezone('utc',now())
      and coalesce(candidate_item.next_attempt_at,candidate_item.execute_at)<=timezone('utc',now()) and coalesce(connection_limit.throttled_until,'-infinity'::timestamptz)<=timezone('utc',now())
      and not exists(select 1 from public.twitter_publication_items active_profile where active_profile.profile_id=candidate_item.profile_id and active_profile.status in('claimed','processing','outcome_unknown'))
      and candidate_item.id=(select first_profile_item.id from public.twitter_publication_items first_profile_item where first_profile_item.profile_id=candidate_item.profile_id and first_profile_item.status in('ready','retry') order by case when first_profile_item.status='retry' then 0 else 1 end,coalesce(first_profile_item.next_attempt_at,first_profile_item.execute_at),first_profile_item.id limit 1)
      and coalesce(active_count.total,0)<connection_limit.current_limit
  ),candidates as(
    select eligible_item.id
    from eligible eligible_item
    join public.twitter_publication_items locked_item on locked_item.id=eligible_item.id
    join public.twitter_connection_dispatch_limits connection_limit on connection_limit.connection_id=locked_item.connection_id
    left join active active_count on active_count.connection_id=locked_item.connection_id
    where eligible_item.connection_rank<=connection_limit.current_limit-coalesce(active_count.total,0)
    order by eligible_item.connection_rank,locked_item.execute_at,locked_item.organization_id,locked_item.connection_id,locked_item.id
    for update of locked_item skip locked
    limit least(greatest(p_limit,1),50)
  ),updated as(
    update public.twitter_publication_items claimed_item
    set status='claimed',claimed_at=timezone('utc',now()),claimed_by=left(p_worker_id,160),attempt_count=claimed_item.attempt_count+1
    from candidates selected_candidate where claimed_item.id=selected_candidate.id
    returning claimed_item.*
  ),attempts as(
    insert into public.twitter_publication_attempts(organization_id,item_id,attempt_number,worker_id,idempotency_key,fencing_token)
    select claimed_item.organization_id,claimed_item.id,claimed_item.attempt_count,left(p_worker_id,160),'twitter-attempt:'||claimed_item.id::text||':'||claimed_item.attempt_count::text,p_fencing_token
    from updated claimed_item
    returning twitter_publication_attempts.id,twitter_publication_attempts.item_id
  ),holds as(
    update public.twitter_item_holds item_hold set status='active',activated_at=timezone('utc',now())
    from updated claimed_item where item_hold.item_id=claimed_item.id returning item_hold.item_id
  )
  select claimed_item.id,(select created_attempt.id from attempts created_attempt where created_attempt.item_id=claimed_item.id),claimed_item.organization_id,claimed_item.profile_id,claimed_item.connection_id,claimed_item.content,claimed_item.execute_at,claimed_item.dispatch_deadline_at,claimed_item.amount_micros,claimed_item.payload_snapshot,claimed_item.media_manifest,p_fencing_token
  from updated claimed_item;
end $$;

revoke all on function public.twitter_claim_publication_items_v2(text,integer,uuid) from public,anon,authenticated;
grant execute on function public.twitter_claim_publication_items_v2(text,integer,uuid) to service_role;

-- Correção forward-only: nomes explícitos evitam conflito com OUT parameters.
create or replace function public.twitter_claim_publication_items(
  p_worker_id text,
  p_limit integer
) returns table(
  item_id uuid,
  attempt_id uuid,
  organization_id uuid,
  profile_id uuid,
  connection_id uuid,
  content text,
  execute_at timestamptz,
  amount_micros bigint,
  media_set_client_key text
) language plpgsql security definer set search_path=public as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception using errcode='42501';
  end if;
  return query
  with candidates as (
    select queue_item.id
    from public.twitter_publication_items queue_item
    where queue_item.status in ('ready','retry')
      and coalesce(queue_item.next_attempt_at,queue_item.execute_at) <= timezone('utc',now())
      and not exists (
        select 1 from public.twitter_publication_items active_item
        where active_item.profile_id=queue_item.profile_id and active_item.status='claimed'
      )
      and queue_item.id=(
        select first_item.id from public.twitter_publication_items first_item
        where first_item.profile_id=queue_item.profile_id
          and first_item.status in ('ready','retry')
          and coalesce(first_item.next_attempt_at,first_item.execute_at)<=timezone('utc',now())
        order by coalesce(first_item.next_attempt_at,first_item.execute_at),first_item.id limit 1
      )
    order by coalesce(queue_item.next_attempt_at,queue_item.execute_at),queue_item.id
    for update skip locked limit least(greatest(p_limit,1),50)
  ), updated_items as (
    update public.twitter_publication_items queue_item
    set status='claimed',claimed_at=timezone('utc',now()),claimed_by=p_worker_id,attempt_count=queue_item.attempt_count+1
    from candidates candidate where queue_item.id=candidate.id returning queue_item.*
  ), attempts(attempt_id_value,attempt_item_id) as (
    insert into public.twitter_publication_attempts(organization_id,item_id,attempt_number,worker_id,idempotency_key)
    select updated_items.organization_id,updated_items.id,updated_items.attempt_count,p_worker_id,
      'twitter-attempt:'||updated_items.id::text||':'||updated_items.attempt_count::text
    from updated_items
    returning public.twitter_publication_attempts.id,public.twitter_publication_attempts.item_id
  )
  update public.twitter_item_holds item_hold
  set status='active',activated_at=timezone('utc',now())
  from updated_items
  where item_hold.item_id=updated_items.id
  returning updated_items.id,
    (select attempts.attempt_id_value from attempts where attempts.attempt_item_id=updated_items.id),
    updated_items.organization_id,updated_items.profile_id,updated_items.connection_id,
    updated_items.content,updated_items.execute_at,updated_items.amount_micros,updated_items.media_set_client_key;
end $$;

revoke all on function public.twitter_claim_publication_items(text,integer) from public,anon,authenticated;
grant execute on function public.twitter_claim_publication_items(text,integer) to service_role;

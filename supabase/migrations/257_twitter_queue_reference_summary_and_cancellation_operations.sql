-- Paridade da fila operacional nova do Instagram para o módulo X.
-- Os agregados continuam isolados nas tabelas twitter_* e o cancelamento
-- preserva os holds de chamadas externas que exigem reconciliação.

create table if not exists public.twitter_queue_cancellation_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  requested_by uuid not null references auth.users(id) on delete restrict,
  scope text not null check (scope in ('account', 'batch', 'group', 'item')),
  target_id uuid,
  target_profile_ids uuid[] not null default '{}',
  target_label text not null check (char_length(target_label) between 1 and 200),
  reason text not null check (char_length(trim(reason)) between 4 and 1000),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 255),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  progress smallint not null default 5 check (progress between 0 and 100),
  result jsonb not null default '{}',
  error_message text,
  completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, idempotency_key)
);

create index if not exists twitter_queue_cancellation_operations_lookup_idx
  on public.twitter_queue_cancellation_operations (organization_id, requested_by, created_at desc);

alter table public.twitter_queue_cancellation_operations enable row level security;
revoke all on table public.twitter_queue_cancellation_operations from public, anon, authenticated;
grant all on table public.twitter_queue_cancellation_operations to service_role;

create or replace function public.twitter_queue_operational_summary(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with recent_programs as (
    select p.id, p.name, p.created_at
    from public.twitter_programs p
    where p.organization_id = p_organization_id
    order by p.created_at desc
    limit 200
  ), queue_items as (
    select i.*, p.name as program_name, p.created_at as program_created_at
    from public.twitter_publication_items i
    join recent_programs p on p.id = i.program_id
    where i.organization_id = p_organization_id
  ), account_rows as (
    select
      profile.id,
      profile.username,
      profile.display_name,
      profile.avatar_url,
      count(item.id) filter (where item.status <> 'cancelled')::integer as total,
      count(item.id) filter (where item.status = 'published')::integer as completed,
      count(item.id) filter (where item.status = 'cancelled')::integer as closed,
      count(item.id) filter (where item.status in ('failed', 'outcome_unknown'))::integer as errors,
      0::integer as suspended,
      count(item.id) filter (where item.status in ('ready', 'retry'))::integer as pending,
      count(item.id) filter (where item.status in ('claimed', 'processing'))::integer as processing,
      count(item.id) filter (where item.status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown'))::integer as active,
      min(coalesce(item.next_attempt_at, item.execute_at)) filter (where item.status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown')) as next_at,
      case
        when count(item.id) filter (where item.status in ('failed', 'outcome_unknown')) > 0 then 'error'
        when count(item.id) filter (where item.status in ('claimed', 'processing')) > 0 then 'posting'
        when count(item.id) filter (where item.status in ('ready', 'retry')) > 0 then 'idle'
        else 'done'
      end as tone
    from public.twitter_profiles profile
    join queue_items item on item.profile_id = profile.id
    where profile.organization_id = p_organization_id and profile.deleted_at is null
    group by profile.id, profile.username, profile.display_name, profile.avatar_url
  ), batch_rows as (
    select
      program.id,
      coalesce(program.name, 'Programa ' || left(program.id::text, 8)) as title,
      program.created_at,
      count(item.id) filter (where item.status <> 'cancelled')::integer as total,
      count(item.id) filter (where item.status = 'published')::integer as completed,
      count(item.id) filter (where item.status = 'cancelled')::integer as closed,
      count(item.id) filter (where item.status in ('failed', 'outcome_unknown'))::integer as errors,
      0::integer as suspended,
      count(item.id) filter (where item.status in ('ready', 'retry'))::integer as pending,
      count(item.id) filter (where item.status in ('claimed', 'processing'))::integer as processing,
      count(item.id) filter (where item.status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown'))::integer as active,
      min(coalesce(item.next_attempt_at, item.execute_at)) filter (where item.status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown')) as next_at,
      case
        when count(item.id) filter (where item.status in ('failed', 'outcome_unknown')) > 0 then 'error'
        when count(item.id) filter (where item.status in ('claimed', 'processing')) > 0 then 'posting'
        when count(item.id) filter (where item.status in ('ready', 'retry')) > 0 then 'idle'
        else 'done'
      end as tone
    from recent_programs program
    join queue_items item on item.program_id = program.id
    group by program.id, program.name, program.created_at
  ), group_rows as (
    select
      twitter_group.id,
      twitter_group.name as title,
      count(distinct member.profile_id)::integer as profile_count,
      count(item.id) filter (where item.status <> 'cancelled')::integer as total,
      count(item.id) filter (where item.status = 'published')::integer as completed,
      count(item.id) filter (where item.status = 'cancelled')::integer as closed,
      count(item.id) filter (where item.status in ('failed', 'outcome_unknown'))::integer as errors,
      0::integer as suspended,
      count(item.id) filter (where item.status in ('ready', 'retry'))::integer as pending,
      count(item.id) filter (where item.status in ('claimed', 'processing'))::integer as processing,
      count(item.id) filter (where item.status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown'))::integer as active,
      min(coalesce(item.next_attempt_at, item.execute_at)) filter (where item.status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown')) as next_at,
      case
        when count(item.id) filter (where item.status in ('failed', 'outcome_unknown')) > 0 then 'error'
        when count(item.id) filter (where item.status in ('claimed', 'processing')) > 0 then 'posting'
        when count(item.id) filter (where item.status in ('ready', 'retry')) > 0 then 'idle'
        else 'done'
      end as tone
    from public.twitter_groups twitter_group
    join public.twitter_group_members member on member.group_id = twitter_group.id and member.organization_id = p_organization_id
    join queue_items item on item.profile_id = member.profile_id
    where twitter_group.organization_id = p_organization_id and twitter_group.deleted_at is null
    group by twitter_group.id, twitter_group.name
  ), totals as (
    select
      count(*) filter (where status <> 'cancelled')::integer as total,
      count(*) filter (where status = 'published')::integer as ok,
      count(*) filter (where status in ('ready', 'retry'))::integer as pending,
      count(*) filter (where status in ('claimed', 'processing'))::integer as processing,
      count(*) filter (where status in ('failed', 'outcome_unknown'))::integer as errors,
      count(*) filter (where status = 'cancelled')::integer as closed,
      count(*) filter (where status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown'))::integer as active,
      count(distinct profile_id) filter (where status in ('ready', 'retry', 'claimed', 'processing', 'outcome_unknown'))::integer as active_accounts,
      count(distinct profile_id) filter (where status <> 'cancelled')::integer as total_accounts
    from queue_items
  )
  select jsonb_build_object(
    'totals', coalesce((select to_jsonb(totals) || jsonb_build_object('progress', case when totals.total = 0 then 0 else round(totals.ok * 100.0 / totals.total)::integer end) from totals), '{}'),
    'accounts', coalesce((select jsonb_agg(to_jsonb(account_rows) order by active desc, errors desc, username) from account_rows), '[]'),
    'batches', coalesce((select jsonb_agg(to_jsonb(batch_rows) order by created_at desc) from batch_rows), '[]'),
    'groups', coalesce((select jsonb_agg(to_jsonb(group_rows) order by active desc, errors desc, title) from group_rows), '[]')
  );
$$;

revoke all on function public.twitter_queue_operational_summary(uuid) from public, anon, authenticated;
grant execute on function public.twitter_queue_operational_summary(uuid) to service_role;

notify pgrst, 'reload schema';

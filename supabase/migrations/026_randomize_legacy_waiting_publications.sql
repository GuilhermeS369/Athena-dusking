-- Migração operacional para normalizar horários legados sem tocar em itens que
-- já entraram no worker. A execução é explícita por RPC; aplicar esta migration
-- não altera nenhuma publicação por si só.
create table public.publication_schedule_randomizations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  publication_item_id uuid not null references public.publication_items(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete restrict,
  original_execute_at timestamptz not null,
  randomized_execute_at timestamptz not null,
  state text not null default 'applied' check (state in ('applied', 'rolled_back', 'rollback_skipped')),
  applied_at timestamptz not null default timezone('utc', now()),
  rolled_back_at timestamptz,
  rollback_note text,
  unique (run_id, publication_item_id)
);

create index publication_schedule_randomizations_run_idx
  on public.publication_schedule_randomizations (run_id, state, applied_at);

alter table public.publication_schedule_randomizations enable row level security;

create policy publication_schedule_randomizations_select_member
  on public.publication_schedule_randomizations for select to authenticated
  using (public.is_organization_member(organization_id));

revoke all on table public.publication_schedule_randomizations from public, anon;
grant select on table public.publication_schedule_randomizations to authenticated;

-- Prévia sem escrita: expõe somente os itens que poderiam ser alterados.
create or replace function public.preview_legacy_waiting_randomization()
returns table (
  organization_id uuid,
  profile_id uuid,
  publication_item_id uuid,
  format public.publication_format,
  original_execute_at timestamptz,
  base_window_start timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    item.organization_id,
    item.profile_id,
    item.id,
    item.format,
    item.execute_at,
    (
      date_trunc('hour', item.execute_at at time zone 'America/Sao_Paulo')
      + make_interval(mins => floor(extract(minute from item.execute_at at time zone 'America/Sao_Paulo') / 10)::integer * 10)
    ) at time zone 'America/Sao_Paulo'
  from public.publication_items item
  where item.status = 'waiting'
    and item.execute_at > timezone('utc', now())
  order by item.organization_id, item.profile_id, item.execute_at, item.id;
$$;

-- Randomiza todos os itens futuros que ainda aguardam. Um mesmo run_id pode ser
-- retomado com segurança: itens já auditados naquele run são ignorados.
create or replace function public.randomize_legacy_waiting_publications(
  p_run_id uuid default gen_random_uuid()
)
returns table (
  run_id uuid,
  publication_item_id uuid,
  original_execute_at timestamptz,
  randomized_execute_at timestamptz,
  state text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
  original_local timestamp;
  candidate_window_start timestamptz;
  candidate_minute timestamptz;
  resolved_execute_at timestamptz;
begin
  for item in
    select queue_item.id, queue_item.organization_id, queue_item.profile_id, queue_item.execute_at
    from public.publication_items queue_item
    where queue_item.status = 'waiting'
      and queue_item.execute_at > timezone('utc', now())
      and not exists (
        select 1 from public.publication_schedule_randomizations audit
        where audit.run_id = p_run_id and audit.publication_item_id = queue_item.id
      )
    order by queue_item.organization_id, queue_item.profile_id, queue_item.execute_at, queue_item.id
  loop
    -- Sincroniza com novos agendamentos e com o trigger de exclusividade.
    perform pg_advisory_xact_lock(hashtextextended(item.profile_id::text, 0));

    select current_item.execute_at into item.execute_at
    from public.publication_items current_item
    where current_item.id = item.id
      and current_item.status = 'waiting'
      and current_item.execute_at > timezone('utc', now())
    for update;
    if item.execute_at is null then
      continue;
    end if;

    original_local := item.execute_at at time zone 'America/Sao_Paulo';
    candidate_window_start := (
      date_trunc('hour', original_local)
      + make_interval(mins => floor(extract(minute from original_local) / 10)::integer * 10)
    ) at time zone 'America/Sao_Paulo';

    loop
      select candidate.minute_start into candidate_minute
      from (
        select candidate_window_start + make_interval(mins => minute_offset) as minute_start
        from generate_series(1, 9) as minute_offset
      ) candidate
      where candidate.minute_start > timezone('utc', now())
        and not exists (
          select 1
          from public.publication_items occupied
          where occupied.organization_id = item.organization_id
            and occupied.profile_id = item.profile_id
            and date_trunc('minute', occupied.execute_at) = candidate.minute_start
            and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
            and occupied.id <> item.id
        )
      order by random()
      limit 1;

      if candidate_minute is not null then
        resolved_execute_at := candidate_minute + make_interval(secs => floor(random() * 60)::integer);
        exit;
      end if;
      candidate_window_start := candidate_window_start + interval '10 minutes';
    end loop;

    update public.publication_items
    set execute_at = resolved_execute_at,
        updated_at = timezone('utc', now())
    where id = item.id
      and status = 'waiting'
      and execute_at = item.execute_at;
    if not found then
      continue;
    end if;

    insert into public.publication_schedule_randomizations (
      run_id, organization_id, publication_item_id, profile_id,
      original_execute_at, randomized_execute_at
    ) values (
      p_run_id, item.organization_id, item.id, item.profile_id,
      item.execute_at, resolved_execute_at
    );

    run_id := p_run_id;
    publication_item_id := item.id;
    original_execute_at := item.execute_at;
    randomized_execute_at := resolved_execute_at;
    state := 'applied';
    return next;
  end loop;
end;
$$;

-- Rollback conservador: nunca restaura um horário se ele passou, se o item saiu
-- de waiting, se seu horário foi alterado depois do run ou se o minuto original
-- foi ocupado por uma reserva nova.
create or replace function public.rollback_legacy_waiting_randomization(p_run_id uuid)
returns table (
  publication_item_id uuid,
  original_execute_at timestamptz,
  randomized_execute_at timestamptz,
  state text,
  note text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  audit record;
begin
  for audit in
    select *
    from public.publication_schedule_randomizations
    where run_id = p_run_id and state = 'applied'
    order by applied_at desc, id desc
    for update
  loop
    perform pg_advisory_xact_lock(hashtextextended(audit.profile_id::text, 0));

    if audit.original_execute_at <= timezone('utc', now()) then
      update public.publication_schedule_randomizations
      set state = 'rollback_skipped', rollback_note = 'O horário original já passou.'
      where id = audit.id;
      publication_item_id := audit.publication_item_id;
      original_execute_at := audit.original_execute_at;
      randomized_execute_at := audit.randomized_execute_at;
      state := 'rollback_skipped';
      note := 'O horário original já passou.';
      return next;
      continue;
    end if;

    if not exists (
      select 1 from public.publication_items item
      where item.id = audit.publication_item_id
        and item.status = 'waiting'
        and item.execute_at = audit.randomized_execute_at
    ) then
      update public.publication_schedule_randomizations
      set state = 'rollback_skipped', rollback_note = 'Item não está mais aguardando no horário randomizado.'
      where id = audit.id;
      publication_item_id := audit.publication_item_id;
      original_execute_at := audit.original_execute_at;
      randomized_execute_at := audit.randomized_execute_at;
      state := 'rollback_skipped';
      note := 'Item não está mais aguardando no horário randomizado.';
      return next;
      continue;
    end if;

    if exists (
      select 1 from public.publication_items occupied
      where occupied.organization_id = audit.organization_id
        and occupied.profile_id = audit.profile_id
        and date_trunc('minute', occupied.execute_at) = date_trunc('minute', audit.original_execute_at)
        and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        and occupied.id <> audit.publication_item_id
    ) then
      update public.publication_schedule_randomizations
      set state = 'rollback_skipped', rollback_note = 'O minuto original está ocupado.'
      where id = audit.id;
      publication_item_id := audit.publication_item_id;
      original_execute_at := audit.original_execute_at;
      randomized_execute_at := audit.randomized_execute_at;
      state := 'rollback_skipped';
      note := 'O minuto original está ocupado.';
      return next;
      continue;
    end if;

    update public.publication_items
    set execute_at = audit.original_execute_at,
        updated_at = timezone('utc', now())
    where id = audit.publication_item_id
      and status = 'waiting'
      and execute_at = audit.randomized_execute_at;

    update public.publication_schedule_randomizations
    set state = 'rolled_back', rolled_back_at = timezone('utc', now()), rollback_note = null
    where id = audit.id;

    publication_item_id := audit.publication_item_id;
    original_execute_at := audit.original_execute_at;
    randomized_execute_at := audit.randomized_execute_at;
    state := 'rolled_back';
    note := null;
    return next;
  end loop;
end;
$$;

revoke all on function public.preview_legacy_waiting_randomization() from public, anon, authenticated;
revoke all on function public.randomize_legacy_waiting_publications(uuid) from public, anon, authenticated;
revoke all on function public.rollback_legacy_waiting_randomization(uuid) from public, anon, authenticated;
grant execute on function public.preview_legacy_waiting_randomization() to service_role;
grant execute on function public.randomize_legacy_waiting_publications(uuid) to service_role;
grant execute on function public.rollback_legacy_waiting_randomization(uuid) to service_role;

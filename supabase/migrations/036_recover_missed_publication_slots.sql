-- Recuperação segura de agendamentos que o worker não iniciou a tempo.
-- Regra de negócio:
--   1. cada item pode ser reagendado automaticamente uma única vez;
--   2. o reagendamento preserva a mesma faixa diária de 10 minutos;
--   3. se a faixa estiver ocupada em um dia futuro para o mesmo perfil, pula
--      o dia inteiro (ex.: 04/08 09:00 perdido, 05/08 09:00 ocupado -> 06/08);
--   4. se o item voltar a vencer após a recuperação, não é movido novamente:
--      fica em falha explícita para intervenção humana.

alter table public.publication_items
  add column if not exists missed_schedule_recovery_count integer not null default 0
  check (missed_schedule_recovery_count >= 0 and missed_schedule_recovery_count <= 1);

create index if not exists publication_items_missed_schedule_recovery_idx
  on public.publication_items (status, execute_at)
  where status in ('waiting', 'ready')
    and execute_at is not null;

create or replace function public.recover_missed_publication_slots(
  p_max_items integer default 100,
  p_grace_seconds integer default 120
)
returns table (
  id uuid,
  organization_id uuid,
  profile_id uuid,
  previous_execute_at timestamptz,
  execute_at timestamptz,
  outcome text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  candidate_window_start timestamptz;
  candidate_minute timestamptz;
  recovered_at timestamptz := timezone('utc', now());
begin
  if p_max_items not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Limite de recuperação deve estar entre 1 e 500';
  end if;
  if p_grace_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Margem de atraso deve estar entre 30 e 3600 segundos';
  end if;

  for item_row in
    select item_source.*
    from public.publication_items as item_source
    where item_source.status in ('waiting', 'ready')
      and item_source.execute_at is not null
      and item_source.execute_at <= recovered_at - make_interval(secs => p_grace_seconds)
      and (item_source.next_attempt_at is null or item_source.next_attempt_at <= recovered_at)
      and (item_source.lease_until is null or item_source.lease_until <= recovered_at)
      and item_source.creation_id is null
    order by item_source.execute_at, item_source.created_at, item_source.id
    for update skip locked
    limit p_max_items
  loop
    id := item_row.id;
    organization_id := item_row.organization_id;
    profile_id := item_row.profile_id;
    previous_execute_at := item_row.execute_at;

    if item_row.missed_schedule_recovery_count >= 1 then
      update public.publication_items as item_update
      set status = 'failed',
          claimed_by = null,
          lease_until = null,
          next_attempt_at = null,
          last_error_code = 'missed_schedule_requires_attention',
          last_error_message = 'A publicação voltou a perder o horário após um reagendamento automático e precisa de intervenção manual.'
      where item_update.id = item_row.id;

      perform public.log_publication_item_event(
        item_row.id, 'failed', item_row.status, 'failed', null,
        'system: missed-schedule-recovery',
        'missed_schedule_requires_attention',
        'A publicação voltou a perder o horário após um reagendamento automático e precisa de intervenção manual.',
        jsonb_build_object('previous_execute_at', item_row.execute_at, 'recovery_count', item_row.missed_schedule_recovery_count)
      );
      perform public.sync_publication_batch_status(item_row.batch_id);

      execute_at := item_row.execute_at;
      outcome := 'requires_attention';
      return next;
      continue;
    end if;

    -- Mantém a mesma faixa horária de São Paulo (por exemplo, 09:00–09:09),
    -- começando pelo próximo dia. Um único item ativo na faixa ocupa aquele
    -- dia inteiro para esta recuperação, preservando a cadência planejada.
    candidate_window_start := (
      ((item_row.execute_at at time zone 'America/Sao_Paulo')::date + 1)
      + date_trunc('hour', item_row.execute_at at time zone 'America/Sao_Paulo')::time
      + make_interval(mins => (extract(minute from item_row.execute_at at time zone 'America/Sao_Paulo')::integer / 10) * 10)
    ) at time zone 'America/Sao_Paulo';

    loop
      exit when candidate_window_start > recovered_at
        and not exists (
          select 1
          from public.publication_items as occupied
          where occupied.organization_id = item_row.organization_id
            and occupied.profile_id = item_row.profile_id
            and occupied.execute_at >= candidate_window_start
            and occupied.execute_at < candidate_window_start + interval '10 minutes'
            and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
        );
      candidate_window_start := candidate_window_start + interval '1 day';
    end loop;

    -- A faixa já está livre no dia escolhido; a distribuição por minuto evita
    -- colisões caso outra recuperação concorrente alcance a mesma faixa.
    perform pg_advisory_xact_lock(hashtextextended(item_row.profile_id::text, 0));
    loop
      candidate_minute := null;
      select candidate.minute_start into candidate_minute
      from (
        select candidate_window_start + make_interval(mins => minute_offset) as minute_start
        from generate_series(1, 9) as minute_offset
      ) as candidate
      where not exists (
        select 1
        from public.publication_items as occupied
        where occupied.organization_id = item_row.organization_id
          and occupied.profile_id = item_row.profile_id
          and date_trunc('minute', occupied.execute_at) = candidate.minute_start
          and occupied.status in ('waiting', 'ready', 'preparing', 'publishing')
      )
      order by random()
      limit 1;

      exit when candidate_minute is not null;
      -- Só alcança este caso em corrida excepcional; mantém o mesmo dia até
      -- esgotá-lo e então passa para a próxima data com a mesma faixa-base.
      candidate_window_start := candidate_window_start + interval '1 day';
    end loop;

    update public.publication_items as item_update
    set execute_at = candidate_minute + make_interval(secs => floor(random() * 60)::integer),
        status = 'waiting',
        claimed_by = null,
        lease_until = null,
        next_attempt_at = null,
        missed_schedule_recovery_count = 1,
        last_error_code = 'missed_schedule_recovered',
        last_error_message = 'O worker não iniciou a publicação no horário previsto; ela foi reagendada automaticamente uma única vez.'
    where item_update.id = item_row.id
    returning item_update.execute_at into execute_at;

    perform public.log_publication_item_event(
      item_row.id, 'processing_deferred', item_row.status, 'waiting', null,
      'system: missed-schedule-recovery',
      'missed_schedule_recovered',
      'O worker não iniciou a publicação no horário previsto; ela foi reagendada automaticamente uma única vez.',
      jsonb_build_object(
        'previous_execute_at', item_row.execute_at,
        'rescheduled_execute_at', execute_at,
        'recovery_count', 1
      )
    );
    perform public.sync_publication_batch_status(item_row.batch_id);

    outcome := 'rescheduled_once';
    return next;
  end loop;
end;
$$;

revoke all on function public.recover_missed_publication_slots(integer, integer) from public, anon, authenticated;
grant execute on function public.recover_missed_publication_slots(integer, integer) to service_role;

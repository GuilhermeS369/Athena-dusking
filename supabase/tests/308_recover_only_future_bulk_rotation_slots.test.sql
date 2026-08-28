begin;
select '1..7';

select case when to_regprocedure('public.set_bulk_rotation_plan_generation_hold(uuid,boolean,text)') is not null
  then 'ok 1 - controle de hold existe' else 'not ok 1 - controle de hold ausente' end;

select case when to_regprocedure('public.recover_future_bulk_rotation_timeout_slots(uuid,text,timestamptz,boolean)') is not null
  then 'ok 2 - reparo futuro existe' else 'not ok 2 - reparo futuro ausente' end;

do $$ declare definition text; begin
  definition := pg_get_functiondef(
    'public.recover_future_bulk_rotation_timeout_slots(uuid,text,timestamptz,boolean)'::regprocedure
  );
  if position('floor(' in definition) = 0
    or position('p_cutoff - chunk_row.schedule_base_at' in definition) = 0
    or position('next_slot_index = future_start' in definition) = 0 then
    raise exception 'Reparo não avança deterministicamente até o primeiro slot futuro.';
  end if;
end $$;
select 'ok 3 - cursor salta horários vencidos';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.recover_future_bulk_rotation_timeout_slots(uuid,text,timestamptz,boolean)'::regprocedure
  ));
  if position('ignored_items = case' in definition) = 0
    or position('chunk.ignored_items + skipped_count' in definition) = 0
    or position('ignored_slot_count = profile_plan.ignored_slot_count + skipped_count' in definition) = 0 then
    raise exception 'Slots vencidos não são contabilizados como ignored.';
  end if;
end $$;
select 'ok 4 - slots vencidos ficam ignored';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.recover_future_bulk_rotation_timeout_slots(uuid,text,timestamptz,boolean)'::regprocedure
  ));
  if position('p_dry_run' in definition) = 0
    or position('statement timeout' in definition) = 0
    or position('other_horizon.status = ''active''' in definition) = 0 then
    raise exception 'Faltam dry-run, escopo por timeout ou proteção de conflito.';
  end if;
end $$;
select 'ok 5 - reparo é pré-visualizável e recusa conflito';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.set_bulk_rotation_plan_generation_hold(uuid,boolean,text)'::regprocedure
  ));
  if position('status = ''paused''' in definition) = 0
    or position('last_error_message = hold_marker' in definition) = 0
    or position('plano possui chunk com lease ativo.' in definition) = 0 then
    raise exception 'Hold não é reversível ou pode disputar lease.';
  end if;
end $$;
select 'ok 6 - hold seletivo é reversível e lease-safe';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.recover_future_bulk_rotation_timeout_slots(uuid,text,timestamptz,boolean)'::regprocedure
  ));
  if position('chunk.generated_items <> 0' in definition) = 0
    or position('slot_start = case when future_count > 0 then future_start' in definition) = 0
    or position('slot_count = case when future_count > 0 then future_count' in definition) = 0 then
    raise exception 'Reparo pode misturar progresso anterior com o novo segmento futuro.';
  end if;
end $$;
select 'ok 7 - segmento futuro reinicia sem dupla contagem';

rollback;

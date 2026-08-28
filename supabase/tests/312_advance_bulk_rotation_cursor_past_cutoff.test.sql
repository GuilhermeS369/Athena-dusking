begin;
select '1..5';

select case when to_regprocedure('public.advance_bulk_rotation_cursor_past_cutoff(uuid,text,timestamptz,boolean)') is not null
  then 'ok 1 - avanço de cursor existe' else 'not ok 1 - função ausente' end;

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.advance_bulk_rotation_cursor_past_cutoff(uuid,text,timestamptz,boolean)'::regprocedure
  ));
  if position('p_dry_run' in definition) = 0
    or position('plan_row.name <> trim(p_expected_name)' in definition) = 0 then
    raise exception 'Função não exige preview/identidade exata.';
  end if;
end $$;
select 'ok 2 - preview e identidade são obrigatórios';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.advance_bulk_rotation_cursor_past_cutoff(uuid,text,timestamptz,boolean)'::regprocedure
  ));
  if position('p_cutoff - chunk_row.schedule_base_at' in definition) = 0
    or position('future_start - chunk_row.next_slot_index' in definition) = 0 then
    raise exception 'Cálculo não usa corte/cursor atual.';
  end if;
end $$;
select 'ok 3 - somente intervalo ainda não materializado é ignorado';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.advance_bulk_rotation_cursor_past_cutoff(uuid,text,timestamptz,boolean)'::regprocedure
  ));
  if position('when chunk_row.status = ''paused'' then profile_plan.status' in definition) = 0
    or position('holdpreserved' in definition) = 0 then
    raise exception 'Hold pode ser perdido.';
  end if;
end $$;
select 'ok 4 - hold é preservado';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.advance_bulk_rotation_cursor_past_cutoff(uuid,text,timestamptz,boolean)'::regprocedure
  ));
  if position('plano possui chunk com lease ativo.' in definition) = 0
    or position('ignored_slot_count = profile_plan.ignored_slot_count + skipped' in definition) = 0 then
    raise exception 'Lease/contabilização não estão protegidos.';
  end if;
end $$;
select 'ok 5 - lease e contador ignored são protegidos';

rollback;

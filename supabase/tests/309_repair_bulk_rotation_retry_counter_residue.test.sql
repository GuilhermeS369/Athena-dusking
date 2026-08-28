begin;
select '1..4';

select case when to_regprocedure('public.repair_bulk_rotation_retry_counter_residue(uuid,text,integer,text)') is not null
  then 'ok 1 - reparo residual existe' else 'not ok 1 - reparo residual ausente' end;

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.repair_bulk_rotation_retry_counter_residue(uuid,text,integer,text)'::regprocedure
  ));
  if position('candidate_count <> p_expected_profiles' in definition) = 0
    or position('plan_row.name <> trim(p_expected_name)' in definition) = 0 then
    raise exception 'Reparo não exige identidade e cardinalidade exatas.';
  end if;
end $$;
select 'ok 2 - identidade e cardinalidade são exatas';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.repair_bulk_rotation_retry_counter_residue(uuid,text,integer,text)'::regprocedure
  ));
  if position('chunk.generated_items = 0' in definition) = 0
    or position('chunk.next_slot_index = chunk.slot_start' in definition) = 0
    or position('chunk.failed_items = chunk.slot_count' in definition) = 0 then
    raise exception 'Reparo pode tocar em chunk com progresso confirmado.';
  end if;
end $$;
select 'ok 3 - somente progresso zero entra';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.repair_bulk_rotation_retry_counter_residue(uuid,text,integer,text)'::regprocedure
  ));
  if position('plan_row.status <> ''paused''' in definition) = 0
    or position('holdpreserved' in definition) = 0 then
    raise exception 'Reparo não preserva o hold operacional.';
  end if;
end $$;
select 'ok 4 - hold permanece ativo';

rollback;

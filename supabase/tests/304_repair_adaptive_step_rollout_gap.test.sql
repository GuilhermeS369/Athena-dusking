begin;
select '1..1';

do $$ begin
  if position(
    'p_step_size not between 1 and 100'
    in pg_get_functiondef('public.process_bulk_rotation_generation_chunk(uuid,text,integer)'::regprocedure)
  ) = 0 then
    raise exception 'Contrato adaptativo de 100 slots não está ativo.';
  end if;
end $$;
select 'ok 1 - contrato que originou a janela reparada permanece limitado a 100';

rollback;

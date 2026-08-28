begin;
select '1..8';

select case when to_regprocedure('public.get_publication_generation_pressure_signal(integer)') is not null
  then 'ok 1 - sinal leve de pressão existe' else 'not ok 1 - sinal leve ausente' end;

select case when to_regclass('public.publication_queue_operational_snapshots') is not null
  then 'ok 2 - snapshot operacional existe' else 'not ok 2 - snapshot ausente' end;

do $$ begin
  if position('priority_band' in pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure)) = 0 then
    raise exception 'Claim não separa faixa crítica e backlog.';
  end if;
end $$;
select 'ok 3 - claim prioriza publicação atual';

do $$ begin
  if position('ceil(p_limit * 0.25)' in pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure)) = 0 then
    raise exception 'Claim não limita recuperação histórica.';
  end if;
end $$;
select 'ok 4 - recuperação histórica usa no máximo 25 por cento do claim';

select case when to_regprocedure('public.refresh_publication_queue_operational_snapshots()') is not null
  then 'ok 5 - recomposição assíncrona existe' else 'not ok 5 - recomposição ausente' end;

select case when to_regprocedure('public.get_publication_queue_operational_snapshot(uuid)') is not null
  then 'ok 6 - leitura constante do snapshot existe' else 'not ok 6 - leitura ausente' end;

do $$ begin
  if position('interval ''48 hours''' in pg_get_functiondef('public.claim_bulk_rotation_generation_chunks(text,integer,integer,integer)'::regprocedure)) = 0 then
    raise exception 'Claim compacto não limita horizonte.';
  end if;
end $$;
select 'ok 7 - claim compacto respeita horizonte de 48 horas';

do $$ begin
  if position('p_step_size integer DEFAULT 50' in pg_get_functiondef('public.process_bulk_rotation_generation_chunk(uuid,text,integer)'::regprocedure)) = 0 then
    raise exception 'Passo SQL default não foi reduzido para 50.';
  end if;
end $$;
select 'ok 8 - processamento compacto usa passo default 50';

rollback;

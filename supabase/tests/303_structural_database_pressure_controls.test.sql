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

-- O teto literal de 25% para backlog histórico deixou de existir na migration
-- 315 (stage_publications_without_internal_discard), que reescreveu o claim para
-- nunca descartar item por atraso interno. O que garante que o backlog não
-- atropela a publicação atual passou a ser a ordenação justa por perfil e por
-- organização, verificada aqui no lugar da string removida.
do $$ begin
  if position('profile_position' in pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure)) = 0
    or position('org_position' in pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure)) = 0 then
    raise exception 'Claim não distribui de forma justa entre perfis e organizações.';
  end if;
end $$;
select 'ok 4 - claim distribui de forma justa entre perfis e organizações';

select case when to_regprocedure('public.refresh_publication_queue_operational_snapshots()') is not null
  then 'ok 5 - recomposição assíncrona existe' else 'not ok 5 - recomposição ausente' end;

select case when to_regprocedure('public.get_publication_queue_operational_snapshot(uuid)') is not null
  then 'ok 6 - leitura constante do snapshot existe' else 'not ok 6 - leitura ausente' end;

-- Invertido pela migration 328: o horizonte móvel de 48h foi REMOVIDO. Um plano
-- de 3 dias precisa gerar 3 dias e o gerador precisa poder ficar ocioso depois,
-- em vez de reabastecer a fila de prioridade para sempre. O contrato agora é a
-- ausência da janela, mais o rodízio entre planos que a 326 introduziu.
do $$ begin
  if position('interval ''48 hours''' in pg_get_functiondef('public.claim_bulk_rotation_generation_chunks(text,integer,integer,integer)'::regprocedure)) > 0 then
    raise exception 'Claim compacto voltou a limitar o horizonte de geração.';
  end if;
  if position('starvation_band' in pg_get_functiondef('public.claim_bulk_rotation_generation_chunks(text,integer,integer,integer)'::regprocedure)) = 0 then
    raise exception 'Claim compacto perdeu o rodízio justo entre planos.';
  end if;
end $$;
select 'ok 7 - claim compacto gera o plano inteiro e faz rodízio entre planos';

do $$ begin
  if position('p_step_size integer DEFAULT 50' in pg_get_functiondef('public.process_bulk_rotation_generation_chunk(uuid,text,integer)'::regprocedure)) = 0 then
    raise exception 'Passo SQL default não foi reduzido para 50.';
  end if;
end $$;
select 'ok 8 - processamento compacto usa passo default 50';

rollback;

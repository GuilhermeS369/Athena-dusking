begin;

select '1..4';

select case when to_regprocedure('public.reset_due_zernio_media_preparation(integer)') is not null
  then 'ok 1 - reset de preparação Zernio continua disponível'
  else 'not ok 1 - reset ausente' end;
select case when to_regprocedure('public.promote_cached_zernio_media_preparation(integer)') is not null
  then 'ok 2 - promoção por cache Zernio continua disponível'
  else 'not ok 2 - promoção ausente' end;

do $$ begin
  if position('effective_limit := least(p_limit, 100)' in
    pg_get_functiondef('public.reset_due_zernio_media_preparation(integer)'::regprocedure)) = 0 then
    raise exception 'Reset Zernio não aplica teto 100.';
  end if;
end $$;
select 'ok 3 - reset limita a transação a 100';

do $$ begin
  if position('effective_limit := least(p_limit, 250)' in
    pg_get_functiondef('public.promote_cached_zernio_media_preparation(integer)'::regprocedure)) = 0 then
    raise exception 'Promoção Zernio não aplica teto 250.';
  end if;
end $$;
select 'ok 4 - promoção limita a transação a 250';

rollback;

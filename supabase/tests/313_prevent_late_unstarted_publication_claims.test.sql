begin;
select '1..5';

select case when to_regprocedure('public.claim_publication_items(text,integer,integer)') is not null
  then 'ok 1 - claim principal existe' else 'not ok 1 - claim principal ausente' end;

do $$ declare definition text; staging_available boolean; begin
  definition := lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure));
  staging_available := to_regprocedure('public.claim_publication_dispatch_staging_items(text,integer,integer,integer)') is not null;
  if not staging_available and position($needle$item.execute_at >= timezone('utc', now()) - interval '60 seconds'$needle$ in definition) = 0 then
    raise exception 'Claim 313 não exclui publicação nunca iniciada após 60 segundos.';
  end if;
  if staging_available and position($needle$interval '60 seconds'$needle$ in definition) > 0 then
    raise exception 'Claim 315 ainda contém o corte que descartava backlog interno.';
  end if;
end $$;
select 'ok 2 - política de atraso corresponde à versão ativa do dispatcher';

do $$ declare definition text; staging_available boolean; begin
  definition := lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure));
  staging_available := to_regprocedure('public.claim_publication_dispatch_staging_items(text,integer,integer,integer)') is not null;
  if position('item.creation_id is not null' in definition) = 0
    or (not staging_available and position($needle$or item.execute_at >= timezone('utc', now()) - interval '60 seconds'$needle$ in definition) = 0) then
    raise exception 'Criação aceita não está explicitamente fora do corte de atraso.';
  end if;
end $$;
select 'ok 3 - criação aceita continua reconciliável';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef('public.claim_publication_items(text,integer,integer)'::regprocedure));
  if position($needle$auth.role() <> 'service_role'$needle$ in definition) = 0
    or position('for update of item skip locked' in definition) = 0 then
    raise exception 'Claim não preserva autorização ou concorrência segura.';
  end if;
end $$;
select 'ok 4 - service role e skip locked preservados';

select case when has_function_privilege(
  'service_role', 'public.claim_publication_items(text,integer,integer)', 'execute'
) then 'ok 5 - service role pode executar' else 'not ok 5 - grant ausente' end;

rollback;

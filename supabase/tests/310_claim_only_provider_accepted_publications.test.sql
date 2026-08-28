begin;
select '1..5';

select case when to_regprocedure('public.claim_provider_accepted_publication_items(text,integer,integer)') is not null
  then 'ok 1 - claim exclusivo existe' else 'not ok 1 - claim exclusivo ausente' end;

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.claim_provider_accepted_publication_items(text,integer,integer)'::regprocedure
  ));
  if position('item.creation_id is not null' in definition) = 0 then
    raise exception 'Claim pode incluir publicação ainda não criada.';
  end if;
end $$;
select 'ok 2 - criação aceita é obrigatória';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.claim_provider_accepted_publication_items(text,integer,integer)'::regprocedure
  ));
  if position('for update of item skip locked' in definition) = 0
    or position('p_limit not between 1 and 20' in definition) = 0 then
    raise exception 'Claim não tem concorrência/limite conservador.';
  end if;
end $$;
select 'ok 3 - claim é concorrente e limitado';

do $$ declare definition text; begin
  definition := lower(pg_get_functiondef(
    'public.claim_provider_accepted_publication_items(text,integer,integer)'::regprocedure
  ));
  if position('partition by item.organization_id' in definition) = 0
    or position('partition by item.profile_id' in definition) = 0 then
    raise exception 'Claim não preserva justiça por organização/perfil.';
  end if;
end $$;
select 'ok 4 - justiça é preservada';

select case when has_function_privilege(
  'service_role',
  'public.claim_provider_accepted_publication_items(text,integer,integer)',
  'execute'
) then 'ok 5 - service role pode executar' else 'not ok 5 - grant ausente' end;

rollback;

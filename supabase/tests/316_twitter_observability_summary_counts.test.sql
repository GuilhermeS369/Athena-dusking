begin;

select '1..6';

-- 1. Contrato: função existe com a assinatura que a rota chama.
select case when to_regprocedure('public.twitter_observability_summary_counts(uuid,timestamptz)') is not null
  then 'ok 1 - função de resumo X disponível'
  else 'not ok 1 - função de resumo X ausente' end;

-- 2. Somente leitura: precisa ser stable, nunca volatile, para não entrar em
--    nenhum caminho de escrita nem invalidar plano a cada chamada.
do $$ declare volatility "char"; begin
  select provolatile into volatility
  from pg_proc where oid = 'public.twitter_observability_summary_counts(uuid,timestamptz)'::regprocedure;
  if volatility <> 's' then
    raise exception 'A função de resumo precisa ser stable; encontrado provolatile=%.', volatility;
  end if;
end $$;
select 'ok 2 - resumo é stable e somente leitura';

-- 3. Privilégio: exposta apenas ao service_role.
do $$ begin
  if has_function_privilege('anon', 'public.twitter_observability_summary_counts(uuid,timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.twitter_observability_summary_counts(uuid,timestamptz)', 'execute') then
    raise exception 'Resumo X não pode ser executável por anon/authenticated.';
  end if;
  if not has_function_privilege('service_role', 'public.twitter_observability_summary_counts(uuid,timestamptz)', 'execute') then
    raise exception 'service_role precisa executar o resumo X.';
  end if;
end $$;
select 'ok 3 - execução restrita ao service_role';

-- 4. Uma única varredura sobre incidents: a regressão que esta migration corrige
--    era a repetição de count(exact) por status/severity/domain.
do $$ declare definition text; begin
  definition := pg_get_functiondef('public.twitter_observability_summary_counts(uuid,timestamptz)'::regprocedure);
  if (length(definition) - length(replace(definition, 'from public.twitter_observability_incidents', '')))
     / length('from public.twitter_observability_incidents') <> 1 then
    raise exception 'O resumo deve varrer twitter_observability_incidents exatamente uma vez.';
  end if;
  if position('count(*) filter' in definition) = 0 then
    raise exception 'Os contadores devem usar agregados FILTER numa passagem só.';
  end if;
end $$;
select 'ok 4 - incidents é varrida uma única vez, com agregados FILTER';

-- 5 e 6. Comportamento com dados reais, dentro da transação revertida.
do $$
declare
  org uuid;
  since timestamptz := timezone('utc', now()) - interval '24 hours';
  result jsonb;
begin
  select id into org from public.organizations where deleted_at is null order by created_at limit 1;
  if org is null then
    raise notice 'Sem organização disponível: asserções comportamentais ignoradas.';
    return;
  end if;

  insert into public.twitter_observability_incidents
    (organization_id, fingerprint, domain, stage, stable_code, severity, status, title, first_seen_at, last_seen_at)
  values
    (org, md5('t316-a') || md5('t316-a'), 'publication', 'dispatch', 'c1', 'critical', 'open',          't1', since, since),
    (org, md5('t316-b') || md5('t316-b'), 'worker',      'dispatch', 'c2', 'error',    'investigating', 't2', since, since),
    -- Resolvido: não pode entrar em nenhum contador por domínio nem em críticos.
    (org, md5('t316-c') || md5('t316-c'), 'publication', 'dispatch', 'c3', 'critical', 'resolved',      't3', since, since);

  select public.twitter_observability_summary_counts(org, since) into result;

  if (result->>'open')::int <> 1 or (result->>'investigating')::int <> 1 then
    raise exception 'Contagem por status incorreta: %', result;
  end if;
  -- O crítico resolvido precisa ficar de fora.
  if (result->>'critical')::int <> 1 then
    raise exception 'Crítico resolvido não pode ser contado: %', result;
  end if;
  if (result->>'publication')::int <> 1 or (result->>'worker')::int <> 1 then
    raise exception 'Contagem por domínio incorreta: %', result;
  end if;
  if (result->>'account')::int <> 0 then
    raise exception 'Domínio sem incidente deve retornar zero: %', result;
  end if;
  if result->>'events24h' is null then
    raise exception 'events24h precisa vir no mesmo retorno: %', result;
  end if;
end $$;
select 'ok 5 - status, severidade e domínio contados numa passagem';
select 'ok 6 - incidente resolvido fica fora dos contadores não resolvidos';

rollback;

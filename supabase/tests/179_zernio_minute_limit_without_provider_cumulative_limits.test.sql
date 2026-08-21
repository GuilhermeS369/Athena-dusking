begin;

do $$
declare
  function_definition text;
  zernio_limit integer;
begin
  select max_provider_publications_per_minute into zernio_limit
  from public.publication_rate_limit_settings
  where organization_id is null
    and provider = 'zernio'
    and enabled = true;

  if zernio_limit is distinct from 200 then
    raise exception 'O limite global da Zernio deve ser 200/minuto; encontrado %.', zernio_limit;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'publication_rate_limit_settings'
      and column_name in ('max_provider_publications_per_hour', 'max_provider_publications_per_day')
  ) then
    raise exception 'Os limites acumulados por hora e dia do provedor devem ter sido removidos.';
  end if;

  select pg_get_functiondef(procedure.oid) into function_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'reserve_publication_dispatch_capacity'
  limit 1;

  if function_definition is null
    or function_definition not ilike '%provider_minute_limit%'
    or function_definition not ilike '%profile_24h_limit%'
    or function_definition not ilike '%profile_min_interval%' then
    raise exception 'A reserva deve manter os guardrails por minuto e por perfil.';
  end if;

  if function_definition ilike '%provider_hour_limit%'
    or function_definition ilike '%provider_24h_limit%'
    or function_definition ilike '%max_provider_publications_per_hour%'
    or function_definition ilike '%max_provider_publications_per_day%' then
    raise exception 'A reserva não pode manter limites acumulados por organização/provedor.';
  end if;
end;
$$;

rollback;

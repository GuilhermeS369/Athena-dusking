begin;

do $$
declare
  claim_definition text;
  recovery_definition text;
  zernio_recovery_definition text;
  coordinated_recovery_definition text;
begin
  select pg_get_functiondef(procedure.oid) into claim_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'claim_publication_items'
    and pg_get_function_identity_arguments(procedure.oid) = 'p_worker_id text, p_limit integer, p_lease_seconds integer';

  if claim_definition is null then
    raise exception 'claim_publication_items não encontrado.';
  end if;
  if claim_definition not ilike '%next_attempt_at is not null%'
    or claim_definition not ilike '%attempt_count < 5%'
  then
    raise exception 'Falha terminal sem retry agendado ainda pode voltar ao claim.';
  end if;
  if claim_definition not ilike '%creation_id is null%'
    or claim_definition not ilike '%zernio_recovery_count%'
  then
    raise exception 'Claim não contém a barreira para segunda criação Zernio.';
  end if;

  select pg_get_functiondef(procedure.oid) into recovery_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'recover_missed_publication_slots'
    and pg_get_function_identity_arguments(procedure.oid) = 'p_max_items integer, p_grace_seconds integer, p_worker_id text, p_cycle_correlation_id uuid';

  if recovery_definition is null then
    raise exception 'recover_missed_publication_slots não encontrado.';
  end if;
  if recovery_definition not ilike '%missed_bulk_slot_expired%'
    or recovery_definition not ilike '%pipeline_version = 1%'
    or recovery_definition not ilike '%creation_id is null%'
  then
    raise exception 'Expiração bulk não preserva o corte temporal e a criação externa.';
  end if;
  if recovery_definition ilike '%outcome := ''bulk_slot_at_risk''%'
    or recovery_definition ilike '%outcome := ''awaiting_safe_recovery''%'
  then
    raise exception 'Slot vencido ainda está sendo encaminhado para recuperação tardia.';
  end if;

  select pg_get_functiondef(procedure.oid) into zernio_recovery_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'schedule_zernio_media_download_recovery'
  limit 1;

  if zernio_recovery_definition is null
    or zernio_recovery_definition not ilike '%automatic_recreation_disabled%'
  then
    raise exception 'Segunda criação automática Zernio não foi desabilitada.';
  end if;
  if zernio_recovery_definition ilike '%update public.publication_items%'
    or zernio_recovery_definition ilike '%creation_id = null%'
  then
    raise exception 'RPC de compatibilidade ainda altera o item ou limpa creation_id.';
  end if;

  select pg_get_functiondef(procedure.oid) into coordinated_recovery_definition
  from pg_proc procedure
  join pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'claim_publication_slot_recovery_items'
  limit 1;

  if coordinated_recovery_definition is null
    or coordinated_recovery_definition ilike '%from public.publication_items%'
    or coordinated_recovery_definition ilike '%update public.publication_items%'
  then
    raise exception 'Claim coordenado ainda pode entregar slot vencido para publicação.';
  end if;

  if exists (
    select 1
    from public.claim_publication_slot_recovery_items('test:safe-empty-recovery', 1, 30)
  ) then
    raise exception 'Claim coordenado deveria retornar conjunto vazio.';
  end if;
end;
$$;

rollback;

-- Prova, com dados reais e o caminho real da função (não só pg_get_functiondef),
-- que get_publication_generation_pressure_signal deixou de contar como
-- "atraso crítico" um item que só está lento pelo relógio (execute_at vencido)
-- mas segue um ciclo normal de retry/poll (next_attempt_at ou lease_until no
-- futuro) — o falso positivo investigado em 2026-08-29 que travava o
-- publication-generation-worker mesmo sem nada realmente parado.
-- Executar em PostgreSQL 17 descartável com schema até a migration 321.

begin;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'sub', nullif(current_setting('request.jwt.claim.sub', true), ''),
    'role', nullif(current_setting('request.jwt.claim.role', true), ''),
    'email', nullif(current_setting('request.jwt.claim.email', true), '')
  )
$$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values (
  '18000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'pressure-signal@example.com', '', timezone('utc', now()),
  timezone('utc', now()), timezone('utc', now())
);

insert into public.organizations (id, name, slug, created_by) values
  ('28000000-0000-0000-0000-000000000001', 'Organização sinal de pressão', 'pressure-signal-org', '18000000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by) values
  ('28000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000001', 'admin', '18000000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (
  id, organization_id, provider, instagram_user_id, username, encrypted_access_token, status, created_by
) values (
  '38000000-0000-0000-0000-000000000001', '28000000-0000-0000-0000-000000000001', 'meta_official',
  'pressure-signal-profile', 'pressure_signal_profile', 'token', 'online', '18000000-0000-0000-0000-000000000001'
);

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at) values
  ('58000000-0000-0000-0000-000000000001', '28000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000001', 'Lote de teste do sinal de pressão', 'processing', timezone('utc', now()));

set local role service_role;
set local request.jwt.claim.role = 'service_role';

do $$
declare
  signal jsonb;
begin
  -----------------------------------------------------------------------
  -- Cenário 1: item "aceito" (creation_id definido) com execute_at vencido
  -- há mais de 60s, mas com next_attempt_at no futuro próximo — exatamente
  -- o Reel em ciclo normal de poll de container que causou o falso positivo.
  -- Não deve contar como atraso crítico.
  -----------------------------------------------------------------------
  insert into public.publication_items (
    id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key,
    pipeline_version, preparation_status, creation_id, next_attempt_at, lease_until, attempt_count
  ) values (
    '68000000-0000-0000-0000-000000000001', '28000000-0000-0000-0000-000000000001',
    '58000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001',
    'reel', 'waiting', timezone('utc', now()) - interval '5 minutes', 'pressure-signal-item-0001',
    2, 'ready', 'provider-container-0001', timezone('utc', now()) + interval '2 minutes', null, 1
  );

  signal := public.get_publication_generation_pressure_signal(60);
  if (signal ->> 'criticalDelay')::boolean is not false then
    raise exception 'item em ciclo normal de retry (next_attempt_at futuro) não deveria disparar criticalDelay (%).', signal;
  end if;

  -----------------------------------------------------------------------
  -- Cenário 2: mesma ideia, mas o item está com lease ativa agora (um
  -- worker está processando-o neste instante) em vez de next_attempt_at.
  -- Também não deve contar como atraso crítico.
  -----------------------------------------------------------------------
  update public.publication_items
  set next_attempt_at = null, lease_until = timezone('utc', now()) + interval '2 minutes', claimed_by = 'worker-pressure-test'
  where id = '68000000-0000-0000-0000-000000000001';

  signal := public.get_publication_generation_pressure_signal(60);
  if (signal ->> 'criticalDelay')::boolean is not false then
    raise exception 'item com lease ativa (em processamento agora) não deveria disparar criticalDelay (%).', signal;
  end if;

  -----------------------------------------------------------------------
  -- Cenário 3: o mesmo item, agora genuinamente parado — sem próximo
  -- retry agendado e sem lease ativa. Deve disparar criticalDelay com
  -- overdueAccepted=true (creation_id definido) e overdueUnstarted=false.
  -----------------------------------------------------------------------
  update public.publication_items
  set lease_until = null, claimed_by = null
  where id = '68000000-0000-0000-0000-000000000001';

  signal := public.get_publication_generation_pressure_signal(60);
  if (signal ->> 'criticalDelay')::boolean is not true then
    raise exception 'item aceito genuinamente parado deveria disparar criticalDelay (%).', signal;
  end if;
  if (signal ->> 'overdueAccepted')::boolean is not true or (signal ->> 'overdueUnstarted')::boolean is not false then
    raise exception 'item aceito parado deveria marcar overdueAccepted=true e overdueUnstarted=false (%).', signal;
  end if;

  -----------------------------------------------------------------------
  -- Cenário 4: item nunca iniciado (creation_id nulo) também genuinamente
  -- parado. Deve disparar criticalDelay com overdueUnstarted=true.
  -----------------------------------------------------------------------
  update public.publication_items
  set status = 'cancelled', cancelled_at = timezone('utc', now())
  where id = '68000000-0000-0000-0000-000000000001';

  insert into public.publication_items (
    id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key,
    pipeline_version, preparation_status, creation_id, next_attempt_at, lease_until, attempt_count
  ) values (
    '68000000-0000-0000-0000-000000000002', '28000000-0000-0000-0000-000000000001',
    '58000000-0000-0000-0000-000000000001', '38000000-0000-0000-0000-000000000001',
    'reel', 'waiting', timezone('utc', now()) - interval '5 minutes', 'pressure-signal-item-0002',
    2, 'ready', null, null, null, 0
  );

  signal := public.get_publication_generation_pressure_signal(60);
  if (signal ->> 'criticalDelay')::boolean is not true then
    raise exception 'item nunca iniciado e parado deveria disparar criticalDelay (%).', signal;
  end if;
  if (signal ->> 'overdueUnstarted')::boolean is not true or (signal ->> 'overdueAccepted')::boolean is not false then
    raise exception 'item nunca iniciado parado deveria marcar overdueUnstarted=true e overdueAccepted=false (%).', signal;
  end if;
end;
$$;

reset role;
rollback;

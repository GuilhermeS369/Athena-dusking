-- Teste transacional da reserva concorrente e liberação por soft-delete.
begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values (
  '19000000-0000-0000-0000-000000000159',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'zernio-key-guard@example.com', '',
  timezone('utc', now()), timezone('utc', now()), timezone('utc', now())
);

insert into public.organizations (id, name, slug, created_by)
values (
  '29000000-0000-0000-0000-000000000159',
  'Teste guarda Zernio',
  'teste-guarda-zernio-159',
  '19000000-0000-0000-0000-000000000159'
);

set local role service_role;

do $$
declare
  fingerprint text := repeat('a', 64);
  first_owner uuid := '39000000-0000-0000-0000-000000000159';
  second_owner uuid := '49000000-0000-0000-0000-000000000159';
  connection_id uuid := '59000000-0000-0000-0000-000000000159';
  result jsonb;
begin
  result := public.claim_zernio_api_key(
    '29000000-0000-0000-0000-000000000159', fingerprint,
    'Conta original', first_owner, null, 3600
  );
  if (result ->> 'claimed')::boolean is not true then
    raise exception 'primeira reserva deveria ter sido aceita';
  end if;

  result := public.claim_zernio_api_key(
    '29000000-0000-0000-0000-000000000159', fingerprint,
    'Conta repetida', second_owner, null, 3600
  );
  if (result ->> 'claimed')::boolean is not false
     or result ->> 'existingLabel' <> 'Conta original' then
    raise exception 'segunda reserva deveria ter sido recusada com o nome existente';
  end if;

  insert into public.zernio_connections (
    id, organization_id, label, encrypted_api_key, api_key_fingerprint,
    status, created_by
  ) values (
    connection_id,
    '29000000-0000-0000-0000-000000000159',
    'Conta original',
    'encrypted-test-api-key-value',
    fingerprint,
    'online',
    '19000000-0000-0000-0000-000000000159'
  );

  if not public.finalize_zernio_api_key_claim(fingerprint, first_owner, connection_id) then
    raise exception 'reserva deveria ter sido finalizada';
  end if;

  update public.zernio_connections
  set deleted_at = timezone('utc', now())
  where id = connection_id;

  if exists (select 1 from public.zernio_api_key_claims where api_key_fingerprint = fingerprint) then
    raise exception 'soft-delete deveria liberar a credencial';
  end if;

  result := public.claim_zernio_api_key(
    '29000000-0000-0000-0000-000000000159', fingerprint,
    'Conta reutilizada', second_owner, null, 3600
  );
  if (result ->> 'claimed')::boolean is not true then
    raise exception 'credencial apagada deveria poder ser reutilizada';
  end if;
end;
$$;

reset role;
rollback;

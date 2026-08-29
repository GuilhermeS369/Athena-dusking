-- Fase 7 do plano de despacho Instagram (1000 perfis): prova, pelo caminho real
-- de staging/ativação da migration 315, que (a) um perfil que cai entre o staging
-- e o execute_at é suspenso sem consumir tentativa, e (b) uma queda terminal Zernio
-- pós-claim contém só o perfil afetado, sem travar outros perfis/organizações.
-- Executar em PostgreSQL 17 descartável com schema até a migration 319.

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
  '17000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'staging-drop@example.com', '', timezone('utc', now()),
  timezone('utc', now()), timezone('utc', now())
);

insert into public.organizations (id, name, slug, created_by) values
  ('27000000-0000-0000-0000-000000000001', 'Organização staging drop', 'staging-drop-org-1', '17000000-0000-0000-0000-000000000001'),
  ('27000000-0000-0000-0000-000000000002', 'Organização staging drop isolada', 'staging-drop-org-2', '17000000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by) values
  ('27000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001', 'admin', '17000000-0000-0000-0000-000000000001'),
  ('27000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000001', 'admin', '17000000-0000-0000-0000-000000000001');

-- Perfil A: cairá entre o staging e o execute_at (cenário 1).
-- Perfil B: mesma organização, permanece online (controle de isolamento).
-- Perfil C: sofrerá queda terminal Zernio pós-claim (cenário 2) — precisa ser zernio de
--   verdade, com conexão e inventário remoto canônico (migrations 151/161/318).
-- Perfil D: mesma organização de C, permanece online (controle de isolamento).
-- Perfil E: organização diferente, permanece online (controle de isolamento entre orgs).
-- A, B, D e E são meta_official: a barreira de perfil online e o isolamento entre
-- perfis/organizações não dependem do provider, e isso evita a guarda de identidade
-- Zernio (irrelevante para o que esses perfis testam).
insert into public.zernio_connections (
  id, organization_id, label, encrypted_api_key, zernio_profile_id, created_by
) values (
  '77000000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000001',
  'Conexão staging drop C', 'fake-api-key-not-a-real-secret-0001', 'zprofile-staging-drop-c',
  '17000000-0000-0000-0000-000000000001'
);
insert into public.zernio_connection_remote_profiles (
  organization_id, zernio_connection_id, zernio_profile_id, kind, status
) values (
  '27000000-0000-0000-0000-000000000001', '77000000-0000-0000-0000-000000000001',
  'zprofile-staging-drop-c', 'canonical', 'connected'
);

insert into public.instagram_profiles (
  id, organization_id, provider, zernio_connection_id, zernio_profile_id, zernio_account_id,
  instagram_user_id, username, encrypted_access_token, status, created_by
) values
  ('37000000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000001', 'meta_official', null, null, null, 'staging-drop-a', 'staging_drop_a', 'token', 'online', '17000000-0000-0000-0000-000000000001'),
  ('37000000-0000-0000-0000-000000000002', '27000000-0000-0000-0000-000000000001', 'meta_official', null, null, null, 'staging-drop-b', 'staging_drop_b', 'token', 'online', '17000000-0000-0000-0000-000000000001'),
  ('37000000-0000-0000-0000-000000000003', '27000000-0000-0000-0000-000000000001', 'zernio', '77000000-0000-0000-0000-000000000001', 'zprofile-staging-drop-c', 'zernio-acct-c', 'staging-drop-c', 'staging_drop_c', 'token', 'online', '17000000-0000-0000-0000-000000000001'),
  ('37000000-0000-0000-0000-000000000004', '27000000-0000-0000-0000-000000000001', 'meta_official', null, null, null, 'staging-drop-d', 'staging_drop_d', 'token', 'online', '17000000-0000-0000-0000-000000000001'),
  ('37000000-0000-0000-0000-000000000005', '27000000-0000-0000-0000-000000000002', 'meta_official', null, null, null, 'staging-drop-e', 'staging_drop_e', 'token', 'online', '17000000-0000-0000-0000-000000000001');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at) values
  ('57000000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001', 'Cenário 1 - queda entre staging e execute_at', 'queued', timezone('utc', now())),
  ('57000000-0000-0000-0000-000000000002', '27000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000001', 'Cenário 2 - queda terminal Zernio', 'queued', timezone('utc', now())),
  ('57000000-0000-0000-0000-000000000003', '27000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000001', 'Cenário 2 - isolamento entre organizações', 'queued', timezone('utc', now()));

-- preparation_status='ready' simula um item pipeline v2 (padrão desde a migration 264) que já
-- passou pela preparação — a Fase 7 testa staging/ativação/suspensão, não a preparação em si,
-- e a RPC de staging só aceita pipeline_version=1 ou preparation_status='ready'.
insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, preparation_status
) values
  ('67000000-0000-0000-0000-000000000001', '27000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-000000000001', 'image', 'waiting', timezone('utc', now()) + interval '5 minutes', 'staging-drop-item-a-0001', 'ready'),
  ('67000000-0000-0000-0000-000000000002', '27000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-000000000001', '37000000-0000-0000-0000-000000000002', 'image', 'waiting', timezone('utc', now()) + interval '5 minutes', 'staging-drop-item-b-0001', 'ready'),
  ('67000000-0000-0000-0000-000000000003', '27000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-000000000002', '37000000-0000-0000-0000-000000000003', 'image', 'waiting', timezone('utc', now()) + interval '5 minutes', 'staging-drop-item-c-0001', 'ready'),
  ('67000000-0000-0000-0000-000000000004', '27000000-0000-0000-0000-000000000001', '57000000-0000-0000-0000-000000000002', '37000000-0000-0000-0000-000000000004', 'image', 'waiting', timezone('utc', now()) + interval '5 minutes', 'staging-drop-item-d-0001', 'ready'),
  ('67000000-0000-0000-0000-000000000005', '27000000-0000-0000-0000-000000000002', '57000000-0000-0000-0000-000000000003', '37000000-0000-0000-0000-000000000005', 'image', 'waiting', timezone('utc', now()) + interval '5 minutes', 'staging-drop-item-e-0001', 'ready');

set local role service_role;
set local request.jwt.claim.role = 'service_role';

do $$
declare
  staged_count integer;
  activated_count integer;
  online_before boolean;
  online_after boolean;
  item_a public.publication_items%rowtype;
  item_b public.publication_items%rowtype;
  item_c public.publication_items%rowtype;
  item_d public.publication_items%rowtype;
  item_e public.publication_items%rowtype;
  disconnection jsonb;
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  recycling_row public.zernio_profile_recycling_jobs%rowtype;
begin
  -----------------------------------------------------------------------
  -- Cenário 1: perfil cai entre o staging e o execute_at, pelo caminho
  -- real da migration 315 (claim de staging -> ativação -> barreira).
  -----------------------------------------------------------------------

  select count(*) into staged_count
  from public.claim_publication_dispatch_staging_items('worker-drop', 10, 1200, 600)
  where id in ('67000000-0000-0000-0000-000000000001', '67000000-0000-0000-0000-000000000002');
  if staged_count <> 2 then
    raise exception 'itens A e B deveriam ser reivindicados para staging (obtidos: %)', staged_count;
  end if;

  -- Simula o tempo passando até o horário de execução.
  update public.publication_items
  set execute_at = timezone('utc', now()) - interval '30 seconds'
  where id in ('67000000-0000-0000-0000-000000000001', '67000000-0000-0000-0000-000000000002');

  select count(*) into activated_count
  from public.activate_staged_publication_items(
    'worker-drop',
    array['67000000-0000-0000-0000-000000000001'::uuid, '67000000-0000-0000-0000-000000000002'::uuid],
    300
  );
  if activated_count <> 2 then
    raise exception 'itens A e B deveriam ser ativados a partir do spool (obtidos: %)', activated_count;
  end if;

  select * into item_a from public.publication_items where id = '67000000-0000-0000-0000-000000000001';
  if item_a.status <> 'preparing' or item_a.claimed_by <> 'worker-drop' or item_a.dispatch_staged_by is not null then
    raise exception 'ativação não deixou o item A pronto para o dispatcher (status=%, claimed_by=%, staged_by=%)',
      item_a.status, item_a.claimed_by, item_a.dispatch_staged_by;
  end if;

  -- Perfil ainda online: a barreira usada imediatamente antes do provedor libera o item.
  online_before := public.assert_claimed_publication_profile_online(item_a.id, 'worker-drop');
  if not online_before then
    raise exception 'barreira rejeitou item A com perfil ainda online';
  end if;

  -- Perfil cai agora (mesma transição que aconteceria de verdade via sincronia/observabilidade).
  update public.instagram_profiles set status = 'offline', last_error_message = 'Perfil caiu no teste de staging.'
  where id = '37000000-0000-0000-0000-000000000001';

  -- O trigger de suspensão (migration 088) já deve ter suspendido o item, sem esperar
  -- pela próxima chamada do worker; a barreira confirma isso de forma idempotente.
  select * into item_a from public.publication_items where id = '67000000-0000-0000-0000-000000000001';
  if item_a.status <> 'suspended' then
    raise exception 'perfil offline não suspendeu automaticamente o item A ativado via staging (status=%)', item_a.status;
  end if;
  if item_a.claimed_by is not null or item_a.lease_until is not null then
    raise exception 'suspensão automática não liberou claim/lease do item A';
  end if;
  if item_a.attempt_count <> 0 then
    raise exception 'suspensão automática deveria devolver a tentativa consumida na ativação (attempt_count=%)', item_a.attempt_count;
  end if;

  online_after := public.assert_claimed_publication_profile_online(item_a.id, 'worker-drop');
  if online_after then
    raise exception 'barreira aceitou item A depois do perfil cair';
  end if;

  -- O worker chamaria suspend_claimed_publication_item mesmo já suspenso pelo trigger;
  -- precisa continuar idempotente, sem erro, sem duplicar suspensão.
  if (public.suspend_claimed_publication_item(item_a.id, 'worker-drop', 'teste: perfil caiu') ->> 'idempotent')::boolean is not true then
    raise exception 'suspend_claimed_publication_item não tratou o item A já suspenso como idempotente';
  end if;

  -- Isolamento: item B (mesmo lote/organização, outro perfil, ainda online) segue ativo.
  select * into item_b from public.publication_items where id = '67000000-0000-0000-0000-000000000002';
  if item_b.status <> 'preparing' or item_b.claimed_by <> 'worker-drop' then
    raise exception 'item B foi afetado pela queda do perfil A (status=%, claimed_by=%)', item_b.status, item_b.claimed_by;
  end if;
  if not public.assert_claimed_publication_profile_online(item_b.id, 'worker-drop') then
    raise exception 'barreira rejeitou item B, cujo perfil nunca caiu';
  end if;

  -----------------------------------------------------------------------
  -- Cenário 2: queda terminal Zernio devolvida depois do claim, pelo
  -- mesmo caminho real de staging/ativação.
  -----------------------------------------------------------------------

  perform public.claim_publication_dispatch_staging_items('worker-drop', 10, 1200, 600);
  update public.publication_items
  set execute_at = timezone('utc', now()) - interval '30 seconds'
  where id in ('67000000-0000-0000-0000-000000000003', '67000000-0000-0000-0000-000000000004', '67000000-0000-0000-0000-000000000005');
  perform public.activate_staged_publication_items(
    'worker-drop',
    array[
      '67000000-0000-0000-0000-000000000003'::uuid,
      '67000000-0000-0000-0000-000000000004'::uuid,
      '67000000-0000-0000-0000-000000000005'::uuid
    ],
    300
  );

  select * into item_c from public.publication_items where id = '67000000-0000-0000-0000-000000000003';
  if item_c.status <> 'preparing' or item_c.claimed_by <> 'worker-drop' then
    raise exception 'item C não chegou ativado ao dispatcher (status=%, claimed_by=%)', item_c.status, item_c.claimed_by;
  end if;

  -- Simula exatamente o que processClaimedItem faz ao receber uma queda terminal da Zernio.
  disconnection := public.schedule_zernio_profile_disconnection(
    item_c.id, 'worker-drop', 'account_disconnected', 'zernio_account_disconnected',
    'A Zernio informou que a conta foi desconectada.', false
  );
  if (disconnection ->> 'scheduled')::boolean is not true then
    raise exception 'queda terminal não foi agendada (%).', disconnection;
  end if;

  if (select status from public.instagram_profiles where id = '37000000-0000-0000-0000-000000000003') <> 'offline' then
    raise exception 'perfil C não foi marcado offline pela contenção da queda terminal';
  end if;
  select * into item_c from public.publication_items where id = '67000000-0000-0000-0000-000000000003';
  if item_c.status <> 'ignored' or item_c.attempt_count <> 0 then
    raise exception 'item C não foi contido corretamente após a queda terminal (status=%, attempt_count=%)', item_c.status, item_c.attempt_count;
  end if;

  select * into incident_row from public.zernio_profile_disconnection_incidents
  where profile_id = '37000000-0000-0000-0000-000000000003';
  if incident_row.id is null or incident_row.state <> 'remote_removal_pending' or incident_row.source <> 'publication_worker' then
    raise exception 'incidente de desconexão não foi criado/atualizado corretamente (%).', row_to_json(incident_row);
  end if;
  select * into recycling_row from public.zernio_profile_recycling_jobs
  where incident_id = incident_row.id;
  if recycling_row.id is null or recycling_row.status <> 'pending' then
    raise exception 'job de reciclagem remota não foi criado a partir do claim (%).', row_to_json(recycling_row);
  end if;

  -- Isolamento: perfil D (mesma organização) e perfil E (organização diferente)
  -- continuam intocados, seus itens seguem ativos sob claim do worker.
  select * into item_d from public.publication_items where id = '67000000-0000-0000-0000-000000000004';
  if item_d.status <> 'preparing' or item_d.claimed_by <> 'worker-drop' then
    raise exception 'item D (mesma organização, outro perfil) foi afetado pela queda de C (status=%, claimed_by=%)', item_d.status, item_d.claimed_by;
  end if;
  if (select status from public.instagram_profiles where id = '37000000-0000-0000-0000-000000000004') <> 'online' then
    raise exception 'perfil D foi indevidamente marcado offline';
  end if;

  select * into item_e from public.publication_items where id = '67000000-0000-0000-0000-000000000005';
  if item_e.status <> 'preparing' or item_e.claimed_by <> 'worker-drop' then
    raise exception 'item E (organização diferente) foi afetado pela queda do perfil C (status=%, claimed_by=%)', item_e.status, item_e.claimed_by;
  end if;
  if (select status from public.instagram_profiles where id = '37000000-0000-0000-0000-000000000005') <> 'online' then
    raise exception 'perfil E (organização diferente) foi indevidamente marcado offline';
  end if;

  -- Reciclagem remota (chamada HTTP real à Zernio) fica fora deste teste transacional:
  -- claim_zernio_profile_recycling_jobs/complete_zernio_profile_recycling são exercitadas
  -- separadamente pelo worker de sincronia; aqui confirmamos só que o job ficou pronto
  -- para ser reivindicado.
  if not exists (
    select 1 from public.zernio_profile_recycling_jobs
    where incident_id = incident_row.id and claimed_by is null and status = 'pending'
  ) then
    raise exception 'job de reciclagem não ficou disponível para claim (skip locked) do worker de sincronia';
  end if;
end;
$$;

reset role;
rollback;

-- Teste transacional da suspensão global de perfis offline. Executar em banco
-- descartável com schema até as migrations 087 e 088.

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values (
  '12000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'suspension@example.com', '', timezone('utc', now()),
  timezone('utc', now()), timezone('utc', now())
);
insert into public.organizations (id, name, slug, created_by)
values ('22000000-0000-0000-0000-000000000001', 'Organização suspensão', 'organizacao-suspensao', '12000000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('22000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-000000000001', 'admin', '12000000-0000-0000-0000-000000000001');
insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
) values
  ('32000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', 'suspension-1', 'suspension_1', 'token', 'online', '12000000-0000-0000-0000-000000000001'),
  ('32000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000001', 'suspension-2', 'suspension_2', 'token', 'online', '12000000-0000-0000-0000-000000000001');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('52000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001',
  '12000000-0000-0000-0000-000000000001', 'Suspensão tradicional', 'queued', timezone('utc', now()));
insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key
) values
  ('62000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001', '32000000-0000-0000-0000-000000000001', 'image', 'waiting', timezone('utc', now()) - interval '30 seconds', 'suspension-traditional-item-0001'),
  ('62000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001', '32000000-0000-0000-0000-000000000002', 'image', 'waiting', timezone('utc', now()) - interval '30 seconds', 'suspension-online-item-0000001');

set local role service_role;
set local request.jwt.claim.role = 'service_role';

do $$
declare
  claimed record;
  attempt_after_claim integer;
  suspended_event_count bigint;
  summary record;
  suspension_result jsonb;
begin
  select * into claimed from public.claim_publication_items('worker-suspension', 1, 120);
  if claimed.id is distinct from '62000000-0000-0000-0000-000000000001'::uuid then
    raise exception 'claim deveria selecionar o primeiro item online';
  end if;
  select attempt_count into attempt_after_claim from public.publication_items where id = claimed.id;
  if attempt_after_claim <> 1 then raise exception 'primeiro claim deveria consumir uma tentativa'; end if;

  update public.instagram_profiles
  set status = 'offline', last_error_message = 'Conta offline no teste.'
  where id = '32000000-0000-0000-0000-000000000001';

  if (select status from public.publication_items where id = claimed.id) <> 'suspended' then
    raise exception 'trigger não suspendeu item em voo';
  end if;
  if (select attempt_count from public.publication_items where id = claimed.id) <> 0 then
    raise exception 'suspensão em voo consumiu tentativa';
  end if;
  if (select claimed_by is not null or lease_until is not null or next_attempt_at is not null
      from public.publication_items where id = claimed.id) then
    raise exception 'suspensão não liberou claim, lease ou retry';
  end if;
  select count(*) into suspended_event_count
  from public.publication_item_events
  where publication_item_id = claimed.id and event_type = 'suspended';
  if suspended_event_count <> 1 then
    raise exception 'evento de suspensão não foi registrado exatamente uma vez; observado=%',
      suspended_event_count;
  end if;

  update public.instagram_profiles set status = 'online'
  where id = '32000000-0000-0000-0000-000000000001';
  if exists (select 1 from public.claim_publication_items('worker-no-auto-resume', 10, 120) where id = claimed.id) then
    raise exception 'perfil online não deveria retomar item automaticamente';
  end if;

  if exists (select 1 from public.recover_missed_publication_slots(100, 120) where id = claimed.id) then
    raise exception 'suspenso não pode entrar em recuperação de horário';
  end if;

  select * into summary from public.get_publication_queue_operational_summary('22000000-0000-0000-0000-000000000001')
  where status = 'suspended';
  if summary.total <> 1 or summary.overdue <> 0 or summary.due_retries <> 0
    or summary.expired_leases <> 0 or summary.max_lag_seconds <> 0 then
    raise exception 'resumo operacional contou suspenso como atraso/retry/lease';
  end if;

  suspension_result := public.suspend_claimed_publication_item(
    claimed.id, 'worker-suspension', 'Replay depois do trigger.'
  );
  if (suspension_result ->> 'idempotent')::boolean is not true then
    raise exception 'suspensão do worker após trigger deveria ser idempotente';
  end if;
end;
$$;

reset role;
rollback;

-- Teste transacional da retomada manual isolada. Executar em banco descartável
-- com schema até as migrations 089 e 090.

begin;

create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'sub', nullif(current_setting('request.jwt.claim.sub', true), ''),
    'role', nullif(current_setting('request.jwt.claim.role', true), ''),
    'email', nullif(current_setting('request.jwt.claim.email', true), '')
  )
$$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values (
  '14000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'resume@example.com', '', timezone('utc', now()),
  timezone('utc', now()), timezone('utc', now())
);
insert into public.organizations (id, name, slug, created_by)
values ('24000000-0000-0000-0000-000000000001', 'Organização retomada', 'organizacao-retomada', '14000000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('24000000-0000-0000-0000-000000000001', '14000000-0000-0000-0000-000000000001', 'admin', '14000000-0000-0000-0000-000000000001');
insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
) values (
  '34000000-0000-0000-0000-000000000001', '24000000-0000-0000-0000-000000000001',
  'resume-profile', 'resume_profile', 'token', 'offline', '14000000-0000-0000-0000-000000000001'
);

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values
  ('54000000-0000-0000-0000-000000000001', '24000000-0000-0000-0000-000000000001', '14000000-0000-0000-0000-000000000001', 'Lote retomado', 'processing', timezone('utc', now())),
  ('54000000-0000-0000-0000-000000000002', '24000000-0000-0000-0000-000000000001', '14000000-0000-0000-0000-000000000001', 'Outro lote suspenso', 'processing', timezone('utc', now())),
  ('54000000-0000-0000-0000-000000000003', '24000000-0000-0000-0000-000000000001', '14000000-0000-0000-0000-000000000001', 'Fila concorrente', 'queued', timezone('utc', now()));

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status, execute_at,
  idempotency_key, suspended_at, suspension_reason
) values
  ('64000000-0000-0000-0000-000000000001', '24000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-000000000001', '34000000-0000-0000-0000-000000000001', 'image', 'suspended', '2026-08-13T10:00:00Z', 'resume-target-expired-0001', timezone('utc', now()), 'offline'),
  ('64000000-0000-0000-0000-000000000002', '24000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-000000000001', '34000000-0000-0000-0000-000000000001', 'image', 'suspended', '2026-08-14T13:00:00Z', 'resume-target-future-00001', timezone('utc', now()), 'offline'),
  ('64000000-0000-0000-0000-000000000003', '24000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-000000000001', '34000000-0000-0000-0000-000000000001', 'image', 'suspended', '2026-08-14T14:00:00Z', 'resume-target-future-00002', timezone('utc', now()), 'offline'),
  ('64000000-0000-0000-0000-000000000004', '24000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000001', 'image', 'suspended', '2026-08-14T15:00:00Z', 'resume-other-batch-0000001', timezone('utc', now()), 'offline'),
  ('64000000-0000-0000-0000-000000000005', '24000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-000000000003', '34000000-0000-0000-0000-000000000001', 'image', 'waiting', '2026-08-14T18:00:00Z', 'resume-competing-queue-0001', null, null);

set local role authenticated;
set local request.jwt.claim.sub = '14000000-0000-0000-0000-000000000001';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'resume@example.com';

do $$
declare
  result jsonb;
begin
  begin
    perform public.resume_suspended_batch_profile_publications(
      '24000000-0000-0000-0000-000000000001',
      '54000000-0000-0000-0000-000000000001',
      '34000000-0000-0000-0000-000000000001',
      '2026-08-14T12:00:00Z', 'resume@example.com'
    );
    raise exception 'retomada deveria rejeitar perfil offline';
  exception when sqlstate '22023' then null;
  end;

  update public.instagram_profiles set status = 'online'
  where id = '34000000-0000-0000-0000-000000000001';

  result := public.resume_suspended_batch_profile_publications(
    '24000000-0000-0000-0000-000000000001',
    '54000000-0000-0000-0000-000000000001',
    '34000000-0000-0000-0000-000000000001',
    '2026-08-14T12:00:00Z', 'resume@example.com'
  );

  if result ->> 'resumedItems' <> '2' or result ->> 'ignoredItems' <> '1' then
    raise exception 'retomada tradicional não classificou 2 futuros e 1 vencido';
  end if;
  if (select status from public.publication_items where id = '64000000-0000-0000-0000-000000000001') <> 'ignored' then
    raise exception 'slot vencido não foi encerrado';
  end if;
  if (select execute_at from public.publication_items where id = '64000000-0000-0000-0000-000000000002') <> '2026-08-14T19:00:00Z'::timestamptz
    or (select execute_at from public.publication_items where id = '64000000-0000-0000-0000-000000000003') <> '2026-08-14T20:00:00Z'::timestamptz then
    raise exception 'itens futuros não foram redistribuídos depois da fila concorrente';
  end if;
  if (select status from public.publication_items where id = '64000000-0000-0000-0000-000000000004') <> 'suspended' then
    raise exception 'retomada alterou outro lote do mesmo perfil';
  end if;
  if (select count(*) from public.publication_item_events event
      join public.publication_items item on item.id = event.publication_item_id
      where item.batch_id = '54000000-0000-0000-0000-000000000001'
        and event.event_type = 'resumed') <> 3 then
    raise exception 'retomada não registrou evento por item processado';
  end if;
  if (select count(*) from public.profile_publication_resumptions
      where batch_id = '54000000-0000-0000-0000-000000000001'
        and profile_id = '34000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'auditoria agregada da retomada não foi registrada';
  end if;

  begin
    perform public.resume_suspended_batch_profile_publications(
      '24000000-0000-0000-0000-000000000001',
      '54000000-0000-0000-0000-000000000001',
      '34000000-0000-0000-0000-000000000001',
      '2026-08-14T12:00:00Z', 'resume@example.com'
    );
    raise exception 'segundo play deveria rejeitar par sem suspensos';
  exception when sqlstate '22023' then null;
  end;
end;
$$;

reset role;
rollback;

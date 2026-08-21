begin;

-- Regressão: Story ativo não pode deslocar a revisão nem a reserva de Reels.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values ('10000000-0000-0000-0000-000000000201', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'format-isolation@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));
insert into public.organizations (id, name, slug, created_by)
values ('20000000-0000-0000-0000-000000000201', 'Organização isolamento de formato', 'isolamento-formato-201', '10000000-0000-0000-0000-000000000201');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('20000000-0000-0000-0000-000000000201', '10000000-0000-0000-0000-000000000201', 'admin', '10000000-0000-0000-0000-000000000201');
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by)
values ('30000000-0000-0000-0000-000000000201', '20000000-0000-0000-0000-000000000201', 'format-isolation-profile', 'format_isolation_profile', 'test-token', 'online', '10000000-0000-0000-0000-000000000201');

set local role authenticated;
set local request.jwt.claim.sub = '10000000-0000-0000-0000-000000000201';
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.email = 'format-isolation@example.com';

do $$
declare
  organization_id uuid := '20000000-0000-0000-0000-000000000201';
  profile_id uuid := '30000000-0000-0000-0000-000000000201';
  review jsonb;
begin
  insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
  values ('50000000-0000-0000-0000-000000000201', organization_id, '10000000-0000-0000-0000-000000000201', 'Story futuro', 'queued', '2026-08-13T10:00:00Z');
  insert into public.publication_items (id, organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key)
  values ('60000000-0000-0000-0000-000000000201', organization_id, '50000000-0000-0000-0000-000000000201', profile_id, 'story', 'waiting', '2026-08-13T23:30:00Z', 'format-isolation-story');

  review := public.review_bulk_rotation_schedule(organization_id, array[profile_id], 60, 1, 'reel'::public.publication_format, '2026-08-13T10:00:00Z');
  if review ->> 'firstExecuteAt' <> '2026-08-13T11:00:00+00:00' then
    raise exception 'Story deslocou indevidamente a prévia de Reels: %', review;
  end if;
end;
$$;

reset role;
rollback;

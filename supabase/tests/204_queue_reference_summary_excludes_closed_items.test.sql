-- Regressão: itens cancelados são auditáveis, mas não fazem parte da fila operacional.
begin;

create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select jsonb_build_object('sub', nullif(current_setting('request.jwt.claim.sub', true), ''), 'role', 'authenticated')
$$;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, confirmed_at, created_at, updated_at)
values ('20400000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'queue-summary-204@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));
insert into public.organizations (id, name, slug, created_by)
values ('20400000-0000-0000-0000-000000000002', 'Resumo operacional', 'resumo-operacional-204', '20400000-0000-0000-0000-000000000001');
insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('20400000-0000-0000-0000-000000000002', '20400000-0000-0000-0000-000000000001', 'admin', '20400000-0000-0000-0000-000000000001');
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by)
values ('20400000-0000-0000-0000-000000000003', '20400000-0000-0000-0000-000000000002', 'queue-summary-204', 'queue_summary_204', 'token', 'online', '20400000-0000-0000-0000-000000000001');
insert into public.profile_groups (id, organization_id, name, created_by)
values ('20400000-0000-0000-0000-000000000004', '20400000-0000-0000-0000-000000000002', 'Dani', '20400000-0000-0000-0000-000000000001');
insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
values ('20400000-0000-0000-0000-000000000002', '20400000-0000-0000-0000-000000000004', '20400000-0000-0000-0000-000000000003', '20400000-0000-0000-0000-000000000001');
insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('20400000-0000-0000-0000-000000000005', '20400000-0000-0000-0000-000000000002', '20400000-0000-0000-0000-000000000001', 'Lote Dani', 'processing', timezone('utc', now()));
insert into public.publication_items (organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key)
values
  ('20400000-0000-0000-0000-000000000002', '20400000-0000-0000-0000-000000000005', '20400000-0000-0000-0000-000000000003', 'reel', 'published', timezone('utc', now()) - interval '1 hour', 'queue-summary-204-published'),
  ('20400000-0000-0000-0000-000000000002', '20400000-0000-0000-0000-000000000005', '20400000-0000-0000-0000-000000000003', 'story', 'waiting', timezone('utc', now()) + interval '1 hour', 'queue-summary-204-waiting'),
  ('20400000-0000-0000-0000-000000000002', '20400000-0000-0000-0000-000000000005', '20400000-0000-0000-0000-000000000003', 'reel', 'cancelled', timezone('utc', now()) + interval '2 hours', 'queue-summary-204-cancelled-1'),
  ('20400000-0000-0000-0000-000000000002', '20400000-0000-0000-0000-000000000005', '20400000-0000-0000-0000-000000000003', 'reel', 'cancelled', timezone('utc', now()) + interval '3 hours', 'queue-summary-204-cancelled-2');

set local role authenticated;
set local request.jwt.claim.sub = '20400000-0000-0000-0000-000000000001';

do $$
declare summary jsonb; group_row jsonb;
begin
  summary := public.get_publication_queue_reference_summary('20400000-0000-0000-0000-000000000002');
  select value into group_row from jsonb_array_elements(summary -> 'groups') where value ->> 'id' = '20400000-0000-0000-0000-000000000004';
  if summary #>> '{totals,total}' <> '2' or summary #>> '{totals,active}' <> '1' or summary #>> '{totals,closed}' <> '2' then
    raise exception 'totais operacionais deveriam ser 2 acompanhados, 1 ativo e 2 encerrados: %', summary -> 'totals';
  end if;
  if group_row ->> 'total' <> '2' or group_row ->> 'completed' <> '1' or group_row ->> 'active' <> '1' or group_row ->> 'closed' <> '2' then
    raise exception 'grupo deveria separar publicado, ativo e cancelado: %', group_row;
  end if;
end;
$$;

reset role;
rollback;

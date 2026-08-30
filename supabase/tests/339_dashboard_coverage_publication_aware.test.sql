-- Cobertura da dashboard consciente de publicação (migração 339).
-- Executar contra banco descartável com migrations até 339.
--
-- O que este teste protege: a fração "perfis com métrica / perfis ativos"
-- tratava três situações diferentes como o mesmo alarme. Os campos novos
-- separam "publicou e ficou sem métrica" (problema de coleta) de "não publicou
-- nada" (nada a fazer).

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(1);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
)
values ('13900000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'coverage-339@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('23900000-0000-4000-8000-000000000001', 'Cobertura 339', 'cobertura-339', '13900000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('23900000-0000-4000-8000-000000000001', '13900000-0000-4000-8000-000000000001', 'admin', '13900000-0000-4000-8000-000000000001')
on conflict (organization_id, user_id) do nothing;

-- Quatro perfis, um para cada situação que a interface precisa distinguir:
--   1 publicou e tem métrica          -> cobertura saudável
--   2 publicou e NÃO tem métrica      -> pendência de coleta (o único alarme)
--   3 não publicou e não tem métrica  -> legítimo, não é falha
--   4 não publicou mas tem métrica    -> herança de janela anterior
insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username,
  encrypted_access_token, status, created_by, provider
)
values
  ('33900000-0000-4000-8000-000000000001', '23900000-0000-4000-8000-000000000001', 'coverage-339-p1', 'coverage_339_p1', 'token', 'online', '13900000-0000-4000-8000-000000000001', 'meta_official'),
  ('33900000-0000-4000-8000-000000000002', '23900000-0000-4000-8000-000000000001', 'coverage-339-p2', 'coverage_339_p2', 'token', 'online', '13900000-0000-4000-8000-000000000001', 'meta_official'),
  ('33900000-0000-4000-8000-000000000003', '23900000-0000-4000-8000-000000000001', 'coverage-339-p3', 'coverage_339_p3', 'token', 'online', '13900000-0000-4000-8000-000000000001', 'meta_official'),
  ('33900000-0000-4000-8000-000000000004', '23900000-0000-4000-8000-000000000001', 'coverage-339-p4', 'coverage_339_p4', 'token', 'online', '13900000-0000-4000-8000-000000000001', 'meta_official');

insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date,
  posts, reach, views, likes, comments, shares, saves, interactions, coverage_status
)
values
  ('23900000-0000-4000-8000-000000000001', '33900000-0000-4000-8000-000000000001', 'meta_official', '2026-08-10', 1, 10, 10, 1, 0, 0, 0, 1, 'complete'),
  ('23900000-0000-4000-8000-000000000001', '33900000-0000-4000-8000-000000000004', 'meta_official', '2026-08-10', 1, 10, 10, 1, 0, 0, 0, 1, 'complete');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('53900000-0000-4000-8000-000000000001', '23900000-0000-4000-8000-000000000001', '13900000-0000-4000-8000-000000000001', 'Lote cobertura 339', 'processing', timezone('utc', now()));

insert into public.publication_items (
  id, organization_id, batch_id, profile_id, format, status,
  execute_at, published_at, idempotency_key
)
values
  ('93900000-0000-4000-8000-000000000001', '23900000-0000-4000-8000-000000000001', '53900000-0000-4000-8000-000000000001', '33900000-0000-4000-8000-000000000001', 'image', 'published', '2026-08-10 12:00:00-03', '2026-08-10 12:00:00-03', 'coverage-339-item-1'),
  ('93900000-0000-4000-8000-000000000002', '23900000-0000-4000-8000-000000000001', '53900000-0000-4000-8000-000000000001', '33900000-0000-4000-8000-000000000002', 'image', 'published', '2026-08-10 12:00:00-03', '2026-08-10 12:00:00-03', 'coverage-339-item-2'),
  -- Fora da janela consultada: não pode contar como publicação do período.
  ('93900000-0000-4000-8000-000000000003', '23900000-0000-4000-8000-000000000001', '53900000-0000-4000-8000-000000000001', '33900000-0000-4000-8000-000000000003', 'image', 'published', '2026-07-01 12:00:00-03', '2026-07-01 12:00:00-03', 'coverage-339-item-3'),
  -- Agendado mas não publicado: também não conta.
  ('93900000-0000-4000-8000-000000000004', '23900000-0000-4000-8000-000000000001', '53900000-0000-4000-8000-000000000001', '33900000-0000-4000-8000-000000000004', 'image', 'waiting', '2026-08-10 12:00:00-03', null, 'coverage-339-item-4');

set local role authenticated;
select set_config('request.jwt.claim.sub', '13900000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  payload jsonb;
begin
  payload := public.get_dashboard_analytics_v2(
    '23900000-0000-4000-8000-000000000001',
    '2026-08-01', '2026-08-31', null, null, null, 'likes', 'day'
  );

  if (payload #>> '{coverage,selected_profiles}')::integer <> 4 then
    raise exception 'Denominador de perfis ativos incorreto: %', payload #> '{coverage}';
  end if;

  -- p1 e p4 têm linha diária.
  if (payload #>> '{coverage,profiles_with_metrics}')::integer <> 2 then
    raise exception 'profiles_with_metrics incorreto: %', payload #> '{coverage}';
  end if;

  -- Só p1 e p2 publicaram DENTRO da janela e com status published.
  if (payload #>> '{coverage,profiles_with_publications}')::integer <> 2 then
    raise exception 'profiles_with_publications não isolou janela/status: %', payload #> '{coverage}';
  end if;

  -- Apenas p2 publicou e ficou sem métrica. p3 não publicou (não é pendência)
  -- e p4 tem métrica sem ter publicado (não é pendência).
  if (payload #>> '{coverage,profiles_pending_collection}')::integer <> 1 then
    raise exception 'profiles_pending_collection deveria contar somente quem publicou sem métrica: %', payload #> '{coverage}';
  end if;

  -- Janela sem publicação nenhuma zera a pendência sem zerar o denominador.
  payload := public.get_dashboard_analytics_v2(
    '23900000-0000-4000-8000-000000000001',
    '2026-06-01', '2026-06-30', null, null, null, 'likes', 'day'
  );
  if (payload #>> '{coverage,profiles_with_publications}')::integer <> 0
    or (payload #>> '{coverage,profiles_pending_collection}')::integer <> 0
    or (payload #>> '{coverage,selected_profiles}')::integer <> 4
  then
    raise exception 'Janela vazia não deveria gerar pendência: %', payload #> '{coverage}';
  end if;

  -- Campos antigos preservados: a migração é aditiva.
  if payload #> '{coverage,partial_profiles}' is null
    or not (payload #> '{coverage}') ? 'first_metric_date'
    or not (payload #> '{coverage}') ? 'last_metric_date'
  then
    raise exception 'Contrato antigo de coverage foi quebrado: %', payload #> '{coverage}';
  end if;
end;
$$;

reset role;

select extensions.pass('cobertura da dashboard separa pendência de coleta de ausência de publicação');
select extensions.finish();

rollback;

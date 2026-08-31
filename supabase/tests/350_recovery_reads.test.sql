begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(11);

-- Leitura da tela de Recuperacao (migration 350).
--
-- Cenario minimo com os dois niveis representados:
--   grupo A: 7 perfis em views/slot 5, 12, 30, 40, 50, 60, 70 -> M = 40,
--            entao p1 cai a 25% (severo) e p2 so a 40% (moderado);
--   grupo B: 6 perfis saudaveis em 30 + 1 que fez 100 e caiu para 0,1.
--
-- Logo: 25% -> 2 elegiveis (1 nunca engrenou + 1 desabou)
--       40% -> 3 elegiveis (2 nunca engrenou + 1 desabou)

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('15000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'leitura-350@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('25000000-0000-4000-8000-000000000001', 'Leitura 350', 'leitura-350', '15000000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('25000000-0000-4000-8000-000000000001', '15000000-0000-4000-8000-000000000001', 'operator', '15000000-0000-4000-8000-000000000001');

insert into public.profile_groups (id, organization_id, name, created_by, recovery_enabled) values
  ('35000000-0000-4000-8000-00000000000a', '25000000-0000-4000-8000-000000000001', 'A regua', '15000000-0000-4000-8000-000000000001', true),
  ('35000000-0000-4000-8000-00000000000b', '25000000-0000-4000-8000-000000000001', 'B desabou', '15000000-0000-4000-8000-000000000001', true);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
)
select ('a5000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '25000000-0000-4000-8000-000000000001',
       'ig-350-' || n, 'perfil' || n, 'token', 'online',
       '15000000-0000-4000-8000-000000000001'
from generate_series(1, 17) n;

insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
select '25000000-0000-4000-8000-000000000001',
       case when n between 1 and 7 then '35000000-0000-4000-8000-00000000000a'
            else '35000000-0000-4000-8000-00000000000b' end::uuid,
       ('a5000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '15000000-0000-4000-8000-000000000001'
from generate_series(1, 17) n
where n between 1 and 7 or n between 11 and 17;

insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '25000000-0000-4000-8000-000000000001',
       ('a5000000-0000-4000-8000-' || lpad(v.n::text, 12, '0'))::uuid,
       'zernio', d::date, 10, v.views_day
from (values
  (1, 50), (2, 120), (3, 300), (4, 400), (5, 500), (6, 600), (7, 700),
  (11, 300), (12, 300), (13, 300), (14, 300), (15, 300), (16, 300)
) as v(n, views_day)
cross join generate_series(current_date - 11, current_date - 2, interval '1 day') d;

-- O perfil que ja provou e depois desabou.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '25000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000017',
       'zernio', d::date, 10,
       case when d::date <= current_date - 9 then 1000 else 1 end
from generate_series(current_date - 11, current_date - 2, interval '1 day') d;

-- Dia parcial, descartado pela regua.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '25000000-0000-4000-8000-000000000001',
       ('a5000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'zernio', current_date - 1, 10, 0
from generate_series(1, 7) n;

set local role authenticated;
set local request.jwt.claim.sub = '15000000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

select public.begin_recovery_analysis_run('25000000-0000-4000-8000-000000000001'::uuid, 'manual');

do $$
declare
  v_run uuid;
  v_result jsonb;
  v_guard integer := 0;
begin
  select id into v_run from public.recovery_analysis_runs
   where organization_id = '25000000-0000-4000-8000-000000000001';
  loop
    v_guard := v_guard + 1;
    v_result := public.process_recovery_analysis_chunk(v_run, 1);
    exit when (v_result ->> 'remaining')::integer = 0 or v_guard > 20;
  end loop;
end;
$$;

-- Panorama ------------------------------------------------------------------

select extensions.is(
  (select (public.get_recovery_overview('25000000-0000-4000-8000-000000000001'::uuid)
             -> 'totals' ->> 'eligible25')::integer),
  2,
  'o cenario conservador soma o Filtro 1 a 25% com o Filtro 2'
);
select extensions.is(
  (select (public.get_recovery_overview('25000000-0000-4000-8000-000000000001'::uuid)
             -> 'totals' ->> 'eligible40')::integer),
  3,
  'o cenario aberto troca so o ajuste do Filtro 1; o Filtro 2 nao tem botao'
);
select extensions.is(
  (select (public.get_recovery_overview('25000000-0000-4000-8000-000000000001'::uuid)
             -> 'totals' ->> 'newSincePrevious')::integer),
  0,
  'na primeira execucao ninguem e "novo": nao ha rodada anterior para comparar'
);
select extensions.is(
  (select jsonb_array_length(public.get_recovery_overview(
     '25000000-0000-4000-8000-000000000001'::uuid) -> 'groups')),
  2,
  'os dois grupos com recuperacao ligada aparecem no panorama'
);
select extensions.is(
  (select round((g ->> 'health_gate_threshold')::numeric, 4)
     from jsonb_array_elements(public.get_recovery_overview(
            '25000000-0000-4000-8000-000000000001'::uuid) -> 'groups') g
    where g ->> 'group_name' = 'B desabou'),
  (select round(peak_daily_median * 0.60, 4) from public.recovery_group_stats s
     join public.profile_groups g on g.id = s.group_id
    where g.name = 'B desabou'),
  'o limiar do portao e derivado do pico na leitura, nunca gravado como pico'
);
select extensions.ok(
  (select (public.get_recovery_overview('25000000-0000-4000-8000-000000000001'::uuid)
             -> 'staleness' ->> 'warn')::boolean) = false,
  'com a coleta em dia a faixa de atraso nao acende'
);

-- Candidatos ----------------------------------------------------------------

select extensions.is(
  (select count(*)::integer from public.list_recovery_candidates(
     (select id from public.recovery_analysis_runs
       where organization_id = '25000000-0000-4000-8000-000000000001'))),
  3,
  'a listagem traz o superconjunto de 40%, para o botao girar sem requisicao'
);
select extensions.ok(
  not (select bool_or(has_more) from public.list_recovery_candidates(
     (select id from public.recovery_analysis_runs
       where organization_id = '25000000-0000-4000-8000-000000000001'))),
  'tres candidatos cabem folgado no teto: has_more fica falso'
);
select extensions.is(
  (select judged_index = recent_index from public.list_recovery_candidates(
     (select id from public.recovery_analysis_runs
       where organization_id = '25000000-0000-4000-8000-000000000001'))
    where profile_id = 'a5000000-0000-4000-8000-000000000017'),
  true,
  'quem desabou e julgado pela razao recente, nao pela agregada'
);
select extensions.is(
  (select judged_index = vs_index from public.list_recovery_candidates(
     (select id from public.recovery_analysis_runs
       where organization_id = '25000000-0000-4000-8000-000000000001'))
    where profile_id = 'a5000000-0000-4000-8000-000000000001'),
  true,
  'quem nunca engrenou e julgado pela razao agregada'
);

-- Esteira -------------------------------------------------------------------

select public.enter_recovery_cohort(
  '25000000-0000-4000-8000-000000000001'::uuid,
  '35000000-0000-4000-8000-00000000000a'::uuid,
  array['a5000000-0000-4000-8000-000000000001']::uuid[]);

select extensions.is(
  (select array[username, entry_reason] from public.get_recovery_cohort_page(
     '25000000-0000-4000-8000-000000000001'::uuid)),
  array['perfil1', 'never_started'],
  'a esteira mostra o perfil com o motivo congelado na entrada'
);

select * from extensions.finish();
rollback;

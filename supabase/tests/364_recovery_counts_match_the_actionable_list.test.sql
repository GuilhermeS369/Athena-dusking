-- O cabecalho da Recuperacao nao pode prometer um numero que a lista nao tem.
--
-- Cenario copiado do teste da 350 (dois niveis representados), e entao um dos
-- candidatos e excluido. Antes da 364 o cabecalho continuava contando ele: em
-- producao, com todos os marcados ja excluidos, a tela dizia 43 elegiveis com
-- a lista vazia.
--
-- A divisao que este teste fixa:
--   MEDIDA  (julgaveis, mediana, pico) — congelada no snapshot, nao se mexe;
--   ACAO    (quantos elegiveis) — conta ao vivo, igual a lista.

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(9);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('16400000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'contagem-364@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('26400000-0000-4000-8000-000000000001', 'Contagem 364', 'contagem-364', '16400000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('26400000-0000-4000-8000-000000000001', '16400000-0000-4000-8000-000000000001', 'operator', '16400000-0000-4000-8000-000000000001');

insert into public.profile_groups (id, organization_id, name, created_by, recovery_enabled) values
  ('36400000-0000-4000-8000-00000000000a', '26400000-0000-4000-8000-000000000001', 'A regua', '16400000-0000-4000-8000-000000000001', true),
  ('36400000-0000-4000-8000-00000000000b', '26400000-0000-4000-8000-000000000001', 'B desabou', '16400000-0000-4000-8000-000000000001', true);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
)
select ('a6400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '26400000-0000-4000-8000-000000000001',
       'ig-364-' || n, 'perfil364' || n, 'token', 'online',
       '16400000-0000-4000-8000-000000000001'
from generate_series(1, 17) n;

insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
select '26400000-0000-4000-8000-000000000001',
       case when n between 1 and 7 then '36400000-0000-4000-8000-00000000000a'
            else '36400000-0000-4000-8000-00000000000b' end::uuid,
       ('a6400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '16400000-0000-4000-8000-000000000001'
from generate_series(1, 17) n
where n between 1 and 7 or n between 11 and 17;

insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '26400000-0000-4000-8000-000000000001',
       ('a6400000-0000-4000-8000-' || lpad(v.n::text, 12, '0'))::uuid,
       'zernio', d::date, 10, v.views_day
from (values
  (1, 50), (2, 120), (3, 300), (4, 400), (5, 500), (6, 600), (7, 700),
  (11, 300), (12, 300), (13, 300), (14, 300), (15, 300), (16, 300)
) as v(n, views_day)
cross join generate_series(current_date - 11, current_date - 2, interval '1 day') d;

-- O perfil que ja provou e depois desabou (Nivel 2).
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '26400000-0000-4000-8000-000000000001', 'a6400000-0000-4000-8000-000000000017',
       'zernio', d::date, 10,
       case when d::date <= current_date - 9 then 1000 else 1 end
from generate_series(current_date - 11, current_date - 2, interval '1 day') d;

-- Dia parcial, descartado pela regua.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '26400000-0000-4000-8000-000000000001',
       ('a6400000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'zernio', current_date - 1, 10, 0
from generate_series(1, 7) n;

set local role authenticated;
set local request.jwt.claim.sub = '16400000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

select public.begin_recovery_analysis_run('26400000-0000-4000-8000-000000000001'::uuid, 'manual');

do $$
declare
  v_run uuid;
  v_result jsonb;
  v_guard integer := 0;
begin
  select id into v_run from public.recovery_analysis_runs
   where organization_id = '26400000-0000-4000-8000-000000000001';
  loop
    v_guard := v_guard + 1;
    v_result := public.process_recovery_analysis_chunk(v_run, 1);
    exit when (v_result ->> 'remaining')::integer = 0 or v_guard > 20;
  end loop;
end;
$$;

-- Linha de base: 2 elegiveis a 25%, 3 a 40%, e a lista com os 3.

select extensions.is(
  (select (public.get_recovery_overview('26400000-0000-4000-8000-000000000001'::uuid)
             -> 'totals' ->> 'eligible40')::integer),
  3,
  'a rodada marca tres candidatos'
);
select extensions.is(
  (select count(*)::integer from public.list_recovery_candidates(
    (select id from public.recovery_analysis_runs
      where organization_id = '26400000-0000-4000-8000-000000000001'))),
  3,
  'e a lista mostra os tres'
);

-- O operador exclui o candidato severo do grupo A (perfil 1).
update public.instagram_profiles set deleted_at = timezone('utc', now())
 where id = 'a6400000-0000-4000-8000-000000000001';

select extensions.is(
  (select count(*)::integer from public.list_recovery_candidates(
    (select id from public.recovery_analysis_runs
      where organization_id = '26400000-0000-4000-8000-000000000001'))),
  2,
  'perfil excluido sai da lista'
);
select extensions.is(
  (select (public.get_recovery_overview('26400000-0000-4000-8000-000000000001'::uuid)
             -> 'totals' ->> 'eligible40')::integer),
  2,
  'e sai da contagem do cabecalho junto — era aqui que a tela se contradizia'
);
select extensions.is(
  (select (public.get_recovery_overview('26400000-0000-4000-8000-000000000001'::uuid)
             -> 'totals' ->> 'eligible25')::integer),
  1,
  'o ajuste de 25% conta pela mesma fonte'
);

-- Os dois numeros que explicam o zero.
select extensions.is(
  (select (public.get_recovery_overview('26400000-0000-4000-8000-000000000001'::uuid)
             -> 'totals' ->> 'markedInRun')::integer),
  3,
  'markedInRun preserva o que a regua marcou na rodada'
);
select extensions.is(
  (select (public.get_recovery_overview('26400000-0000-4000-8000-000000000001'::uuid)
             -> 'totals' ->> 'goneSinceRun')::integer),
  1,
  'goneSinceRun diz quantos sairam depois da analise'
);

-- A MEDIDA nao se mexe: quem foi julgado foi julgado, e a mediana daquele dia
-- e o que a proxima rodada precisa comparar.
select extensions.is(
  (select (grupo ->> 'judgeable_profiles')::integer
     from jsonb_array_elements(
       public.get_recovery_overview('26400000-0000-4000-8000-000000000001'::uuid) -> 'groups'
     ) as grupo
    where grupo ->> 'group_id' = '36400000-0000-4000-8000-00000000000a'),
  7,
  'julgaveis continua sendo o do snapshot, sem descontar o excluido'
);

-- already_in_recovery ao vivo: mover para a esteira DEPOIS da analise tem de
-- refletir na lista, porque esse campo decide se a linha e clicavel.
--
-- A insercao troca de papel de proposito: `authenticated` NAO escreve nessa
-- tabela (a esteira so entra por RPC security definer, para a tela nao
-- conseguir fabricar um veredito). Tentar inserir como authenticated aqui falha
-- com 42501 — o que e a politica funcionando, nao um problema do teste.
set local role service_role;
set local request.jwt.claim.role = 'service_role';

insert into public.recovery_cohort_members (
  organization_id, profile_id, username_at_entry, source_group_id,
  entered_on, measurement_start_on, entry_reason, status
) values (
  '26400000-0000-4000-8000-000000000001', 'a6400000-0000-4000-8000-000000000002',
  'perfil3642', '36400000-0000-4000-8000-00000000000a',
  current_date, current_date, 'never_started', 'active'
);

-- Volta para quem de fato lê a tela.
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';

select extensions.is(
  (select already_in_recovery from public.list_recovery_candidates(
     (select id from public.recovery_analysis_runs
       where organization_id = '26400000-0000-4000-8000-000000000001'))
    where profile_id = 'a6400000-0000-4000-8000-000000000002'),
  true,
  'entrar na esteira depois da analise trava a linha na hora'
);

select * from extensions.finish();
rollback;

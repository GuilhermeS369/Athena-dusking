begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(24);

-- A regua de corte (migration 348), com dados sinteticos desenhados para que
-- cada numero esperado seja verificavel a mao.
--
-- Cenario base: 10 dias de metrica (21 a 30/08) e um dia parcial (31/08) que a
-- regua tem de descartar. Cada perfil "constante" posta 10 vezes por dia
-- durante os 10 dias (100 posts, folgadamente acima do gate de 60), e as views
-- do dia sao 10 x v — entao `v` E o views/slot do perfil, e a mediana do grupo
-- pode ser conferida de cabeca.
--
-- Grupos:
--   A  regua        7 perfis com v = 5, 12, 30, 40, 50, 60, 70  -> M = 40
--   B  desabou      6 saudaveis em v=30 + 1 que fez 100 e caiu para 0,1
--   C  queda        6 perfis que cairam JUNTOS (100 -> 10): portao fechado
--   D  pequeno      2 julgaveis: amostra degenerada
--   E  vazio        nenhum membro
--   F  mortos       5 perfis com views = 0: M = 0 e pico = 0
--   G  fronteira    5 fillers + perfis de 59, 60 e 61 posts
--   H  par          6 perfis: mediana interpolada
--   I  estouro      valores que estouram numeric(18,6): o grupo tem de virar
--                   'failed' sem travar o laco

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('14800000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'regua-348@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('24800000-0000-4000-8000-000000000001', 'Regua 348', 'regua-348', '14800000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('24800000-0000-4000-8000-000000000001', '14800000-0000-4000-8000-000000000001', 'operator', '14800000-0000-4000-8000-000000000001');

insert into public.profile_groups (id, organization_id, name, created_by, recovery_enabled) values
  ('34800000-0000-4000-8000-00000000000a', '24800000-0000-4000-8000-000000000001', 'A regua', '14800000-0000-4000-8000-000000000001', true),
  ('34800000-0000-4000-8000-00000000000b', '24800000-0000-4000-8000-000000000001', 'B desabou', '14800000-0000-4000-8000-000000000001', true),
  ('34800000-0000-4000-8000-00000000000c', '24800000-0000-4000-8000-000000000001', 'C queda', '14800000-0000-4000-8000-000000000001', true),
  ('34800000-0000-4000-8000-00000000000d', '24800000-0000-4000-8000-000000000001', 'D pequeno', '14800000-0000-4000-8000-000000000001', true),
  ('34800000-0000-4000-8000-00000000000e', '24800000-0000-4000-8000-000000000001', 'E vazio', '14800000-0000-4000-8000-000000000001', true),
  ('34800000-0000-4000-8000-00000000000f', '24800000-0000-4000-8000-000000000001', 'F mortos', '14800000-0000-4000-8000-000000000001', true),
  ('34800000-0000-4000-8000-000000000010', '24800000-0000-4000-8000-000000000001', 'G fronteira', '14800000-0000-4000-8000-000000000001', true),
  ('34800000-0000-4000-8000-000000000011', '24800000-0000-4000-8000-000000000001', 'H par', '14800000-0000-4000-8000-000000000001', true),
  ('34800000-0000-4000-8000-000000000012', '24800000-0000-4000-8000-000000000001', 'I estouro', '14800000-0000-4000-8000-000000000001', true),
  -- Grupo desligado: nao pode aparecer em nenhuma execucao.
  ('34800000-0000-4000-8000-000000000013', '24800000-0000-4000-8000-000000000001', 'Z desligado', '14800000-0000-4000-8000-000000000001', false);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
)
select
  ('a4800000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '24800000-0000-4000-8000-000000000001',
  'ig-348-' || n, 'p' || n, 'token', 'online',
  '14800000-0000-4000-8000-000000000001'
from generate_series(1, 80) n;

insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
select
  '24800000-0000-4000-8000-000000000001',
  case
    when n between  1 and  7 then '34800000-0000-4000-8000-00000000000a'
    when n between 11 and 17 then '34800000-0000-4000-8000-00000000000b'
    when n between 21 and 26 then '34800000-0000-4000-8000-00000000000c'
    when n between 31 and 32 then '34800000-0000-4000-8000-00000000000d'
    when n between 41 and 45 then '34800000-0000-4000-8000-00000000000f'
    when n between 51 and 58 then '34800000-0000-4000-8000-000000000010'
    when n between 61 and 66 then '34800000-0000-4000-8000-000000000011'
    when n between 71 and 75 then '34800000-0000-4000-8000-000000000012'
  end::uuid,
  ('a4800000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '14800000-0000-4000-8000-000000000001'
from generate_series(1, 80) n
where n between 1 and 7 or n between 11 and 17 or n between 21 and 26
   or n between 31 and 32 or n between 41 and 45 or n between 51 and 58
   or n between 61 and 66 or n between 71 and 75;

-- Perfis constantes: 10 posts/dia por 10 dias, views do dia = 10 x v.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select
  '24800000-0000-4000-8000-000000000001',
  ('a4800000-0000-4000-8000-' || lpad(v.n::text, 12, '0'))::uuid,
  'zernio', d::date, v.posts_day, v.views_day
from (values
  -- A: M = 40
  (1, 10, 50), (2, 10, 120), (3, 10, 300), (4, 10, 400), (5, 10, 500), (6, 10, 600), (7, 10, 700),
  -- B saudaveis
  (11, 10, 300), (12, 10, 300), (13, 10, 300), (14, 10, 300), (15, 10, 300), (16, 10, 300),
  -- D: so dois julgaveis
  (31, 10, 300), (32, 10, 300),
  -- F: views zeradas -> M = 0 e pico = 0
  (41, 10, 0), (42, 10, 0), (43, 10, 0), (44, 10, 0), (45, 10, 0),
  -- G fillers
  (51, 10, 300), (52, 10, 300), (53, 10, 300), (54, 10, 300), (55, 10, 300),
  -- H: 6 perfis, mediana interpolada entre 30 e 40 = 35
  (61, 10, 100), (62, 10, 200), (63, 10, 300), (64, 10, 400), (65, 10, 500), (66, 10, 600),
  -- I: 60 posts e views absurdas; a mediana estoura numeric(18,6)
  (71, 6, 90000000000000000), (72, 6, 90000000000000000), (73, 6, 90000000000000000),
  (74, 6, 90000000000000000), (75, 6, 90000000000000000)
) as v(n, posts_day, views_day)
cross join generate_series('2026-08-21'::date, '2026-08-30'::date, interval '1 day') d
-- O perfil 1 tem o dia 25 substituido pelas duas linhas de provider mais abaixo.
where not (v.n = 1 and d::date = '2026-08-25');

-- Duas linhas de provider no MESMO dia para o perfil 1. Somadas, o dia da
-- views/slot 5 como todos os outros dias dele; NAO somadas, o maior dia dele
-- seria 45/1 = 45, acima da mediana 40, e o veto vitalicio o tiraria da lista.
-- Se este perfil aparecer como candidato, o colapso por provider funcionou.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views) values
  ('24800000-0000-4000-8000-000000000001', 'a4800000-0000-4000-8000-000000000001', 'meta_official', '2026-08-25', 1, 45),
  ('24800000-0000-4000-8000-000000000001', 'a4800000-0000-4000-8000-000000000001', 'zernio',        '2026-08-25', 9,  5);

-- Dia sem postagem para o perfil 2: se as linhas com posts = 0 nao fossem
-- descartadas, as 999.999 views entrariam no total e ele deixaria de ser
-- candidato.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views) values
  ('24800000-0000-4000-8000-000000000001', 'a4800000-0000-4000-8000-000000000002', 'zernio', '2026-08-20', 0, 999999);

-- Dia parcial: o mais recente do conjunto. Zera as views de todo o grupo A e
-- tem de ser descartado, senao a mediana de A despenca.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '24800000-0000-4000-8000-000000000001',
       ('a4800000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'zernio', '2026-08-31', 10, 0
from generate_series(1, 7) n;

-- B: o caso do perfil que fez 100 num dia e esta em 0,1 nos ultimos posts.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '24800000-0000-4000-8000-000000000001', 'a4800000-0000-4000-8000-000000000017',
       'zernio', d::date, 10,
       case when d::date <= '2026-08-23' then 1000 else 1 end
from generate_series('2026-08-21'::date, '2026-08-30'::date, interval '1 day') d;

-- C: o grupo INTEIRO caiu junto (midia queimando). O portao de saude tem de
-- fechar: aqui nao da para separar conta caindo de midia queimando.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '24800000-0000-4000-8000-000000000001',
       ('a4800000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       'zernio', d::date, 10,
       case when d::date <= '2026-08-23' then 1000 else 100 end
from generate_series(21, 26) n
cross join generate_series('2026-08-21'::date, '2026-08-30'::date, interval '1 day') d;

-- G: fronteira exata do gate de 60 posts.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views) values
  ('24800000-0000-4000-8000-000000000001', 'a4800000-0000-4000-8000-000000000056', 'zernio', '2026-08-30', 59, 1770),
  ('24800000-0000-4000-8000-000000000001', 'a4800000-0000-4000-8000-000000000057', 'zernio', '2026-08-30', 60, 1800),
  ('24800000-0000-4000-8000-000000000001', 'a4800000-0000-4000-8000-000000000058', 'zernio', '2026-08-30', 61, 1830);

set local role authenticated;
set local request.jwt.claim.sub = '14800000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

-- As duas execucoes do teste sao identificadas pela origem ('manual' e depois
-- 'backfill'), nao por ordem de uuid: id e aleatorio e nao ordena por tempo.
select public.begin_recovery_analysis_run('24800000-0000-4000-8000-000000000001'::uuid, 'manual');

-- Janela ------------------------------------------------------------------

select extensions.is(
  (select latest_metric_date from public.recovery_analysis_runs where id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual')),
  '2026-08-31'::date,
  'a janela sai dos dados: o dia mais recente do conjunto e 31/08'
);
select extensions.is(
  (select array[window_start, window_end] from public.recovery_analysis_runs where id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual')),
  array['2026-08-01'::date, '2026-08-30'::date],
  'o dia mais recente e descartado e a janela padrao cobre 30 dias'
);

-- Um grupo por chamada, laco entre chamadas ---------------------------------

do $$
declare
  v_run uuid;
  v_result jsonb;
  v_guard integer := 0;
begin
  select id into v_run from public.recovery_analysis_runs
   where organization_id = '24800000-0000-4000-8000-000000000001'
     and trigger_source = 'manual';
  loop
    v_guard := v_guard + 1;
    v_result := public.process_recovery_analysis_chunk(v_run, 1);
    exit when (v_result ->> 'remaining')::integer = 0 or v_guard > 40;
  end loop;
end;
$$;

-- Grupo A: a regua de base --------------------------------------------------

select extensions.is(
  (select median_vs from public.recovery_group_stats
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000a'),
  40.000000::numeric,
  'o dia parcial nao entrou: a mediana de A e exatamente 40'
);
select extensions.is(
  (select count(*)::integer from public.recovery_candidates
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000a'),
  2,
  'a 40% da mediana, dois perfis de A caem no Filtro 1'
);
select extensions.is(
  (select severity from public.recovery_candidates
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and profile_id = 'a4800000-0000-4000-8000-000000000001'),
  'severe',
  'perfil abaixo de 25% da mediana entra como severo'
);
select extensions.is(
  (select severity from public.recovery_candidates
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and profile_id = 'a4800000-0000-4000-8000-000000000002'),
  'moderate',
  'perfil que so entra a 40% e etiquetado como moderado, nao some'
);
select extensions.is(
  (select best_day_vs from public.recovery_candidates
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and profile_id = 'a4800000-0000-4000-8000-000000000001'),
  5.000000::numeric,
  'as duas linhas de provider do mesmo dia sao somadas antes de tudo'
);
select extensions.ok(
  exists (select 1 from public.recovery_candidates
           where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual')
             and profile_id = 'a4800000-0000-4000-8000-000000000002'),
  'dia com posts = 0 e descartado: as views dele nao salvam o perfil'
);

-- Grupo B: o veto vitalicio manda o perfil para o Filtro 2 -------------------

select extensions.is(
  (select reason from public.recovery_candidates
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and profile_id = 'a4800000-0000-4000-8000-000000000017'),
  'collapsed',
  'quem ja teve um dia no nivel da mediana cai pelo Filtro 2, nunca pelo 1'
);
select extensions.is(
  (select count(*)::integer from public.recovery_candidates
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000b'),
  1,
  'os saudaveis de B nao sao acusados junto'
);
select extensions.ok(
  (select health_gate_passed from public.recovery_group_stats
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000b'),
  'B esta saudavel, entao o Filtro 2 pode opinar'
);

-- Grupo C: midia queimando, a regua se cala ---------------------------------

select extensions.is(
  (select status from public.recovery_group_stats
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000c'),
  'gate_blocked',
  'grupo em queda desliga o Filtro 2 sozinho'
);
select extensions.is(
  (select count(*)::integer from public.recovery_candidates
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000c'),
  0,
  'com o portao fechado nenhum perfil de C e condenado'
);

-- Amostras degeneradas ------------------------------------------------------

select extensions.is(
  (select status from public.recovery_group_stats
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000d'),
  'insufficient_judgeable',
  'mediana de dois perfis nao e regua'
);
select extensions.is(
  (select count(*)::integer from public.recovery_candidates
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000d'),
  0,
  'grupo com amostra insuficiente nao produz candidato'
);
select extensions.is(
  (select status from public.recovery_group_stats
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000e'),
  'no_members',
  'grupo sem membros AINDA ganha linha: sem ela o laco de chunks nunca termina'
);
select extensions.is(
  (select status from public.recovery_group_stats
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000f'),
  'degenerate_median',
  'com M = 0 o Filtro 1 sumiria em silencio; o status registra o motivo'
);
select extensions.ok(
  not (select health_gate_passed from public.recovery_group_stats
        where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-00000000000f'),
  'com pico = 0 o portao FECHA; sem a guarda ele abriria no grupo morto'
);

-- Fronteiras ----------------------------------------------------------------

select extensions.is(
  (select judgeable_profiles from public.recovery_group_stats
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-000000000010'),
  7,
  'o gate e >= 60 posts: 59 fica de fora, 60 e 61 entram'
);
select extensions.is(
  (select median_vs from public.recovery_group_stats
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-000000000011'),
  35.000000::numeric,
  'com contagem par a mediana interpola e pode nao existir na amostra'
);

-- Falha isolada nao trava o laco --------------------------------------------

select extensions.is(
  (select status from public.recovery_group_stats
    where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual') and group_id = '34800000-0000-4000-8000-000000000012'),
  'failed',
  'grupo que estoura vira failed em vez de reverter a execucao inteira'
);
select extensions.is(
  (select status from public.recovery_analysis_runs where id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual')),
  'completed_with_errors',
  'o laco termina mesmo com um grupo quebrado (senao ele repetiria para sempre)'
);
select extensions.ok(
  not exists (select 1 from public.recovery_group_stats
               where run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'manual')
                 and group_id = '34800000-0000-4000-8000-000000000013'),
  'grupo com recuperacao desligada nao entra na analise'
);

-- O marco de midia move o pico ----------------------------------------------

insert into public.recovery_media_milestones (
  organization_id, group_id, happened_on, media_count, batch_kind, created_by)
values ('24800000-0000-4000-8000-000000000001', '34800000-0000-4000-8000-00000000000c',
        '2026-08-24', 36, 'reprocessed', '14800000-0000-4000-8000-000000000001');

select public.begin_recovery_analysis_run('24800000-0000-4000-8000-000000000001'::uuid, 'backfill');

do $$
declare
  v_run uuid;
  v_result jsonb;
  v_guard integer := 0;
begin
  select id into v_run from public.recovery_analysis_runs
   where organization_id = '24800000-0000-4000-8000-000000000001'
     and trigger_source = 'backfill';
  loop
    v_guard := v_guard + 1;
    v_result := public.process_recovery_analysis_chunk(v_run, 1);
    exit when (v_result ->> 'remaining')::integer = 0 or v_guard > 40;
  end loop;
end;
$$;

select extensions.is(
  (select status from public.recovery_group_stats
    where group_id = '34800000-0000-4000-8000-00000000000c'
      and run_id = (select id from public.recovery_analysis_runs where organization_id = '24800000-0000-4000-8000-000000000001' and trigger_source = 'backfill')),
  'ok',
  'depois da troca de midia o pico e recontado e o Filtro 2 volta a opinar'
);

select * from extensions.finish();
rollback;

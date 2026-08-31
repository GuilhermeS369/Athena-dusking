begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(21);

-- A esteira e o acompanhamento (migration 349).
--
-- Datas relativas a current_date para o teste nao envelhecer. As metricas vao
-- de D-12 a D-1, entao o dia mais recente do conjunto e D-1, e a janela
-- efetiva termina em D-2 (mesmo descarte do dia parcial que a regua faz).
-- A medicao de cada membro comeca em D-10.
--
-- Origem: perfis em views/slot 100 -> mediana de referencia = 100. Sao 7 ate a
-- segunda entrada na esteira levar mais um; depois dela, 6.
-- Coorte:  p1 = 50 (indice 0,50, recuperado)
--          p2 = 30 (indice 0,30, parcial)
--          p3 = 10 (indice 0,10, nao recuperou)
--          p4 = so 20 posts na janela (aguardando volume)

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('14900000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'esteira-349@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('24900000-0000-4000-8000-000000000001', 'Esteira 349', 'esteira-349', '14900000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('24900000-0000-4000-8000-000000000001', '14900000-0000-4000-8000-000000000001', 'operator', '14900000-0000-4000-8000-000000000001');

insert into public.profile_groups (id, organization_id, name, description, consumption_mode, created_by, recovery_enabled) values
  ('34900000-0000-4000-8000-000000000001', '24900000-0000-4000-8000-000000000001', 'GG TESTE', 'origem', 'reusable', '14900000-0000-4000-8000-000000000001', true),
  ('34900000-0000-4000-8000-000000000002', '24900000-0000-4000-8000-000000000001', 'Outro grupo', null, 'single_use', '14900000-0000-4000-8000-000000000001', false),
  -- Nome de 120 caracteres: o limite exato do check em profile_groups.
  ('34900000-0000-4000-8000-000000000003', '24900000-0000-4000-8000-000000000001', repeat('N', 120), null, 'single_use', '14900000-0000-4000-8000-000000000001', true);

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
)
select
  ('a4900000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '24900000-0000-4000-8000-000000000001',
  'ig-349-' || n, 'perfil' || n, 'token', 'online',
  '14900000-0000-4000-8000-000000000001'
from generate_series(1, 13) n;

insert into public.profile_group_members (organization_id, group_id, profile_id, added_by)
select '24900000-0000-4000-8000-000000000001',
       case when n = 11 then '34900000-0000-4000-8000-000000000002'
            when n = 13 then '34900000-0000-4000-8000-000000000003'
            else '34900000-0000-4000-8000-000000000001' end::uuid,
       ('a4900000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
       '14900000-0000-4000-8000-000000000001'
from generate_series(1, 13) n;

-- Origem (p5..p10 e p12) em 100 views/slot; coorte em 50, 30 e 10.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '24900000-0000-4000-8000-000000000001',
       ('a4900000-0000-4000-8000-' || lpad(v.n::text, 12, '0'))::uuid,
       'zernio', d::date, 10, v.views_day
from (values
  (1, 500), (2, 300), (3, 100),
  (5, 1000), (6, 1000), (7, 1000), (8, 1000), (9, 1000), (10, 1000), (12, 1000)
) as v(n, views_day)
cross join generate_series(current_date - 12, current_date - 1, interval '1 day') d
where not (v.n = 1 and d::date = current_date - 11);

-- p1 tem um dia ANTES do inicio da medicao com views absurdas. Se o corte por
-- measurement_start_on nao fosse respeitado, o indice dele explodiria.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
values ('24900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000001',
        'zernio', current_date - 11, 10, 100000);

-- p4: so dois dias dentro da janela -> amostra curta.
insert into public.profile_analytics_daily_metrics (
  organization_id, profile_id, provider, metric_date, posts, views)
select '24900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000004',
       'zernio', d::date, 10, 500
from generate_series(current_date - 3, current_date - 2, interval '1 day') d;

-- Posts de p1 para a taxa de zerados. Dos sete, so cinco podem ser medidos:
-- o 'pending' e "nao sei", e o de duas horas atras tem 0 view por definicao.
-- A tabela exige ao menos um identificador de post (zernio, plataforma ou item
-- de publicacao); aqui basta o da plataforma.
insert into public.profile_post_analytics_snapshots (
  organization_id, profile_id, provider, platform_post_id, views, sync_status, published_at)
values
  ('24900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000001', 'zernio', 'post-349-1',0,   'synced',  now() - interval '5 days'),
  ('24900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000001', 'zernio', 'post-349-2',0,   'synced',  now() - interval '5 days'),
  ('24900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000001', 'zernio', 'post-349-3',0,   'synced',  now() - interval '5 days'),
  ('24900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000001', 'zernio', 'post-349-4',100, 'synced',  now() - interval '5 days'),
  ('24900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000001', 'zernio', 'post-349-5',100, 'synced',  now() - interval '5 days'),
  ('24900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000001', 'zernio', 'post-349-6',0,   'pending', now() - interval '5 days'),
  ('24900000-0000-4000-8000-000000000001', 'a4900000-0000-4000-8000-000000000001', 'zernio', 'post-349-7',0,   'synced',  now() - interval '2 hours');

set local role authenticated;
set local request.jwt.claim.sub = '14900000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

-- Entrada na esteira --------------------------------------------------------

create temporary table t_enter as
select public.enter_recovery_cohort(
  '24900000-0000-4000-8000-000000000001'::uuid,
  '34900000-0000-4000-8000-000000000001'::uuid,
  array['a4900000-0000-4000-8000-000000000001',
        'a4900000-0000-4000-8000-000000000002',
        'a4900000-0000-4000-8000-000000000003',
        'a4900000-0000-4000-8000-000000000004',
        -- Este esta em outro grupo: tem de voltar em skippedProfileIds em vez
        -- de ser movido em silencio.
        'a4900000-0000-4000-8000-000000000011']::uuid[]
) as r;

select extensions.is(
  (select name from public.profile_groups
    where recovery_source_group_id = '34900000-0000-4000-8000-000000000001'),
  'GG TESTE rec',
  'a esteira nasce com o nome do grupo de origem mais " rec"'
);
select extensions.is(
  (select consumption_mode::text from public.profile_groups
    where recovery_source_group_id = '34900000-0000-4000-8000-000000000001'),
  'reusable',
  'a esteira herda o modo de consumo da origem'
);
select extensions.is(
  (select jsonb_array_length(r -> 'cohortMemberIds') from t_enter),
  4,
  'os quatro perfis da origem entraram na esteira'
);
select extensions.is(
  (select r -> 'skippedProfileIds' from t_enter),
  '["a4900000-0000-4000-8000-000000000011"]'::jsonb,
  'perfil que nao estava na origem volta como ignorado, nao como sucesso'
);
select extensions.is(
  (select count(*)::integer from public.profile_group_members
    where group_id = '34900000-0000-4000-8000-000000000001'),
  7,
  'os movidos sairam da origem: sobram os sete que formam a mediana'
);

-- Segunda chamada reusa a esteira em vez de partir a coorte em duas.
create temporary table t_again as
select public.enter_recovery_cohort(
  '24900000-0000-4000-8000-000000000001'::uuid,
  '34900000-0000-4000-8000-000000000001'::uuid,
  array['a4900000-0000-4000-8000-000000000005']::uuid[]
) as r;

select extensions.is(
  (select (r ->> 'created')::boolean from t_again),
  false,
  'a segunda entrada reusa a esteira existente'
);
select extensions.is(
  (select count(*)::integer from public.profile_groups
    where recovery_source_group_id = '34900000-0000-4000-8000-000000000001'
      and deleted_at is null),
  1,
  'existe uma unica esteira por grupo de origem'
);

-- Nome de 120 caracteres: sem o truncamento em 116 o check estouraria.
select extensions.lives_ok(
  $$select public.enter_recovery_cohort(
      '24900000-0000-4000-8000-000000000001'::uuid,
      '34900000-0000-4000-8000-000000000003'::uuid,
      array['a4900000-0000-4000-8000-000000000013']::uuid[])$$,
  'origem com nome no limite de 120 caracteres nao quebra a entrada'
);
select extensions.is(
  (select char_length(name) from public.profile_groups
    where recovery_source_group_id = '34900000-0000-4000-8000-000000000003'),
  120,
  'o nome da esteira e truncado para caber no limite'
);

-- Acompanhamento ------------------------------------------------------------

reset role;

-- Recua a entrada para a janela de metricas existir. O check
-- measurement_start_on >= entered_on continua valendo.
update public.recovery_cohort_members
   set entered_on = current_date - 10,
       measurement_start_on = current_date - 10
 where organization_id = '24900000-0000-4000-8000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = '14900000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

select public.refresh_recovery_cohort_observations('24900000-0000-4000-8000-000000000001'::uuid);

select extensions.is(
  (select o.origin_profiles from public.recovery_cohort_observations o
     join public.recovery_cohort_members m on m.id = o.cohort_member_id
    where m.profile_id = 'a4900000-0000-4000-8000-000000000001'),
  6,
  'a mediana de referencia sai so dos perfis que ficaram na origem'
);
select extensions.is(
  (select round(o.vs_since, 2) from public.recovery_cohort_observations o
     join public.recovery_cohort_members m on m.id = o.cohort_member_id
    where m.profile_id = 'a4900000-0000-4000-8000-000000000001'),
  50.00::numeric,
  'o dia anterior ao inicio da medicao fica de fora, mesmo existindo no banco'
);
select extensions.is(
  (select round(o.recovery_index, 2) from public.recovery_cohort_observations o
     join public.recovery_cohort_members m on m.id = o.cohort_member_id
    where m.profile_id = 'a4900000-0000-4000-8000-000000000001'),
  0.50::numeric,
  'o indice compara o perfil com a mediana da origem nos MESMOS dias'
);
select extensions.is(
  (select o.verdict from public.recovery_cohort_observations o
     join public.recovery_cohort_members m on m.id = o.cohort_member_id
    where m.profile_id = 'a4900000-0000-4000-8000-000000000001'),
  'recovered',
  'acima do corte aberto o perfil esta recuperado'
);
select extensions.is(
  (select o.verdict from public.recovery_cohort_observations o
     join public.recovery_cohort_members m on m.id = o.cohort_member_id
    where m.profile_id = 'a4900000-0000-4000-8000-000000000002'),
  'partial',
  'entre os dois cortes o veredito e parcial'
);
select extensions.is(
  (select o.verdict from public.recovery_cohort_observations o
     join public.recovery_cohort_members m on m.id = o.cohort_member_id
    where m.profile_id = 'a4900000-0000-4000-8000-000000000003'),
  'not_recovered',
  'abaixo do corte apertado o perfil nao recuperou'
);
select extensions.is(
  (select o.verdict from public.recovery_cohort_observations o
     join public.recovery_cohort_members m on m.id = o.cohort_member_id
    where m.profile_id = 'a4900000-0000-4000-8000-000000000004'),
  'short_sample',
  'sem volume o veredito espera em vez de mentir'
);
select extensions.is(
  (select array[o.measured_posts, o.zero_view_posts]
     from public.recovery_cohort_observations o
     join public.recovery_cohort_members m on m.id = o.cohort_member_id
    where m.profile_id = 'a4900000-0000-4000-8000-000000000001'),
  array[5, 3],
  'post nao coletado e post de menos de 24h ficam fora da taxa de zerados'
);

-- Saida ---------------------------------------------------------------------

select public.return_from_recovery_cohort(
  '24900000-0000-4000-8000-000000000001'::uuid,
  array[(select id from public.recovery_cohort_members
          where profile_id = 'a4900000-0000-4000-8000-000000000001')]::uuid[],
  'recovered', 'voltou a entregar');

select extensions.is(
  (select array[status, exit_decision] from public.recovery_cohort_members
    where profile_id = 'a4900000-0000-4000-8000-000000000001'),
  array['returned', 'recovered'],
  'a saida registra a decisao do operador'
);
select extensions.ok(
  exists (select 1 from public.profile_group_members
           where group_id = '34900000-0000-4000-8000-000000000001'
             and profile_id = 'a4900000-0000-4000-8000-000000000001'),
  'devolver leva o perfil de volta ao grupo de origem'
);

-- Exclusao vira registro ----------------------------------------------------

select public.record_recovery_cohort_deletion(
  '24900000-0000-4000-8000-000000000001'::uuid,
  array['a4900000-0000-4000-8000-000000000012',
        'a4900000-0000-4000-8000-000000000003']::uuid[]);

select extensions.is(
  (select array[entry_reason, status, exit_decision]
     from public.recovery_cohort_members
    where profile_id = 'a4900000-0000-4000-8000-000000000012'),
  array['direct_delete', 'removed', 'deleted'],
  'excluir da aba Elegiveis, sem passar pela esteira, ainda vira historico'
);
select extensions.is(
  (select array[status, exit_decision] from public.recovery_cohort_members
    where profile_id = 'a4900000-0000-4000-8000-000000000003'),
  array['removed', 'deleted'],
  'quem estava na esteira tem a passagem encerrada, nao duplicada'
);

select * from extensions.finish();
rollback;

begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(7);

-- Captura automática do marco de troca de mídia (migration 352).
--
-- O que este teste protege:
--   - só grupo que a tela de Recuperação enxerga vira marco (senão toda
--     atribuição de mídia da organização viraria marcador sem significado);
--   - duas levas no mesmo dia SOMAM em vez de virar dois marcadores dizendo a
--     mesma coisa;
--   - o tipo da leva fica 'unknown', porque o sistema não tem como distinguir
--     mídia reprocessada de mídia fresca — inventar 'common' seria pior.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('15200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'marco-352@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by)
values ('25200000-0000-4000-8000-000000000001', 'Marco 352', 'marco-352', '15200000-0000-4000-8000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('25200000-0000-4000-8000-000000000001', '15200000-0000-4000-8000-000000000001', 'operator', '15200000-0000-4000-8000-000000000001');

insert into public.profile_groups (id, organization_id, name, created_by, recovery_enabled) values
  -- ligado para a analise: ganha marco
  ('35200000-0000-4000-8000-000000000001', '25200000-0000-4000-8000-000000000001', 'GG ANALISE', '15200000-0000-4000-8000-000000000001', true),
  -- grupo comum, sem recuperacao: NAO ganha marco
  ('35200000-0000-4000-8000-000000000002', '25200000-0000-4000-8000-000000000001', 'GG COMUM', '15200000-0000-4000-8000-000000000001', false);

-- esteira: ganha marco mesmo com recovery_enabled = false
insert into public.profile_groups (id, organization_id, name, created_by, recovery_source_group_id)
values ('35200000-0000-4000-8000-000000000003', '25200000-0000-4000-8000-000000000001', 'GG ANALISE rec', '15200000-0000-4000-8000-000000000001', '35200000-0000-4000-8000-000000000001');

set local role authenticated;
set local request.jwt.claim.sub = '15200000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

-- Primeira leva: 20 mídias para os três grupos de uma vez.
select extensions.is(
  public.record_auto_media_milestones(
    '25200000-0000-4000-8000-000000000001'::uuid,
    array['35200000-0000-4000-8000-000000000001',
          '35200000-0000-4000-8000-000000000002',
          '35200000-0000-4000-8000-000000000003']::uuid[],
    20),
  2,
  'só o grupo em análise e a esteira viram marco; o grupo comum fica de fora'
);

select extensions.ok(
  not exists (select 1 from public.recovery_media_milestones
               where group_id = '35200000-0000-4000-8000-000000000002'),
  'atribuir mídia a grupo sem recuperação não polui o gráfico com marcador'
);

select extensions.is(
  (select array[batch_kind, source] from public.recovery_media_milestones
    where group_id = '35200000-0000-4000-8000-000000000001'),
  array['unknown', 'auto'],
  'a captura automática não inventa o tipo da leva'
);

-- Segunda leva no mesmo dia: soma, não duplica.
select extensions.is(
  public.record_auto_media_milestones(
    '25200000-0000-4000-8000-000000000001'::uuid,
    array['35200000-0000-4000-8000-000000000001']::uuid[],
    16),
  1,
  'a segunda leva do dia é aceita'
);

select extensions.is(
  (select count(*)::integer from public.recovery_media_milestones
    where group_id = '35200000-0000-4000-8000-000000000001'),
  1,
  'duas levas no mesmo dia continuam sendo UM marcador'
);

select extensions.is(
  (select media_count from public.recovery_media_milestones
    where group_id = '35200000-0000-4000-8000-000000000001'),
  36,
  'as levas do dia somam: 20 + 16'
);

-- O registro manual continua podendo coexistir com o automático no mesmo dia:
-- o índice único é parcial, só para `source = 'auto'`.
select extensions.lives_ok(
  $$insert into public.recovery_media_milestones (
      organization_id, group_id, happened_on, media_count, batch_kind)
    values ('25200000-0000-4000-8000-000000000001', '35200000-0000-4000-8000-000000000001',
            (timezone('America/Sao_Paulo', now()))::date, 12, 'reprocessed')$$,
  'um marco manual no mesmo dia não colide com o automático'
);

select * from extensions.finish();
rollback;

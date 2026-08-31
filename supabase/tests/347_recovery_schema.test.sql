begin;

create extension if not exists pgtap with schema extensions;
select extensions.plan(16);

-- Schema da tela de Recuperacao (migration 347).
--
-- O que este teste protege, em ordem de gravidade:
--   - a esteira nao pode se partir em duas (uma esteira por origem);
--   - um perfil nao pode estar em duas esteiras ao mesmo tempo, mas PODE
--     reentrar depois de sair;
--   - o registro do historico sobrevive a exclusao do perfil — e o caso da
--     recuperacao que falhou, o mais importante de lembrar;
--   - a tela nao pode fabricar um veredito: nenhuma tabela de snapshot ou de
--     coorte aceita escrita de `authenticated`.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  ('14700000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'rec-347@example.com', '', now(), now(), now()),
  ('14700000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fora-347@example.com', '', now(), now(), now());

insert into public.organizations (id, name, slug, created_by) values
  ('24700000-0000-4000-8000-000000000001', 'Recuperacao 347', 'recuperacao-347', '14700000-0000-4000-8000-000000000001'),
  ('24700000-0000-4000-8000-000000000002', 'Vizinha 347', 'vizinha-347', '14700000-0000-4000-8000-000000000002');

insert into public.organization_members (organization_id, user_id, role, invited_by) values
  ('24700000-0000-4000-8000-000000000001', '14700000-0000-4000-8000-000000000001', 'operator', '14700000-0000-4000-8000-000000000001'),
  ('24700000-0000-4000-8000-000000000002', '14700000-0000-4000-8000-000000000002', 'admin', '14700000-0000-4000-8000-000000000002');

-- Grupo de origem e a esteira dele.
insert into public.profile_groups (id, organization_id, name, created_by, recovery_enabled) values
  ('34700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001', 'GG TESTE', '14700000-0000-4000-8000-000000000001', true);

insert into public.profile_groups (id, organization_id, name, created_by, recovery_source_group_id) values
  ('34700000-0000-4000-8000-000000000002', '24700000-0000-4000-8000-000000000001', 'GG TESTE rec', '14700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000001');

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by
) values
  ('44700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001', 'ig-347-a', 'perfil_a', 'token', 'online', '14700000-0000-4000-8000-000000000001'),
  ('44700000-0000-4000-8000-000000000002', '24700000-0000-4000-8000-000000000001', 'ig-347-b', 'perfil_b', 'token', 'online', '14700000-0000-4000-8000-000000000001');

-- ---------------------------------------------------------------------------
-- Restricoes estruturais (como superusuario: CHECK e UNIQUE valem para todos)
-- ---------------------------------------------------------------------------

select extensions.throws_ok(
  $$update public.profile_groups
      set recovery_source_group_id = id
    where id = '34700000-0000-4000-8000-000000000002'$$,
  '23514',
  null,
  'um grupo nao pode ser a esteira de si mesmo'
);

select extensions.throws_ok(
  $$insert into public.profile_groups (organization_id, name, created_by, recovery_source_group_id)
    values ('24700000-0000-4000-8000-000000000001', 'GG TESTE rec 2',
            '14700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000001')$$,
  '23505',
  null,
  'uma esteira por origem: o segundo "rec" do mesmo grupo e recusado'
);

-- Uma execucao viva por organizacao (defesa contra cron e botao competindo).
insert into public.recovery_analysis_runs (
  id, organization_id, trigger_source, window_days, discard_recent_days,
  min_posts_judgeable, recent_window_posts, never_started_ratio, never_started_ratio_alt,
  collapsed_ratio, health_gate_ratio, min_judgeable_profiles, min_profiles_per_day, max_staleness_days
) values (
  '54700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001', 'cron', 30, 1,
  60, 60, 0.25, 0.40, 0.25, 0.60, 5, 3, 2
);

select extensions.throws_ok(
  $$insert into public.recovery_analysis_runs (
      organization_id, trigger_source, window_days, discard_recent_days,
      min_posts_judgeable, recent_window_posts, never_started_ratio, never_started_ratio_alt,
      collapsed_ratio, health_gate_ratio, min_judgeable_profiles, min_profiles_per_day, max_staleness_days
    ) values (
      '24700000-0000-4000-8000-000000000001', 'manual', 30, 1,
      60, 60, 0.25, 0.40, 0.25, 0.60, 5, 3, 2)$$,
  '23505',
  null,
  'so uma execucao viva por organizacao'
);

select extensions.throws_ok(
  $$insert into public.recovery_analysis_runs (
      organization_id, trigger_source, window_days, discard_recent_days,
      min_posts_judgeable, recent_window_posts, never_started_ratio, never_started_ratio_alt,
      collapsed_ratio, health_gate_ratio, min_judgeable_profiles, min_profiles_per_day, max_staleness_days
    ) values (
      '24700000-0000-4000-8000-000000000002', 'manual', 30, 1,
      60, 60, 0.40, 0.25, 0.25, 0.60, 5, 3, 2)$$,
  '23514',
  null,
  'o ajuste apertado nao pode ser maior que o frouxo'
);

-- Coorte -------------------------------------------------------------------

insert into public.recovery_cohort_members (
  id, organization_id, profile_id, username_at_entry, source_group_id, recovery_group_id,
  entered_on, measurement_start_on, entry_reason
) values (
  '64700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001',
  '44700000-0000-4000-8000-000000000001', 'perfil_a',
  '34700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000002',
  '2026-08-20', '2026-08-21', 'never_started'
);

select extensions.throws_ok(
  $$insert into public.recovery_cohort_members (
      organization_id, profile_id, username_at_entry, source_group_id, recovery_group_id,
      entered_on, measurement_start_on, entry_reason
    ) values (
      '24700000-0000-4000-8000-000000000001', '44700000-0000-4000-8000-000000000001', 'perfil_a',
      '34700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000002',
      '2026-08-25', '2026-08-26', 'collapsed')$$,
  '23505',
  null,
  'um perfil ativo na esteira por vez'
);

select extensions.throws_ok(
  $$insert into public.recovery_cohort_members (
      organization_id, profile_id, username_at_entry, source_group_id, recovery_group_id,
      entered_on, measurement_start_on, entry_reason
    ) values (
      '24700000-0000-4000-8000-000000000001', '44700000-0000-4000-8000-000000000002', 'perfil_b',
      '34700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000002',
      '2026-08-25', '2026-08-24', 'collapsed')$$,
  '23514',
  null,
  'a medicao nao pode comecar antes da entrada'
);

select extensions.throws_ok(
  $$insert into public.recovery_cohort_members (
      organization_id, profile_id, username_at_entry, source_group_id, recovery_group_id,
      entered_on, measurement_start_on, entry_reason, exit_at
    ) values (
      '24700000-0000-4000-8000-000000000001', '44700000-0000-4000-8000-000000000002', 'perfil_b',
      '34700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000002',
      '2026-08-25', '2026-08-26', 'collapsed', now())$$,
  '23514',
  null,
  'membro ativo nao pode ter saida registrada'
);

-- Saida libera a reentrada.
update public.recovery_cohort_members
   set status = 'returned', exit_at = now(), exit_decision = 'recovered', exit_index = 0.66
 where id = '64700000-0000-4000-8000-000000000001';

select extensions.lives_ok(
  $$insert into public.recovery_cohort_members (
      organization_id, profile_id, username_at_entry, source_group_id, recovery_group_id,
      entered_on, measurement_start_on, entry_reason
    ) values (
      '24700000-0000-4000-8000-000000000001', '44700000-0000-4000-8000-000000000001', 'perfil_a',
      '34700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000002',
      '2026-08-28', '2026-08-29', 'collapsed')$$,
  'depois de sair, o perfil pode reentrar na esteira'
);

-- O historico sobrevive a exclusao do perfil: e o caso da recuperacao que
-- falhou, justamente o que nao pode sumir do registro.
delete from public.instagram_profiles where id = '44700000-0000-4000-8000-000000000001';

select extensions.is(
  (select count(*)::integer from public.recovery_cohort_members
    where profile_id = '44700000-0000-4000-8000-000000000001'),
  2,
  'o registro da coorte sobrevive a exclusao do perfil'
);

select extensions.is(
  (select username_at_entry from public.recovery_cohort_members
    where id = '64700000-0000-4000-8000-000000000001'),
  'perfil_a',
  'o nome de usuario na entrada continua legivel depois da exclusao'
);

-- Marcos e midia ------------------------------------------------------------

select extensions.throws_ok(
  $$insert into public.recovery_media_milestones (organization_id, group_id, happened_on, media_count, batch_kind)
    values ('24700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000002',
            '2026-08-30', 36, 'mista')$$,
  '23514',
  null,
  'a leva e comum ou reprocessada; nao ha terceiro valor'
);

insert into public.media_assets (
  id, organization_id, uploaded_by, storage_path, original_name,
  mime_type, kind, size_bytes, checksum_sha256
) values (
  '74700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001',
  '14700000-0000-4000-8000-000000000001', 'org/347/a.mp4', 'a.mp4',
  'video/mp4', 'video', 1024, repeat('a', 64)
);

select extensions.throws_ok(
  $$update public.media_assets set content_origin = 'refeita'
     where id = '74700000-0000-4000-8000-000000000001'$$,
  '23514',
  null,
  'content_origin so aceita common ou reprocessed'
);

-- ---------------------------------------------------------------------------
-- RLS e grants: a tela le, mas nao fabrica veredito
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = '14700000-0000-4000-8000-000000000001';
set local request.jwt.claim.role = 'authenticated';

select extensions.is(
  (select count(*)::integer from public.recovery_analysis_runs),
  1,
  'membro da organizacao le a execucao'
);

select extensions.throws_ok(
  $$insert into public.recovery_candidates (
      run_id, organization_id, group_id, profile_id, reason, severity,
      posts_total, views_total, vs, best_day_vs)
    values ('54700000-0000-4000-8000-000000000001', '24700000-0000-4000-8000-000000000001',
            '34700000-0000-4000-8000-000000000001', '44700000-0000-4000-8000-000000000002',
            'never_started', 'severe', 200, 100, 0.5, 1.0)$$,
  '42501',
  null,
  'a tela nao consegue inventar um candidato'
);

select extensions.throws_ok(
  $$update public.recovery_cohort_members set exit_decision = 'recovered'
     where id = '64700000-0000-4000-8000-000000000001'$$,
  '42501',
  null,
  'a tela nao consegue reescrever o veredito de saida'
);

select extensions.lives_ok(
  $$insert into public.recovery_media_milestones (organization_id, group_id, happened_on, media_count, batch_kind)
    values ('24700000-0000-4000-8000-000000000001', '34700000-0000-4000-8000-000000000002',
            '2026-08-30', 36, 'reprocessed')$$,
  'o operador registra o marco de midia a mao'
);

select * from extensions.finish();
rollback;

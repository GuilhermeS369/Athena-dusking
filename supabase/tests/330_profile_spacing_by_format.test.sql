-- Cobre o espaçamento por formato da migration 330.
--
-- Os três cenários que precisam estar certos, nesta ordem de importância:
--
-- 1. Reel bloqueia reel do mesmo perfil dentro da janela — inclusive quando o
--    anterior AINDA NÃO tem published_at (já foi ao ar pelo publishNow, mas o
--    polling não confirmou). Era esse buraco que produzia intervalos de 0 min.
-- 2. Story NÃO é bloqueada por reel recente. Formatos são trilhas separadas;
--    misturar adiaria 3.846 publicações corretas em 48h.
-- 3. O cooldown é POR PERFIL: o perfil B publica normalmente enquanto o A espera.

begin;

select plan(11);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('33000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'spacing330@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('33000000-0000-0000-0000-000000000002', 'Spacing 330', 'spacing-330', '33000000-0000-0000-0000-000000000001');

insert into public.organization_members (organization_id, user_id, role, invited_by)
values ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000001', 'admin', '33000000-0000-0000-0000-000000000001');

-- Perfil A (onde as colisões acontecem) e perfil B (prova do isolamento).
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider)
values
  ('33000000-0000-0000-0000-00000000000a', '33000000-0000-0000-0000-000000000002', 'spacing-330-a', 'spacing_330_a', 'synthetic-token', 'online', '33000000-0000-0000-0000-000000000001', 'meta_official'),
  ('33000000-0000-0000-0000-00000000000b', '33000000-0000-0000-0000-000000000002', 'spacing-330-b', 'spacing_330_b', 'synthetic-token', 'online', '33000000-0000-0000-0000-000000000001', 'meta_official');

insert into public.publication_batches (id, organization_id, created_by, name, status, review_confirmed_at)
values ('33000000-0000-0000-0000-000000000004', '33000000-0000-0000-0000-000000000002',
  '33000000-0000-0000-0000-000000000001', 'Lote 330', 'processing', timezone('utc', now()));

-- Helper: cria um item já sob lease do worker, pronto para reservar capacidade.
create or replace function pg_temp.claimed_item(
  p_id uuid, p_profile uuid, p_format public.publication_format, p_key text
) returns void language plpgsql as $$
begin
  insert into public.publication_items (
    id, organization_id, batch_id, profile_id, format, status, execute_at,
    idempotency_key, claimed_by, lease_until
  ) values (
    p_id, '33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000004',
    p_profile, p_format, 'preparing', timezone('utc', now()) - interval '1 minute',
    p_key, 'spacing-330-worker', timezone('utc', now()) + interval '10 minutes'
  );
end;
$$;

set local role service_role;

-- ---------------------------------------------------------------------------
-- 1. Reel bloqueado por reel confirmado recente
-- ---------------------------------------------------------------------------
insert into public.publication_items (
  organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, published_at
) values (
  '33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000004',
  '33000000-0000-0000-0000-00000000000a', 'reel', 'published',
  timezone('utc', now()) - interval '20 minutes', 'spacing-330-reel-publicado',
  timezone('utc', now()) - interval '10 minutes'
);

select pg_temp.claimed_item('33000000-0000-0000-0000-0000000000c1', '33000000-0000-0000-0000-00000000000a', 'reel', 'spacing-330-reel-bloqueado');

-- A função é destrutiva por desenho: ao negar, ela devolve o item para
-- `waiting` e solta o lease. Por isso o resultado é capturado numa chamada só —
-- uma segunda chamada no mesmo item falharia com "não está sob lease".
create temporary table reserva_bloqueada_330 on commit drop as
select * from public.reserve_publication_dispatch_capacity('33000000-0000-0000-0000-0000000000c1', 'spacing-330-worker');

select is(
  (select allowed from reserva_bloqueada_330),
  false,
  'reel a 10 min de um reel publicado é negado (janela de 25 min)'
);

select is(
  (select reason from reserva_bloqueada_330),
  'profile_min_interval',
  'o motivo do adiamento é o intervalo mínimo do perfil'
);

select ok(
  (select next_attempt_at from reserva_bloqueada_330) > timezone('utc', now()),
  'o item recebe próxima tentativa no futuro, em vez de ser perdido'
);

select is(
  (select status from public.publication_items where id = '33000000-0000-0000-0000-0000000000c1'),
  'waiting'::public.publication_item_status,
  'o item volta para waiting — adiado, não descartado'
);

select is(
  (select attempt_count from public.publication_items where id = '33000000-0000-0000-0000-0000000000c1'),
  0,
  'adiar NÃO consome tentativa — o item não corre risco de esgotar retries esperando'
);

-- ---------------------------------------------------------------------------
-- 2. Story NÃO é bloqueada pelo reel recente do mesmo perfil
-- ---------------------------------------------------------------------------
select pg_temp.claimed_item('33000000-0000-0000-0000-0000000000c2', '33000000-0000-0000-0000-00000000000a', 'story', 'spacing-330-story-livre');

select is(
  (select allowed from public.reserve_publication_dispatch_capacity('33000000-0000-0000-0000-0000000000c2', 'spacing-330-worker')),
  true,
  'story NÃO é bloqueada por reel recente — formatos são trilhas separadas'
);

-- ---------------------------------------------------------------------------
-- 3. O cooldown é por perfil: o perfil B não sofre com o cooldown do A
-- ---------------------------------------------------------------------------
select pg_temp.claimed_item('33000000-0000-0000-0000-0000000000c3', '33000000-0000-0000-0000-00000000000b', 'reel', 'spacing-330-reel-outro-perfil');

select is(
  (select allowed from public.reserve_publication_dispatch_capacity('33000000-0000-0000-0000-0000000000c3', 'spacing-330-worker')),
  true,
  'perfil B publica normalmente enquanto o perfil A está em cooldown'
);

-- ---------------------------------------------------------------------------
-- 4. O buraco principal: reel enviado ao provedor mas AINDA SEM published_at
-- ---------------------------------------------------------------------------
-- É o caso que produzia intervalos de 0 minuto: o publishNow já pôs o post no ar,
-- mas o published_at só aparece 2+ min depois, quando o polling confirma.
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider)
values ('33000000-0000-0000-0000-00000000000c', '33000000-0000-0000-0000-000000000002', 'spacing-330-c', 'spacing_330_c', 'synthetic-token', 'online', '33000000-0000-0000-0000-000000000001', 'meta_official');

insert into public.publication_items (
  organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key,
  creation_id, provider_creation_started_at
) values (
  '33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000004',
  '33000000-0000-0000-0000-00000000000c', 'reel', 'publishing',
  timezone('utc', now()) - interval '3 minutes', 'spacing-330-reel-em-voo',
  'zernio-creation-330', timezone('utc', now()) - interval '2 minutes'
);

select pg_temp.claimed_item('33000000-0000-0000-0000-0000000000c4', '33000000-0000-0000-0000-00000000000c', 'reel', 'spacing-330-reel-apos-em-voo');

select is(
  (select allowed from public.reserve_publication_dispatch_capacity('33000000-0000-0000-0000-0000000000c4', 'spacing-330-worker')),
  false,
  'reel é negado por outro reel JÁ ENVIADO ao provedor e ainda sem published_at'
);

-- ---------------------------------------------------------------------------
-- 5. Reel fora da janela passa normalmente
-- ---------------------------------------------------------------------------
insert into public.instagram_profiles (id, organization_id, instagram_user_id, username, encrypted_access_token, status, created_by, provider)
values ('33000000-0000-0000-0000-00000000000d', '33000000-0000-0000-0000-000000000002', 'spacing-330-d', 'spacing_330_d', 'synthetic-token', 'online', '33000000-0000-0000-0000-000000000001', 'meta_official');

insert into public.publication_items (
  organization_id, batch_id, profile_id, format, status, execute_at, idempotency_key, published_at
) values (
  '33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000004',
  '33000000-0000-0000-0000-00000000000d', 'reel', 'published',
  timezone('utc', now()) - interval '90 minutes', 'spacing-330-reel-antigo',
  timezone('utc', now()) - interval '60 minutes'
);

select pg_temp.claimed_item('33000000-0000-0000-0000-0000000000c5', '33000000-0000-0000-0000-00000000000d', 'reel', 'spacing-330-reel-liberado');

select is(
  (select allowed from public.reserve_publication_dispatch_capacity('33000000-0000-0000-0000-0000000000c5', 'spacing-330-worker')),
  true,
  'reel 60 min depois do anterior passa — a cadência normal não é afetada'
);

-- ---------------------------------------------------------------------------
-- 6. Configuração
-- ---------------------------------------------------------------------------
select is(
  (select (min_seconds_between_profile_publications_by_format ->> 'reel')::integer
   from public.publication_rate_limit_settings
   where organization_id is null and provider = 'zernio'),
  1500,
  'o padrão global para reel é 25 minutos (menor que os 30 do plano, para não cascatear)'
);

select ok(
  (select min_seconds_between_profile_publications_by_format ->> 'story'
   from public.publication_rate_limit_settings
   where organization_id is null and provider = 'zernio') is null,
  'story não recebe valor por formato — cai no escalar de 45s, nunca atingido'
);

select * from finish();

rollback;

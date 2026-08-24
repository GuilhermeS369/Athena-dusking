-- Capacidade transacional da esteira v2. Nenhuma API externa é chamada e o
-- rollback final remove todos os 1.500 perfis/itens sintéticos.

begin;

select plan(9);

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('26500000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'pipeline265@example.com', '', timezone('utc', now()), timezone('utc', now()), timezone('utc', now()));

insert into public.organizations (id, name, slug, created_by)
values ('26500000-0000-0000-0000-000000000002', 'Pipeline v2 capacity', 'pipeline-v2-capacity-265', '26500000-0000-0000-0000-000000000001');

insert into public.instagram_profiles (
  id, organization_id, instagram_user_id, username, encrypted_access_token,
  status, created_by, provider, capabilities
)
select gen_random_uuid(), '26500000-0000-0000-0000-000000000002',
  'capacity-' || profile_number, 'capacity_' || profile_number, 'synthetic-token',
  'offline', '26500000-0000-0000-0000-000000000001', 'meta_official',
  jsonb_build_object('synthetic', true, 'profileNumber', profile_number)
from generate_series(1, 1500) profile_number;

insert into public.publication_batches (id, organization_id, created_by, name, status, scheduled_for, review_confirmed_at)
values
  ('26500000-0000-0000-0000-000000000003', '26500000-0000-0000-0000-000000000002', '26500000-0000-0000-0000-000000000001', 'Mesmo slot 500 perfis', 'queued', timezone('utc', now()) - interval '3 minutes', timezone('utc', now())),
  ('26500000-0000-0000-0000-000000000004', '26500000-0000-0000-0000-000000000002', '26500000-0000-0000-0000-000000000001', 'Mesmo slot 1000 perfis', 'queued', timezone('utc', now()) - interval '3 minutes', timezone('utc', now()));

insert into public.publication_items (
  organization_id, batch_id, profile_id, format, status, execute_at, caption,
  idempotency_key, pipeline_version, preparation_status, prepared_at
)
select profile.organization_id,
  case when (profile.capabilities ->> 'profileNumber')::integer <= 500
    then '26500000-0000-0000-0000-000000000003'::uuid
    else '26500000-0000-0000-0000-000000000004'::uuid end,
  profile.id,
  case when (profile.capabilities ->> 'profileNumber')::integer % 2 = 0 then 'story'::public.publication_format else 'reel'::public.publication_format end,
  'ready', timezone('utc', now()) - interval '3 minutes', 'Sintético; não enviar ao provedor',
  'capacity-265-' || profile.id, 2, 'ready', timezone('utc', now())
from public.instagram_profiles profile
where profile.organization_id = '26500000-0000-0000-0000-000000000002';

select is((select count(*)::bigint from public.publication_items where batch_id = '26500000-0000-0000-0000-000000000003'), 500::bigint,
  'cenário de 500 perfis foi materializado no mesmo slot');
select is((select count(*)::bigint from public.publication_items where batch_id = '26500000-0000-0000-0000-000000000004'), 1000::bigint,
  'cenário de 1000 perfis foi materializado no mesmo slot');

do $$
begin
  perform * from public.recover_missed_publication_slots(500, 120, 'capacity-worker-265', gen_random_uuid());
  perform * from public.recover_missed_publication_slots(500, 120, 'capacity-worker-265', gen_random_uuid());
  perform * from public.recover_missed_publication_slots(500, 120, 'capacity-worker-265', gen_random_uuid());
end;
$$;

select is((select count(*)::bigint from public.publication_items where organization_id = '26500000-0000-0000-0000-000000000002' and status = 'ignored'), 0::bigint,
  'SLA acima de 120 segundos não ignora itens v2');
select is((select count(*)::bigint from public.publication_dispatch_sla_alerts where organization_id = '26500000-0000-0000-0000-000000000002' and state = 'open'), 2::bigint,
  'atraso é agregado em um alerta por lote/slot');

create temporary table claimed_capacity_265 (id uuid primary key) on commit drop;
do $$
declare
  claimed_in_cycle integer;
begin
  loop
    with claimed as (
      select id from public.claim_publication_items('capacity-worker-265', 100, 180)
    ), inserted as (
      insert into claimed_capacity_265 (id) select id from claimed on conflict do nothing returning id
    )
    select count(*) into claimed_in_cycle from inserted;
    exit when claimed_in_cycle = 0;
  end loop;
end;
$$;

select is((select count(*)::bigint from claimed_capacity_265), 1500::bigint,
  'todos os 1.500 itens foram reivindicados em páginas, sem limite total por slot');
select is((select count(distinct item.profile_id)::bigint from claimed_capacity_265 claimed join public.publication_items item using (id)), 1500::bigint,
  'todos os 1.500 perfis participaram do processamento');
select is((select count(*)::bigint from public.publication_items where organization_id = '26500000-0000-0000-0000-000000000002' and status = 'preparing'), 1500::bigint,
  'claims preservam todos os itens, sem descarte do restante');
select is((select count(*)::bigint from public.publication_items where organization_id = '26500000-0000-0000-0000-000000000002' and format = 'reel'), 750::bigint,
  'Reels e Stories dividem o cenário de capacidade');
select is((select count(*)::bigint from public.publication_items where organization_id = '26500000-0000-0000-0000-000000000002' and format = 'story'), 750::bigint,
  'Stories permanecem elegíveis no mesmo fluxo');

select * from finish();
rollback;

-- Congela as últimas métricas locais no instante em que a queda é registrada.
-- O trigger centraliza a captura para todos os fluxos de incidente (publicação,
-- sincronia e duplicidade), sem alterar a lógica de reciclagem/removal existente.

alter table public.zernio_profile_disconnection_incidents
  add column if not exists analytics_followers_count_snapshot bigint,
  add column if not exists analytics_views_snapshot bigint,
  add column if not exists analytics_posts_count_snapshot integer,
  add column if not exists analytics_synced_at_snapshot timestamptz,
  add column if not exists analytics_status_snapshot public.profile_analytics_sync_status;

alter table public.zernio_profile_disconnection_incidents
  drop constraint if exists zernio_disconnection_incidents_analytics_followers_snapshot_check,
  drop constraint if exists zernio_disconnection_incidents_analytics_views_snapshot_check,
  drop constraint if exists zernio_disconnection_incidents_analytics_posts_snapshot_check;

alter table public.zernio_profile_disconnection_incidents
  add constraint zernio_disconnection_incidents_analytics_followers_snapshot_check
    check (analytics_followers_count_snapshot is null or analytics_followers_count_snapshot >= 0),
  add constraint zernio_disconnection_incidents_analytics_views_snapshot_check
    check (analytics_views_snapshot is null or analytics_views_snapshot >= 0),
  add constraint zernio_disconnection_incidents_analytics_posts_snapshot_check
    check (analytics_posts_count_snapshot is null or analytics_posts_count_snapshot >= 0);

create or replace function public.capture_zernio_disconnection_incident_analytics_snapshot()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  analytics_snapshot public.profile_analytics_snapshots%rowtype;
begin
  -- Permite uma inserção explícita por manutenção e mantém o snapshot imutável
  -- quando um incidente já existente for atualizado por um novo sinal.
  if new.analytics_followers_count_snapshot is not null
    or new.analytics_views_snapshot is not null
    or new.analytics_posts_count_snapshot is not null
    or new.analytics_synced_at_snapshot is not null
    or new.analytics_status_snapshot is not null
    or new.profile_id is null
  then
    return new;
  end if;

  select snapshot.* into analytics_snapshot
  from public.profile_analytics_snapshots snapshot
  where snapshot.organization_id = new.organization_id
    and snapshot.profile_id = new.profile_id
    and snapshot.deleted_at is null
    and snapshot.sync_status in ('synced', 'partial')
    and snapshot.synced_at is not null
  order by snapshot.synced_at desc, snapshot.period_end desc, snapshot.created_at desc
  limit 1;

  if found then
    new.analytics_followers_count_snapshot := analytics_snapshot.followers_count;
    new.analytics_views_snapshot := analytics_snapshot.views;
    new.analytics_posts_count_snapshot := analytics_snapshot.posts_count;
    new.analytics_synced_at_snapshot := analytics_snapshot.synced_at;
    new.analytics_status_snapshot := analytics_snapshot.sync_status;
  end if;

  return new;
end;
$$;

drop trigger if exists zernio_disconnection_incidents_capture_analytics_snapshot
  on public.zernio_profile_disconnection_incidents;
create trigger zernio_disconnection_incidents_capture_analytics_snapshot
before insert on public.zernio_profile_disconnection_incidents
for each row execute function public.capture_zernio_disconnection_incident_analytics_snapshot();

notify pgrst, 'reload schema';

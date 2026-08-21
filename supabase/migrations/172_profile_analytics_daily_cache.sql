-- Cache diário normalizado. A dashboard não deve depender do payload bruto de
-- uma sincronização nem transformar totais de período em métricas de um dia.

create table public.profile_analytics_daily_metrics (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,
  provider public.instagram_integration_provider not null,
  metric_date date not null,
  posts integer not null default 0 check (posts >= 0),
  impressions bigint not null default 0 check (impressions >= 0),
  reach bigint not null default 0 check (reach >= 0),
  views bigint not null default 0 check (views >= 0),
  likes bigint not null default 0 check (likes >= 0),
  comments bigint not null default 0 check (comments >= 0),
  shares bigint not null default 0 check (shares >= 0),
  saves bigint not null default 0 check (saves >= 0),
  interactions bigint not null default 0 check (interactions >= 0),
  coverage_status text not null default 'complete' check (coverage_status in ('complete', 'partial', 'unavailable')),
  source_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(source_payload) = 'object'),
  normalized_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (organization_id, profile_id, provider, metric_date)
);

create index profile_analytics_daily_metrics_org_date_idx
  on public.profile_analytics_daily_metrics (organization_id, metric_date desc, profile_id)
  where coverage_status in ('complete', 'partial');

create trigger profile_analytics_daily_metrics_set_updated_at
before update on public.profile_analytics_daily_metrics
for each row execute function public.set_updated_at();

alter table public.profile_analytics_daily_metrics enable row level security;

create policy profile_analytics_daily_metrics_select_member
on public.profile_analytics_daily_metrics for select to authenticated
using (public.is_organization_member(organization_id));

grant select, insert, update, delete on public.profile_analytics_daily_metrics to authenticated, service_role;

-- Tela de Recuperacao (Instagram) — schema.
--
-- Plano: plans/plano-tela-recuperacao-instagram-2026-08-31.md
-- Regua: artifact "A regua de corte pra recuperacao" (31/08/2026).
--
-- O que esta esteira resolve: hoje um perfil com desempenho ruim so tem duas
-- saidas, continuar rodando ou ser excluido do Athena+Zernio. Estas tabelas
-- sustentam o passo intermediario — isolar o perfil num grupo "<origem> rec",
-- trocar a midia, reagendar e medir se recuperou.
--
-- DUAS ESCOLHAS QUE DIVERGEM DA REGUA ORIGINAL, ambas decididas explicitamente
-- e ambas parametrizadas para poderem ser desligadas na validacao:
--
--   1. median_includes_recovery — a populacao de M/MR/pico e "membros do grupo
--      UNIAO membros da esteira do grupo". Sem isso a regua tem uma catraca:
--      tirar os piores sobe M na rodada seguinte, que acusa os proximos piores,
--      que ao sairem sobem M de novo, e o grupo drena por aritmetica e nao por
--      desempenho. Os candidatos continuam saindo so dos membros do grupo.
--
--   2. peak_from_last_milestone — o pico e contado a partir do ultimo marco de
--      troca de midia do grupo (piso em window_start). O pico e um max sobre a
--      janela; um dia excepcional de tres semanas atras mantem MR/pico < 0,60
--      para sempre e o Filtro 2 nunca mais roda. Cada leva de midia tem seu
--      proprio teto de desempenho.
--
-- ASSIMETRIA DE ESTIMADORES, registrada de proposito para ninguem "corrigir"
-- daqui a tres meses: MR e mediana de agregados por perfil; pico e maximo de
-- medianas diarias por post. Sao comparaveis em unidade, nao em construcao.
-- Esta na regua fechada e nao deve ser uniformizado.
--
-- Nenhum limiar absoluto de views/post e gravado aqui — so razoes e contagens
-- de posts. M, MR e pico sao recalculados a cada execucao, e copiar o numero
-- absoluto e o erro que quebra a regua.

-- ---------------------------------------------------------------------------
-- 1. Grupos: o interruptor da esteira
-- ---------------------------------------------------------------------------

alter table public.profile_groups
  add column if not exists recovery_enabled boolean not null default false,
  add column if not exists recovery_source_group_id uuid
    references public.profile_groups (id) on delete set null;

-- Um grupo nao pode ser a esteira de si mesmo.
alter table public.profile_groups
  drop constraint if exists profile_groups_recovery_source_not_self;
alter table public.profile_groups
  add constraint profile_groups_recovery_source_not_self
  check (recovery_source_group_id is null or recovery_source_group_id <> id);

-- Uma esteira por origem. Sem isto, dois cliques simultaneos em "mandar para
-- recuperacao" criam dois "GG LEXY rec" e a esteira se parte em duas.
create unique index if not exists profile_groups_one_recovery_per_source_idx
  on public.profile_groups (organization_id, recovery_source_group_id)
  where deleted_at is null and recovery_source_group_id is not null;

-- A esteira e identificada pelo ponteiro acima, NUNCA por parsear o sufixo
-- " rec" do nome — o operador pode renomear o grupo a qualquer momento.
create index if not exists profile_groups_recovery_enabled_idx
  on public.profile_groups (organization_id, id)
  where deleted_at is null and recovery_enabled;

-- ---------------------------------------------------------------------------
-- 2. Midia: comum ou reprocessada
-- ---------------------------------------------------------------------------

-- Nulo = desconhecido. O passado nao e reescrito.
alter table public.media_assets
  add column if not exists content_origin text
    check (content_origin is null or content_origin in ('common', 'reprocessed'));

-- ---------------------------------------------------------------------------
-- 3. Execucoes da analise
-- ---------------------------------------------------------------------------

create table if not exists public.recovery_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  trigger_source text not null check (trigger_source in ('cron', 'manual', 'backfill')),
  requested_by uuid references auth.users (id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'completed_with_errors', 'failed')),

  -- Parametros COPIADOS para esta execucao. Mudar o default da RPC nao
  -- reescreve o passado: cada snapshot carrega a regua com que foi produzido.
  window_days integer not null check (window_days between 7 and 180),
  discard_recent_days integer not null check (discard_recent_days between 1 and 5),
  min_posts_judgeable integer not null check (min_posts_judgeable between 1 and 10000),
  recent_window_posts integer not null check (recent_window_posts between 1 and 10000),
  never_started_ratio numeric(6,4) not null check (never_started_ratio > 0 and never_started_ratio <= 1),
  never_started_ratio_alt numeric(6,4) not null check (never_started_ratio_alt > 0 and never_started_ratio_alt <= 1),
  collapsed_ratio numeric(6,4) not null check (collapsed_ratio > 0 and collapsed_ratio <= 1),
  health_gate_ratio numeric(6,4) not null check (health_gate_ratio > 0 and health_gate_ratio <= 1),
  min_judgeable_profiles integer not null check (min_judgeable_profiles between 2 and 500),
  min_profiles_per_day integer not null check (min_profiles_per_day between 1 and 100),
  max_staleness_days integer not null check (max_staleness_days between 0 and 30),
  median_includes_recovery boolean not null default true,
  peak_from_last_milestone boolean not null default true,

  -- A janela sai dos DADOS, nao do relogio. Se a coleta parou ha tres dias, a
  -- tela precisa dizer isso em vez de analisar um vazio recente.
  latest_metric_date date,
  window_start date,
  window_end date,

  groups_total integer not null default 0,
  groups_processed integer not null default 0,
  groups_failed integer not null default 0,
  candidates_total integer not null default 0,
  last_error_message text check (char_length(coalesce(last_error_message, '')) <= 1200),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  check (window_start is null or window_end is null or window_start <= window_end),
  check (never_started_ratio <= never_started_ratio_alt)
);

create index if not exists recovery_analysis_runs_org_created_idx
  on public.recovery_analysis_runs (organization_id, created_at desc);

-- Mesma defesa da migration 323: o cron e o botao "Recalcular" competindo nao
-- podem abrir duas execucoes vivas para a mesma organizacao.
create unique index if not exists recovery_analysis_runs_one_active_per_org_idx
  on public.recovery_analysis_runs (organization_id)
  where status in ('pending', 'running');

create trigger recovery_analysis_runs_set_updated_at
before update on public.recovery_analysis_runs
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Estatisticas por grupo por execucao
-- ---------------------------------------------------------------------------

create table if not exists public.recovery_group_stats (
  run_id uuid not null references public.recovery_analysis_runs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  group_id uuid not null references public.profile_groups (id) on delete cascade,
  status text not null check (status in (
    'ok', 'gate_blocked', 'insufficient_judgeable', 'degenerate_median',
    'no_metrics', 'no_members', 'failed')),

  profiles_total integer not null default 0,
  profiles_with_metrics integer not null default 0,
  -- Membro sem NENHUM dia com post na janela. Some da regua por construcao
  -- (nao ha o que medir); o numero existe para a tela nao deixar a pergunta
  -- "cade os outros" sem resposta.
  profiles_idle integer not null default 0,
  judgeable_profiles integer not null default 0,
  posts_total bigint not null default 0,
  views_total bigint not null default 0,

  median_vs numeric(18,6),            -- M
  median_recent_vs numeric(18,6),     -- MR
  peak_daily_median numeric(18,6),    -- pico
  peak_from_date date,                -- de onde o pico passou a ser contado
  health_ratio numeric(18,6),         -- MR / pico
  health_gate_passed boolean not null default false,

  -- Limiares DERIVADOS desta rodada, gravados so para auditoria e exibicao.
  -- O limiar do portao (pico * health_gate_ratio) e derivado na leitura:
  -- gravar o limiar como se fosse o pico e o erro classico aqui.
  never_started_cut numeric(18,6),
  never_started_cut_alt numeric(18,6),
  collapsed_cut numeric(18,6),

  candidates_never_started integer not null default 0,
  candidates_collapsed integer not null default 0,
  last_metric_date date,

  -- Serie diaria da mediana do grupo, para o sparkline. Em jsonb e nao em
  -- tabela: seriam runs x grupos x dias linhas, sujeitas ao teto de 5000 do
  -- PostgREST e a regra de ordem total do row-limit-guard. Aqui a tela le a
  -- serie inteira junto com a linha do grupo.
  -- Formato: [{"d":"2026-08-20","m":812.5,"n":41}]
  daily_median_series jsonb not null default '[]'::jsonb
    check (jsonb_typeof(daily_median_series) = 'array'
           and jsonb_array_length(daily_median_series) <= 400),
  error_message text check (char_length(coalesce(error_message, '')) <= 1200),
  computed_at timestamptz not null default timezone('utc', now()),
  primary key (run_id, group_id)
);

create index if not exists recovery_group_stats_org_group_idx
  on public.recovery_group_stats (organization_id, group_id, computed_at desc);

-- ---------------------------------------------------------------------------
-- 5. Candidatos
-- ---------------------------------------------------------------------------

create table if not exists public.recovery_candidates (
  run_id uuid not null references public.recovery_analysis_runs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  group_id uuid not null references public.profile_groups (id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles (id) on delete cascade,

  -- 'never_started' = Filtro 1 (nunca engrenou); 'collapsed' = Filtro 2 (desabou).
  reason text not null check (reason in ('never_started', 'collapsed')),
  -- Filtro 1 e emitido no limiar frouxo (0,40) e etiquetado por severidade:
  -- 'severe' abaixo de 0,25, 'moderate' entre 0,25 e 0,40. E o que permite a
  -- tela oferecer os dois ajustes lado a lado sem duas execucoes, e o que faz
  -- o botao 25/40 nao disparar requisicao.
  severity text not null check (severity in ('severe', 'moderate')),

  posts_total bigint not null,
  views_total bigint not null,
  vs numeric(18,6) not null,
  best_day_vs numeric(18,6) not null,
  best_day_date date,
  recent_posts bigint,
  recent_views bigint,
  recent_vs numeric(18,6),
  recent_from_date date,
  recent_to_date date,

  vs_index numeric(18,6),          -- vs / M           (razao que julga o Filtro 1)
  best_day_index numeric(18,6),    -- melhor_dia / M   (o veto vitalicio)
  recent_index numeric(18,6),      -- vs_recente / MR  (razao que julga o Filtro 2)
  last_active_date date,
  stale_days integer,
  already_in_recovery boolean not null default false,
  new_since_previous boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),

  -- Seguro porque os dois filtros sao mutuamente exclusivos por construcao:
  -- o 1 exige melhor_dia < M, o 2 exige melhor_dia >= M.
  primary key (run_id, profile_id)
);

create index if not exists recovery_candidates_run_group_idx
  on public.recovery_candidates (run_id, group_id, vs_index, profile_id);

create index if not exists recovery_candidates_profile_history_idx
  on public.recovery_candidates (organization_id, profile_id, run_id);

-- ---------------------------------------------------------------------------
-- 6. A esteira
-- ---------------------------------------------------------------------------

create table if not exists public.recovery_cohort_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- SEM chave estrangeira para instagram_profiles, de proposito. O registro
  -- precisa sobreviver a exclusao do perfil: sem isso a aba Historico perderia
  -- justamente os casos em que a recuperacao falhou, que sao os mais
  -- importantes de lembrar. username_at_entry guarda a identidade.
  profile_id uuid not null,
  username_at_entry text not null,

  -- on delete restrict: o grupo de origem e a regua de comparacao da coorte
  -- inteira. O soft delete que DELETE /api/groups/[groupId] faz nao dispara
  -- restrict, entao o historico continua legivel; um hard delete acidental
  -- passa a falhar em vez de apagar a historia em silencio.
  source_group_id uuid not null references public.profile_groups (id) on delete restrict,
  -- Nulo para exclusoes feitas direto da aba Elegiveis, sem passar pela esteira.
  recovery_group_id uuid references public.profile_groups (id) on delete restrict,

  entered_at timestamptz not null default timezone('utc', now()),
  entered_on date not null,
  -- Separado de entered_on de proposito: entre entrar na esteira e o primeiro
  -- post com midia nova passam 1 a 3 dias, e nesse meio a fila antiga ainda
  -- publica midia velha. Medir a partir da entrada contamina justamente os
  -- primeiros dias, que e onde a taxa de zerados deveria falar.
  measurement_start_on date not null,
  entered_by uuid references auth.users (id) on delete set null,
  entry_run_id uuid references public.recovery_analysis_runs (id) on delete set null,
  entry_reason text not null
    check (entry_reason in ('never_started', 'collapsed', 'manual', 'direct_delete')),

  -- Baseline CONGELADO na entrada: sobrevive a poda de execucoes, e e contra
  -- ele que o "antes -> depois" e lido. Para candidatos de Nivel 2,
  -- baseline_ratio guarda vs_recente/MR (nao vs/M) — e a razao pela qual ele
  -- entrou, e mostrar a outra faria o perfil parecer melhor do que estava.
  baseline_posts_total bigint,
  baseline_vs numeric(18,6),
  baseline_best_day_vs numeric(18,6),
  baseline_recent_vs numeric(18,6),
  baseline_ratio numeric(18,6),
  baseline_group_median_vs numeric(18,6),
  baseline_group_median_recent_vs numeric(18,6),

  status text not null default 'active' check (status in ('active', 'returned', 'removed')),
  exit_at timestamptz,
  exit_decision text
    check (exit_decision in ('recovered', 'partial', 'not_recovered', 'deleted', 'manual')),
  exit_index numeric(18,6),
  exit_note text check (char_length(coalesce(exit_note, '')) <= 500),
  exit_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),

  check (status = 'active' or exit_at is not null),
  check (status <> 'active' or (exit_at is null and exit_decision is null)),
  check (measurement_start_on >= entered_on)
);

-- Um perfil ativo na esteira por vez. Permite reentrada depois da saida.
create unique index if not exists recovery_cohort_members_one_active_per_profile_idx
  on public.recovery_cohort_members (organization_id, profile_id)
  where status = 'active';

create index if not exists recovery_cohort_members_group_idx
  on public.recovery_cohort_members (organization_id, recovery_group_id, entered_at desc, id desc);

create index if not exists recovery_cohort_members_source_idx
  on public.recovery_cohort_members (organization_id, source_group_id, status);

create trigger recovery_cohort_members_set_updated_at
before update on public.recovery_cohort_members
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Observacao diaria da coorte
-- ---------------------------------------------------------------------------

create table if not exists public.recovery_cohort_observations (
  cohort_member_id uuid not null
    references public.recovery_cohort_members (id) on delete cascade,
  observed_on date not null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- set null de proposito: podar execucoes nao pode apagar a trajetoria.
  run_id uuid references public.recovery_analysis_runs (id) on delete set null,

  posts_since bigint not null default 0,
  views_since bigint not null default 0,
  vs_since numeric(18,6),
  days_since integer not null default 0,
  origin_median_vs numeric(18,6),
  origin_profiles integer not null default 0,
  recovery_index numeric(18,6),      -- vs_since / origin_median_vs
  verdict text not null check (verdict in (
    'recovered', 'partial', 'not_recovered', 'short_sample', 'no_reference', 'no_data')),

  -- measured_posts e o denominador da taxa de zerados e PRECISA aparecer na
  -- tela ao lado dela: a Zernio devolve analytics de post em paginas de 25, e
  -- "40% de zerados" sobre 5 posts medidos nao e a mesma frase que sobre 60.
  measured_posts integer not null default 0,
  zero_view_posts integer not null default 0,
  zero_view_rate numeric(6,4),
  stale_days integer,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (cohort_member_id, observed_on)
);

create index if not exists recovery_cohort_observations_org_day_idx
  on public.recovery_cohort_observations (organization_id, observed_on desc, cohort_member_id);

-- ---------------------------------------------------------------------------
-- 8. Marcos de troca de midia
-- ---------------------------------------------------------------------------

create table if not exists public.recovery_media_milestones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  group_id uuid not null references public.profile_groups (id) on delete cascade,
  happened_on date not null,
  media_count integer not null default 0 check (media_count >= 0),
  batch_kind text not null check (batch_kind in ('common', 'reprocessed')),
  media_group_assignment_job_id uuid
    references public.media_group_assignment_jobs (id) on delete set null,
  note text check (char_length(coalesce(note, '')) <= 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- Sem unique em (group_id, happened_on, batch_kind): duas levas do mesmo tipo
-- no mesmo dia sao um caso real. A protecao contra duplo clique fica na rota.
create index if not exists recovery_media_milestones_group_day_idx
  on public.recovery_media_milestones (organization_id, group_id, happened_on desc);

create trigger recovery_media_milestones_set_updated_at
before update on public.recovery_media_milestones
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 9. RLS e grants
--
-- auto_expose_new_tables esta COMENTADO em supabase/config.toml: tabela nova
-- sem grant explicito simplesmente nao existe para a Data API. Sem esta secao,
-- tudo compila e nada responde.
-- ---------------------------------------------------------------------------

alter table public.recovery_analysis_runs enable row level security;
alter table public.recovery_group_stats enable row level security;
alter table public.recovery_candidates enable row level security;
alter table public.recovery_cohort_members enable row level security;
alter table public.recovery_cohort_observations enable row level security;
alter table public.recovery_media_milestones enable row level security;

create policy recovery_analysis_runs_select_member
on public.recovery_analysis_runs for select to authenticated
using (public.is_organization_member(organization_id));

create policy recovery_group_stats_select_member
on public.recovery_group_stats for select to authenticated
using (public.is_organization_member(organization_id));

create policy recovery_candidates_select_member
on public.recovery_candidates for select to authenticated
using (public.is_organization_member(organization_id));

create policy recovery_cohort_members_select_member
on public.recovery_cohort_members for select to authenticated
using (public.is_organization_member(organization_id));

create policy recovery_cohort_observations_select_member
on public.recovery_cohort_observations for select to authenticated
using (public.is_organization_member(organization_id));

create policy recovery_media_milestones_select_member
on public.recovery_media_milestones for select to authenticated
using (public.is_organization_member(organization_id));

-- Marcos sao o unico registro que o operador lanca a mao; o resto e produto de
-- RPC. Nenhuma politica de escrita nas tabelas de snapshot e de coorte: a tela
-- nao pode fabricar um veredito.
create policy recovery_media_milestones_write_manager
on public.recovery_media_milestones for all to authenticated
using (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]))
with check (public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]));

-- O revoke PRECISA incluir `authenticated`, e nao e detalhe de estilo: o
-- pg_default_acl deste projeto concede arwdDxtm em toda tabela nova do schema
-- public a anon, authenticated e service_role. Sem revogar antes, as tabelas de
-- snapshot nascem com INSERT/UPDATE/DELETE liberados e a unica coisa que segura
-- a escrita e a RLS — que barra o INSERT (42501) mas deixa UPDATE e DELETE sem
-- politica afetarem zero linhas em SILENCIO, sem erro. Uma politica permissiva
-- acrescentada por engano no futuro abriria a escrita inteira de uma vez.
revoke all on table public.recovery_analysis_runs from public, anon, authenticated;
revoke all on table public.recovery_group_stats from public, anon, authenticated;
revoke all on table public.recovery_candidates from public, anon, authenticated;
revoke all on table public.recovery_cohort_members from public, anon, authenticated;
revoke all on table public.recovery_cohort_observations from public, anon, authenticated;
revoke all on table public.recovery_media_milestones from public, anon, authenticated;

grant select on table public.recovery_analysis_runs to authenticated;
grant select on table public.recovery_group_stats to authenticated;
grant select on table public.recovery_candidates to authenticated;
grant select on table public.recovery_cohort_members to authenticated;
grant select on table public.recovery_cohort_observations to authenticated;
grant select, insert, update, delete on table public.recovery_media_milestones to authenticated;

grant all on table public.recovery_analysis_runs to service_role;
grant all on table public.recovery_group_stats to service_role;
grant all on table public.recovery_candidates to service_role;
grant all on table public.recovery_cohort_members to service_role;
grant all on table public.recovery_cohort_observations to service_role;
grant all on table public.recovery_media_milestones to service_role;

notify pgrst, 'reload schema';

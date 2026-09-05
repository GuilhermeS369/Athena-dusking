-- Athena Scheduler: apaga os placeholders zerados que escondiam o histórico
-- dos perfis religados na API da Meta.
--
-- CONTEXTO. A migration 380 explica a origem: `initialize_profile_analytics_state`
-- gravava, a cada reconexão, um snapshot com período `hoje-29 .. hoje`, todas as
-- métricas em zero e `sync_status = 'not_configured'`. Como toda leitura de
-- "estado atual do perfil" pega o snapshot de maior `period_end`, esse zero
-- passou a ser a resposta para 996 linhas — inclusive para contas com meses de
-- views coletadas, que era exatamente o histórico que a migração para a Meta
-- foi feita para preservar.
--
-- MEDIDO EM 05/09/2026, antes de rodar:
--   * 996 snapshots `meta_official` + `not_configured`, TODOS com
--     views/reach/seguidores/interações em zero;
--   * 77 linhas em `profile_analytics_current` no mesmo estado;
--   * 958 perfis `meta_official` ativos, 0 linhas diárias desde 03/09.
--
-- O QUE ELA NÃO FAZ. Não apaga métrica nenhuma: a condição exige que TODAS as
-- colunas de valor estejam zeradas, então nenhuma linha com número é tocada.
-- Não mexe em `profile_analytics_daily_metrics`, que é onde vive o histórico
-- que a dashboard soma. E usa `deleted_at`, não DELETE — a linha continua
-- auditável e o reparo é reversível por
-- `update ... set deleted_at = null where deleted_at = '<data desta migração>'`.

-- Snapshots: some da leitura, permanece na tabela.
with repaired as (
  update public.profile_analytics_snapshots
  set deleted_at = timezone('utc', now())
  where provider = 'meta_official'
    and sync_status = 'not_configured'
    and deleted_at is null
    -- Todas as colunas de valor em zero. Qualquer número aqui significaria que
    -- a linha carrega coleta de verdade, e ela não é placeholder.
    and followers_count = 0
    and impressions = 0
    and reach = 0
    and views = 0
    and likes = 0
    and comments = 0
    and shares = 0
    and saves = 0
    and replies = 0
    and total_interactions = 0
    and posts_count = 0
  returning 1
)
select count(*) as snapshots_apagados from repaired;

-- Estado compacto: "não configurado" virou mentira no dia em que a coleta da
-- Meta passou a existir. Quem ainda não foi coletado está AGUARDANDO, que é
-- diferente — e é o que a tela precisa dizer.
update public.profile_analytics_current
set sync_status = 'pending'::public.profile_analytics_sync_status,
    unavailable_reason = 'Aguardando a primeira coleta pela API da Meta.'
where sync_status = 'not_configured'
  and deleted_at is null;

notify pgrst, 'reload schema';

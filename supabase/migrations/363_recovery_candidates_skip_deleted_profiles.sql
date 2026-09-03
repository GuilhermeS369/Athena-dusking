-- Perfil ja excluido continuava listado como candidato na tela de Recuperacao.
--
-- `list_recovery_candidates` (migration 350) junta `instagram_profiles` sem
-- filtrar `deleted_at`. O snapshot de candidatos e imutavel de proposito — ele
-- registra o que a regua viu no dia da analise — mas a LISTA e uma superficie
-- de acao, e oferecer acao sobre um perfil que nao existe mais e um convite ao
-- erro: "mandar para recuperacao" e "cancelar fila" apontariam para um perfil
-- apagado, e o operador nao teria como saber por que nada acontece.
--
-- Na pratica isso ficou visivel em 03/09/2026: depois de excluir 63 perfis, os
-- 63 continuaram na lista ate a proxima analise diaria, selecionaveis.
--
-- O join passa a exigir `deleted_at is null`. Vale para o soft delete local dos
-- perfis meta_official (imediato) e para os Zernio (depois que o worker confirma
-- o DELETE remoto, em complete_zernio_profile_recycling).
--
-- CONSEQUENCIA ACEITA E DELIBERADA: a contagem do card do grupo vem de
-- `recovery_group_stats`, que e o snapshot da execucao, e nao encolhe junto.
-- Depois de uma exclusao o card pode dizer 13 e a lista mostrar 11. Isso esta
-- CERTO — o card conta o que a regua marcou naquela rodada, a lista mostra
-- sobre o que ainda da para agir. Reescrever o snapshot para casar os numeros
-- seria apagar o passado; a tela e que diz de onde vem cada numero.
--
-- Nada aqui muda `get_recovery_cohort_page`: a esteira guarda `username_at_entry`
-- justamente para sobreviver a exclusao do perfil, e o Historico perderia os
-- casos que mais importam lembrar se sumissem.

create or replace function public.list_recovery_candidates(
  p_run_id uuid,
  p_group_id uuid default null,
  p_limit integer default 500
) returns table (
  profile_id uuid,
  username text,
  display_name text,
  profile_picture_url text,
  group_id uuid,
  group_name text,
  reason text,
  severity text,
  posts_total bigint,
  views_total bigint,
  vs numeric,
  best_day_vs numeric,
  best_day_date date,
  recent_posts bigint,
  recent_vs numeric,
  vs_index numeric,
  best_day_index numeric,
  recent_index numeric,
  -- A razao que a tela deve mostrar na barra "% da mediana": cada nivel e
  -- julgado por uma metrica diferente, e mostrar sempre vs/M colocaria o perfil
  -- que DESABOU acima do tique dos 40%, parecendo que nao deveria estar ali.
  judged_index numeric,
  last_active_date date,
  stale_days integer,
  already_in_recovery boolean,
  new_since_previous boolean,
  has_more boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  with page_limit as (
    select greatest(1, least(coalesce(p_limit, 500), 500)) as value
  ),
  rows_found as (
    select c.*, p.username, p.display_name, p.profile_picture_url, g.name as group_name
      from public.recovery_candidates c
      join public.instagram_profiles p on p.id = c.profile_id
      join public.profile_groups g on g.id = c.group_id
     where c.run_id = p_run_id
       and (p_group_id is null or c.group_id = p_group_id)
       -- Perfil excluido sai da lista. O snapshot continua guardando a linha.
       and p.deleted_at is null
     order by
       case when c.reason = 'collapsed' then c.recent_index else c.vs_index end nulls last,
       c.profile_id
     limit (select value from page_limit) + 1
  )
  select
    r.profile_id, r.username, r.display_name, r.profile_picture_url,
    r.group_id, r.group_name, r.reason, r.severity,
    r.posts_total, r.views_total, r.vs, r.best_day_vs, r.best_day_date,
    r.recent_posts, r.recent_vs,
    r.vs_index, r.best_day_index, r.recent_index,
    case when r.reason = 'collapsed' then r.recent_index else r.vs_index end,
    r.last_active_date, r.stale_days, r.already_in_recovery, r.new_since_previous,
    (select count(*) from rows_found) > (select value from page_limit)
  from rows_found r
  order by
    case when r.reason = 'collapsed' then r.recent_index else r.vs_index end nulls last,
    r.profile_id
  limit (select value from page_limit);
$$;

revoke all on function public.list_recovery_candidates(uuid, uuid, integer) from public, anon;
grant execute on function public.list_recovery_candidates(uuid, uuid, integer) to authenticated, service_role;

notify pgrst, 'reload schema';

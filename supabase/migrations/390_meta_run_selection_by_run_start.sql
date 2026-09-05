-- Athena Scheduler: a rodada passa a saber quem ELA já visitou.
--
-- O ERRO, visto em produção. A rodada precisa de um critério de "ainda não
-- visitado NESTA rodada", e eu traduzi isso para "parado há N minutos", com N =
-- minutos desde o início dela. Parecia equivalente e não é: N cresce junto com
-- a rodada. Aos 19 minutos, N vale 19, e o perfil coletado no minuto zero volta
-- a ser elegível — a rodada recomeça sozinha e nunca termina.
--
-- MEDIDO em 05/09/2026 na rodada manual das 13:41: 1.683 perfis no total,
-- 2.131 processados aos 18 minutos — 127%, subindo. Nenhum erro apareceu; ela
-- simplesmente girava, gastando chamada à Meta e escrita no banco em perfis já
-- coletados.
--
-- A CORREÇÃO é usar o instante em que a rodada começou, que não se move:
-- `current_synced_at < p_collected_before`. Janela fixa, critério estável, e a
-- rodada fecha quando todo mundo foi visitado uma vez.
--
-- `p_stale_minutes` continua existindo para o caminho de rede de segurança (o
-- cron da Vercel, que não tem rodada). Quando os dois vêm, o instante manda.

create or replace function public.select_meta_analytics_refresh_batch(
  p_organization_id uuid default null,
  p_profile_ids uuid[] default null,
  p_limit integer default 60,
  p_stale_minutes integer default 45,
  p_collected_before timestamptz default null
)
returns table (
  profile_id uuid,
  organization_id uuid,
  username text,
  instagram_user_id text,
  last_synced_at timestamptz,
  pending_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  if p_limit not between 1 and 500 then
    raise exception using errcode = '22023', message = 'Lote de coleta deve estar entre 1 e 500.';
  end if;

  return query
  with candidates as (
    select
      profile.id,
      profile.organization_id,
      profile.username,
      profile.instagram_user_id,
      state.current_synced_at
    from public.instagram_profiles as profile
    left join public.profile_analytics_current as state
      on state.organization_id = profile.organization_id
     and state.profile_id = profile.id
     and state.deleted_at is null
    where profile.deleted_at is null
      and profile.provider = 'meta_official'
      and profile.encrypted_access_token is not null
      and (p_organization_id is null or profile.organization_id = p_organization_id)
      and (p_profile_ids is null or profile.id = any(p_profile_ids))
      and (p_profile_ids is not null or profile.status = 'online')
      and (
        -- Instante fixo: "ainda não visitado desde que a rodada começou".
        case when p_collected_before is not null then
          state.current_synced_at is null or state.current_synced_at < p_collected_before
        else
          p_stale_minutes <= 0
          or state.current_synced_at is null
          or state.current_synced_at < timezone('utc', now()) - make_interval(mins => p_stale_minutes)
        end
      )
  )
  select
    candidate.id,
    candidate.organization_id,
    candidate.username,
    candidate.instagram_user_id,
    candidate.current_synced_at,
    (select count(*)::integer from candidates)
  from candidates as candidate
  order by candidate.current_synced_at asc nulls first, candidate.id
  limit p_limit;
end;
$$;

revoke all on function public.select_meta_analytics_refresh_batch(uuid, uuid[], integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.select_meta_analytics_refresh_batch(uuid, uuid[], integer, integer, timestamptz) to service_role;

-- A assinatura antiga (sem `p_collected_before`) sai de cena: mantê-la seria
-- deixar disponível exatamente a forma que causou o giro infinito.
drop function if exists public.select_meta_analytics_refresh_batch(uuid, uuid[], integer, integer);

notify pgrst, 'reload schema';

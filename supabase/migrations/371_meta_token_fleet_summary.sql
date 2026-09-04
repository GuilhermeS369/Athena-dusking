-- Resumo do estado de renovação dos tokens da Meta, agregado no banco.
--
-- A alternativa seria a tela ler todos os perfis meta_official e contar em
-- memória. Com 14 perfis isso funciona; com os ~3.300 previstos para depois da
-- migração, seriam milhares de linhas a cada carregamento — e acima de 5.000 o
-- PostgREST cortaria a leitura em silêncio, deixando o resumo errado sem erro
-- nenhum. Contar aqui devolve uma linha por app.
--
-- Os limites são PARÂMETROS, não constantes. A política mora em
-- lib/integrations/meta-token-renewal.ts e é ela que decide o que é "renovar a
-- partir de N dias"; duplicar os números aqui garantiria que um dia os dois
-- lados discordassem e ninguém percebesse.

create or replace function public.meta_token_fleet_summary(
  p_organization_id uuid,
  p_refresh_after_days integer,
  p_alarm_after_days integer,
  p_expire_after_days integer
)
returns table (
  meta_app_id uuid,
  total integer,
  healthy integer,
  due integer,
  at_risk integer,
  expired integer,
  unknown integer,
  failing integer,
  oldest_token_refreshed_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with aged as (
    select
      profile.meta_app_id,
      profile.token_refreshed_at,
      coalesce(profile.token_refresh_failure_count, 0) as failure_count,
      case
        when profile.token_refreshed_at is null then null
        else extract(epoch from (timezone('utc', now()) - profile.token_refreshed_at)) / 86400
      end as age_days
    from public.instagram_profiles profile
    where profile.organization_id = p_organization_id
      and profile.provider = 'meta_official'
      and profile.deleted_at is null
  )
  select
    aged.meta_app_id,
    count(*)::integer as total,
    count(*) filter (where age_days is not null and age_days < p_refresh_after_days)::integer as healthy,
    count(*) filter (where age_days >= p_refresh_after_days and age_days < p_alarm_after_days)::integer as due,
    count(*) filter (where age_days >= p_alarm_after_days and age_days < p_expire_after_days)::integer as at_risk,
    count(*) filter (where age_days >= p_expire_after_days)::integer as expired,
    count(*) filter (where age_days is null)::integer as unknown,
    count(*) filter (where failure_count > 0)::integer as failing,
    min(aged.token_refreshed_at) as oldest_token_refreshed_at
  from aged
  group by aged.meta_app_id;
$$;

-- security invoker: a função enxerga exatamente o que quem chamou enxerga, e o
-- RLS de instagram_profiles continua sendo a barreira. Sem grant para anon.
revoke all on function public.meta_token_fleet_summary(uuid, integer, integer, integer) from public, anon;
grant execute on function public.meta_token_fleet_summary(uuid, integer, integer, integer) to authenticated, service_role;

notify pgrst, 'reload schema';

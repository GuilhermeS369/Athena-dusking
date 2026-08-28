-- Resumo operacional X em uma varredura por tabela.
--
-- A rota /api/x/logs/summary executava 11 count(exact): 10 sobre
-- twitter_observability_incidents com o mesmo recorte de organização,
-- diferindo apenas em status/severity/domain, mais 1 sobre
-- twitter_observability_events. Sob polling de 30 s por aba aberta, isso
-- multiplicava varreduras completas sem necessidade.
--
-- Agregados com FILTER resolvem os 10 primeiros em uma única passagem.
-- A função é stable e somente leitura: não grava, não altera fila e não
-- participa de nenhum caminho de publicação.

create or replace function public.twitter_observability_summary_counts(
  p_organization_id uuid,
  p_events_since timestamptz
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501';
  end if;

  select jsonb_build_object(
    'open', count(*) filter (where status = 'open'),
    'investigating', count(*) filter (where status = 'investigating'),
    'critical', count(*) filter (where status <> 'resolved' and severity = 'critical'),
    'account', count(*) filter (where status <> 'resolved' and domain = 'account'),
    'scheduling', count(*) filter (where status <> 'resolved' and domain = 'scheduling'),
    'publication', count(*) filter (where status <> 'resolved' and domain = 'publication'),
    'worker', count(*) filter (where status <> 'resolved' and domain = 'worker'),
    'connection', count(*) filter (where status <> 'resolved' and domain = 'connection'),
    'analytics', count(*) filter (where status <> 'resolved' and domain = 'analytics'),
    'finance', count(*) filter (where status <> 'resolved' and domain = 'finance')
  )
  into result
  from public.twitter_observability_incidents
  where organization_id = p_organization_id;

  return coalesce(result, '{}'::jsonb) || jsonb_build_object(
    'events24h', (
      select count(*)
      from public.twitter_observability_events
      where organization_id = p_organization_id
        and occurred_at >= p_events_since
    )
  );
end $$;

revoke all on function public.twitter_observability_summary_counts(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.twitter_observability_summary_counts(uuid, timestamptz) to service_role;

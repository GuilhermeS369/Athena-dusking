-- Perfis podem ser removidos depois de integrarem um plano compacto. Nessa
-- situação, o worker ainda precisa alterar somente o estado do registro
-- histórico (por exemplo, queued -> suspended) para liberar o plano restante.
-- A criação de uma nova associação com perfil removido continua bloqueada.

create or replace function public.enforce_bulk_publication_organization()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_table_name = 'bulk_publication_plans' then
    if not exists (
      select 1 from public.publication_batches batch_row
      where batch_row.id = new.batch_id and batch_row.organization_id = new.organization_id
    ) or (new.origin_group_id is not null and not exists (
      select 1 from public.profile_groups group_row
      where group_row.id = new.origin_group_id and group_row.organization_id = new.organization_id
        and group_row.deleted_at is null
    )) then raise exception using errcode = '23514', message = 'Plano, lote e origem devem pertencer à mesma organização.'; end if;
  elsif tg_table_name = 'bulk_publication_plan_profiles' then
    if not exists (
      select 1 from public.bulk_publication_plans plan_row
      join public.instagram_profiles profile_row on profile_row.id = new.profile_id
      where plan_row.id = new.plan_id and plan_row.organization_id = new.organization_id
        and profile_row.organization_id = new.organization_id
        and (tg_op = 'UPDATE' or profile_row.deleted_at is null)
    ) then raise exception using errcode = '23514', message = 'Plano e perfil devem pertencer à mesma organização.'; end if;
  elsif tg_table_name = 'bulk_publication_plan_media' then
    if not exists (
      select 1 from public.bulk_publication_plans plan_row
      join public.media_assets asset_row on asset_row.id = new.media_asset_id
      where plan_row.id = new.plan_id and plan_row.organization_id = new.organization_id
        and asset_row.organization_id = new.organization_id
    ) then raise exception using errcode = '23514', message = 'Plano e mídia devem pertencer à mesma organização.'; end if;
  elsif tg_table_name = 'bulk_publication_profile_horizons' then
    if not exists (
      select 1 from public.bulk_publication_plan_profiles profile_plan
      where profile_plan.id = new.plan_profile_id and profile_plan.plan_id = new.plan_id
        and profile_plan.profile_id = new.profile_id and profile_plan.organization_id = new.organization_id
    ) then raise exception using errcode = '23514', message = 'Horizonte não corresponde ao perfil do plano.'; end if;
  elsif tg_table_name = 'bulk_publication_generation_chunks' then
    if not exists (
      select 1 from public.bulk_publication_plan_profiles profile_plan
      where profile_plan.id = new.plan_profile_id and profile_plan.plan_id = new.plan_id
        and profile_plan.profile_id = new.profile_id and profile_plan.organization_id = new.organization_id
    ) then raise exception using errcode = '23514', message = 'Chunk não corresponde ao perfil do plano.'; end if;
  end if;
  return new;
end;
$$;

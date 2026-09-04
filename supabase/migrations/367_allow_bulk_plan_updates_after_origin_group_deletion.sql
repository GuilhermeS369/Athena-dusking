-- Plano cujo grupo de origem foi excluido volta a aceitar UPDATE.
--
-- O QUE ISSO QUEBRAVA. `enforce_bulk_publication_organization` revalida, a cada
-- UPDATE do plano, que `origin_group_id` aponte para um grupo da mesma
-- organizacao E `deleted_at is null`. Como grupo e excluido por soft delete, todo
-- plano gerado a partir de um grupo que depois sumiu ficava CONGELADO: nenhuma
-- alteracao de estado passava, nem cancelar.
--
-- MEDIDO EM 04/09/2026, no cancelamento em massa da fila antes da migracao para
-- a API da Meta: de 3.164 perfis, 1.155 falharam com '23514 Plano, lote e origem
-- devem pertencer a mesma organizacao', deixando 51.059 itens sem cancelar.
-- A metade "lote em outra organizacao" da condicao nao tinha nada a ver: zero
-- planos tem lote fora da propria organizacao. Sao os 55 planos cujo grupo de
-- origem esta excluido.
--
-- POR QUE E SEGURO. E exatamente a folga que a migration 178 ja abriu para o
-- caso irmao: perfil removido depois de entrar num plano tambem travava o UPDATE
-- do plan_profile, e a correcao foi liberar `tg_op = 'UPDATE'` mantendo o INSERT
-- bloqueado. Aqui vale o mesmo raciocinio, e pela mesma razao: o vinculo com o
-- grupo e historico. Criar um plano novo apontando para grupo excluido continua
-- proibido; o que passa a ser permitido e mexer no estado de um plano que ja
-- existe.
--
-- A checagem de ORGANIZACAO continua valendo nos dois casos -- e ela que da nome
-- a mensagem de erro e e a que realmente protege multi-tenancy. O que sai e
-- apenas a exigencia de o grupo estar vivo, e apenas no UPDATE.
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
        -- Espelha a 178: no UPDATE o vinculo e historico, entao grupo excluido
        -- nao bloqueia. No INSERT a exigencia continua de pe.
        and (tg_op = 'UPDATE' or group_row.deleted_at is null)
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

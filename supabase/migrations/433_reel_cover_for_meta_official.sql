-- Capa personalizada de Reel para perfis da API oficial da Meta.
--
-- PEDIDO DO DONO (16/09/2026): a capa personalizada da programação em massa só
-- estava liberada para perfis Zernio; precisa valer para a API oficial.
--
-- O QUE A META EXIGE (developers.facebook.com/docs/instagram-platform/
-- instagram-graph-api/reference/ig-user/media, parâmetro `cover_url` de
-- media_type=REELS): URL pública, SÓ JPEG, até 8 MB, sRGB; 9:16 recomendado (ela
-- corta o centro quando não é). O publicador passa a enviar `cover_url` (ver
-- `metaReelContainerFields` em scripts/workers/publication-direct-dispatch.mjs).
--
-- O QUE ESTA MIGRATION MUDA em `bulk_reel_cover_is_eligible`, a validação usada
-- na revisão (/api/bulk-publications/review), na confirmação e dentro das
-- funções de criação de plano (207 e 432):
--
--   1. SÓ JPEG ATÉ 8 MB. Hoje a galeria tem 9 PNG entre 17 imagens prontas; uma
--      capa PNG seria recusada pela Meta no contêiner. Barrar aqui é o que impede
--      o plano de nascer com uma capa que nunca funcionaria.
--   2. PERMISSÃO. A 207 revogou a execução do papel `authenticated`, mas as rotas
--      chamam a função com a sessão do usuário: toda revisão com capa caía em
--      "A imagem de capa não está mais disponível" — a capa personalizada NUNCA
--      funcionou de ponta a ponta (nenhum plano com capa existe em produção).
--      Como a função é security definer e lê media_assets sem RLS, liberar a
--      execução exige conferir o papel do chamador: admin/operator da
--      organização, ou service_role.
--
-- Sem mudança de assinatura: `create or replace` preserva as chamadas das
-- funções de criação.

create or replace function public.bulk_reel_cover_is_eligible(
  p_organization_id uuid,
  p_media_asset_id uuid,
  p_origin_type text,
  p_origin_group_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_media_asset_id is not null
    and (
      coalesce(auth.role(), '') = 'service_role'
      or public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[])
    )
    and p_origin_type in ('group', 'ungrouped')
    and ((p_origin_type = 'group' and p_origin_group_id is not null)
      or (p_origin_type = 'ungrouped' and p_origin_group_id is null))
    and exists (
      select 1 from public.media_assets asset
      where asset.id = p_media_asset_id
        and asset.organization_id = p_organization_id
        and asset.kind = 'image'
        and asset.status = 'ready'
        and asset.deleted_at is null
        and asset.deletion_requested_at is null
        -- Exigência da Meta para `cover_url` (433).
        and lower(coalesce(asset.mime_type, '')) in ('image/jpeg', 'image/jpg')
        and coalesce(asset.size_bytes, 0) <= 8 * 1024 * 1024
        and public.media_asset_has_storage_object(asset.storage_path)
        and (
          (p_origin_type = 'group' and exists (
            select 1 from public.media_group_assignments assignment
            where assignment.organization_id = p_organization_id
              and assignment.group_id = p_origin_group_id
              and assignment.media_asset_id = asset.id
          ))
          or (p_origin_type = 'ungrouped' and not exists (
            select 1 from public.media_group_assignments assignment
            where assignment.organization_id = p_organization_id
              and assignment.media_asset_id = asset.id
          ))
        )
    );
$$;

revoke all on function public.bulk_reel_cover_is_eligible(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.bulk_reel_cover_is_eligible(uuid, uuid, text, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

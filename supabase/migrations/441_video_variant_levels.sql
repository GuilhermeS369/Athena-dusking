-- 441 — Variantes de video em niveis (decisao do dono em 23/09/2026):
--   nivel 1  micro        imagem identica; muda o audio e a marca interna do arquivo
--   nivel 2  bookend      congela o inicio + tela preta no fim (PADRAO do painel)
--   nivel 3  bookend_mid  nivel 2 + congela alguns quadros no meio
-- Nenhum nivel recodifica o video: os pedacos novos sao codificados e o original
-- entra por copia. O meio e cortado exatamente num quadro-chave (medido em
-- 23/09/2026 na VPS de variantes: metades identicas a fonte quadro a quadro).
--
-- `container` e `light` saem do PAINEL: a funcao que grava a receita de um plano
-- novo passa a recusar as duas. Os checks das tabelas continuam aceitando-as,
-- porque ha planos e variantes gravados com elas (historico) e o worker ainda as
-- gera para o que ja foi agendado (variante que volta para a fila quando o objeto
-- some do R2).

set lock_timeout = '10s';

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_video_variant_recipe_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_video_variant_recipe_check
  check (video_variant_recipe is null
    or (video_variant_recipe in ('container', 'micro', 'light', 'bookend', 'bookend_mid') and format = 'reel'));

alter table public.publication_item_video_variants
  drop constraint if exists publication_item_video_variants_recipe_check;
alter table public.publication_item_video_variants
  add constraint publication_item_video_variants_recipe_check
  check (recipe in ('container', 'micro', 'light', 'bookend', 'bookend_mid'));

-- Copia da 439 com a lista dos tres niveis.
create or replace function public.apply_bulk_plan_video_variant_recipe(
  p_result jsonb,
  p_format public.publication_format,
  p_video_variant_recipe text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  resolved_plan_id uuid := nullif(p_result ->> 'planId', '')::uuid;
  existing_recipe text;
begin
  if p_video_variant_recipe is not null and p_video_variant_recipe not in ('micro', 'bookend', 'bookend_mid') then
    raise exception using errcode = '22023', message = 'Receita de variante de vídeo inválida.';
  end if;
  if p_video_variant_recipe is not null and p_format <> 'reel' then
    raise exception using errcode = '22023', message = 'Variante de vídeo só existe para Reels.';
  end if;
  if resolved_plan_id is null then
    raise exception using errcode = 'P0002', message = 'Plano em massa não foi criado.';
  end if;

  if coalesce((p_result ->> 'created')::boolean, false) then
    update public.bulk_publication_plans
    set video_variant_recipe = p_video_variant_recipe
    where id = resolved_plan_id;
  else
    select video_variant_recipe into existing_recipe
    from public.bulk_publication_plans where id = resolved_plan_id;
    if existing_recipe is distinct from p_video_variant_recipe then
      raise exception using errcode = '23505',
        message = 'Este pedido já foi criado com outra opção de variante de vídeo.';
    end if;
  end if;
  return p_result || jsonb_build_object('videoVariantRecipe', p_video_variant_recipe);
end;
$$;

revoke all on function public.apply_bulk_plan_video_variant_recipe(jsonb, public.publication_format, text) from public, anon, authenticated;

notify pgrst, 'reload schema';

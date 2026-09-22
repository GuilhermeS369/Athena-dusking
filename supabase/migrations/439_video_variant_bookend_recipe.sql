-- 439 — Receita de variante de video `bookend` (teste, pedido do dono em 22/09/2026):
-- congela poucos quadros do INICIO do video e poe tela preta no FIM, variando os
-- dois por post, SEM recodificar o video inteiro (so os dois pedacos novos sao
-- codificados; o original entra por copia). O objetivo do teste e ver se a Meta
-- aceita o arquivo montado assim.
--
-- Medido na VPS de variantes em 22/09/2026 com 3 videos full HD de 43-52 s:
-- ~1-2 s por video (a `light` leva ~29 s nos mesmos videos), trecho original
-- identico a fonte quadro a quadro, zero aviso de decodificacao.
--
-- So estende as tres listas de receita da 436 (dois checks e a funcao que grava a
-- receita do plano). Nada mais muda: gerador, claim, preparacao e publicador ja
-- tratam a receita como texto.

set lock_timeout = '10s';

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_video_variant_recipe_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_video_variant_recipe_check
  check (video_variant_recipe is null
    or (video_variant_recipe in ('container', 'micro', 'light', 'bookend') and format = 'reel'));

alter table public.publication_item_video_variants
  drop constraint if exists publication_item_video_variants_recipe_check;
alter table public.publication_item_video_variants
  add constraint publication_item_video_variants_recipe_check
  check (recipe in ('container', 'micro', 'light', 'bookend'));

-- Copia da 436 com a lista nova.
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
  if p_video_variant_recipe is not null and p_video_variant_recipe not in ('container', 'micro', 'light', 'bookend') then
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

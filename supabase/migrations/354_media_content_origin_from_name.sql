-- Midia comum ou reprocessada, deduzida do nome do arquivo.
--
-- (Numerada 354: a 353 foi tomada por outra sessao na mesma branch enquanto
-- este trabalho estava em curso.)
--
-- Levantamento do acervo real em 31/08/2026 (917 midias): 205 delas ja trazem a
-- marca no proprio nome, porque ela sai da ferramenta que gera o video, nao da
-- memoria de quem sobe:
--
--   video_final_#_#_camuflado.mp4      156
--   video_conjunto_#_#_camuflado.mp4    45
--   V#_espelhado.mp4                     4
--
-- O restante e saida crua de baixador (conta_#_#_#.mp4), que e midia fresca.
--
-- Por isso a classificacao e inferida, e nao pedida: nao ha tela nova nem
-- clique novo, e o historico inteiro pode ser reclassificado de uma vez. A
-- lista de marcadores canonica vive em lib/media/content-origin.ts — quando a
-- ferramenta mudar de nomenclatura, e la que se acrescenta, e um backfill como
-- o desta migration reclassifica o passado.
--
-- Sem esse campo nao ha como ler o experimento de recuperacao depois: ele e o
-- que separa "melhorou porque foi reprocessada" de "melhorou porque era nova".

-- ---------------------------------------------------------------------------
-- 1. Backfill do acervo
-- ---------------------------------------------------------------------------

-- `camuflado` e `espelhado` nao levam acento em portugues, entao o LIKE simples
-- basta aqui. A versao TypeScript normaliza acentos por precaucao, para o dia
-- em que alguem renomear um arquivo a mao.
update public.media_assets
   set content_origin = case
         when lower(original_name) like '%camuflad%' then 'reprocessed'
         when lower(original_name) like '%espelhad%' then 'reprocessed'
         else 'common'
       end
 where content_origin is null;

-- ---------------------------------------------------------------------------
-- 2. O marco passa a derivar o tipo da leva
-- ---------------------------------------------------------------------------

-- 'mixed' entra porque e um estado real: atribuir numa tacada so uma leva que
-- mistura reprocessado e comum torna aquele marco ilegivel para o experimento,
-- e dizer isso e melhor do que escolher um dos dois lados no par ou impar.
alter table public.recovery_media_milestones
  drop constraint if exists recovery_media_milestones_batch_kind_check;

alter table public.recovery_media_milestones
  add constraint recovery_media_milestones_batch_kind_check
  check (batch_kind in ('common', 'reprocessed', 'mixed', 'unknown'));

-- A assinatura muda: em vez da contagem, a funcao recebe os ids das midias —
-- e deles que sai o tipo da leva, e a contagem vem de graca.
drop function if exists public.record_auto_media_milestones(uuid, uuid[], integer);

create or replace function public.record_auto_media_milestones(
  p_organization_id uuid,
  p_group_ids uuid[],
  p_media_asset_ids uuid[]
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('America/Sao_Paulo', now()))::date;
  v_actor uuid := auth.uid();
  v_total integer;
  v_reprocessed integer;
  v_kind text;
  v_touched integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_organization_role(
           p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Acao nao permitida.';
  end if;
  if coalesce(array_length(p_group_ids, 1), 0) = 0
     or coalesce(array_length(p_media_asset_ids, 1), 0) = 0 then
    return 0;
  end if;

  select count(*)::integer,
         count(*) filter (where a.content_origin = 'reprocessed')::integer
    into v_total, v_reprocessed
    from public.media_assets a
   where a.organization_id = p_organization_id
     and a.id = any(p_media_asset_ids);

  if coalesce(v_total, 0) = 0 then
    return 0;
  end if;

  -- Oitenta por cento decide. Uma leva raramente vem misturada de proposito;
  -- quando vem, chamar de "mista" e o unico rotulo honesto — o experimento nao
  -- consegue ler um marco que junta os dois tipos.
  v_kind := case
    when v_reprocessed::numeric / v_total >= 0.8 then 'reprocessed'
    when v_reprocessed::numeric / v_total <= 0.2 then 'common'
    else 'mixed'
  end;

  -- So grupos que a tela de Recuperacao enxerga: os liberados para a analise e
  -- as esteiras. Sem esse recorte, toda atribuicao de midia da organizacao
  -- viraria marco, e o grafico encheria de marcador sem significado.
  with alvo as (
    select g.id
      from public.profile_groups g
     where g.organization_id = p_organization_id
       and g.deleted_at is null
       and g.id = any(p_group_ids)
       and (g.recovery_enabled or g.recovery_source_group_id is not null)
  ),
  gravado as (
    insert into public.recovery_media_milestones (
      organization_id, group_id, happened_on, media_count, batch_kind, source, created_by)
    select p_organization_id, a.id, v_today, v_total, v_kind, 'auto', v_actor
      from alvo a
    on conflict (organization_id, group_id, happened_on) where source = 'auto'
    do update set
      -- Levas do mesmo dia somam em vez de virar marcadores repetidos...
      media_count = public.recovery_media_milestones.media_count + excluded.media_count,
      -- ...e se as duas levas do dia forem de tipos diferentes, o marco do dia
      -- vira 'mixed': foi isso que de fato entrou no grupo naquele dia.
      batch_kind = case
        when public.recovery_media_milestones.batch_kind = 'unknown' then excluded.batch_kind
        when public.recovery_media_milestones.batch_kind = excluded.batch_kind then excluded.batch_kind
        else 'mixed'
      end,
      updated_at = timezone('utc', now())
    returning 1
  )
  select count(*)::integer into v_touched from gravado;

  return v_touched;
end;
$$;

revoke all on function public.record_auto_media_milestones(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.record_auto_media_milestones(uuid, uuid[], uuid[])
  to authenticated, service_role;

notify pgrst, 'reload schema';

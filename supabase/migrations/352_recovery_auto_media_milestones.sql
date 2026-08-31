-- Tela de Recuperacao — marcos de midia capturados automaticamente.
--
-- O registro manual dependia de o operador lembrar de vir registrar. O marco
-- nao e burocracia: o pico do grupo (que decide se o Filtro 2 opina) passa a
-- ser contado a partir dele, e ele e o eixo do grafico de acompanhamento.
-- Depender da memoria de alguem para um dado que decide veredito e frageil.
--
-- Agora a atribuicao de midia a um grupo grava o marco sozinha.
--
-- SOBRE O TIPO DA LEVA. `batch_kind` ganha 'unknown', e a captura automatica
-- usa esse valor. O sistema NAO tem como saber se a leva e comum ou
-- reprocessada: um video reprocessado entra como asset novo, com checksum
-- novo, indistinguivel de uma midia fresca qualquer. Gravar 'common' por
-- padrao seria inventar o dado — e a analise de 31/08 registra exatamente que
-- sem esse campo nao da para separar "melhorou porque foi reprocessada" de
-- "melhorou porque era nova". Melhor dizer "nao sei" do que mentir com cara de
-- dado.

alter table public.recovery_media_milestones
  drop constraint if exists recovery_media_milestones_batch_kind_check;

alter table public.recovery_media_milestones
  add constraint recovery_media_milestones_batch_kind_check
  check (batch_kind in ('common', 'reprocessed', 'unknown'));

alter table public.recovery_media_milestones
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'auto'));

-- Um marco automatico por grupo por dia. Atribuir midia em tres levas no mesmo
-- dia e um caso real, e viraria tres marcadores no grafico dizendo a mesma
-- coisa; o certo e somar a contagem do dia. O indice e parcial porque o
-- registro manual continua podendo ter mais de um por dia (levas de tipos
-- diferentes, por exemplo).
create unique index if not exists recovery_media_milestones_one_auto_per_day_idx
  on public.recovery_media_milestones (organization_id, group_id, happened_on)
  where source = 'auto';

-- ---------------------------------------------------------------------------
-- Captura
-- ---------------------------------------------------------------------------

create or replace function public.record_auto_media_milestones(
  p_organization_id uuid,
  p_group_ids uuid[],
  p_media_count integer
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('America/Sao_Paulo', now()))::date;
  v_actor uuid := auth.uid();
  v_touched integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not public.has_organization_role(
           p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Acao nao permitida.';
  end if;
  if coalesce(array_length(p_group_ids, 1), 0) = 0 or coalesce(p_media_count, 0) <= 0 then
    return 0;
  end if;

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
    select p_organization_id, a.id, v_today, p_media_count, 'unknown', 'auto', v_actor
      from alvo a
    on conflict (organization_id, group_id, happened_on) where source = 'auto'
    -- Levas do mesmo dia somam em vez de virar marcadores repetidos.
    do update set media_count = public.recovery_media_milestones.media_count + excluded.media_count,
                  updated_at = timezone('utc', now())
    returning 1
  )
  select count(*)::integer into v_touched from gravado;

  return v_touched;
end;
$$;

revoke all on function public.record_auto_media_milestones(uuid, uuid[], integer) from public, anon;
grant execute on function public.record_auto_media_milestones(uuid, uuid[], integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';

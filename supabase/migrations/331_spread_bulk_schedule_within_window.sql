-- Espalha o início de cada perfil dentro de uma janela, para que os planos não
-- nasçam todos empilhados no mesmo segundo.
--
-- MEDIDO EM PRODUÇÃO (2026-08-29): nas 6 horas seguintes havia 11.749 reels
-- agendados em apenas 97 segundos distintos — 456 reels no MESMO SEGUNDO, hora
-- após hora. 80,8% caíam em minutos que já nasciam saturados (acima dos 180/min
-- do teto de despacho). Pior minuto: 503.
--
-- Causa: `create_bulk_rotation_plan` calcula `schedule_base` como
-- `greatest(now, último item ativo, fim da reserva)` — e, num plano recém-criado
-- sem histórico, isso dá praticamente o mesmo instante para todos os perfis.
--
-- Consequência: a pilha escoa a 180/min, então o último perfil publica ~2,5 min
-- atrasado. E **o atraso varia a cada hora**, porque a ordem de despacho muda —
-- um perfil que ficou no fim às 20:33 pode cair no começo às 21:33. É essa
-- variação que comprime o intervalo real e ativa a guarda da migration 330.
--
-- REGRA DE PRODUTO: o intervalo entre postagens é o produto (rende views) e é
-- testado deliberadamente (45, 90, 30 min). O deslocamento é aplicado UMA VEZ ao
-- ponto de partida de cada perfil, nunca a cada slot — então o intervalo pedido
-- é preservado exatamente. Os perfis continuam postando no mesmo horário; só
-- deixam de disputar o mesmo segundo. Janela padrão: 10 minutos.
--
-- POR QUE GATILHO E NÃO REESCRITA DA FUNÇÃO: `create_bulk_rotation_plan` tem
-- ~100 linhas e copiá-la inteira só para somar um deslocamento adicionaria risco
-- de transcrição sem ganho. Os gatilhos abaixo interceptam a inserção e mantêm
-- perfil e horizonte consistentes por construção.
--
-- MODO DIÁRIO (stories) fica de fora naturalmente: `create_bulk_daily_rotation_plan`
-- sobrescreve os horários DEPOIS de inserir os perfis, apagando o deslocamento.
-- É o comportamento desejado — story tem horário fixo e volume baixo (2/dia por
-- perfil, zero violações medidas).

alter table public.bulk_publication_plans
  add column if not exists spread_window_seconds integer not null default 600;

alter table public.bulk_publication_plans
  drop constraint if exists bulk_publication_plans_spread_window_check;
alter table public.bulk_publication_plans
  add constraint bulk_publication_plans_spread_window_check
  check (spread_window_seconds between 0 and 3600);

comment on column public.bulk_publication_plans.spread_window_seconds is
  'Janela em segundos para distribuir o início dos perfis do plano, evitando que todos publiquem no mesmo segundo. Padrão 600 (10 min). Zero desliga o espalhamento. NÃO altera o intervalo entre as postagens de um mesmo perfil — desloca apenas o ponto de partida.';

-- Deslocamento determinístico do perfil dentro da janela do plano.
create or replace function public.bulk_profile_spread_offset(
  p_plan_id uuid,
  p_ordinal bigint
) returns interval
language sql
stable
security definer
set search_path = public
as $$
  select make_interval(secs =>
    case
      when plan.profile_count <= 1 or plan.spread_window_seconds <= 0 then 0
      -- O último perfil fica em (n-1)/n da janela, nunca no fim exato, para o
      -- espalhamento não encostar no slot seguinte quando a janela for grande.
      else (p_ordinal % plan.profile_count) * plan.spread_window_seconds / plan.profile_count::numeric
    end)
  from public.bulk_publication_plans as plan
  where plan.id = p_plan_id;
$$;

create or replace function public.apply_bulk_profile_spread()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  offset_interval interval;
begin
  offset_interval := coalesce(public.bulk_profile_spread_offset(new.plan_id, new.ordinal), make_interval(secs => 0));
  if offset_interval = make_interval(secs => 0) then
    return new;
  end if;

  -- Os três campos deslocam juntos, preservando `first_execute_at > schedule_base_at`
  -- e mantendo exatamente o intervalo entre os slots deste perfil.
  new.schedule_base_at := new.schedule_base_at + offset_interval;
  new.first_execute_at := new.first_execute_at + offset_interval;
  new.last_execute_at := new.last_execute_at + offset_interval;
  return new;
end;
$$;

drop trigger if exists bulk_publication_plan_profiles_apply_spread on public.bulk_publication_plan_profiles;
create trigger bulk_publication_plan_profiles_apply_spread
before insert on public.bulk_publication_plan_profiles
for each row execute function public.apply_bulk_profile_spread();

-- O horizonte copia os valores do perfil já deslocado, em vez de recalcular o
-- deslocamento. Assim os dois não podem divergir: a reserva que encadeia o
-- próximo plano fica exatamente sobre o período real deste.
create or replace function public.align_bulk_horizon_with_profile()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  profile_plan public.bulk_publication_plan_profiles%rowtype;
begin
  select * into profile_plan
  from public.bulk_publication_plan_profiles as candidate
  where candidate.id = new.plan_profile_id;

  if profile_plan.id is null then
    return new;
  end if;

  new.reserved_from := profile_plan.schedule_base_at;
  new.first_execute_at := profile_plan.first_execute_at;
  new.reserved_through := profile_plan.last_execute_at;
  return new;
end;
$$;

drop trigger if exists bulk_publication_profile_horizons_align on public.bulk_publication_profile_horizons;
create trigger bulk_publication_profile_horizons_align
before insert on public.bulk_publication_profile_horizons
for each row execute function public.align_bulk_horizon_with_profile();

revoke all on function public.bulk_profile_spread_offset(uuid, bigint) from public, anon;
revoke all on function public.apply_bulk_profile_spread() from public, anon;
revoke all on function public.align_bulk_horizon_with_profile() from public, anon;

notify pgrst, 'reload schema';

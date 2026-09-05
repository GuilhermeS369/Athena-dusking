-- Athena Scheduler: corrige o fuso na decisão do horário da coleta.
--
-- O ERRO. A 387 escreveu `timezone('America/Sao_Paulo', timezone('utc', now()))`
-- para obter "agora em São Paulo". São duas conversões, e a segunda vai no
-- sentido oposto ao pretendido:
--
--   timezone(zona, timestamptz) -> CONVERTE para a zona          (o que eu queria)
--   timezone(zona, timestamp)   -> INTERPRETA o valor como da zona
--
-- `timezone('utc', now())` já devolve timestamp SEM fuso, então a chamada
-- seguinte caiu na segunda forma: pegou 15:58 (que era UTC) e tratou como se
-- fosse 15:58 em São Paulo, devolvendo 18:58 UTC.
--
-- MEDIDO em 05/09/2026: com 12:58 em São Paulo, a função respondia que a
-- próxima coleta era às 21:00 — porque achava que já eram 18:58. Seis horas de
-- erro. Em produção isso abriria a rodada das 09:00 por volta das 03:00 da
-- madrugada, e a das 21:00 nunca aconteceria no dia certo.
--
-- Quem denunciou foi a tela: o balão do indicador dizia "próxima coleta às
-- 21:00" às treze horas. Um número errado à vista vale mais que um teste que
-- não escrevi.
--
-- A correção é uma conversão só: `timezone('America/Sao_Paulo', now())`.

create or replace function public.open_meta_analytics_run(
  p_slots text[] default array['09:00', '15:00', '21:00']
)
returns public.meta_analytics_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  -- `now()` é timestamptz; uma conversão só, para o fuso da operação.
  agora_local timestamp := timezone('America/Sao_Paulo', now());
  hoje date := agora_local::date;
  slot text;
  escolhido text;
  escolhido_em timestamptz;
  run public.meta_analytics_runs%rowtype;
  elegiveis integer;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  foreach slot in array p_slots loop
    if agora_local::time >= slot::time then
      if escolhido is null or slot::time > escolhido::time then
        escolhido := slot;
      end if;
    end if;
  end loop;

  if escolhido is null then
    return null;
  end if;

  escolhido_em := (hoje::text || ' ' || escolhido)::timestamp at time zone 'America/Sao_Paulo';

  select * into run
  from public.meta_analytics_runs
  where slot_date = hoje and slot_label = escolhido;

  if found then
    return run;
  end if;

  select count(*)::integer into elegiveis
  from public.instagram_profiles
  where deleted_at is null
    and provider = 'meta_official'
    and status = 'online'
    and encrypted_access_token is not null;

  insert into public.meta_analytics_runs (slot_date, slot_label, scheduled_at, total_profiles)
  values (hoje, escolhido, escolhido_em, elegiveis)
  on conflict (slot_date, slot_label) do nothing
  returning * into run;

  if run.id is null then
    select * into run
    from public.meta_analytics_runs
    where slot_date = hoje and slot_label = escolhido;
  end if;

  return run;
end;
$$;

create or replace function public.get_meta_analytics_run_status(
  p_slots text[] default array['09:00', '15:00', '21:00']
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  agora_local timestamp := timezone('America/Sao_Paulo', now());
  run public.meta_analytics_runs%rowtype;
  proximo text;
  slot text;
begin
  select * into run
  from public.meta_analytics_runs
  order by scheduled_at desc
  limit 1;

  foreach slot in array p_slots loop
    if agora_local::time < slot::time and (proximo is null or slot::time < proximo::time) then
      proximo := slot;
    end if;
  end loop;
  if proximo is null then
    proximo := p_slots[1];
  end if;

  return jsonb_build_object(
    'slots', to_jsonb(p_slots),
    'next_slot', proximo,
    'server_time', to_char(agora_local, 'HH24:MI'),
    'run', case when run.id is null then null else jsonb_build_object(
      'slot_label', run.slot_label,
      'slot_date', run.slot_date,
      'started_at', run.started_at,
      'finished_at', run.finished_at,
      'total_profiles', run.total_profiles,
      'processed_profiles', run.processed_profiles,
      'synced_profiles', run.synced_profiles,
      'failed_profiles', run.failed_profiles,
      'daily_rows', run.daily_rows,
      'post_rows', run.post_rows,
      'percent', case
        when run.total_profiles > 0
          then least(100, round(run.processed_profiles::numeric * 100 / run.total_profiles))
        else 0
      end
    ) end
  );
end;
$$;

notify pgrst, 'reload schema';

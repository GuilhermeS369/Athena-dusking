-- Athena Scheduler: a coleta da Meta passa a acontecer em três horários fixos.
--
-- POR QUE SAIR DA COLETA CONTÍNUA. O worker da VPS coleta bem e sobra folga
-- nele; quem não tem folga é o Supabase. Projetado para 5.000 perfis, com
-- metade publicando 25 posts por dia:
--
--   escritas por rodada ......... 85.000  (74% delas são a linha por post)
--   3 rodadas por dia ........... 255.000/dia
--   de hora em hora ............. 1.190.000/dia
--   de 30 em 30 minutos ......... 2.380.000/dia
--
-- A cadência é o único parâmetro que muda isso de ordem de grandeza, e três
-- horários entregam o dia em três fotos — que é o que a operação lê de fato.
--
-- POR QUE UMA TABELA DE RODADAS, E NÃO UM CRON MUDO. A tela precisa dizer o que
-- está acontecendo: às 09:00 o indicador gira e mostra o progresso; depois fica
-- cinza e informa "concluída às 09:07, próxima às 15:00". Isso exige que a
-- rodada seja um OBJETO com início, progresso e fim — e não um efeito colateral
-- de um cron que ninguém vê. É também o que substitui o botão "atualizar", que
-- só servia para gastar processamento quando alguém clicava.
--
-- A rodada é GLOBAL, não por organização: a coleta varre a frota inteira, e uma
-- rodada por organização faria três telas discordarem sobre o mesmo trabalho.

create table if not exists public.meta_analytics_runs (
  id uuid primary key default gen_random_uuid(),
  -- Data e rótulo do horário no fuso da operação. A chave é o par: uma rodada
  -- por horário por dia, e a unicidade é o que impede duas VPS abrirem a mesma.
  slot_date date not null,
  slot_label text not null check (slot_label ~ '^[0-2][0-9]:[0-5][0-9]$'),
  scheduled_at timestamptz not null,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  total_profiles integer not null default 0 check (total_profiles >= 0),
  processed_profiles integer not null default 0 check (processed_profiles >= 0),
  synced_profiles integer not null default 0 check (synced_profiles >= 0),
  failed_profiles integer not null default 0 check (failed_profiles >= 0),
  daily_rows integer not null default 0 check (daily_rows >= 0),
  post_rows integer not null default 0 check (post_rows >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (slot_date, slot_label)
);

create index if not exists meta_analytics_runs_recent_idx
  on public.meta_analytics_runs (scheduled_at desc);

create trigger meta_analytics_runs_set_updated_at
before update on public.meta_analytics_runs
for each row execute function public.set_updated_at();

alter table public.meta_analytics_runs enable row level security;

-- A rodada é informação de operação, não de organização: qualquer pessoa com
-- sessão no painel pode ver que a coleta das 09:00 terminou. Escrita é só do
-- servidor.
create policy meta_analytics_runs_select_authenticated
on public.meta_analytics_runs for select
to authenticated
using (true);

-- ---------------------------------------------------------------------------
-- Abrir (ou recuperar) a rodada do horário corrente
-- ---------------------------------------------------------------------------

create or replace function public.open_meta_analytics_run(
  p_slots text[] default array['09:00', '15:00', '21:00']
)
returns public.meta_analytics_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  agora_local timestamp := timezone('America/Sao_Paulo', timezone('utc', now()));
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

  -- O horário mais recente que JÁ passou hoje. Antes do primeiro, não há
  -- rodada: a tela mostra "próxima às 09:00" e ninguém coleta.
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

  -- Quantos perfis esta rodada tem para visitar. Vira o denominador do
  -- progresso na tela; sem ele o indicador giraria sem dizer quanto falta.
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
    -- Outra chamada abriu a mesma rodada no intervalo. Pega a dela.
    select * into run
    from public.meta_analytics_runs
    where slot_date = hoje and slot_label = escolhido;
  end if;

  return run;
end;
$$;

revoke all on function public.open_meta_analytics_run(text[]) from public, anon, authenticated;
grant execute on function public.open_meta_analytics_run(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- Progresso e encerramento
-- ---------------------------------------------------------------------------

create or replace function public.advance_meta_analytics_run(
  p_run_id uuid,
  p_processed integer default 0,
  p_synced integer default 0,
  p_failed integer default 0,
  p_daily_rows integer default 0,
  p_post_rows integer default 0,
  p_remaining integer default null
)
returns public.meta_analytics_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  run public.meta_analytics_runs%rowtype;
begin
  if not public.is_service_role_request() then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;

  update public.meta_analytics_runs set
    processed_profiles = processed_profiles + greatest(coalesce(p_processed, 0), 0),
    synced_profiles = synced_profiles + greatest(coalesce(p_synced, 0), 0),
    failed_profiles = failed_profiles + greatest(coalesce(p_failed, 0), 0),
    daily_rows = daily_rows + greatest(coalesce(p_daily_rows, 0), 0),
    post_rows = post_rows + greatest(coalesce(p_post_rows, 0), 0),
    -- Fecha quando não sobrou perfil para visitar. `finished_at` é o que faz o
    -- indicador parar de girar e o despachante parar de trabalhar até o
    -- próximo horário.
    finished_at = case
      when p_remaining is not null and p_remaining <= 0 then coalesce(finished_at, timezone('utc', now()))
      else finished_at
    end
  where id = p_run_id
  returning * into run;

  return run;
end;
$$;

revoke all on function public.advance_meta_analytics_run(uuid, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.advance_meta_analytics_run(uuid, integer, integer, integer, integer, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- O que a tela lê
-- ---------------------------------------------------------------------------

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
  agora_local timestamp := timezone('America/Sao_Paulo', timezone('utc', now()));
  run public.meta_analytics_runs%rowtype;
  proximo text;
  slot text;
begin
  -- Sem checagem de organização de propósito: é estado de coleta, igual para
  -- todo mundo, e a política de select já exige sessão.

  select * into run
  from public.meta_analytics_runs
  order by scheduled_at desc
  limit 1;

  -- O próximo horário do dia; se todos já passaram, o primeiro de amanhã.
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

revoke all on function public.get_meta_analytics_run_status(text[]) from public, anon;
grant execute on function public.get_meta_analytics_run_status(text[]) to authenticated, service_role;

notify pgrst, 'reload schema';

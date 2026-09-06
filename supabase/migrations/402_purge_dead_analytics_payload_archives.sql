-- Athena Scheduler — 402: o arquivo de payload de analytics vira podável, e as
-- duas classes que ninguém lê saem de vez.
--
-- O QUE FOI MEDIDO EM 05/09/2026. `profile_analytics_payload_archives` tem
-- 142.914 linhas escritas entre 22/08 e 03/09, com payload JSON de 41,7 KB de
-- média — as da classe `posts` chegam a 95 KB cada. É a segunda maior estrutura
-- do banco, ~6 GB de JSON cru.
--
--   posts ....... 50.192 linhas   (~75–95 KB cada)
--   daily ....... 46.605 linhas   (~0,9–1,5 KB cada)
--   current ..... 46.117 linhas   (~0,9–1,5 KB cada)
--
-- POR QUE ELA PAROU DE CRESCER, E POR QUE ISSO IMPORTA. A última linha é de
-- 03/09 às 22:20. Não foi falha: a coleta migrou para a Meta, e
-- `lib/integrations/meta-analytics.ts` decidiu explicitamente não arquivar
-- payload ("Sem arquivo de payload", na cabeça do arquivo). O que está aqui é o
-- rastro da coleta Zernio, de um pipeline que não roda mais.
--
-- QUEM LÊ CADA CLASSE, VERIFICADO ARQUIVO POR ARQUIVO:
--
--   current → `get_profile_analytics_latest_payload_archive`, chamada pela tela
--             de detalhe do perfil (`app/(painel)/perfis/[profileId]/page.tsx`)
--             para mostrar o `raw_payload` ao admin. É a única classe lida.
--   daily   → ninguém.
--   posts   → ninguém.
--
-- `backfill_profile_analytics_current_archives` (220) também só escreve e lê
-- `current`. Por isso `posts` e `daily` saem inteiras, sem piso de dias: o piso
-- de 5 dias existe para histórico que alguém consulta, e aqui não há consulta
-- possível. `current` fica inteira — são ~70 MB e sustentam uma tela viva.
--
-- A CHAVE ESTRANGEIRA QUE PRECISOU SAIR. Seis colunas apontam para cá com
-- `on delete set null`, e nenhuma tem índice. Sem índice, cada linha apagada
-- dispara uma varredura sequencial na tabela que aponta — 50 mil varreduras de
-- `profile_post_analytics_snapshots` para apagar a classe `posts`.
--
-- Nas cinco colunas pequenas a saída é o índice parcial (abaixo). Na sexta não:
-- 231.823 das 277.778 linhas de `profile_post_analytics_snapshots` apontam para
-- um arquivo `posts`, e mantê-la ligada significaria reescrever 83% da tabela
-- para gravar `null` numa coluna que ninguém lê. A chave sai; o id fica órfão de
-- propósito — mesma decisão, e mesmo motivo, da 333 nas tabelas frias. O elo
-- auditável continua em `payload_sha256`, que não depende da linha existir.

-- ---------------------------------------------------------------------------
-- 1. As referências
-- ---------------------------------------------------------------------------

-- Descobre a constraint em vez de confiar no nome padrão: um `drop constraint if
-- exists` com o nome errado não falha, ele não faz nada — e a poda seguinte
-- viraria varredura sequencial sem ninguém perceber.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'public.profile_post_analytics_snapshots'::regclass
      and confrelid = 'public.profile_analytics_payload_archives'::regclass
      and contype = 'f'
  loop
    execute format(
      'alter table public.profile_post_analytics_snapshots drop constraint %I',
      constraint_name
    );
  end loop;
end;
$$;

comment on column public.profile_post_analytics_snapshots.payload_archive_id is
  'Id do arquivo de payload que originou a linha. Sem chave estrangeira desde a 402: o arquivo da classe posts é descartável e a integridade referencial custaria reescrever a tabela inteira a cada poda. Pode apontar para linha inexistente.';

create index if not exists profile_analytics_snapshots_payload_archive_idx
  on public.profile_analytics_snapshots (payload_archive_id)
  where payload_archive_id is not null;
create index if not exists profile_follower_daily_snapshots_payload_archive_idx
  on public.profile_follower_daily_snapshots (payload_archive_id)
  where payload_archive_id is not null;
create index if not exists profile_analytics_current_payload_archive_idx
  on public.profile_analytics_current (current_payload_archive_id)
  where current_payload_archive_id is not null;
create index if not exists profile_analytics_current_daily_archive_idx
  on public.profile_analytics_current (daily_payload_archive_id)
  where daily_payload_archive_id is not null;
create index if not exists profile_analytics_current_posts_archive_idx
  on public.profile_analytics_current (posts_payload_archive_id)
  where posts_payload_archive_id is not null;

create index if not exists profile_analytics_payload_archives_class_time_idx
  on public.profile_analytics_payload_archives (source_class, created_at);

-- ---------------------------------------------------------------------------
-- 2. A poda
--
-- Em lotes, com `has_more`, no mesmo formato de `prune_profile_post_analytics`
-- (385): a rota horária chama até esvaziar, sem segurar a tabela. Um `delete`
-- único de 96 mil linhas de 42 KB seria ~4 GB de WAL numa transação só.
-- ---------------------------------------------------------------------------

create or replace function public.purge_profile_analytics_payload_archives(
  p_source_classes text[],
  p_retention_days integer default 0,
  p_limit integer default 1000
)
returns table (deleted_count integer, has_more boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  classes text[];
  retention_days integer := greatest(0, least(coalesce(p_retention_days, 0), 365));
  batch_size integer := greatest(1, least(coalesce(p_limit, 1000), 5000));
  cutoff timestamptz;
  removed integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Apenas service_role poda o arquivo de payload.';
  end if;

  select array_agg(distinct lower(trim(item)))
    into classes
  from unnest(coalesce(p_source_classes, array[]::text[])) as item
  where nullif(trim(item), '') is not null;

  if classes is null or array_length(classes, 1) is null then
    raise exception using errcode = '22023', message = 'Informe ao menos uma classe de payload.';
  end if;
  if exists (select 1 from unnest(classes) as item where item not in ('posts', 'daily', 'current')) then
    raise exception using errcode = '22023', message = 'Classe de payload desconhecida.';
  end if;

  cutoff := timezone('utc', now()) - make_interval(days => retention_days);

  with expired as (
    select archive.id
    from public.profile_analytics_payload_archives archive
    where archive.source_class = any(classes)
      and archive.created_at < cutoff
    order by archive.created_at
    limit batch_size
    for update skip locked
  ), removed_rows as (
    delete from public.profile_analytics_payload_archives archive
    using expired
    where archive.id = expired.id
    returning archive.id
  )
  select count(*)::integer into removed from removed_rows;

  deleted_count := removed;
  has_more := removed >= batch_size;
  return next;
end;
$$;

revoke all on function public.purge_profile_analytics_payload_archives(text[],integer,integer)
  from public, anon, authenticated;
grant execute on function public.purge_profile_analytics_payload_archives(text[],integer,integer)
  to service_role;

notify pgrst, 'reload schema';

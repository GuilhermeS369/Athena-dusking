-- B4 — retenção: tira da tabela quente os itens arquivados há mais de N dias.
--
-- POR QUE PRECISA EXISTIR: `clean_publication_queue_finished` grava `archived_at`
-- e **a linha continua em `publication_items`**. Dos 34 índices da tabela, 23 não
-- filtram por essa coluna e quatro não filtram por nada. Medido em 29/08/2026:
-- 336 mil arquivados de 462 mil linhas — 73% da tabela era histórico ocupando
-- heap e oito índices. Arquivar aliviou a operação; não devolveu espaço.
--
-- PERIGO ENCONTRADO NA ANÁLISE, E QUE MUDOU O DESENHO ORIGINAL:
-- oito chaves estrangeiras apontam para `publication_items` com
-- `on delete cascade`. Um "mover" ingênuo (insert no frio + delete no quente)
-- **destruiria `publication_item_media` junto** — 474 mil linhas que registram
-- QUAL mídia foi publicada. Seria perda de histórico silenciosa.
--
-- Por isso a mídia é copiada para o frio ANTES do delete. As outras seis tabelas
-- em cascata são estado operacional que não sobrevive ao próprio item e cuja
-- perda é desejada:
--   * publication_profile_daily_reservations — reserva diária, já expirada
--   * publication_schedule_randomizations     — log de sorteio de horário
--   * publication_dispatch_rate_reservations  — reserva de despacho, expira em minutos
--   * ledger de circuito / saúde de entrega   — telemetria operacional
--   * publication_failure_acknowledgements    — 351 linhas; o reconhecimento
--     existe para limpar um alerta, e o alerta morre com o arquivamento
--
-- AS TABELAS FRIAS NÃO TÊM CHAVE ESTRANGEIRA. De propósito: um arquivo não pode
-- restringir a operação viva. Se um `media_asset` for apagado um dia, o frio
-- guarda o id órfão — que é justamente o registro histórico que se quer manter.
--
-- MANUTENÇÃO: as tabelas frias nascem com `like`, ou seja, com as colunas de
-- hoje. Se uma migration futura adicionar coluna em `publication_items` sem
-- adicionar aqui, a função abaixo **falha alto** com mensagem explícita, em vez
-- de mover dados pela metade. É proposital.

create table if not exists public.publication_items_archive (
  like public.publication_items including defaults
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.publication_items_archive'::regclass and contype = 'p'
  ) then
    alter table public.publication_items_archive add primary key (id);
  end if;
end;
$$;

create index if not exists publication_items_archive_org_idx
  on public.publication_items_archive (organization_id, archived_at desc);

create table if not exists public.publication_item_media_archive (
  like public.publication_item_media including defaults
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.publication_item_media_archive'::regclass and contype = 'p'
  ) then
    alter table public.publication_item_media_archive add primary key (publication_item_id, position);
  end if;
end;
$$;

create index if not exists publication_item_media_archive_org_idx
  on public.publication_item_media_archive (organization_id, publication_item_id);

alter table public.publication_items_archive enable row level security;
alter table public.publication_item_media_archive enable row level security;

drop policy if exists publication_items_archive_select_member on public.publication_items_archive;
create policy publication_items_archive_select_member
on public.publication_items_archive for select to authenticated
using (public.is_organization_member(organization_id));

drop policy if exists publication_item_media_archive_select_member on public.publication_item_media_archive;
create policy publication_item_media_archive_select_member
on public.publication_item_media_archive for select to authenticated
using (public.is_organization_member(organization_id));

-- Somente leitura para quem está logado: nada além do service_role escreve aqui.
revoke all on table public.publication_items_archive from anon, authenticated;
revoke all on table public.publication_item_media_archive from anon, authenticated;
grant select on table public.publication_items_archive to authenticated;
grant select on table public.publication_item_media_archive to authenticated;

comment on table public.publication_items_archive is
  'Arquivo frio de publication_items. Recebe itens com archived_at mais antigo que a retenção. Sem chaves estrangeiras de propósito: um arquivo não restringe a operação viva. Escrita apenas por move_archived_publication_items_to_cold_storage.';
comment on table public.publication_item_media_archive is
  'Arquivo frio de publication_item_media. Copiado ANTES do delete do item, porque a FK original é on delete cascade e o delete apagaria o registro de qual mídia foi publicada.';

create or replace function public.move_archived_publication_items_to_cold_storage(
  p_organization_id uuid,
  p_retention_days integer default 7,
  p_limit integer default 500
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Piso de 7 dias: mesmo que alguém passe 0 ou 1, nada recém-arquivado sai da
  -- tabela quente. O teto de duração de plano é 7 dias (migration 329), então
  -- nada em voo pode ser mais antigo que isso.
  retention_days integer := greatest(coalesce(p_retention_days, 7), 7);
  resolved_limit integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  cutoff timestamptz := timezone('utc', now()) - make_interval(days => retention_days);
  hot_columns integer;
  cold_columns integer;
  moving_ids uuid[];
  moved_items integer := 0;
  moved_media integer := 0;
  remaining_count bigint := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501',
      message = 'Apenas service_role move itens para o arquivo frio.';
  end if;

  -- Falha alta e explícita se as formas divergirem. Sem isto, um `insert select *`
  -- com colunas a mais falharia com mensagem críptica, e com colunas a menos
  -- poderia gravar dado na coluna errada.
  select count(*) into hot_columns from information_schema.columns
  where table_schema = 'public' and table_name = 'publication_items';
  select count(*) into cold_columns from information_schema.columns
  where table_schema = 'public' and table_name = 'publication_items_archive';
  if hot_columns <> cold_columns then
    raise exception using errcode = '55000',
      message = format(
        'publication_items tem %s colunas e publication_items_archive tem %s. '
        || 'Alguma migration adicionou coluna sem espelhar no arquivo frio. '
        || 'Espelhe a coluna antes de mover qualquer linha.',
        hot_columns, cold_columns);
  end if;

  -- Um array em vez de tabela temporária: o worker chama esta função em laço, e
  -- uma temporária `on commit drop` colidiria consigo mesma se duas chamadas
  -- caíssem na mesma transação. Com o teto de 2.000 ids o array é pequeno.
  select array_agg(candidate.id) into moving_ids
  from (
    select item.id
    from public.publication_items as item
    where item.organization_id = p_organization_id
      and item.archived_at is not null
      and item.archived_at < cutoff
    order by item.archived_at, item.id
    limit resolved_limit
    for update skip locked
  ) as candidate;

  if moving_ids is null then
    return jsonb_build_object(
      'organizationId', p_organization_id,
      'cutoff', cutoff,
      'retentionDays', retention_days,
      'movedItems', 0,
      'movedMedia', 0,
      'remaining', 0,
      'hasMore', false
    );
  end if;

  -- A mídia vai primeiro. Se fosse depois, o delete do item já teria levado a
  -- linha embora pela cascata — que é exatamente o acidente que este desenho evita.
  insert into public.publication_item_media_archive
  select media.*
  from public.publication_item_media as media
  where media.publication_item_id = any(moving_ids)
  on conflict do nothing;
  get diagnostics moved_media = row_count;

  insert into public.publication_items_archive
  select item.*
  from public.publication_items as item
  where item.id = any(moving_ids)
  on conflict (id) do nothing;
  get diagnostics moved_items = row_count;

  delete from public.publication_items as item
  where item.id = any(moving_ids);

  select count(*) into remaining_count
  from public.publication_items as item
  where item.organization_id = p_organization_id
    and item.archived_at is not null
    and item.archived_at < cutoff;

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'cutoff', cutoff,
    'retentionDays', retention_days,
    'movedItems', moved_items,
    'movedMedia', moved_media,
    'remaining', remaining_count,
    'hasMore', remaining_count > 0
  );
end;
$$;

revoke all on function public.move_archived_publication_items_to_cold_storage(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.move_archived_publication_items_to_cold_storage(uuid, integer, integer)
  to service_role;

comment on function public.move_archived_publication_items_to_cold_storage(uuid, integer, integer) is
  'Move itens arquivados há mais de N dias (piso de 7) de publication_items para o arquivo frio, copiando publication_item_media antes do delete. Retorna quantos moveu e quantos restam.';

notify pgrst, 'reload schema';

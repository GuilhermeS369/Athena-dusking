-- 424 — mover para o arquivo frio para de contar o que falta a cada chamada.
--
-- MEDIDO EM 07/09/2026 (pg_stat_statements, 17 dias): 14.286 chamadas de
-- move_archived_publication_items_to_cold_storage a 2.728 ms de media, 38.985 s
-- no total -- o segundo maior consumo de tempo de banco do sistema, para mover
-- 25 itens por vez. O custo nao era mover: era o `select count(*)` final, que
-- varre TODOS os arquivados alem do corte da organizacao (213.778 hoje) so para
-- devolver `remaining` e `hasMore`. O worker (media-maintenance-worker.mjs) le
-- apenas `hasMore`. `exists` responde a mesma pergunta em um indice.
--
-- `remaining` passa a ser -1 (desconhecido) para nao mentir com um numero.
create or replace function public.move_archived_publication_items_to_cold_storage(
  p_organization_id uuid,
  p_retention_days integer default 7,
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  retention_days integer := greatest(coalesce(p_retention_days, 7), 7);
  resolved_limit integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
  cutoff timestamptz := timezone('utc', now()) - make_interval(days => retention_days);
  hot_columns integer;
  cold_columns integer;
  moving_ids uuid[];
  moved_items integer := 0;
  moved_media integer := 0;
  has_more boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501',
      message = 'Apenas service_role move itens para o arquivo frio.';
  end if;

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

  -- `exists` em vez de `count(*)`: a pergunta e "sobrou algum?", nao "quantos".
  select exists (
    select 1
    from public.publication_items as item
    where item.organization_id = p_organization_id
      and item.archived_at is not null
      and item.archived_at < cutoff
  ) into has_more;

  return jsonb_build_object(
    'organizationId', p_organization_id,
    'cutoff', cutoff,
    'retentionDays', retention_days,
    'movedItems', moved_items,
    'movedMedia', moved_media,
    'remaining', case when has_more then -1 else 0 end,
    'hasMore', has_more
  );
end;
$function$;

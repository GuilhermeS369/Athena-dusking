-- A migração 039 usou um delimitador dollar-quoted em linha própria e incluiu
-- uma quebra CRLF inicial não desejada no texto. Este reparo complementar
-- remove somente esse prefixo dos mesmos itens ainda elegíveis.
do $$
declare
  target_batch_id constant uuid := '892a4bfb-e6d1-4d72-b941-ec9435178904';
  expected_item_count constant integer := 96;
  locked_count integer;
  updated_count integer;
begin
  perform 1
  from public.publication_batches
  where id = target_batch_id
  for update;

  -- No-op em bancos novos, que não possuem o lote histórico reparado.
  if not found then return; end if;

  select count(*) into locked_count
  from public.publication_items
  where batch_id = target_batch_id
    and status = 'waiting'
    and execute_at > timezone('utc', now())
    and creation_id is null
    and left(caption, 2) = E'\r\n'
    and substring(caption from 3) like 'VEJAM MEU STORYS 🚨%';

  if locked_count <> expected_item_count then
    raise exception using errcode = 'P0001', message = format('Esperados %s itens com quebra inicial acidental; encontrados %s. Reparo cancelado.', expected_item_count, locked_count);
  end if;

  with updated as (
    update public.publication_items
    set caption = substring(caption from 3)
    where batch_id = target_batch_id
      and status = 'waiting'
      and execute_at > timezone('utc', now())
      and creation_id is null
      and left(caption, 2) = E'\r\n'
      and substring(caption from 3) like 'VEJAM MEU STORYS 🚨%'
    returning id, organization_id, status
  ), audit as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status, status,
      actor_label, error_code, metadata
    )
    select
      organization_id, id, 'caption_repaired'::public.publication_item_event_type, status, status,
      'migration:040_remove_accidental_leading_newline', 'caption_repair_normalization',
      jsonb_build_object('batch_id', target_batch_id, 'removed_prefix', 'CRLF')
    from updated
    returning publication_item_id
  )
  select count(*) into updated_count from audit;

  if updated_count <> expected_item_count then
    raise exception using errcode = 'P0001', message = 'O reparo da quebra inicial não atualizou todos os itens esperados.';
  end if;
end;
$$;

-- Textareas do navegador e o payload JSON usam LF. Normaliza a legenda
-- operacionalmente reparada ao mesmo formato antes de o worker enviá-la à Meta.
do $$
declare
  target_batch_id constant uuid := '892a4bfb-e6d1-4d72-b941-ec9435178904';
  updated_count integer;
begin
  perform 1
  from public.publication_batches
  where id = target_batch_id
  for update;

  -- No-op em bancos novos, que não possuem o lote histórico reparado.
  if not found then return; end if;

  with updated as (
    update public.publication_items
    set caption = replace(caption, E'\r\n', E'\n')
    where batch_id = target_batch_id
      and status = 'waiting'
      and execute_at > timezone('utc', now())
      and creation_id is null
      and caption like 'VEJAM MEU STORYS 🚨' || E'\r\n' || 'Acidente na BR-381%'
    returning id, organization_id, status
  ), audit as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status, status,
      actor_label, error_code, metadata
    )
    select
      organization_id, id, 'caption_repaired'::public.publication_item_event_type, status, status,
      'migration:041_normalize_repaired_batch_caption_line_endings', 'caption_line_ending_normalization',
      jsonb_build_object('batch_id', target_batch_id, 'line_ending', 'LF')
    from updated
    returning publication_item_id
  )
  select count(*) into updated_count from audit;

  -- O worker pode publicar itens entre as migrações. A cláusula WHERE é
  -- restritiva e idempotente; cada item restante que ainda tiver CRLF é
  -- normalizado, sem tocar em itens publicados ou já reivindicados.
end;
$$;

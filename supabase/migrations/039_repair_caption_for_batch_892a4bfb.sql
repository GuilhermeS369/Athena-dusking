-- Repara exclusivamente as 96 publicações ainda não iniciadas do lote criado
-- em 04/08/2026 por aleidar1010@gmail.com. Itens publicados, em processamento
-- ou que já tenham creation_id na Meta permanecem imutáveis.
do $$
declare
  target_batch_id constant uuid := '892a4bfb-e6d1-4d72-b941-ec9435178904';
  expected_item_count constant integer := 96;
  old_caption constant text := 'VEJAM MEU STORYS';
  corrected_caption constant text := $caption$
VEJAM MEU STORYS 🚨
Acidente na BR-381 deixa trânsito lento e mobiliza equipes de resgate A manhã desta sexta-feira foi marcada por transtornos para quem trafegava pela BR-381, nas proximidades de João Monlevade, em Minas Gerais. Segundo informações de motoristas que passavam pelo local, uma colisão envolvendo dois caminhões e um veículo de passeio ocorreu por volta das 7h10, causando lentidão em ambos os sentidos da rodovia. Imagens compartilhadas nas redes sociais mostram longas filas de veículos e equipes de emergência atuando na remoção dos automóveis envolvidos. Equipes do Corpo de Bombeiros, da Polícia Rodoviária Federal e do SAMU foram acionadas para atender a ocorrência. Até o momento, não há confirmação oficial sobre o número de feridos. As autoridades orientam os condutores a redobrarem a atenção e, se possível, buscarem rotas alternativas até a normalização do tráfego.$caption$;
  locked_count integer;
  updated_count integer;
  verified_count integer;
begin
  if char_length(corrected_caption) > 2200 then
    raise exception using errcode = '22001', message = 'A legenda de correção excede o limite permitido.';
  end if;

  -- O bloqueio impede que o worker reivindique um item entre a prévia e o update.
  perform 1
  from public.publication_batches
  where id = target_batch_id
  for update;

  -- Bancos novos e ambientes de teste não possuem este lote histórico. A
  -- correção é deliberadamente um no-op nesses ambientes.
  if not found then return; end if;

  select count(*) into locked_count
  from public.publication_items
  where batch_id = target_batch_id
    and status = 'waiting'
    and execute_at > timezone('utc', now())
    and creation_id is null
    and caption = old_caption;

  if locked_count = 0 then
    -- Reexecução segura: tudo já foi corrigido anteriormente.
    select count(*) into verified_count
    from public.publication_items
    where batch_id = target_batch_id
      and status = 'waiting'
      and execute_at > timezone('utc', now())
      and creation_id is null
      and caption = corrected_caption;

    if verified_count = expected_item_count then return; end if;
    raise exception using errcode = 'P0001', message = 'Nenhum item elegível com a legenda original; estado do lote não é seguro para reparo.';
  end if;

  if locked_count <> expected_item_count then
    raise exception using errcode = 'P0001', message = format('Esperados %s itens elegíveis; encontrados %s. Reparo cancelado.', expected_item_count, locked_count);
  end if;

  with updated as (
    update public.publication_items
    set caption = corrected_caption
    where batch_id = target_batch_id
      and status = 'waiting'
      and execute_at > timezone('utc', now())
      and creation_id is null
      and caption = old_caption
    returning id, organization_id, status
  ), audit as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status, status,
      actor_label, error_code, metadata
    )
    select
      organization_id, id, 'caption_repaired'::public.publication_item_event_type, status, status,
      'migration:039_repair_caption_for_batch_892a4bfb', 'caption_repair',
      jsonb_build_object(
        'batch_id', target_batch_id,
        'previous_caption_length', char_length(old_caption),
        'caption_length', char_length(corrected_caption),
        'reason', 'shared_caption_multiline_truncation'
      )
    from updated
    returning publication_item_id
  )
  select count(*) into updated_count from audit;

  if updated_count <> expected_item_count then
    raise exception using errcode = 'P0001', message = format('Foram atualizados %s itens; esperados %s. Reparo cancelado.', updated_count, expected_item_count);
  end if;

  select count(*) into verified_count
  from public.publication_items
  where batch_id = target_batch_id
    and status = 'waiting'
    and execute_at > timezone('utc', now())
    and creation_id is null
    and caption = corrected_caption;

  if verified_count <> expected_item_count then
    raise exception using errcode = 'P0001', message = 'Validação final da legenda corrigida falhou.';
  end if;
end;
$$;

-- Cancelamento atômico da fila operacional por conta, lote ou grupo.
--
-- A rotina nunca confirma um cancelamento enquanto houver uma publicação já
-- sob lease de um worker. Nessa situação ela não altera nenhum item e devolve
-- `state = blocked`; isso evita afirmar que uma chamada já em curso ao provedor
-- externo foi interrompida. Itens ainda aguardando são travados, cancelados e
-- verificados na mesma transação.

create or replace function public.cancel_publication_queue_scope(
  p_scope text,
  p_target_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  organization_id uuid;
  target_profile_ids uuid[];
  target_profile_count integer := 0;
  item_row public.publication_items%rowtype;
  job_row public.publication_generation_jobs%rowtype;
  blocked_item_ids uuid[] := '{}'::uuid[];
  cancelled_item_ids uuid[] := '{}'::uuid[];
  affected_batch_ids uuid[] := '{}'::uuid[];
  cancelled_generation_jobs integer := 0;
  excluded_generation_jobs integer := 0;
  remaining_active_items integer := 0;
  job_has_remaining_profiles boolean;
  existing_excluded_profile_ids text[];
  affected_batch_id uuid;
begin
  if p_scope not in ('account', 'batch', 'group') then
    raise exception using errcode = '22023', message = 'Escopo de cancelamento inválido.';
  end if;

  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Autenticação necessária.';
  end if;

  if p_scope = 'batch' then
    select batch_row.organization_id
    into organization_id
    from public.publication_batches as batch_row
    where batch_row.id = p_target_id
    for update;

    if organization_id is null then
      raise exception using errcode = 'P0002', message = 'Lote de publicação não encontrado.';
    end if;
  elsif p_scope = 'account' then
    select profile_row.organization_id, array[profile_row.id]
    into organization_id, target_profile_ids
    from public.instagram_profiles as profile_row
    where profile_row.id = p_target_id
      and profile_row.deleted_at is null
    for update;

    if organization_id is null then
      raise exception using errcode = 'P0002', message = 'Perfil não encontrado.';
    end if;
  else
    select group_row.organization_id
    into organization_id
    from public.profile_groups as group_row
    where group_row.id = p_target_id
      and group_row.deleted_at is null
    for update;

    if organization_id is null then
      raise exception using errcode = 'P0002', message = 'Grupo não encontrado.';
    end if;

    select coalesce(array_agg(member.profile_id order by member.profile_id), '{}'::uuid[])
    into target_profile_ids
    from public.profile_group_members as member
    where member.organization_id = organization_id
      and member.group_id = p_target_id;
  end if;

  if not public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  if p_scope <> 'batch' then
    target_profile_count := coalesce(array_length(target_profile_ids, 1), 0);
    if target_profile_count = 0 then
      return jsonb_build_object(
        'state', 'cancelled',
        'scope', p_scope,
        'cancelledItemIds', '[]'::jsonb,
        'cancelledItems', 0,
        'remainingActiveItems', 0,
        'verified', true,
        'cancelledGenerationJobs', 0,
        'excludedGenerationJobs', 0
      );
    end if;
  end if;

  -- Mantém a ordem de lock do worker de geração: chunks antes de job. Caso um
  -- chunk já esteja em execução, esta transação espera seu commit, cancela os
  -- itens que ele acabou de materializar e só então altera os chunks restantes.
  perform 1
  from public.publication_generation_job_chunks as chunk_row
  join public.publication_generation_jobs as generation_job on generation_job.id = chunk_row.job_id
  where generation_job.organization_id = organization_id
    and generation_job.status in ('queued', 'processing', 'paused', 'failed')
    and chunk_row.status in ('queued', 'processing', 'failed')
    and (
      (p_scope = 'batch' and generation_job.batch_id = p_target_id)
      or (
        p_scope <> 'batch'
        and exists (
          select 1
          from jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
          where payload_item.value ->> 'profileId' = any(target_profile_ids::text[])
        )
      )
    )
  order by chunk_row.chunk_index, chunk_row.id
  for update of chunk_row;

  -- Bloqueia os jobs que podem futuramente gerar itens para a conta/grupo.
  -- O payload é a fonte de verdade antes da materialização dos chunks.
  -- Um worker que já recebeu lease pode estar em uma chamada externa. Em vez
  -- de apagá-lo da fila e dar uma falsa garantia, abortamos integralmente.
  for item_row in
    select item_source.*
    from public.publication_items as item_source
    where item_source.organization_id = organization_id
      and (
        (p_scope = 'batch' and item_source.batch_id = p_target_id)
        or (p_scope <> 'batch' and item_source.profile_id = any(target_profile_ids))
      )
      and item_source.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended')
    order by item_source.created_at, item_source.id
    for update
  loop
    if item_row.status in ('preparing', 'publishing') then
      blocked_item_ids := array_append(blocked_item_ids, item_row.id);
    end if;
  end loop;

  if coalesce(array_length(blocked_item_ids, 1), 0) > 0 then
    return jsonb_build_object(
      'state', 'blocked',
      'scope', p_scope,
      'blockedItemIds', to_jsonb(blocked_item_ids),
      'blockedItems', coalesce(array_length(blocked_item_ids, 1), 0),
      'message', 'Há publicação(ões) já em processamento. Nenhum item foi cancelado; aguarde a finalização e tente novamente.'
    );
  end if;

  -- Para lote, o job inteiro pertence ao lote e precisa ser encerrado. Para
  -- conta/grupo, conservamos o job para os demais perfis e gravamos a exclusão
  -- que também é respeitada pelo materializador e pelos workers de chunk.
  for job_row in
    select generation_job.*
    from public.publication_generation_jobs as generation_job
    where generation_job.organization_id = organization_id
      and generation_job.status in ('queued', 'processing', 'paused', 'failed')
      and (
        (p_scope = 'batch' and generation_job.batch_id = p_target_id)
        or (
          p_scope <> 'batch'
          and (
            exists (
              select 1
              from jsonb_array_elements(coalesce(generation_job.payload -> 'items', '[]'::jsonb)) as payload_item(value)
              where payload_item.value ->> 'profileId' = any(target_profile_ids::text[])
            )
            or exists (
              select 1
              from public.publication_generation_job_chunks as chunk_row
              where chunk_row.job_id = generation_job.id
                and chunk_row.status in ('queued', 'processing', 'failed')
                and exists (
                  select 1
                  from jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
                  where payload_item.value ->> 'profileId' = any(target_profile_ids::text[])
                )
            )
          )
        )
      )
    order by generation_job.created_at, generation_job.id
    for update
  loop
    select exists (
      select 1
      from jsonb_array_elements(coalesce(job_row.payload -> 'items', '[]'::jsonb)) as payload_item(value)
      where p_scope <> 'batch'
        and not (payload_item.value ->> 'profileId' = any(target_profile_ids::text[]))
    ) or exists (
      select 1
      from public.publication_generation_job_chunks as chunk_row
      cross join lateral jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
      where chunk_row.job_id = job_row.id
        and chunk_row.status in ('queued', 'processing', 'failed')
        and p_scope <> 'batch'
        and not (payload_item.value ->> 'profileId' = any(target_profile_ids::text[]))
    ) into job_has_remaining_profiles;

    if p_scope = 'batch' or not job_has_remaining_profiles then
      update public.publication_generation_job_chunks
      set status = 'cancelled', claimed_by = null, lease_until = null,
          completed_at = coalesce(completed_at, timezone('utc', now())), last_error_message = null
      where job_id = job_row.id
        and status in ('queued', 'processing', 'failed');

      update public.publication_generation_jobs
      set status = 'cancelled', claimed_by = null, lease_until = null,
          completed_at = timezone('utc', now()), last_error_message = null,
          metadata = metadata || jsonb_build_object(
            'cancelled_at', timezone('utc', now()),
            'cancelled_by', auth.jwt() ->> 'email',
            'cancelled_by_user_id', auth.uid(),
            'cancelled_scope', p_scope
          )
      where id = job_row.id;

      cancelled_generation_jobs := cancelled_generation_jobs + 1;
    else
      select coalesce(array_agg(distinct excluded.profile_id), '{}'::text[])
      into existing_excluded_profile_ids
      from (
        select jsonb_array_elements_text(coalesce(job_row.metadata -> 'cancelled_profile_ids', '[]'::jsonb)) as profile_id
        union
        select unnest(target_profile_ids::text[]) as profile_id
      ) as excluded;

      update public.publication_generation_jobs
      set payload = jsonb_set(
            coalesce(payload, '{}'::jsonb),
            '{items}',
            coalesce((
              select jsonb_agg(payload_item.value)
              from jsonb_array_elements(coalesce(payload -> 'items', '[]'::jsonb)) as payload_item(value)
              where not (payload_item.value ->> 'profileId' = any(target_profile_ids::text[]))
            ), '[]'::jsonb),
            true
          ),
          metadata = jsonb_set(
            coalesce(metadata, '{}'::jsonb),
            '{cancelled_profile_ids}',
            to_jsonb(existing_excluded_profile_ids),
            true
          ) || jsonb_build_object(
            'last_scoped_cancellation_at', timezone('utc', now()),
            'last_scoped_cancellation_by', auth.jwt() ->> 'email'
          )
      where id = job_row.id;

      -- Esses chunks já estão travados acima. Remover o perfil do payload
      -- impede que um worker gere novos itens para a conta cancelada.
      update public.publication_generation_job_chunks as chunk_row
      set payload = coalesce((
        select jsonb_agg(payload_item.value)
        from jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
        where not (payload_item.value ->> 'profileId' = any(target_profile_ids::text[]))
      ), '[]'::jsonb)
      where chunk_row.job_id = job_row.id
        and chunk_row.status in ('queued', 'processing', 'failed')
        and exists (
          select 1
          from jsonb_array_elements(coalesce(chunk_row.payload, '[]'::jsonb)) as payload_item(value)
          where payload_item.value ->> 'profileId' = any(target_profile_ids::text[])
        );

      excluded_generation_jobs := excluded_generation_jobs + 1;
    end if;
  end loop;

  for item_row in
    select item_source.*
    from public.publication_items as item_source
    where item_source.organization_id = organization_id
      and (
        (p_scope = 'batch' and item_source.batch_id = p_target_id)
        or (p_scope <> 'batch' and item_source.profile_id = any(target_profile_ids))
      )
      and item_source.status in ('waiting', 'ready', 'failed', 'suspended')
    order by item_source.created_at, item_source.id
    for update
  loop
    update public.publication_items
    set status = 'cancelled',
        cancelled_at = timezone('utc', now()),
        next_attempt_at = null,
        lease_until = null,
        claimed_by = null,
        creation_id = null
    where id = item_row.id;

    delete from public.publication_profile_daily_reservations
    where publication_item_id = item_row.id;
    delete from public.publication_dispatch_rate_reservations
    where publication_item_id = item_row.id;

    perform public.log_publication_item_event(
      item_row.id,
      'cancelled',
      item_row.status,
      'cancelled',
      auth.uid(),
      auth.jwt() ->> 'email',
      null,
      null,
      jsonb_build_object('action', 'cancelled_queue_scope_by_user', 'scope', p_scope, 'target_id', p_target_id)
    );

    cancelled_item_ids := array_append(cancelled_item_ids, item_row.id);
    affected_batch_ids := array_append(affected_batch_ids, item_row.batch_id);
  end loop;

  for affected_batch_id in
    select distinct affected.batch_id
    from unnest(affected_batch_ids) as affected(batch_id)
  loop
    perform public.sync_publication_batch_status(affected_batch_id);
  end loop;

  select count(*)::integer
  into remaining_active_items
  from public.publication_items as item_source
  where item_source.organization_id = organization_id
    and (
      (p_scope = 'batch' and item_source.batch_id = p_target_id)
      or (p_scope <> 'batch' and item_source.profile_id = any(target_profile_ids))
    )
    and item_source.status in ('waiting', 'ready', 'preparing', 'publishing', 'failed', 'suspended');

  return jsonb_build_object(
    'state', 'cancelled',
    'scope', p_scope,
    'cancelledItemIds', to_jsonb(cancelled_item_ids),
    'cancelledItems', coalesce(array_length(cancelled_item_ids, 1), 0),
    'remainingActiveItems', remaining_active_items,
    'verified', remaining_active_items = 0,
    'cancelledGenerationJobs', cancelled_generation_jobs,
    'excludedGenerationJobs', excluded_generation_jobs
  );
end;
$$;

revoke all on function public.cancel_publication_queue_scope(text, uuid) from public, anon;
grant execute on function public.cancel_publication_queue_scope(text, uuid) to authenticated;

notify pgrst, 'reload schema';

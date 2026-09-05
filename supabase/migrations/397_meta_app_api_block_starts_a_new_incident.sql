-- Bloqueio novo passa a ser incidente novo, em vez de continuar o antigo.
--
-- O QUE ESTAVA ERRADO NA 393. `api_blocked_at` era gravado com
-- `coalesce(app.api_blocked_at, resolved_now)`, ou seja: uma vez preenchido,
-- nunca mais mudava. Nada limpa esse campo quando o app se recupera sozinho --
-- e a recuperacao automatica e justamente o normal deste desenho, porque a
-- janela expira e a fila volta a publicar sem ninguem tocar em nada.
--
-- O efeito seria a tela mentir na SEGUNDA queda. Um app bloqueado hoje e
-- bloqueado de novo daqui a tres semanas exibiria "Desde 05/09", e o contador
-- "publicacoes ja ignoradas" traria somados os dois incidentes. Quem esta
-- decidindo se vai ao Meta Developers agora precisa do numero de agora.
--
-- COMO SABER QUE HOUVE RECUPERACAO. Sem inventar sinal novo: se algum perfil do
-- app publicou DEPOIS do fim da ultima janela, entao naquele intervalo a API
-- respondeu, e esta queda e outra. A consulta e um `exists` coberto pelo indice
-- `publication_items_profile_published_at_idx` (migration 029), que e parcial em
-- `status = 'published'`, e roda so na deteccao -- que e rara por construcao.
--
-- Quando nao houve publicacao no intervalo, o comportamento e o de antes: mesma
-- queda, janela renovada, `api_blocked_at` preservado como o inicio real.
create or replace function public.flag_meta_app_api_blocked(
  p_item_id uuid,
  p_worker_id text,
  p_error_code text,
  p_error_message text,
  p_window_minutes integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_item public.publication_items%rowtype;
  profile_row public.instagram_profiles%rowtype;
  app_row public.meta_apps%rowtype;
  resolved_now timestamptz := timezone('utc', now());
  window_until timestamptz;
  opened_window boolean := false;
  new_incident boolean := false;
  app_profile_ids uuid[];
  ignored_count integer := 0;
  ignored_event_count integer := 0;
  resolved_message text := left(coalesce(nullif(trim(p_error_message), ''),
    'API access blocked.'), 1200);
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao worker.';
  end if;
  if nullif(trim(p_worker_id), '') is null then
    raise exception using errcode = '22023', message = 'Worker obrigatório.';
  end if;
  if p_window_minutes not between 5 and 360 then
    raise exception using errcode = '22023', message = 'Janela de bloqueio inválida.';
  end if;

  select item.* into source_item
  from public.publication_items item
  where item.id = p_item_id
    and item.claimed_by = trim(p_worker_id)
    and item.lease_until > resolved_now
    and item.status in ('preparing', 'publishing')
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.';
  end if;

  if trim(coalesce(p_error_code, '')) <> '200'
    or coalesce(p_error_message, '') !~* 'api access blocked' then
    raise exception using errcode = '22023',
      message = 'Somente o erro 200 "API access blocked" bloqueia um app.';
  end if;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = source_item.profile_id
    and profile.organization_id = source_item.organization_id
  for update;
  if not found or profile_row.provider <> 'meta_official' then
    raise exception using errcode = '22023', message = 'Perfil Meta oficial não encontrado.';
  end if;
  if profile_row.meta_app_id is null then
    raise exception using errcode = '22023', message = 'Perfil sem app Meta vinculado.';
  end if;

  select app.* into app_row from public.meta_apps app
  where app.id = profile_row.meta_app_id for update;
  if not found then
    raise exception using errcode = '22023', message = 'App Meta não encontrado.';
  end if;

  select coalesce(array_agg(profile.id), '{}'::uuid[]) into app_profile_ids
  from public.instagram_profiles profile
  where profile.meta_app_id = app_row.id;

  if coalesce(app_row.api_block_until, resolved_now) > resolved_now then
    window_until := app_row.api_block_until;
  else
    window_until := resolved_now + make_interval(mins => p_window_minutes);
    opened_window := true;
  end if;

  -- Publicou depois do fim da última janela? Então a API voltou naquele
  -- intervalo, e esta é outra queda -- data e contadores recomeçam.
  if opened_window and app_row.api_block_until is not null then
    select exists (
      select 1 from public.publication_items item
      where item.profile_id = any(app_profile_ids)
        and item.status = 'published'
        and item.published_at is not null
        and item.published_at > app_row.api_block_until
    ) into new_incident;
  end if;

  with targets as (
    select item.id, item.status as previous_status
    from public.publication_items item
    where item.profile_id = any(app_profile_ids)
      and item.archived_at is null
      and item.meta_media_id is null
      and item.published_at is null
      and (
        item.id = source_item.id
        or (
          item.status in ('waiting', 'ready', 'failed')
          and item.execute_at is not null
          and item.execute_at <= window_until
          and (item.lease_until is null or item.lease_until <= resolved_now)
        )
      )
    for update
  ), ignored as (
    update public.publication_items item set
      status = 'ignored', claimed_by = null, lease_until = null,
      next_attempt_at = null,
      attempt_count = case
        when item.id = source_item.id and item.active_claim_consumed_attempt
          then greatest(item.attempt_count - 1, 0)
        else item.attempt_count
      end,
      active_claim_consumed_attempt = false,
      last_error_code = 'meta_app_api_blocked',
      last_error_message = 'App da Meta com acesso à API bloqueado; publicação ignorada.'
    from targets
    where item.id = targets.id
    returning item.id, targets.previous_status
  ), events as (
    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    )
    select profile_row.organization_id, ignored.id, 'ignored',
      ignored.previous_status, 'ignored', 'system: meta-app-api-blocked',
      'meta_app_api_blocked',
      'App da Meta com acesso à API bloqueado; publicação ignorada.',
      jsonb_build_object(
        'meta_app_id', app_row.id,
        'meta_app_label', app_row.label,
        'source_item_id', source_item.id,
        'block_window_until', window_until,
        'new_incident', new_incident,
        'provider_error_message', resolved_message
      )
    from ignored
    returning publication_item_id
  )
  select
    (select count(*)::integer from ignored),
    (select count(*)::integer from events)
  into ignored_count, ignored_event_count;

  if ignored_count <> ignored_event_count then
    raise exception using errcode = 'P0001',
      message = 'Falha ao auditar publicações ignoradas por bloqueio de app.';
  end if;

  delete from public.publication_profile_daily_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.profile_id = any(app_profile_ids)
    and item.status = 'ignored';

  delete from public.publication_dispatch_rate_reservations reservation
  using public.publication_items item
  where reservation.publication_item_id = item.id
    and item.profile_id = any(app_profile_ids)
    and item.status = 'ignored';

  update public.meta_apps app set
    api_blocked_at = case
      when new_incident then resolved_now
      else coalesce(app.api_blocked_at, resolved_now)
    end,
    api_block_until = window_until,
    api_block_error_message = resolved_message,
    api_block_detected_item_id = source_item.id,
    api_block_window_count = case
      when new_incident then 1
      else app.api_block_window_count + case when opened_window then 1 else 0 end
    end,
    api_block_ignored_count = case
      when new_incident then ignored_count
      else app.api_block_ignored_count + ignored_count
    end,
    updated_at = resolved_now
  where app.id = app_row.id;

  return jsonb_build_object(
    'completed', true,
    'metaAppId', app_row.id,
    'metaAppLabel', app_row.label,
    'openedWindow', opened_window,
    'newIncident', new_incident,
    'blockedUntil', window_until,
    'ignoredItemCount', ignored_count
  );
end;
$$;

revoke all on function public.flag_meta_app_api_blocked(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.flag_meta_app_api_blocked(uuid, text, text, text, integer)
  to service_role;

notify pgrst, 'reload schema';

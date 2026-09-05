-- Abre e fecha a janela de bloqueio de um app da Meta.
--
-- `flag_meta_app_api_blocked` e chamada pelo despachante quando a Meta responde
-- `200 / "API access blocked."`. Ela faz tres coisas, nesta ordem:
--
--   1. abre uma janela de uma hora no app, SE ainda nao houver uma aberta;
--   2. marca como `ignored` tudo daquele app que vence dentro da janela --
--      inclusive o que ja estava atrasado;
--   3. marca o item que detectou como `ignored` tambem.
--
-- O PASSO 3 E O QUE IMPORTA MAIS, e e o que faltava hoje: o item vira
-- `ignored`, nunca `failed`. Falha terminal alimenta o disjuntor do lote, e foi
-- assim que tres lotes pausaram em 05/09 -- um deles congelando 6.120 itens de
-- um app saudavel que dividia o lote com o bloqueado. Bloqueio de app nao e
-- falha de lote e nao pode pausar lote nenhum.
--
-- POR QUE A JANELA NAO E ESTENDIDA quando ja existe uma aberta: itens em voo
-- continuam falhando por alguns minutos depois da deteccao, e cada um chama
-- esta funcao. Se cada chamada empurrasse o fim da janela, ela nunca expiraria
-- e a retomada automatica -- que e o coracao do desenho -- nunca aconteceria.
-- So a primeira deteccao depois de a janela vencer abre janela nova.
--
-- ITEM EM VOO NAO E VARRIDO. `preparing`/`publishing` com lease viva pertence a
-- outro worker, e arranca-lo daqui abriria corrida com um `media_publish` que
-- talvez ja tenha saido. Cada um resolve sozinho: ao falhar com o mesmo erro,
-- entra por esta mesma porta e vira `ignored`.
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

  -- Espelha `isMetaAppApiBlocked` do lado do TypeScript. A guarda existe para
  -- que um chamador errado nao consiga bloquear um app inteiro por engano.
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

  if coalesce(app_row.api_block_until, resolved_now) > resolved_now then
    window_until := app_row.api_block_until;
  else
    window_until := resolved_now + make_interval(mins => p_window_minutes);
    opened_window := true;
  end if;

  select coalesce(array_agg(profile.id), '{}'::uuid[]) into app_profile_ids
  from public.instagram_profiles profile
  where profile.meta_app_id = app_row.id;

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
      -- A tentativa consumida por este claim e devolvida: o item nao foi
      -- recusado por merito dele, foi o app que estava fechado.
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

  -- As reservas precisam voltar para o bolo. Item ignorado que segura slot
  -- diario ou cota por minuto rouba capacidade dos apps que estao saudaveis.
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
    api_blocked_at = coalesce(app.api_blocked_at, resolved_now),
    api_block_until = window_until,
    api_block_error_message = resolved_message,
    api_block_detected_item_id = source_item.id,
    api_block_window_count = app.api_block_window_count + case when opened_window then 1 else 0 end,
    api_block_ignored_count = app.api_block_ignored_count + ignored_count,
    updated_at = resolved_now
  where app.id = app_row.id;

  return jsonb_build_object(
    'completed', true,
    'metaAppId', app_row.id,
    'metaAppLabel', app_row.label,
    'openedWindow', opened_window,
    'blockedUntil', window_until,
    'ignoredItemCount', ignored_count
  );
end;
$$;

-- Desbloqueio manual, da tela `/meta`. Zera a janela em vez de esperar ela
-- vencer, para o caso de o operador destravar o app na Meta antes disso.
create or replace function public.clear_meta_app_api_block(
  p_organization_id uuid,
  p_app_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  app_row public.meta_apps%rowtype;
  resolved_now timestamptz := timezone('utc', now());
begin
  if auth.role() <> 'service_role'
    and not public.has_organization_role(
      p_organization_id,
      array['admin', 'operator']::public.organization_role[]
    ) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;

  select app.* into app_row from public.meta_apps app
  where app.id = p_app_id and app.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'App Meta não encontrado.';
  end if;

  if app_row.api_blocked_at is null and app_row.api_block_until is null then
    return jsonb_build_object('cleared', false, 'idempotent', true, 'metaAppId', app_row.id);
  end if;

  update public.meta_apps app set
    api_blocked_at = null,
    api_block_until = null,
    api_block_error_message = null,
    api_block_detected_item_id = null,
    api_last_unblocked_at = resolved_now,
    api_unblocked_by = auth.uid(),
    updated_at = resolved_now
  where app.id = app_row.id;

  return jsonb_build_object(
    'cleared', true,
    'metaAppId', app_row.id,
    'metaAppLabel', app_row.label,
    'unblockedAt', resolved_now
  );
end;
$$;

revoke all on function public.flag_meta_app_api_blocked(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.flag_meta_app_api_blocked(uuid, text, text, text, integer)
  to service_role;
revoke all on function public.clear_meta_app_api_block(uuid, uuid) from public, anon;
grant execute on function public.clear_meta_app_api_block(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';

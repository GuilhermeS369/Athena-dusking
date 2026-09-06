-- "API access deactivated" entra no mesmo tratamento de "API access blocked".
--
-- O QUE ACONTECEU. Em 06/09/2026, a partir das 00:21, a Meta trocou a mensagem
-- dos apps derrubados: de `200 / "API access blocked."` para
-- `200 / "API access deactivated."`. A guarda so casava a primeira, entao os
-- itens voltaram pelo caminho antigo -- 200 nao e retentavel, viraram falha
-- terminal, o disjuntor contou, e TRES lotes pausaram. As 10:50 havia 14.482
-- itens congelados, 2.076 deles ja vencidos, e a esmagadora maioria pertencia a
-- perfis SAUDAVEIS, ja religados nos apps novos -- presos por causa de ~220
-- itens de perfis cujo token era de um app morto.
--
-- E o mesmo estrago do dia anterior voltando por uma palavra diferente.
--
-- POR QUE UMA MENSAGEM SO NAO BASTAVA. `200` e o codigo generico de permissao da
-- Graph API; e a mensagem que diz o que aconteceu de fato. Como a Meta pode
-- escrever mais de uma coisa para "este app nao fala mais com a API", a guarda
-- passa a casar as duas formas conhecidas -- e o `kind` guarda QUAL delas, para
-- a tela nao mentir sobre o que fazer.
--
-- A DIFERENCA QUE IMPORTA PARA QUEM OPERA:
--
--   blocked     -> pode voltar. A janela de uma hora existe justamente para
--                  testar de novo sem esforco humano.
--   deactivated -> nao volta sozinho. O app foi desativado do lado da Meta, e
--                  as contas dele precisam ser religadas em outro app. A janela
--                  continua valendo -- ela e o que impede a fila de sangrar --
--                  mas a tela precisa dizer "religue", e nao "aguarde".
--
-- PERFIL SEM APP. O outro buraco que este incidente revelou: quando o operador
-- apaga um app em /meta, os perfis dele ficam com `meta_app_id` nulo (a rota
-- DELETE os solta de proposito, para nao apontarem para um app inexistente).
-- Esses perfis continuam com um token emitido pelo app morto, entao continuam
-- recebendo 200 -- e a funcao abortava com "Perfil sem app Meta vinculado",
-- devolvendo o item para o caminho de falha terminal. Agora ela marca o item
-- como `ignored` do mesmo jeito, sem janela: nao ha app onde abri-la, e o que
-- esses perfis precisam e de religacao, nao de espera.
alter table public.meta_apps
  add column if not exists api_block_kind text
    check (api_block_kind is null or api_block_kind in ('blocked', 'deactivated'));

comment on column public.meta_apps.api_block_kind is
  'blocked = a Meta pode reabrir, a janela testa sozinha. deactivated = o app foi desativado e as contas precisam ser religadas em outro app.';

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
  resolved_kind text;
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

  -- Espelha `metaAppApiFailureKind` do lado do TypeScript.
  resolved_kind := case
    when trim(coalesce(p_error_code, '')) <> '200' then null
    when coalesce(p_error_message, '') ~* 'api access blocked' then 'blocked'
    when coalesce(p_error_message, '') ~* 'api access deactivated' then 'deactivated'
    else null
  end;
  if resolved_kind is null then
    raise exception using errcode = '22023',
      message = 'Somente o erro 200 "API access blocked/deactivated" bloqueia um app.';
  end if;

  select profile.* into profile_row
  from public.instagram_profiles profile
  where profile.id = source_item.profile_id
    and profile.organization_id = source_item.organization_id
  for update;
  if not found or profile_row.provider <> 'meta_official' then
    raise exception using errcode = '22023', message = 'Perfil Meta oficial não encontrado.';
  end if;

  -- PERFIL SEM APP: não há onde abrir janela. O item é ignorado assim mesmo,
  -- porque deixá-lo virar falha terminal é o que pausa lotes inteiros.
  if profile_row.meta_app_id is null then
    update public.publication_items item set
      status = 'ignored', claimed_by = null, lease_until = null, next_attempt_at = null,
      attempt_count = case
        when item.active_claim_consumed_attempt then greatest(item.attempt_count - 1, 0)
        else item.attempt_count
      end,
      active_claim_consumed_attempt = false,
      last_error_code = 'meta_app_api_blocked',
      last_error_message = 'App da Meta desativado; perfil precisa ser religado em outro app.'
    where item.id = source_item.id;

    insert into public.publication_item_events (
      organization_id, publication_item_id, event_type, previous_status,
      status, actor_label, error_code, error_message, metadata
    ) values (
      profile_row.organization_id, source_item.id, 'ignored', source_item.status,
      'ignored', 'system: meta-app-api-blocked', 'meta_app_api_blocked',
      'App da Meta desativado; perfil precisa ser religado em outro app.',
      jsonb_build_object(
        'orphan_profile', true,
        'profile_id', profile_row.id,
        'kind', resolved_kind,
        'provider_error_message', resolved_message
      )
    );

    return jsonb_build_object(
      'completed', true, 'orphanProfile', true, 'kind', resolved_kind,
      'metaAppId', null, 'ignoredItemCount', 1
    );
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
      last_error_message = case
        when resolved_kind = 'deactivated'
          then 'App da Meta desativado; perfil precisa ser religado em outro app.'
        else 'App da Meta com acesso à API bloqueado; publicação ignorada.'
      end
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
      'App da Meta sem acesso à API; publicação ignorada.',
      jsonb_build_object(
        'meta_app_id', app_row.id,
        'meta_app_label', app_row.label,
        'source_item_id', source_item.id,
        'block_window_until', window_until,
        'new_incident', new_incident,
        'kind', resolved_kind,
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
    -- Uma vez desativado, continua desativado: uma leitura posterior de
    -- "blocked" não deve rebaixar o aviso da tela de "religue" para "aguarde".
    api_block_kind = case
      when resolved_kind = 'deactivated' or app.api_block_kind = 'deactivated'
        then 'deactivated' else 'blocked'
    end,
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
    'kind', resolved_kind,
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

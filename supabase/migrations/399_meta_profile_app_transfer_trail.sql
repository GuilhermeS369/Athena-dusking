-- Mudar um perfil de app da Meta passa a deixar rastro, e a aparecer em /meta.
--
-- POR QUE ISTO EXISTE AGORA. Em 05/09/2026 a Meta bloqueou 5 apps com
-- `200 / API access blocked`, e um dos dois administradores de um deles ficou
-- inacessivel -- ou seja, pode nao haver como destravar o app pelo painel da
-- Meta. A saida operacional e reconectar as contas por um app saudavel:
-- `connect_meta_instagram_profile` casa o perfil por `instagram_user_id` (ou
-- pelo @) e sobrescreve `meta_app_id`, entao a conta troca de app SEM virar
-- perfil novo -- fila agendada, grupos, historico e analises seguem intactos,
-- porque tudo isso aponta para `profile_id`, nunca para o app.
--
-- O QUE FALTAVA. A troca era invisivel e, pior, mentia sobre capacidade.
-- `meta_apps_safe.instagram_profile_count` conta perfis por `meta_app_id`;
-- quando o perfil sai, o app antigo perde a conta na hora e aparece com uma
-- vaga a mais. So que do lado da Meta a conexao CONTINUA no app antigo -- a
-- Meta nao sabe que o Athena passou a usar outro app para aquela conta. E
-- exatamente a vaga fantasma da migration 389, agora por outra porta: la a
-- causa era o perfil removido por checkpoint, aqui e o perfil transferido.
--
-- Por isso a transferencia nasce com `slot_released_at` nulo, igual a queda: a
-- vaga so e considerada livre quando alguem confirmar que apagou a conexao no
-- Meta Developers. Para um app banido isso pode nunca acontecer, e tudo bem --
-- o numero na tela continua sendo verdade em vez de otimismo.
--
-- VOLTA PARA O APP DE ORIGEM. Se a conta for reconectada de novo pelo app do
-- qual saiu, a transferencia e marcada como resolvida na hora: a conexao voltou
-- a ser usada, entao ela nao e mais vaga presa. Sem isso, um vai-e-volta
-- deixaria o app de origem parecendo cheio para sempre.
create table if not exists public.meta_profile_app_transfers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.instagram_profiles(id) on delete cascade,
  from_app_id uuid references public.meta_apps(id) on delete set null,
  to_app_id uuid references public.meta_apps(id) on delete set null,
  from_app_label_snapshot text,
  to_app_label_snapshot text,
  username_snapshot text not null check (char_length(trim(username_snapshot)) between 1 and 80),
  transferred_at timestamptz not null default timezone('utc', now()),
  -- Nulo = a conexao ainda ocupa a vaga do app de origem no painel da Meta.
  slot_released_at timestamptz,
  slot_released_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists meta_profile_app_transfers_pending_idx
  on public.meta_profile_app_transfers (organization_id, from_app_id, transferred_at desc)
  where slot_released_at is null;

create index if not exists meta_profile_app_transfers_profile_idx
  on public.meta_profile_app_transfers (profile_id, transferred_at desc);

alter table public.meta_profile_app_transfers enable row level security;

drop policy if exists meta_profile_app_transfers_select on public.meta_profile_app_transfers;
create policy meta_profile_app_transfers_select on public.meta_profile_app_transfers
  for select to authenticated
  using (public.is_organization_member(organization_id));

grant select on public.meta_profile_app_transfers to authenticated;

-- Reescrita de `connect_meta_instagram_profile` (migrations 373/375) com uma
-- unica adicao: registrar a troca de app. Todo o resto -- lock por (@),
-- resolucao explicita do alvo pelo id, recusa por conflito, takeover da Zernio
-- -- e identico, e os comentarios de la seguem valendo.
create or replace function public.connect_meta_instagram_profile(
  p_organization_id uuid,
  p_instagram_user_id text,
  p_username text,
  p_display_name text,
  p_profile_picture_url text,
  p_account_type text,
  p_encrypted_access_token text,
  p_token_expires_at timestamptz,
  p_meta_app_id uuid,
  p_created_by uuid
)
returns table (
  profile_id uuid,
  outcome text,
  previous_provider text,
  previous_username text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_username text;
  match_by_user_id public.instagram_profiles%rowtype;
  match_by_username public.instagram_profiles%rowtype;
  username_match_count integer;
  target public.instagram_profiles%rowtype;
  resolved_outcome text;
  carried_metadata jsonb;
  from_app_label text;
  to_app_label text;
begin
  normalized_username := lower(nullif(trim(regexp_replace(p_username, '^@', '')), ''));

  if normalized_username is null then
    raise exception 'Username vazio devolvido pela Meta.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('meta_connect:' || p_organization_id::text || ':' || normalized_username, 0)
  );

  select * into match_by_user_id
  from public.instagram_profiles
  where organization_id = p_organization_id
    and instagram_user_id = p_instagram_user_id
    and deleted_at is null
  for update;

  select count(*) into username_match_count
  from public.instagram_profiles
  where organization_id = p_organization_id
    and deleted_at is null
    and lower(trim(regexp_replace(username, '^@', ''))) = normalized_username;

  if username_match_count > 1 then
    return query select null::uuid, 'conflict'::text, null::text, p_username;
    return;
  end if;

  if username_match_count = 1 then
    select * into match_by_username
    from public.instagram_profiles
    where organization_id = p_organization_id
      and deleted_at is null
      and lower(trim(regexp_replace(username, '^@', ''))) = normalized_username
    for update;
  end if;

  if match_by_user_id.id is not null
     and match_by_username.id is not null
     and match_by_user_id.id is distinct from match_by_username.id then
    return query select
      null::uuid,
      'conflict'::text,
      match_by_username.provider::text,
      match_by_username.username;
    return;
  end if;

  if match_by_user_id.id is not null then
    target := match_by_user_id;
  elsif match_by_username.id is not null then
    target := match_by_username;
  end if;

  if target.id is null then
    insert into public.instagram_profiles (
      organization_id, instagram_user_id, username, display_name,
      profile_picture_url, account_type, provider, capabilities,
      encrypted_access_token, token_expires_at, token_refreshed_at,
      token_refresh_attempted_at, token_refresh_error, token_refresh_failure_count,
      meta_app_id, status, last_success_at, last_error_code, last_error_message,
      created_by
    ) values (
      p_organization_id, p_instagram_user_id, trim(p_username), p_display_name,
      p_profile_picture_url, p_account_type, 'meta_official',
      jsonb_build_object('instagram_business_basic', true, 'instagram_business_content_publish', true),
      p_encrypted_access_token, p_token_expires_at, timezone('utc', now()),
      null, null, 0,
      p_meta_app_id, 'online', timezone('utc', now()), null, null,
      p_created_by
    )
    returning id into target.id;

    return query select target.id, 'created'::text, null::text, null::text;
    return;
  end if;

  resolved_outcome := case when target.provider = 'meta_official' then 'updated' else 'takeover' end;

  carried_metadata := coalesce(target.zernio_account_metadata, '{}'::jsonb);
  if resolved_outcome = 'takeover' then
    carried_metadata := carried_metadata || jsonb_build_object(
      'migrated_to_meta_at', timezone('utc', now()),
      'previous_provider', target.provider::text,
      'previous_instagram_user_id', target.instagram_user_id,
      'previous_zernio_account_id', target.zernio_account_id,
      'previous_zernio_profile_id', target.zernio_profile_id,
      'previous_zernio_connection_id', target.zernio_connection_id
    );
  end if;

  -- A TROCA DE APP. Registrada antes do update, enquanto `target.meta_app_id`
  -- ainda guarda a origem.
  if p_meta_app_id is not null
     and target.meta_app_id is not null
     and target.meta_app_id is distinct from p_meta_app_id then
    select label into from_app_label from public.meta_apps where id = target.meta_app_id;
    select label into to_app_label from public.meta_apps where id = p_meta_app_id;

    insert into public.meta_profile_app_transfers (
      organization_id, profile_id, from_app_id, to_app_id,
      from_app_label_snapshot, to_app_label_snapshot, username_snapshot
    ) values (
      p_organization_id, target.id, target.meta_app_id, p_meta_app_id,
      from_app_label, to_app_label, trim(p_username)
    );
  end if;

  -- Voltou para um app do qual havia saido: aquela conexao esta em uso de novo,
  -- entao ela deixa de ser vaga presa la.
  if p_meta_app_id is not null then
    update public.meta_profile_app_transfers transfer set
      slot_released_at = timezone('utc', now())
    where transfer.profile_id = target.id
      and transfer.from_app_id = p_meta_app_id
      and transfer.slot_released_at is null;
  end if;

  update public.instagram_profiles set
    instagram_user_id = p_instagram_user_id,
    username = trim(p_username),
    display_name = coalesce(p_display_name, display_name),
    profile_picture_url = coalesce(p_profile_picture_url, profile_picture_url),
    account_type = coalesce(p_account_type, account_type),
    provider = 'meta_official',
    capabilities = jsonb_build_object(
      'instagram_business_basic', true,
      'instagram_business_content_publish', true
    ),
    encrypted_access_token = p_encrypted_access_token,
    token_expires_at = p_token_expires_at,
    token_refreshed_at = timezone('utc', now()),
    token_refresh_attempted_at = null,
    token_refresh_error = null,
    token_refresh_failure_count = 0,
    meta_app_id = p_meta_app_id,
    status = 'online',
    last_success_at = timezone('utc', now()),
    last_failure_at = null,
    last_error_code = null,
    last_error_message = null,
    zernio_account_id = null,
    zernio_profile_id = null,
    zernio_connection_id = null,
    zernio_account_metadata = carried_metadata
  where id = target.id;

  return query select
    target.id,
    resolved_outcome,
    target.provider::text,
    target.username;
end;
$$;

-- Confirmacao de que a conexao foi apagada no Meta Developers, para as
-- transferencias. Espelha `confirm_meta_profile_slot_release` (migration 389):
-- security definer porque `authenticated` so tem SELECT na tabela, e ids de
-- outra organizacao ou ja liberados sao ignorados em silencio -- a resposta diz
-- quantos entraram de fato, para a tela nunca inventar um numero.
create or replace function public.confirm_meta_profile_app_transfer_release(
  p_transfer_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  released_count integer := 0;
  requested_count integer := coalesce(array_length(p_transfer_ids, 1), 0);
begin
  if requested_count = 0 then
    return jsonb_build_object('requested', 0, 'released', 0);
  end if;
  if requested_count > 1000 then
    raise exception using errcode = '22023', message = 'Confirme no máximo 1000 transferências por vez.';
  end if;

  with alvos as (
    select transfer.id
    from public.meta_profile_app_transfers transfer
    where transfer.id = any(p_transfer_ids)
      and transfer.slot_released_at is null
      and (
        auth.role() = 'service_role'
        or public.has_organization_role(
          transfer.organization_id,
          array['admin', 'operator']::public.organization_role[]
        )
      )
    for update
  ), liberadas as (
    update public.meta_profile_app_transfers transfer set
      slot_released_at = timezone('utc', now()),
      slot_released_by = auth.uid()
    from alvos
    where transfer.id = alvos.id
    returning transfer.id
  )
  select count(*)::integer into released_count from liberadas;

  return jsonb_build_object('requested', requested_count, 'released', released_count);
end;
$$;

revoke all on function public.confirm_meta_profile_app_transfer_release(uuid[]) from public, anon;
grant execute on function public.confirm_meta_profile_app_transfer_release(uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';

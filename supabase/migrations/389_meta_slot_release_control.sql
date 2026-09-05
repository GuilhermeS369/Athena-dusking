-- A vaga do app da Meta so volta a existir quando alguem apaga a conexao no
-- Meta Developers -- e o Athena passa a saber disso.
--
-- O QUE ESTAVA ERRADO. `meta_apps_safe.instagram_profile_count` conta perfis
-- com `deleted_at is null`. Quando `finalize_meta_profile_disconnection`
-- (migrations 136/137/376) remove um perfil caido, ele sai dessa conta na hora
-- e o app aparece com uma vaga a mais. Do outro lado, no painel da Meta, a
-- conexao continua la ocupando o slot: a Meta nao sabe que o Athena desistiu do
-- perfil. Medido em 05/09/2026, a diferenca era de 512 vagas em 28 apps -- e
-- NOVE apps que a tela mostrava com 2 a 27 vagas livres estavam, de fato,
-- lotados. Como `buildBulkMetaRows` gera as linhas `app;grupo` a partir desse
-- numero, cada vaga fantasma virava um celular apontado para um app sem espaco.
--
-- O QUE MUDA. O incidente ganha `slot_released_at`: enquanto for nulo, a queda
-- ainda ocupa a vaga do app. Quem preenche e o operador, em /meta, depois de
-- apagar a conexao no Meta Developers -- nao ha como descobrir isso sozinho, a
-- Graph API nao expoe a lista de contas conectadas ao app.
--
-- POR QUE MARCAR EM VEZ DE APAGAR A LINHA. A linha `fallen` do XLSX de grupos
-- (migration 377) e montada em cima do incidente, e o evento de saida de grupo
-- cai junto por cascade. Apagar o incidente tiraria da planilha a data de queda
-- que a operacao usa hoje. Marcado, o rastro fica; a tela e que passa a mostrar
-- so o que ainda esta pendente.

alter table public.meta_profile_disconnection_incidents
  add column if not exists slot_released_at timestamptz,
  add column if not exists slot_released_by uuid references auth.users(id) on delete set null;

comment on column public.meta_profile_disconnection_incidents.slot_released_at is
  'Quando o operador confirmou ter apagado a conexao no Meta Developers. Nulo = a queda ainda ocupa a vaga do app.';

-- A tela le sempre o mesmo recorte: pendentes de uma organizacao, por app.
create index if not exists meta_disconnection_incidents_pending_idx
  on public.meta_profile_disconnection_incidents(organization_id, meta_app_id, detected_at desc)
  where slot_released_at is null;

-- BACKFILL DAS QUEDAS ANTERIORES AO RASTRO.
--
-- A migration 376 comecou a gravar incidentes em 04/09/2026. As quedas
-- anteriores existem apenas como `instagram_profiles.deleted_at` +
-- `last_error_code = 'meta_profile_disconnected'` -- 16 perfis em 05/09/2026, o
-- mais antigo de 16/08. Sem esta insercao eles ficariam invisiveis na tela nova
-- justamente por serem os mais antigos, ou seja, os que ha mais tempo seguram
-- uma vaga no painel da Meta.
--
-- `error_code` entra como '190' porque e o unico codigo que a regra em
-- `isMetaTerminalProfileDisconnection` aceita: um perfil so chega a esse estado
-- por ela. A mensagem vem do proprio perfil, que a guardou na remocao.
--
-- O evento de saida de grupo NAO tem como ser reconstruido: `profile_group_members`
-- ja foi apagada de verdade (confirmado: zero linhas remanescentes para os 16).
-- Esses perfis nao vao aparecer como `fallen` no XLSX, e nao ha dado de onde
-- tirar isso. Aparecem em /meta, que e o que a operacao precisa para liberar a
-- vaga.
insert into public.meta_profile_disconnection_incidents (
  organization_id, profile_id, meta_app_id, username_snapshot, meta_app_label_snapshot,
  error_code, error_message, ignored_item_count, cancelled_plan_count,
  detected_at, finalized_at, created_at
)
select
  profile.organization_id,
  profile.id,
  profile.meta_app_id,
  left(trim(profile.username), 80),
  app.label,
  '190',
  left(coalesce(nullif(trim(profile.last_error_message), ''),
    'Token Meta invalido; perfil removido automaticamente.'), 1200),
  0, 0,
  profile.deleted_at, profile.deleted_at, profile.deleted_at
from public.instagram_profiles profile
left join public.meta_apps app
  on app.id = profile.meta_app_id
 and app.organization_id = profile.organization_id
where profile.provider = 'meta_official'
  and profile.deleted_at is not null
  and profile.last_error_code = 'meta_profile_disconnected'
  -- O `left(..., 80)` acima ja respeita o check da coluna; aqui so fica de fora
  -- perfil sem username, que nao teria como ser procurado no Meta Developers.
  and char_length(trim(profile.username)) >= 1
on conflict (organization_id, profile_id) do nothing;

-- A view ganha a contagem do que ainda prende vaga. A coluna entra no FIM: o
-- `create or replace view` do Postgres exige nome, tipo e posicao identicos
-- para as colunas que ja existiam.
create or replace view public.meta_apps_safe with (security_invoker = true) as
select
  app.id,
  app.organization_id,
  app.label,
  app.app_id,
  app.instagram_slot_limit,
  app.active,
  app.last_connected_at,
  app.created_by,
  app.deleted_at,
  app.created_at,
  app.updated_at,
  coalesce((
    select count(*)::integer
    from public.instagram_profiles profile
    where profile.organization_id = app.organization_id
      and profile.provider = 'meta_official'
      and profile.meta_app_id = app.id
      and profile.deleted_at is null
  ), 0) as instagram_profile_count,
  coalesce((
    select count(*)::integer
    from public.meta_profile_disconnection_incidents incident
    where incident.organization_id = app.organization_id
      and incident.meta_app_id = app.id
      and incident.slot_released_at is null
  ), 0) as pending_slot_release_count
from public.meta_apps app;

grant select on public.meta_apps_safe to authenticated;

-- Confirmacao em lote da limpeza feita no Meta Developers.
--
-- Security definer porque o papel `authenticated` so tem SELECT no incidente --
-- e continua tendo: liberar vaga passa por aqui, com o papel conferido, ou nao
-- passa. O array chega da tela com os ids marcados; ids de outra organizacao,
-- ja liberados ou inexistentes sao simplesmente ignorados, e a resposta diz
-- quantos entraram de fato para que a tela nunca invente um numero.
create or replace function public.confirm_meta_profile_slot_release(
  p_incident_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  requested integer := coalesce(array_length(p_incident_ids, 1), 0);
  released_count integer := 0;
  released_apps jsonb := '[]'::jsonb;
begin
  if requested = 0 then
    raise exception using errcode = '22023', message = 'Selecione ao menos um perfil.';
  end if;
  -- Teto de sanidade: a maior fila de um app hoje tem 63 perfis, e a tela
  -- confirma um app por vez. Um pedido acima disso e erro de chamada, nao uso.
  if requested > 1000 then
    raise exception using errcode = '22023', message = 'Confirme no maximo 1000 perfis por vez.';
  end if;

  with alvos as (
    select incident.id, incident.organization_id, incident.meta_app_id
    from public.meta_profile_disconnection_incidents incident
    where incident.id = any (p_incident_ids)
      and incident.slot_released_at is null
      and public.has_organization_role(
        incident.organization_id, array['admin', 'operator']::public.organization_role[])
    for update
  ), liberados as (
    update public.meta_profile_disconnection_incidents incident set
      slot_released_at = timezone('utc', now()),
      slot_released_by = (select auth.uid())
    from alvos
    where incident.id = alvos.id
    returning incident.id, incident.meta_app_id
  )
  select
    (select count(*)::integer from liberados),
    coalesce((
      select jsonb_agg(jsonb_build_object('metaAppId', meta_app_id, 'released', total))
      from (
        select meta_app_id, count(*)::integer as total
        from liberados
        group by meta_app_id
      ) por_app
    ), '[]'::jsonb)
  into released_count, released_apps;

  return jsonb_build_object(
    'requested', requested,
    'released', released_count,
    'byApp', released_apps
  );
end;
$$;

revoke all on function public.confirm_meta_profile_slot_release(uuid[]) from public, anon;
grant execute on function public.confirm_meta_profile_slot_release(uuid[]) to authenticated, service_role;

-- Desfazer a confirmacao que acabou de ser feita.
--
-- A tela nao guarda historico de confirmados (foi decisao explicita: depois de
-- limpo, some), e por isso "selecionar todos" numa fila de 63 seria irreversivel
-- sem isto. O estrago de confirmar demais nao aparece na hora -- so semanas
-- depois, quando o Bulk Meta mandar um celular para um app que ele acha vazio.
-- Trinta linhas aqui compram o direito de errar o clique.
create or replace function public.revert_meta_profile_slot_release(
  p_incident_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  requested integer := coalesce(array_length(p_incident_ids, 1), 0);
  reverted_count integer := 0;
begin
  if requested = 0 then
    raise exception using errcode = '22023', message = 'Nada a desfazer.';
  end if;
  if requested > 1000 then
    raise exception using errcode = '22023', message = 'Desfaca no maximo 1000 perfis por vez.';
  end if;

  with revertidos as (
    update public.meta_profile_disconnection_incidents incident set
      slot_released_at = null,
      slot_released_by = null
    where incident.id = any (p_incident_ids)
      and incident.slot_released_at is not null
      and public.has_organization_role(
        incident.organization_id, array['admin', 'operator']::public.organization_role[])
    returning incident.id
  ) select count(*)::integer into reverted_count from revertidos;

  return jsonb_build_object('requested', requested, 'reverted', reverted_count);
end;
$$;

revoke all on function public.revert_meta_profile_slot_release(uuid[]) from public, anon;
grant execute on function public.revert_meta_profile_slot_release(uuid[]) to authenticated, service_role;

notify pgrst, 'reload schema';

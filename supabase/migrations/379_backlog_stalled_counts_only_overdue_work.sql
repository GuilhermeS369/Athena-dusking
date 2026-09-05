-- "Backlog parado" passa a olhar o que está VENCIDO, não a fila inteira.
--
-- O QUE A TELA MOSTRAVA. Em 05/09/2026, o centro de operação exibiu
-- "Backlog: Parado — 40.798 ativos" ao lado de "item mais antigo 0 min vencido",
-- enquanto a fila publicava 153 itens a cada 5 minutos. As duas frases se
-- contradizem, e a segunda estava certa.
--
-- A CAUSA. A condição era:
--
--   stalled := active_total > 0 and last_progress_at < now() - 600s
--
-- `active_total` conta TODA a fila ativa, e a maior parte dela é trabalho
-- agendado para os próximos dias. Com 40 mil itens agendados, o primeiro termo é
-- sempre verdadeiro; basta um intervalo natural de dez minutos entre ondas para
-- a tela declarar estagnação. Ou seja: quanto mais cheia a agenda, mais fácil
-- disparar o alarme — exatamente ao contrário do que ele deveria medir.
--
-- O comentário original da função já dizia a intenção certa — "só sinaliza
-- quando existe backlog de verdade" — mas `active_total` não é backlog. Fila
-- cheia de posts de amanhã é agenda saudável, não atraso.
--
-- A CONDIÇÃO NOVA exige as três coisas juntas:
--
--   1. existe item VENCIDO (`due > 0`);
--   2. o mais antigo já passou do limiar (`oldest_due_age_seconds >= limiar`) —
--      um item vencido há 30 segundos não é estagnação, é o ciclo normal;
--   3. e nada progrediu nesse mesmo intervalo.
--
-- Sozinha, a terceira condição confunde vale entre ondas com travamento. Sozinha,
-- a primeira confunde agenda cheia com atraso. As três juntas descrevem o que a
-- palavra "parado" deveria significar: há trabalho que já deveria ter saído, ele
-- está esperando há tempo demais, e ninguém o está tocando.
--
-- POR QUE ISSO IMPORTA ALÉM DA ESTÉTICA: um alarme que dispara quando está tudo
-- bem gasta a atenção de quem opera, e treina a pessoa a ignorá-lo. Na noite de
-- 04/09 houve um travamento real — 3.040 itens congelados por disjuntor — e é
-- justamente esse alarme que deveria tê-lo apontado.
create or replace function public.get_publication_dispatch_state_snapshot(
  p_organization_id uuid,
  p_stalled_after_seconds integer default 600
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  snapshot_row public.publication_dispatch_state_snapshots%rowtype;
  trend_row public.publication_dispatch_backlog_trend%rowtype;
  stalled boolean;
begin
  if auth.role() <> 'service_role' and not public.is_organization_member(p_organization_id) then
    raise exception using errcode = '42501', message = 'Permissão insuficiente.';
  end if;
  if p_stalled_after_seconds not between 60 and 7200 then
    raise exception using errcode = '22023', message = 'Limite de estagnação inválido.';
  end if;

  select * into snapshot_row from public.publication_dispatch_state_snapshots
  where organization_id = p_organization_id;
  select * into trend_row from public.publication_dispatch_backlog_trend
  where organization_id = p_organization_id;

  -- As três condições precisam valer juntas. Ver o cabeçalho: cada uma sozinha
  -- produz um alarme que mente em uma direção diferente.
  stalled := coalesce(snapshot_row.due, 0) > 0
    and coalesce(snapshot_row.oldest_due_age_seconds, 0) >= p_stalled_after_seconds
    and trend_row.last_progress_at is not null
    and trend_row.last_progress_at < timezone('utc', now()) - make_interval(secs => p_stalled_after_seconds);

  return jsonb_build_object(
    'preloaded', coalesce(snapshot_row.preloaded, 0),
    'awaitingQuota', coalesce(snapshot_row.awaiting_quota, 0),
    'sentToProvider', coalesce(snapshot_row.sent_to_provider, 0),
    'profileDisconnected', coalesce(snapshot_row.profile_disconnected, 0),
    'due', coalesce(snapshot_row.due, 0),
    'failuresLastHour', coalesce(snapshot_row.failures_1h, 0),
    'publishedLastMinute', coalesce(snapshot_row.published_last_minute, 0),
    'oldestDueAgeSeconds', coalesce(snapshot_row.oldest_due_age_seconds, 0),
    'activeTotal', coalesce(snapshot_row.active_total, 0),
    'backlogStalled', coalesce(stalled, false),
    'lastProgressAt', trend_row.last_progress_at,
    'generatedAt', snapshot_row.generated_at,
    'stale', snapshot_row.generated_at is null
      or snapshot_row.generated_at < timezone('utc', now()) - interval '10 minutes'
  );
end;
$$;

notify pgrst, 'reload schema';

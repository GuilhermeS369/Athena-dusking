-- Chave Zernio sem autorização: encerrar local em vez de ficar em dead_letter.
--
-- INCIDENTE QUE MOTIVOU (10/09/2026, org Pomodoro, grupo "Miguel", job
-- c7f94841-301e-4020-9f68-d51acca79a4b):
--
--   A exclusão do grupo apagou as 119 mídias e o próprio grupo, mas os 15
--   perfis Zernio falharam TODOS com HTTP 401 na primeira tentativa e foram
--   direto para dead_letter. Não foi chave individual: 12 chaves distintas
--   falharam dentro de 5 segundos. A última reciclagem Zernio bem-sucedida da
--   organização foi 03/09 22:26. A migration 374 já registrou a causa com número:
--   em 04/09 a Zernio suspendeu 2.004 das 2.166 conexões ativas — 100% das da
--   Pomodoro — e passou a devolver 401 para chaves que funcionavam horas antes.
--   Hoje a organização tem 938 perfis meta_official e 626 Zernio em
--   reauthorization_required.
--
--   A 374 tratou a SITUAÇÃO dos perfis que ficam (marcou reautorização
--   necessária, reversível pela reconexão via Meta da migration 373). Faltava o
--   outro lado: o que fazer com quem foi mandado embora e não consegue sair.
--
-- POR QUE O 401 NÃO VOLTA SOZINHO. O cliente marca retryable apenas para 429 e
-- 5xx (lib/integrations/zernio-client.ts), então 401 vira `terminal_error` e
-- dead_letter na tentativa 1 — corretamente, porque repetir um 401 não muda
-- nada. Mas dead_letter é uma parada sem volta: claim_zernio_profile_recycling_jobs
-- não reivindica esse status. O perfil fica preso para sempre, sem grupo, com a
-- fila já cancelada, visível na tela como se ainda houvesse o que fazer.
--
-- POR QUE ENCERRAR LOCAL É HONESTO AQUI. A conta remota NÃO foi removida, e
-- isto não finge que foi: `remote_result` grava
-- `closed_without_remote_removal`, o `remote_http_status` 401 e a mensagem de
-- erro originais ficam onde estavam, e o evento registra que a vaga remota pode
-- continuar ocupada. O que muda é só o lado do Athena, que é o único lado sobre
-- o qual ainda temos poder: sem a chave, não existe chamada capaz de apagar
-- aquela conta.
--
-- POR QUE NÃO REUSA close-verified-zernio-dead-letter.mjs. Aquele script exige
-- provar contra a própria Zernio que a conta sumiu, usando a chave da conexão.
-- Com 401 essa prova é impossível por construção — e o script recusa, o que
-- está certo. Ele resolve o caso oposto: chave viva confirmando ausência.
--
-- A FUNÇÃO NÃO DUPLICA O CAMINHO DE SUCESSO. Ela delega a
-- contain_instagram_profile_for_removal (migration 342) com
-- p_finalize_local => true, que é exatamente o mesmo corpo que
-- complete_zernio_profile_recycling usa para conter a fila, desfazer o vínculo
-- de grupo e fazer o soft-delete. Duas cópias divergiriam.

-- O vocabulário de resultado ganha o caso novo -------------------------------

alter table public.zernio_profile_recycling_jobs
  drop constraint if exists zernio_profile_recycling_jobs_last_outcome_check;

alter table public.zernio_profile_recycling_jobs
  add constraint zernio_profile_recycling_jobs_last_outcome_check
  check (last_outcome is null or last_outcome in (
    'remote_deleted', 'already_disconnected_404', 'retryable_error', 'terminal_error',
    'closed_without_remote_removal'
  ));

-- Encerramento local ----------------------------------------------------------

create or replace function public.finalize_zernio_removal_without_remote(
  p_organization_id uuid,
  p_incident_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  incident_row public.zernio_profile_disconnection_incidents%rowtype;
  job_row public.zernio_profile_recycling_jobs%rowtype;
  containment jsonb;
  reason_message text := left(
    coalesce(nullif(trim(p_reason), ''),
      'Chave Zernio sem autorização (401): a conta remota não pôde ser removida e o perfil foi encerrado apenas no Athena.'),
    1200);
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_organization_role(p_organization_id, array['admin', 'operator']::public.organization_role[]) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;

  select incident.* into incident_row
  from public.zernio_profile_disconnection_incidents incident
  where incident.id = p_incident_id
    and incident.organization_id = p_organization_id
  for update;

  if not found then
    return jsonb_build_object('closed', false, 'reason', 'incident_not_found');
  end if;

  -- Idempotente: repetir sobre um incidente já encerrado não é erro nem
  -- reabre nada. Quem chama em laço (o worker, o painel) não precisa saber
  -- quem já passou por aqui.
  if incident_row.state = 'completed' then
    return jsonb_build_object('closed', false, 'reason', 'already_completed');
  end if;

  -- SÓ dead_letter. Um incidente ainda vivo pertence ao pipeline normal, que
  -- pode muito bem conseguir apagar a conta remota; encerrar local por cima
  -- dele esconderia uma vaga que ainda dá para liberar.
  if incident_row.state <> 'dead_letter' then
    return jsonb_build_object('closed', false, 'reason', 'not_dead_letter', 'state', incident_row.state);
  end if;

  select job.* into job_row
  from public.zernio_profile_recycling_jobs job
  where job.incident_id = incident_row.id
  for update;

  containment := public.contain_instagram_profile_for_removal(
    p_organization_id,
    incident_row.profile_id,
    incident_row.id,
    'zernio_key_unauthorized',
    reason_message,
    'system: zernio-unauthorized-local-close',
    true
  );

  update public.zernio_profile_disconnection_incidents set
    state = 'completed',
    -- remote_http_status e error_message ficam como estavam: são a evidência de
    -- por que a conta remota não saiu, e apagá-las tornaria este encerramento
    -- indistinguível de uma remoção bem-sucedida.
    remote_result = 'closed_without_remote_removal',
    remote_completed_at = timezone('utc', now()),
    finalized_at = timezone('utc', now()),
    defer_reason = null,
    ignored_item_count = coalesce((containment ->> 'ignoredItemCount')::integer, 0),
    interrupted_plan_count = coalesce((containment ->> 'interruptedPlanCount')::integer, 0),
    updated_at = timezone('utc', now())
  where id = incident_row.id;

  if job_row.id is not null then
    update public.zernio_profile_recycling_jobs set
      status = 'completed',
      claimed_by = null,
      lease_until = null,
      completed_at = timezone('utc', now()),
      last_outcome = 'closed_without_remote_removal',
      deferred_reason = null
      -- dead_letter_at preservado de propósito: é quando o pipeline parou.
    where id = job_row.id;

    insert into public.zernio_profile_recycling_job_events (
      organization_id, job_id, incident_id, event_type,
      previous_status, status, attempt_count, reason, metadata
    ) values (
      p_organization_id, job_row.id, incident_row.id, 'completed',
      job_row.status, 'completed', job_row.attempt_count, reason_message,
      jsonb_build_object(
        'outcome', 'closed_without_remote_removal',
        'httpStatus', incident_row.remote_http_status,
        'remoteAccountStillPresent', true,
        'zernioAccountId', incident_row.zernio_account_id
      )
    );
  end if;

  return jsonb_build_object(
    'closed', true,
    'incidentId', incident_row.id,
    'profileId', incident_row.profile_id,
    'username', incident_row.username_snapshot,
    'ignoredItemCount', coalesce((containment ->> 'ignoredItemCount')::integer, 0),
    'interruptedPlanCount', coalesce((containment ->> 'interruptedPlanCount')::integer, 0)
  );
end;
$$;

revoke all on function public.finalize_zernio_removal_without_remote(uuid, uuid, text) from public, anon;
grant execute on function public.finalize_zernio_removal_without_remote(uuid, uuid, text) to authenticated, service_role;

notify pgrst, 'reload schema';

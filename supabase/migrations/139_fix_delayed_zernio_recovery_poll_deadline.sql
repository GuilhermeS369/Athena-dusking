-- Mantém uma janela real de confirmação para a criação substituta da Zernio.
--
-- A versão original calculava o poll da recuperação como +6 minutos a partir
-- da primeira criação. Quando um item histórico era recuperado depois desse
-- marco, a criação substituta era consultada quase imediatamente e podia ser
-- encerrada como timeout antes de o Instagram terminar o processamento.

create or replace function public.schedule_zernio_media_download_recovery(
  p_item_id uuid,
  p_worker_id text,
  p_creation_id text,
  p_error_code text,
  p_error_message text,
  p_url_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
  now_at timestamptz := timezone('utc', now());
  replacement_poll_at timestamptz := now_at + interval '3 minutes';
begin
  select item.* into item_row
  from public.publication_items item
  where item.id = p_item_id
    and item.claimed_by = trim(p_worker_id)
    and item.lease_until > now_at
    and item.status in ('preparing', 'publishing')
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Item não está sob lease deste worker.';
  end if;
  if item_row.creation_id is distinct from trim(p_creation_id) then
    raise exception using errcode = '22023', message = 'A criação Zernio não corresponde ao item.';
  end if;
  if item_row.zernio_recovery_count >= 1 then
    return jsonb_build_object('scheduled', false, 'reason', 'recovery_already_used');
  end if;
  if item_row.container_poll_count <> 1 or item_row.provider_creation_started_at is null then
    return jsonb_build_object('scheduled', false, 'reason', 'recovery_requires_second_poll');
  end if;

  insert into public.publication_zernio_recoveries (
    organization_id,
    publication_item_id,
    original_creation_id,
    original_creation_started_at,
    original_url_fingerprint,
    replacement_poll_at,
    error_code,
    error_message
  ) values (
    item_row.organization_id,
    item_row.id,
    trim(p_creation_id),
    item_row.provider_creation_started_at,
    nullif(trim(coalesce(p_url_fingerprint, '')), ''),
    replacement_poll_at,
    left(trim(p_error_code), 120),
    left(trim(p_error_message), 1200)
  ) on conflict (publication_item_id) do nothing;

  if not found then
    return jsonb_build_object('scheduled', false, 'reason', 'recovery_already_recorded');
  end if;

  update public.publication_items item
  set status = 'waiting',
      creation_id = null,
      provider_creation_started_at = null,
      container_poll_count = 0,
      zernio_recovery_count = 1,
      claimed_by = null,
      lease_until = null,
      zernio_recovery_poll_at = replacement_poll_at,
      next_attempt_at = now_at,
      last_error_code = null,
      last_error_message = null
  where item.id = item_row.id;

  perform public.log_publication_item_event(
    item_row.id,
    'retry_requested',
    item_row.status,
    'waiting',
    null,
    trim(p_worker_id),
    'zernio_media_download_recovery',
    'A Zernio aceitou uma recriação única com nova URL após o Instagram não baixar a mídia.',
    jsonb_build_object(
      'original_creation_id', trim(p_creation_id),
      'url_fingerprint', p_url_fingerprint,
      'replacement_poll_at', replacement_poll_at
    )
  );

  return jsonb_build_object(
    'scheduled', true,
    'recoveryCount', 1,
    'replacementPollAt', replacement_poll_at
  );
end;
$$;

revoke all on function public.schedule_zernio_media_download_recovery(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.schedule_zernio_media_download_recovery(uuid, text, text, text, text, text)
  to service_role;

notify pgrst, 'reload schema';

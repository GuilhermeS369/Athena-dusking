-- Profiles dedicados cuja abertura do OAuth falhou ainda não possuem conta e
-- podem voltar ao pool. Falhas posteriores ao callback continuam exigindo
-- limpeza explícita para nunca reutilizar um profile remoto contaminado.

create or replace function public.release_zernio_attempt_remote_profile(
  p_attempt_id uuid,
  p_reason text
)
returns boolean language plpgsql security definer set search_path = public as $$
declare released boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  update public.zernio_connection_remote_profiles remote_profile
  set status = case
        when kind = 'canonical' then 'available'
        when p_reason = 'oauth_start_failed' then 'available'
        else 'cleanup_pending'
      end,
      claimed_by_attempt_id = null,
      released_at = timezone('utc', now()),
      release_reason = left(coalesce(p_reason, 'released'), 200),
      updated_at = timezone('utc', now())
  where remote_profile.claimed_by_attempt_id = p_attempt_id
    and remote_profile.status = 'claimed'
  returning true into released;
  return coalesce(released, false);
end;
$$;

revoke all on function public.release_zernio_attempt_remote_profile(uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_zernio_attempt_remote_profile(uuid, text)
  to service_role;

notify pgrst, 'reload schema';

-- Transferência global X idempotente, auditada e autorizada nas duas organizações.

alter table public.twitter_identity_transfer_events
  add column actor_user_id uuid references auth.users (id) on delete set null,
  add column idempotency_key text not null default ('legacy:' || gen_random_uuid()::text);

alter table public.twitter_identity_transfer_events
  alter column idempotency_key drop default,
  add constraint twitter_identity_transfer_events_idempotency_key_check
    check (char_length(trim(idempotency_key)) between 8 and 255),
  add constraint twitter_identity_transfer_events_idempotency_key_key unique (idempotency_key);

create or replace function public.twitter_transfer_identity_organization_v2(
  p_identity_id uuid,
  p_from_organization_id uuid,
  p_to_organization_id uuid,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text,
  p_idempotency_key text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  identity_row public.twitter_global_identities;
  replay public.twitter_identity_transfer_events;
  wallet_balance bigint;
  wallet_version bigint;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Transferência exige operação administrativa.';
  end if;
  if p_identity_id is null or p_from_organization_id is null or p_to_organization_id is null
    or p_actor_user_id is null or p_from_organization_id = p_to_organization_id
    or char_length(trim(coalesce(p_reason, ''))) < 5
    or char_length(trim(coalesce(p_reason, ''))) > 1000
    or char_length(trim(coalesce(p_actor_email, ''))) < 3
    or char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 255
  then raise exception using errcode = '22023', message = 'Transferência inválida.';
  end if;

  select * into replay from public.twitter_identity_transfer_events
  where idempotency_key = trim(p_idempotency_key);
  if found then
    if replay.identity_id <> p_identity_id or replay.from_organization_id <> p_from_organization_id
      or replay.to_organization_id <> p_to_organization_id or replay.actor_user_id is distinct from p_actor_user_id
    then raise exception using errcode = '23505', message = 'Chave idempotente já usada em outra transferência.';
    end if;
    return jsonb_build_object('identityId', p_identity_id, 'transferred', true, 'idempotentReplay', true);
  end if;

  if not exists (select 1 from public.organizations where id=p_to_organization_id and deleted_at is null) then
    raise exception using errcode = 'P0002', message = 'Organização de destino indisponível.';
  end if;
  if not exists (
    select 1 from public.organization_members
    where user_id=p_actor_user_id and role='admin' and organization_id=p_from_organization_id
  ) or not exists (
    select 1 from public.organization_members
    where user_id=p_actor_user_id and role='admin' and organization_id=p_to_organization_id
  ) then raise exception using errcode='42501',message='Administração da origem e do destino é obrigatória.';
  end if;

  select * into identity_row from public.twitter_global_identities
  where id=p_identity_id for update;
  if not found or identity_row.current_organization_id <> p_from_organization_id then
    raise exception using errcode='P0002',message='Identidade não encontrada para transferência.';
  end if;
  if exists (select 1 from public.twitter_wallet_reservations where identity_id=p_identity_id and remaining_micros>0) then
    raise exception using errcode='55000',message='Resolva todas as reservas antes da transferência.';
  end if;
  if exists (select 1 from public.twitter_connections where identity_id=p_identity_id and deleted_at is null and status<>'deleted') then
    raise exception using errcode='55000',message='Remova a conexão ativa antes da transferência.';
  end if;

  update public.twitter_global_identities set current_organization_id=p_to_organization_id,
    transferred_at=timezone('utc',now()) where id=p_identity_id;
  update public.twitter_wallets set organization_id=p_to_organization_id,version=version+1
    where identity_id=p_identity_id returning posted_balance_micros,version into wallet_balance,wallet_version;
  if not found then raise exception using errcode='P0002',message='Carteira da identidade não encontrada.'; end if;

  insert into public.twitter_identity_transfer_events(
    identity_id,from_organization_id,to_organization_id,reason,actor_user_id,actor_email,idempotency_key
  ) values (
    p_identity_id,p_from_organization_id,p_to_organization_id,trim(p_reason),p_actor_user_id,
    lower(trim(p_actor_email)),trim(p_idempotency_key)
  );
  return jsonb_build_object('identityId',p_identity_id,'transferred',true,'idempotentReplay',false,
    'postedBalanceMicros',wallet_balance,'walletVersion',wallet_version);
end $$;

revoke execute on function public.twitter_transfer_identity_organization(uuid,uuid,uuid,text,text) from service_role;
revoke all on function public.twitter_transfer_identity_organization_v2(uuid,uuid,uuid,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.twitter_transfer_identity_organization_v2(uuid,uuid,uuid,text,uuid,text,text) to service_role;

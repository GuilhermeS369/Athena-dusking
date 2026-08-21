-- Fase 2C: uma intenção durável impede duplo clique/retry de criar mais de uma
-- tentativa ou reserva. O callback usa a tentativa como autoridade de destino.

create table public.zernio_connection_intents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 160),
  requested_connection_id uuid not null references public.zernio_connections(id) on delete restrict,
  requested_group_id uuid references public.profile_groups(id) on delete set null,
  resolved_connection_id uuid references public.zernio_connections(id) on delete set null,
  reservation_id uuid references public.zernio_connection_slot_reservations(id) on delete set null,
  attempt_id uuid references public.zernio_connection_attempts(id) on delete set null,
  status text not null default 'started' check (status in (
    'started', 'reserved', 'redirected', 'callback_received', 'synced', 'empty', 'failed', 'expired'
  )),
  diagnostic jsonb not null default '{}'::jsonb check (jsonb_typeof(diagnostic) = 'object'),
  expires_at timestamptz not null default (timezone('utc', now()) + interval '30 minutes'),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (organization_id, created_by, idempotency_key)
);

create trigger zernio_connection_intents_set_updated_at
before update on public.zernio_connection_intents
for each row execute function public.set_updated_at();

create index zernio_connection_intents_active_idx
  on public.zernio_connection_intents (organization_id, created_by, status, expires_at);

alter table public.zernio_connection_intents enable row level security;
create policy zernio_connection_intents_select_operator
  on public.zernio_connection_intents for select to authenticated
  using (
    created_by = (select auth.uid())
    and public.has_organization_role(organization_id, array['admin', 'operator']::public.organization_role[])
  );

alter table public.zernio_connection_slot_reservations
  add column zernio_connection_intent_id uuid
  references public.zernio_connection_intents(id) on delete set null;

create unique index zernio_slot_reservations_intent_idx
  on public.zernio_connection_slot_reservations(zernio_connection_intent_id)
  where zernio_connection_intent_id is not null;

alter table public.zernio_connection_attempts
  add column zernio_connection_intent_id uuid
  references public.zernio_connection_intents(id) on delete set null;

create unique index zernio_connection_attempts_intent_idx
  on public.zernio_connection_attempts(zernio_connection_intent_id)
  where zernio_connection_intent_id is not null;

create or replace function public.claim_zernio_connection_intent(
  p_organization_id uuid,
  p_created_by uuid,
  p_idempotency_key text,
  p_requested_connection_id uuid,
  p_requested_group_id uuid default null
)
returns table(intent_id uuid, intent_status text, reused boolean)
language plpgsql security definer set search_path = public as $$
declare existing public.zernio_connection_intents%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Ação permitida somente ao servidor.';
  end if;
  if char_length(trim(coalesce(p_idempotency_key, ''))) not between 8 and 160 then
    raise exception using errcode = '22023', message = 'Chave de idempotência inválida.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':' || p_created_by::text || ':' || trim(p_idempotency_key), 0
  ));

  select * into existing
  from public.zernio_connection_intents
  where organization_id = p_organization_id
    and created_by = p_created_by
    and idempotency_key = trim(p_idempotency_key);

  if found then
    if existing.requested_connection_id <> p_requested_connection_id
       or existing.requested_group_id is distinct from p_requested_group_id then
      raise exception using errcode = '22023', message = 'A intenção já existe com outro destino.';
    end if;
    intent_id := existing.id;
    intent_status := existing.status;
    reused := true;
    return next;
    return;
  end if;

  insert into public.zernio_connection_intents (
    organization_id, created_by, idempotency_key, requested_connection_id, requested_group_id
  ) values (
    p_organization_id, p_created_by, trim(p_idempotency_key), p_requested_connection_id, p_requested_group_id
  ) returning id, status into intent_id, intent_status;
  reused := false;
  return next;
end;
$$;

revoke all on public.zernio_connection_intents from public, anon, authenticated;
grant select on public.zernio_connection_intents to authenticated;
grant all on public.zernio_connection_intents to service_role;
revoke all on function public.claim_zernio_connection_intent(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_zernio_connection_intent(uuid, uuid, text, uuid, uuid) to service_role;

notify pgrst, 'reload schema';

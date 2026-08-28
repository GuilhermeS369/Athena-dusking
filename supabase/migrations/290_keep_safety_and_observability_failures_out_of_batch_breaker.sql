create or replace function public.is_publication_non_pausing_failure(
  p_error_code text,
  p_error_message text
) returns boolean
language sql
stable
parallel safe
as $$
  select public.is_publication_infrastructure_error(p_error_code, p_error_message)
    or public.is_publication_duplicate_content_failure(p_error_code, p_error_message)
    or lower(trim(coalesce(p_error_code, ''))) in (
      '42804',
      'zernio_creation_outcome_unknown',
      'publication_outcome_unknown',
      'zernio_recovery_confirmation_timeout'
    );
$$;

create or replace function public.apply_publication_batch_failure_circuit_breaker()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row public.publication_items%rowtype;
begin
  if new.event_type not in ('published', 'failed') then return new; end if;

  select item.* into item_row
  from public.publication_items item
  where item.id = new.publication_item_id;
  if item_row.id is null then return new; end if;

  if new.event_type = 'failed' and (
    item_row.next_attempt_at is not null
    or public.is_publication_non_pausing_failure(new.error_code, new.error_message)
  ) then
    return new;
  end if;

  insert into public.publication_batch_terminal_outcomes (
    publication_item_id, batch_id, organization_id, outcome, event_id, reconciled_at
  ) values (
    item_row.id, item_row.batch_id, item_row.organization_id,
    case when new.event_type = 'published' then 'published' else 'failed' end,
    new.id, null
  ) on conflict (publication_item_id) do nothing;

  return new;
end;
$$;

-- O ledger é derivado; os eventos completos continuam preservados.
delete from public.publication_batch_terminal_outcomes outcome
using public.publication_item_events event
where outcome.event_id = event.id
  and outcome.outcome = 'failed'
  and public.is_publication_non_pausing_failure(event.error_code, event.error_message);

revoke all on function public.is_publication_non_pausing_failure(text, text)
  from public, anon, authenticated;
grant execute on function public.is_publication_non_pausing_failure(text, text)
  to service_role;

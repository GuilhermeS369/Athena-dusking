-- Incidente 29/08/2026, achado independente: 182 itens (181 na organização
-- Pomodoro, desde 25/08) ficam presos num estado que não é nem reivindicável
-- nem terminal, entupindo a fila visível indefinidamente.
--
-- claim_publication_items exige, para itens em 'failed':
--
--   and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
--
-- Logo, um item em 'failed' com next_attempt_at NULL (ou attempt_count >= 5)
-- nunca mais pode ser reivindicado — é uma falha terminal por definição. Mas
-- ele continua com archived_at NULL, então segue aparecendo como fila ativa
-- para sempre.
--
-- clean_publication_queue_finished (270) até arquiva esse estado, mas gasta
-- todo o orçamento da chamada com itens JÁ encerrados (published/cancelled/
-- removed/ignored) antes de chegar nas falhas:
--
--   limit greatest(resolved_limit - completed_count, 0)
--
-- Com ~155 mil itens encerrados pendentes de limpeza em produção, o botão
-- "Limpar encerradas" nunca alcança as falhas terminais na prática.
--
-- Esta migration adiciona uma limpeza dedicada, que só toca falhas terminais e
-- por isso não pode ser faminta. Mantém exatamente a mesma semântica de
-- arquivamento e de reconhecimento de falha já usada pela 270 (archived_at +
-- publication_failure_acknowledgements), para não criar um segundo conceito.

create or replace function public.clean_publication_queue_terminal_failures(
  p_organization_id uuid,
  p_limit integer default 2000,
  p_settled_minutes integer default 15
)
returns table (
  archived_failure_count integer,
  remaining_failure_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  resolved_limit integer := least(greatest(coalesce(p_limit, 2000), 1), 5000);
  settled_before timestamptz;
  archived_count integer := 0;
  remaining_count bigint := 0;
begin
  if auth.role() <> 'service_role' and (
    actor_id is null or not public.has_organization_role(
      p_organization_id,
      array['admin', 'operator']::public.organization_role[]
    )
  ) then
    raise exception using errcode = '42501', message = 'Ação não permitida.';
  end if;
  if p_settled_minutes not between 0 and 10080 then
    raise exception using errcode = '22023', message = 'Janela de acomodação inválida.';
  end if;

  -- Margem de acomodação: uma falha recém-gravada pode ainda receber
  -- next_attempt_at do worker que a registrou. Só arquivamos o que já passou
  -- dessa janela, para nunca cancelar um retry legítimo por corrida.
  settled_before := timezone('utc', now()) - make_interval(mins => p_settled_minutes);

  with candidates as (
    select item.id
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status = 'failed'
      and (item.next_attempt_at is null or item.attempt_count >= 5)
      and item.updated_at < settled_before
    order by item.created_at, item.id
    limit resolved_limit
    for update skip locked
  ), archived as (
    update public.publication_items item
    set archived_at = timezone('utc', now()), archived_by = actor_id
    from candidates
    where item.id = candidates.id
    returning item.id, item.batch_id
  ), acknowledged as (
    insert into public.publication_failure_acknowledgements (
      publication_item_id, organization_id, acknowledged_by, scope
    )
    select archived.id, p_organization_id, actor_id, 'visible_items'
    from archived
    on conflict (publication_item_id) do nothing
  )
  select count(*)::integer into archived_count from archived;

  select count(*)::bigint into remaining_count
  from public.publication_items item
  where item.organization_id = p_organization_id
    and item.archived_at is null
    and item.status = 'failed'
    and (item.next_attempt_at is null or item.attempt_count >= 5)
    and item.updated_at < settled_before;

  return query select archived_count, remaining_count;
end;
$$;

revoke all on function public.clean_publication_queue_terminal_failures(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.clean_publication_queue_terminal_failures(uuid, integer, integer)
  to authenticated, service_role;

-- Índice parcial para a varredura acima não depender de sequential scan em
-- publication_items conforme a tabela cresce.
create index if not exists publication_items_terminal_failure_cleanup_idx
  on public.publication_items (organization_id, created_at, id)
  where archived_at is null and status = 'failed';

notify pgrst, 'reload schema';

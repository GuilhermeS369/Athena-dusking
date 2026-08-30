-- O arquivamento de falhas deixa de cancelar retries legítimos.
--
-- O QUE ACONTECEU. Até a migration 302, `clean_publication_queue_finished`
-- arquivava QUALQUER item em 'failed', sem olhar `next_attempt_at` nem
-- `attempt_count`. Isso era tolerável enquanto o arquivamento dependia de
-- alguém clicar "Limpar encerradas" na tela: raro, e com ~155 mil encerrados de
-- backlog o orçamento da chamada se esgotava em published/cancelled antes de
-- alcançar as falhas — o próprio cabeçalho da 327 registra isso.
--
-- Em 29/08/2026 o commit 1eb7202 (B2) pôs esse arquivamento em laço automático
-- no media-maintenance-worker, a cada 10 minutos. E a 333 drenou o backlog. As
-- duas premissas que tornavam o bug inofensivo caíram juntas: agora sobra
-- orçamento todo ciclo e as falhas são alcançadas sempre.
--
-- POR QUE ISSO PERDE PUBLICAÇÃO. `claim_publication_items` (325) exige:
--
--   where item.archived_at is null
--     and (item.status <> 'failed' or (item.attempt_count < 5 and item.next_attempt_at is not null))
--
-- Um item que falhou e tem retry marcado para daqui a 20 minutos era arquivado
-- antes disso. Com `archived_at` preenchido ele nunca mais é reivindicado — a
-- publicação simplesmente não acontece. E como a mesma rotina insere
-- `publication_failure_acknowledgements`, ele também some do KPI de ERROS.
-- Falha silenciosa, sem sinal em tela nenhuma.
--
-- A CORREÇÃO. A 327 já criou o predicado certo em
-- `clean_publication_queue_terminal_failures`, com janela de acomodação — mas
-- nenhum código chama essa função. Em vez de criar um segundo ponto de chamada
-- (e deixar a versão cega viva para quem esquecer), o predicado terminal entra
-- aqui, no caminho que o worker E o botão "Limpar encerradas" já usam.
--
-- `remaining_finished_count` usa exatamente o mesmo predicado. Se contasse as
-- falhas retentáveis que agora não são mais arquivadas, o laço do worker e o
-- `while (remaining > 0)` do hook nunca veriam saldo zero.
--
-- Encerrados (published/cancelled/removed/ignored) seguem sem janela: são
-- terminais por definição, nenhum worker volta a tocá-los.

create or replace function public.clean_publication_queue_finished(
  p_organization_id uuid,
  p_limit integer default 250,
  p_settled_minutes integer default 15
)
returns table (
  archived_completed_count integer,
  archived_failure_count integer,
  remaining_finished_count bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  resolved_limit integer := least(greatest(coalesce(p_limit, 250), 1), 250);
  settled_minutes integer := least(greatest(coalesce(p_settled_minutes, 15), 0), 10080);
  settled_before timestamptz;
  completed_count integer := 0;
  failure_count integer := 0;
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

  -- Margem de acomodação: uma falha recém-gravada pode ainda receber
  -- next_attempt_at do worker que a registrou. Só arquivamos o que já passou
  -- dessa janela, para nunca cancelar um retry legítimo por corrida.
  settled_before := timezone('utc', now()) - make_interval(mins => settled_minutes);

  with candidates as (
    select item.id
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status in ('published', 'cancelled', 'removed', 'ignored')
    order by item.created_at, item.id
    limit resolved_limit
    for update skip locked
  ), archived as (
    update public.publication_items item
    set archived_at = timezone('utc', now()), archived_by = actor_id
    from candidates
    where item.id = candidates.id
    returning item.id
  )
  select count(*)::integer into completed_count from archived;

  -- Só falha terminal: exatamente a condição sob a qual claim_publication_items
  -- recusa o item. Se ele ainda pode ser reivindicado, não é lixo — é trabalho.
  with candidates as (
    select item.id
    from public.publication_items item
    where item.organization_id = p_organization_id
      and item.archived_at is null
      and item.status = 'failed'
      and (item.next_attempt_at is null or item.attempt_count >= 5)
      and item.updated_at < settled_before
    order by item.created_at, item.id
    limit greatest(resolved_limit - completed_count, 0)
    for update skip locked
  ), archived as (
    update public.publication_items item
    set archived_at = timezone('utc', now()), archived_by = actor_id
    from candidates
    where item.id = candidates.id
    returning item.id
  ), acknowledged as (
    insert into public.publication_failure_acknowledgements (
      publication_item_id, organization_id, acknowledged_by, scope
    )
    select id, p_organization_id, actor_id, 'visible_items'
    from archived
    on conflict (publication_item_id) do nothing
  )
  select count(*)::integer into failure_count from archived;

  insert into public.publication_queue_action_audits (
    organization_id, actor_user_id, action, affected_count, item_ids, metadata
  ) values
    (p_organization_id, actor_id, 'archive_completed', completed_count, '{}'::uuid[],
      jsonb_build_object('scope', 'queue_cleanup', 'bulk', true, 'throttled', true)),
    (p_organization_id, actor_id, 'acknowledge_failures', failure_count, '{}'::uuid[],
      jsonb_build_object('scope', 'queue_cleanup', 'archived', true, 'bulk', true,
        'throttled', true, 'terminalOnly', true, 'settledMinutes', settled_minutes));

  -- Mesmo predicado do que foi arquivado acima. Um saldo que inclui falha
  -- retentável nunca zera, e tanto o laço do worker quanto o `while (remaining
  -- > 0)` do hook rodariam para sempre sem conseguir arquivar nada.
  --
  -- Duas contagens somadas, e não um OR: cada metade tem seu índice parcial
  -- (`publication_items_finished_cleanup_idx` e
  -- `publication_items_terminal_failure_cleanup_idx`) e um OR entre predicados
  -- de índices parciais diferentes derruba os dois para sequential scan.
  select count(*) into remaining_count
  from public.publication_items item
  where item.organization_id = p_organization_id
    and item.archived_at is null
    and item.status in ('published', 'cancelled', 'removed', 'ignored');

  select remaining_count + count(*) into remaining_count
  from public.publication_items item
  where item.organization_id = p_organization_id
    and item.archived_at is null
    and item.status = 'failed'
    and (item.next_attempt_at is null or item.attempt_count >= 5)
    and item.updated_at < settled_before;

  return query select completed_count, failure_count, remaining_count;
end;
$$;

revoke all on function public.clean_publication_queue_finished(uuid, integer, integer) from public, anon;
grant execute on function public.clean_publication_queue_finished(uuid, integer, integer) to authenticated, service_role;

-- A assinatura de dois argumentos continua existindo no schema depois de um
-- `create or replace` com parâmetro novo. Removê-la é obrigatório: o PostgREST
-- resolve a RPC pelos argumentos enviados, e o worker e a rota mandam só
-- p_organization_id e p_limit — cairiam na versão antiga, cega, que este
-- arquivo existe para aposentar.
drop function if exists public.clean_publication_queue_finished(uuid, integer);

notify pgrst, 'reload schema';

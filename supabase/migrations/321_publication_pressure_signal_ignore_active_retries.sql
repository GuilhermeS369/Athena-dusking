-- Reels (e outros formatos) legitimamente demoram mais que o limiar de 60s do
-- sinal de pressão para sair de "aceito pelo provedor" (creation_id definido)
-- até publicado — o container leva tempo para processar no lado da Meta/Zernio
-- e o item fica em ciclo normal de poll/retry (next_attempt_at no futuro
-- próximo, ou lease_until no futuro enquanto um worker o processa agora).
-- O sinal atual conta esse relógio vencido como criticalDelay mesmo quando
-- nada está de fato parado, e a Fase 6 do plano de deadlock de staging
-- (2026-08-28) fez o publication-generation-worker ceder incondicionalmente a
-- qualquer criticalDelay — na prática, qualquer lote de Reels em
-- processamento normal congela a geração até o item concluir sozinho.
--
-- Esta migração restringe "atrasado" a itens sem próximo retry agendado e sem
-- lease ativa, espelhando exatamente a condição de elegibilidade já usada por
-- claim_publication_items (313_prevent_late_unstarted_publication_claims.sql):
-- um item com next_attempt_at ou lease_until no futuro está, por definição,
-- fora de disputa por claim agora — não é um atraso crítico, é um item em voo.
-- Contrato de retorno (campos e tipos) inalterado; consumidores existentes
-- (staging, generation, zernio-sync, profile-analytics) não precisam mudar.

create or replace function public.get_publication_generation_pressure_signal(
  p_critical_delay_seconds integer default 60
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  oldest_due_at timestamptz;
  checked_at timestamptz := timezone('utc', now());
  has_overdue_accepted boolean := false;
  has_overdue_unstarted boolean := false;
begin
  if auth.role() <> 'service_role' then
    raise exception using errcode = '42501', message = 'Somente service_role pode consultar pressão global.';
  end if;
  if p_critical_delay_seconds not between 30 and 3600 then
    raise exception using errcode = '22023', message = 'Limite de atraso crítico inválido.';
  end if;

  select item.execute_at into oldest_due_at
  from public.publication_items item
  where item.archived_at is null
    and item.pipeline_version = 2
    and item.status in ('waiting', 'ready')
    and item.execute_at is not null
    and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
    and (item.next_attempt_at is null or item.next_attempt_at <= checked_at)
    and (item.lease_until is null or item.lease_until <= checked_at)
  order by item.execute_at, item.id
  limit 1;

  if oldest_due_at is not null then
    select
      exists (
        select 1 from public.publication_items item
        where item.archived_at is null
          and item.pipeline_version = 2
          and item.status in ('waiting', 'ready')
          and item.execute_at is not null
          and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
          and (item.next_attempt_at is null or item.next_attempt_at <= checked_at)
          and (item.lease_until is null or item.lease_until <= checked_at)
          and item.creation_id is not null
      ),
      exists (
        select 1 from public.publication_items item
        where item.archived_at is null
          and item.pipeline_version = 2
          and item.status in ('waiting', 'ready')
          and item.execute_at is not null
          and item.execute_at <= checked_at - make_interval(secs => p_critical_delay_seconds)
          and (item.next_attempt_at is null or item.next_attempt_at <= checked_at)
          and (item.lease_until is null or item.lease_until <= checked_at)
          and item.creation_id is null
      )
    into has_overdue_accepted, has_overdue_unstarted;
  end if;

  return jsonb_build_object(
    'criticalDelay', oldest_due_at is not null,
    'oldestDueAt', oldest_due_at,
    'overdueCurrent', case when oldest_due_at is null then 0 else 1 end,
    'overdueAccepted', has_overdue_accepted,
    'overdueUnstarted', has_overdue_unstarted,
    'checkedAt', checked_at
  );
end;
$$;

revoke all on function public.get_publication_generation_pressure_signal(integer)
  from public, anon, authenticated;
grant execute on function public.get_publication_generation_pressure_signal(integer)
  to service_role;

notify pgrst, 'reload schema';

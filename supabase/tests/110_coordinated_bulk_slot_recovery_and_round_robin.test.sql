-- Teste manual/CI para a migration 110. Use organizações, lotes, perfis e
-- itens sintéticos dedicados; nunca execute contra itens reais em produção.

-- 1. Fairness: crie itens vencidos em pelo menos duas organizações. Um claim
--    com p_limit >= 2 deve devolver a primeira posição de cada organização
--    antes da segunda posição de qualquer uma.
-- select organization_id, count(*)
-- from public.claim_publication_items('test-round-robin-worker', 2, 120)
-- group by organization_id;
-- Esperado: no máximo um item por organização na primeira rodada.

-- 2. Slot em risco permanece bloqueado no claim regular:
-- select * from public.claim_publication_items('test-normal-worker', 10, 120);
-- Esperado: nenhum item cujo par (organization_id, batch_id, execute_at)
-- tenha incidente state='at_risk' e chave idempotency bulk:*.

-- 3. Recuperação só existe quando habilitada por organização e com janela:
-- insert into public.publication_slot_recovery_settings (
--   organization_id, enabled, max_items_per_cycle, min_safe_window_seconds, max_recovery_delay_seconds
-- ) values (:organization_id, true, 1, 120, 900)
-- on conflict (organization_id) do update set enabled = excluded.enabled;
-- select * from public.claim_publication_slot_recovery_items('test-recovery-worker', 10, 120);
-- Esperado: no máximo max_items_per_cycle para a organização; nenhum item se
-- próximo slot estiver dentro da janela de segurança ou se atraso exceder o máximo.

-- 4. Finalização não encerra o incidente enquanto houver item do slot ainda
--    não publicado, e muda para recovered apenas após todos serem publicados:
-- select public.finalize_publication_slot_recovery_incidents('test-recovery-worker');
-- select state, decision_reason, resolved_at
-- from public.publication_slot_risk_incidents
-- where organization_id = :organization_id and batch_id = :batch_id and slot_execute_at = :slot_execute_at;

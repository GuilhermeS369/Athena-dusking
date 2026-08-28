-- Repara somente os chunks atingidos na janela curta entre a migration 303 e
-- o restart do worker, quando o binário anterior ainda enviou passo 500.

update public.bulk_publication_generation_chunks chunk
set status = 'queued',
    claimed_by = null,
    lease_until = null,
    consecutive_failure_count = 0,
    retry_exhausted_at = null,
    last_error_message = null,
    attempt_count = greatest(chunk.attempt_count - 1, 0)
where chunk.last_error_message = 'Passo adaptativo deve estar entre 1 e 100 slots.'
  and chunk.updated_at >= timestamptz '2026-08-28 03:20:00+00'
  and chunk.updated_at < timestamptz '2026-08-28 03:23:00+00';

notify pgrst, 'reload schema';


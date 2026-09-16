-- Meta `25` "User access is restricted" (subcódigo 2207050) fora do disjuntor de lote.
--
-- Em 16/09/2026 a Meta passou a recusar a ESCRITA (POST /media) de 94 perfis
-- conectados entre 09 e 12/09, com leitura, token e cota intactos. Cada perfil
-- perde 1 reel por hora; é um problema do perfil, não do lote. Como os reels
-- desses perfis caem no mesmo minuto, 5 falhas seguidas pausaram 4 lotes
-- (05:20, 06:05, 06:21 e 10:22 BRT) e tudo que estava neles venceu: 1.557
-- posts perdidos com os publicadores folgados, 42.694 presos.
--
-- O contador do disjuntor continua valendo para os outros erros terminais.
-- O tratamento do `25` no nível do perfil fica para outra migration
-- (docs/fila-de-publicacao-MASTER.md, seção 6.2).

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
      'zernio_recovery_confirmation_timeout',
      -- Meta 25/2207050: restrição de escrita da conta (16/09/2026).
      '25'
    )
    or coalesce(p_error_message, '') ilike '%User access is restricted%';
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

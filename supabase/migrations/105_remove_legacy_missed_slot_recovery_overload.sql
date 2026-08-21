-- Evita ambiguidade do PostgREST entre a assinatura legada e a assinatura auditável.
drop function if exists public.recover_missed_publication_slots(integer, integer);

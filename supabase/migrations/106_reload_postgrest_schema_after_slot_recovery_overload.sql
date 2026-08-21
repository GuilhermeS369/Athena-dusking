-- Força o PostgREST a descartar o cache de funções após remover a sobrecarga
-- legada de recover_missed_publication_slots, eliminando a ambiguidade PGRST203.
notify pgrst, 'reload schema';

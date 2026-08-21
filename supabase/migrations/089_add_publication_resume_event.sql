-- A retomada é um evento explícito e separado de retry: ela redistribui apenas
-- o trabalho suspenso do par lote/perfil e nunca ocorre automaticamente.

alter type public.publication_item_event_type
  add value if not exists 'resumed';

-- Evento explícito para intervenções operacionais que corrigem uma legenda sem
-- alterar agendamento, mídia, perfil ou estado da publicação.
alter type public.publication_item_event_type add value if not exists 'caption_repaired';

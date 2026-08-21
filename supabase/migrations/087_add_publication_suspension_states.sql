-- Os novos valores de enum ficam em uma migration isolada porque o PostgreSQL
-- exige commit antes que um valor recém-adicionado seja usado por funções,
-- índices, constraints ou dados da migration seguinte.

alter type public.publication_item_status add value if not exists 'suspended';
alter type public.publication_item_event_type add value if not exists 'suspended';

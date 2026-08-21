-- A reciclagem Zernio encerra itens como ignored sem classificá-los como falha.
-- O status já existe; o evento imutável correspondente precisa existir também.
alter type public.publication_item_event_type add value if not exists 'ignored';

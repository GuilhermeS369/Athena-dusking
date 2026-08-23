-- O X permite publicar mídia sem legenda. Itens somente texto continuam sendo
-- barrados pela revisão quando o conteúdo estiver vazio.

alter table public.twitter_publication_items
  drop constraint if exists twitter_publication_items_weighted_characters_check;

alter table public.twitter_publication_items
  add constraint twitter_publication_items_weighted_characters_check
  check(weighted_characters between 0 and 25000);

notify pgrst,'reload schema';

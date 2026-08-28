-- O enum precisa ser confirmado em uma transação anterior às funções que o usam.
alter type public.twitter_item_status add value if not exists 'missed';


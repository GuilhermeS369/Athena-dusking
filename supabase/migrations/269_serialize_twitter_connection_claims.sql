-- Keep the distributed per-connection concurrency limit strict even when many
-- dispatcher instances claim simultaneously. The limit row is the lock/fence
-- for a connection, while SKIP LOCKED keeps unrelated connections progressing.

create or replace function public.twitter_ensure_connection_dispatch_limit()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.deleted_at is null then
    insert into public.twitter_connection_dispatch_limits(connection_id)
    values(new.id)
    on conflict(connection_id) do nothing;
  end if;
  return new;
end $$;

insert into public.twitter_connection_dispatch_limits(connection_id)
select connection_row.id
from public.twitter_connections connection_row
where connection_row.deleted_at is null
on conflict(connection_id) do nothing;

drop trigger if exists twitter_ensure_connection_dispatch_limit on public.twitter_connections;
create trigger twitter_ensure_connection_dispatch_limit
after insert or update of deleted_at on public.twitter_connections
for each row execute function public.twitter_ensure_connection_dispatch_limit();

do $$
declare
  claim_definition text;
begin
  select pg_get_functiondef('public.twitter_claim_publication_items_v2(text,integer,uuid)'::regprocedure)
  into claim_definition;

  if position('insert into public.twitter_connection_dispatch_limits(connection_id)' in claim_definition)=0
     or position('for update of locked_item skip locked' in claim_definition)=0 then
    raise exception 'A definição esperada do claim X V2 não foi encontrada.';
  end if;

  claim_definition:=regexp_replace(
    claim_definition,
    E'  insert into public\\.twitter_connection_dispatch_limits\\(connection_id\\)\\n  select connection_row\\.id from public\\.twitter_connections connection_row where connection_row\\.deleted_at is null\\n  on conflict do nothing;\\n',
    '',
    'g'
  );
  claim_definition:=replace(
    claim_definition,
    'for update of locked_item skip locked',
    'for update of locked_item,connection_limit skip locked'
  );

  if position('insert into public.twitter_connection_dispatch_limits(connection_id)' in claim_definition)>0
     or position('for update of locked_item,connection_limit skip locked' in claim_definition)=0 then
    raise exception 'Não foi possível endurecer o claim X V2.';
  end if;

  execute claim_definition;
end $$;

revoke all on function public.twitter_ensure_connection_dispatch_limit() from public,anon,authenticated;
revoke all on function public.twitter_claim_publication_items_v2(text,integer,uuid) from public,anon,authenticated;
grant execute on function public.twitter_claim_publication_items_v2(text,integer,uuid) to service_role;

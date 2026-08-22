do $$declare definition text;begin
 select pg_get_functiondef('public.twitter_confirm_analytics_job(uuid,uuid,text,text,integer,jsonb,jsonb)'::regprocedure)into definition;
 execute replace(definition,'normalized jsonb:=''[]'';','normalized jsonb:=''[]''::jsonb;');
 select pg_get_functiondef('public.twitter_complete_analytics_item(uuid,text,text,jsonb,timestamptz,integer,text,text,text,jsonb)'::regprocedure)into definition;
 execute replace(definition,';wallet public.twitter_wallets;',';');
end$$;

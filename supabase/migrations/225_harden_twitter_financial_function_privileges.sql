-- O Supabase concede EXECUTE explicitamente a anon/authenticated em funções novas.
-- Removemos os grants por papel, além do revoke de PUBLIC já feito na 223/224.

revoke execute on function public.twitter_register_identity_and_grant(uuid, text) from anon;
revoke execute on function public.twitter_get_wallet_snapshot(uuid, uuid) from anon;
revoke execute on function public.twitter_create_wallet_reservation(uuid, uuid, uuid, integer, public.twitter_price_category, public.twitter_financial_origin, uuid, bigint, bigint, text) from anon;
revoke execute on function public.twitter_release_wallet_reservation(uuid, text, text, boolean) from anon;
revoke execute on function public.twitter_settle_wallet_reservation(uuid, bigint, text, jsonb) from anon, authenticated;
revoke execute on function public.twitter_mark_reservation_outcome_unknown(uuid, text, text, jsonb) from anon, authenticated;
revoke execute on function public.twitter_transfer_identity_organization(uuid, uuid, uuid, text, text) from anon, authenticated;

grant execute on function public.twitter_register_identity_and_grant(uuid, text) to authenticated, service_role;
grant execute on function public.twitter_get_wallet_snapshot(uuid, uuid) to authenticated, service_role;
grant execute on function public.twitter_create_wallet_reservation(uuid, uuid, uuid, integer, public.twitter_price_category, public.twitter_financial_origin, uuid, bigint, bigint, text) to authenticated, service_role;
grant execute on function public.twitter_release_wallet_reservation(uuid, text, text, boolean) to authenticated, service_role;
grant execute on function public.twitter_settle_wallet_reservation(uuid, bigint, text, jsonb) to service_role;
grant execute on function public.twitter_mark_reservation_outcome_unknown(uuid, text, text, jsonb) to service_role;
grant execute on function public.twitter_transfer_identity_organization(uuid, uuid, uuid, text, text) to service_role;

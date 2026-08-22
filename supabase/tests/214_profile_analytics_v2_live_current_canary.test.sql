begin;
select plan(2);

select has_function(
  'public',
  'enqueue_profile_analytics_refresh_v2_live_current_canary',
  array['uuid', 'uuid[]', 'text'],
  'enqueue live current canary existe com contrato restrito'
);

select has_function(
  'public',
  'claim_profile_analytics_refresh_v2_live_current_canary',
  array['text', 'uuid[]', 'integer', 'integer'],
  'claim live current canary exige escopo explícito de organizações'
);

select * from finish();
rollback;

begin;
select plan(3);

select has_function('public', 'get_dashboard_current_state_v2', array['uuid'], 'RPC compacta de current state existe');
select has_function('public', 'dashboard_current_state_reads_enabled', array['uuid'], 'feature flag de leitura existe');
select has_function('public', 'get_dashboard_bootstrap_v2', array['uuid'], 'bootstrap V2 permanece disponível com fallback');

select * from finish();
rollback;

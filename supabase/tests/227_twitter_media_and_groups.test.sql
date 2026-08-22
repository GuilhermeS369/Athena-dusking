begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(14);

select extensions.has_table('public', 'twitter_media_assets', 'catálogo de mídia X existe');
select extensions.has_table('public', 'twitter_groups', 'grupos X existem');
select extensions.has_table('public', 'twitter_group_members', 'membros de grupo X existem');
select extensions.has_function('public', 'twitter_replace_group_members', array['uuid','uuid','uuid[]','uuid'], 'troca atômica de membros existe');
select extensions.ok(not has_function_privilege('authenticated','public.twitter_replace_group_members(uuid,uuid,uuid[],uuid)','EXECUTE'), 'authenticated não chama RPC privilegiado diretamente');
select extensions.ok(has_function_privilege('service_role','public.twitter_replace_group_members(uuid,uuid,uuid[],uuid)','EXECUTE'), 'service role pode trocar membros');
select extensions.is((select file_size_limit from storage.buckets where id = 'twitter-media'), 536870912::bigint, 'bucket X limita arquivo a 512 MB');

insert into auth.users (id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at) values
('12700000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','twitter-227-a@example.com','',now(),now(),now()),
('12700000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','twitter-227-b@example.com','',now(),now(),now());
insert into public.organizations(id,name,slug,created_by) values
('22700000-0000-4000-8000-000000000001','Twitter 227 A','twitter-227-a','12700000-0000-4000-8000-000000000001'),
('22700000-0000-4000-8000-000000000002','Twitter 227 B','twitter-227-b','12700000-0000-4000-8000-000000000002');
insert into public.organization_members(organization_id,user_id,role,invited_by) values
('22700000-0000-4000-8000-000000000001','12700000-0000-4000-8000-000000000001','admin','12700000-0000-4000-8000-000000000001'),
('22700000-0000-4000-8000-000000000002','12700000-0000-4000-8000-000000000002','admin','12700000-0000-4000-8000-000000000002');
insert into public.twitter_global_identities(id,zernio_user_id,current_organization_id) values
('32700000-0000-4000-8000-000000000001','z-227-a','22700000-0000-4000-8000-000000000001'),
('32700000-0000-4000-8000-000000000002','z-227-b','22700000-0000-4000-8000-000000000002');
insert into public.twitter_connections(id,organization_id,identity_id,label,status,created_by) values
('42700000-0000-4000-8000-000000000001','22700000-0000-4000-8000-000000000001','32700000-0000-4000-8000-000000000001','A','active','12700000-0000-4000-8000-000000000001'),
('42700000-0000-4000-8000-000000000002','22700000-0000-4000-8000-000000000002','32700000-0000-4000-8000-000000000002','B','active','12700000-0000-4000-8000-000000000002');
insert into public.twitter_profiles(id,organization_id,external_identity_key,twitter_user_id,identity_confidence,username,status,current_connection_id,created_at,updated_at) values
('52700000-0000-4000-8000-000000000001','22700000-0000-4000-8000-000000000001','twitter:x-227-a','x-227-a','twitter_user_id','perfil_a','active','42700000-0000-4000-8000-000000000001',now(),now()),
('52700000-0000-4000-8000-000000000002','22700000-0000-4000-8000-000000000002','twitter:x-227-b','x-227-b','twitter_user_id','perfil_b','active','42700000-0000-4000-8000-000000000002',now(),now());
insert into public.twitter_groups(id,organization_id,name,created_by) values
('62700000-0000-4000-8000-000000000001','22700000-0000-4000-8000-000000000001','Grupo A','12700000-0000-4000-8000-000000000001'),
('62700000-0000-4000-8000-000000000002','22700000-0000-4000-8000-000000000002','Grupo B','12700000-0000-4000-8000-000000000002');

set local role service_role;
select set_config('request.jwt.claim.role','service_role',true);
select extensions.is(public.twitter_replace_group_members('22700000-0000-4000-8000-000000000001','62700000-0000-4000-8000-000000000001',array['52700000-0000-4000-8000-000000000001']::uuid[],'12700000-0000-4000-8000-000000000001'),1,'perfil X válido entra no grupo');
select extensions.throws_ok(
  $$select public.twitter_replace_group_members('22700000-0000-4000-8000-000000000001','62700000-0000-4000-8000-000000000001',array['52700000-0000-4000-8000-000000000002']::uuid[],'12700000-0000-4000-8000-000000000001')$$,
  '22023','Um ou mais perfis X não pertencem à organização.','grupo rejeita perfil de outro tenant'
);
reset role;

select extensions.throws_ok(
  $$insert into public.twitter_groups(organization_id,name,created_by) values('22700000-0000-4000-8000-000000000001','grupo a','12700000-0000-4000-8000-000000000001')$$,
  '23505',null,'nome ativo é único sem diferenciar caixa'
);
select extensions.throws_ok(
  $$insert into public.twitter_media_assets(organization_id,storage_path,original_name,mime_type,media_kind,byte_size,created_by) values('22700000-0000-4000-8000-000000000001','22700000-0000-4000-8000-000000000002/assets/x.jpg','x.jpg','image/jpeg','image',1,'12700000-0000-4000-8000-000000000001')$$,
  '23514',null,'asset não pode apontar para pasta de outro tenant'
);
select extensions.throws_ok(
  $$insert into public.twitter_media_assets(organization_id,storage_path,original_name,mime_type,media_kind,byte_size,created_by) values('22700000-0000-4000-8000-000000000001','22700000-0000-4000-8000-000000000001/assets/invalid-kind.jpg','x.jpg','image/jpeg','video',1,'12700000-0000-4000-8000-000000000001')$$,
  '23514',null,'tipo lógico deve corresponder ao MIME'
);

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','12700000-0000-4000-8000-000000000001',true);
select extensions.is((select count(*)::bigint from public.twitter_groups),1::bigint,'RLS mostra apenas grupos da organização ativa');
select extensions.is((select count(*)::bigint from public.twitter_group_members),1::bigint,'RLS mostra apenas membros do próprio tenant');

select * from extensions.finish();
rollback;

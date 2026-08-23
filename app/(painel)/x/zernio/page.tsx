import { notFound, redirect } from 'next/navigation';

import TwitterZernioClient from '@/app/x/twitter-zernio-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled, isTwitterZernioAnalyticsSyncEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterZernioPage() {
  const context=await getOrganizationContext();
  if(!context.user)redirect('/login');
  if(!context.activeOrganization)redirect('/onboarding');
  if(!isTwitterModuleEnabled(context.activeOrganization.id))notFound();
  const admin=createSupabaseAdminClient();
  const organizationId=context.activeOrganization.id;
  const[connectionsResult,identitiesResult,eventsResult]=await Promise.all([
    admin.from('twitter_connections').select('id,identity_id,label,status,analytics_enabled,inbox_enabled,last_sync_at,last_error_message').eq('organization_id',organizationId).is('deleted_at',null).order('created_at',{ascending:false}),
    admin.from('twitter_global_identities').select('id,transferred_at').eq('current_organization_id',organizationId).order('created_at',{ascending:false}),
    context.activeOrganization.role==='admin'?admin.from('twitter_identity_transfer_events').select('id,identity_id,from_organization_id,to_organization_id,reason,actor_email,created_at').or(`from_organization_id.eq.${organizationId},to_organization_id.eq.${organizationId}`).order('created_at',{ascending:false}).limit(50):Promise.resolve({data:[],error:null}),
  ]);
  if(connectionsResult.error||identitiesResult.error||eventsResult.error)throw new Error('Não foi possível carregar as conexões Zernio do X.');
  const identities=identitiesResult.data??[];
  const identityIds=identities.map((identity)=>identity.id);
  const[walletsResult,reservationsResult]=identityIds.length?await Promise.all([
    admin.from('twitter_wallets').select('identity_id,posted_balance_micros,reserved_micros,version').in('identity_id',identityIds),
    admin.from('twitter_wallet_reservations').select('identity_id,remaining_micros').in('identity_id',identityIds).gt('remaining_micros',0),
  ]):[{data:[],error:null},{data:[],error:null}];
  if(walletsResult.error||reservationsResult.error)throw new Error('Não foi possível carregar as carteiras X.');
  const walletsById=new Map((walletsResult.data??[]).map((wallet)=>[wallet.identity_id,wallet]));
  const activeConnectionIds=new Set((connectionsResult.data??[]).map((connection)=>connection.identity_id));
  const identitiesWithReservation=new Set((reservationsResult.data??[]).map((reservation)=>reservation.identity_id));
  const destinations=context.organizations.filter((organization)=>organization.id!==organizationId&&organization.role==='admin'&&isTwitterModuleEnabled(organization.id)).map(({id,name})=>({id,name}));
  const organizationNames=new Map(context.organizations.map((organization)=>[organization.id,organization.name]));
  return <div className="page-stack"><header className="page-heading"><div><span className="eyebrow">X / Twitter</span><h1>Zernio</h1><p>Conexões, carteira sintética e autorização das contas X.</p></div></header><TwitterZernioClient connections={(connectionsResult.data??[]).map((connection)=>({...connection,wallet:walletsById.get(connection.identity_id)??null}))} transferIdentities={identities.map((identity)=>({id:identity.id,wallet:walletsById.get(identity.id)??null,connectionActive:activeConnectionIds.has(identity.id),openReservation:identitiesWithReservation.has(identity.id)}))} destinations={destinations} transferEvents={(eventsResult.data??[]).map((event)=>({...event,fromOrganizationName:organizationNames.get(event.from_organization_id)??event.from_organization_id.slice(0,8),toOrganizationName:organizationNames.get(event.to_organization_id)??event.to_organization_id.slice(0,8)}))} canManage={context.activeOrganization.role==='admin'} analyticsGateEnabled={isTwitterZernioAnalyticsSyncEnabled(organizationId)}/></div>;
}

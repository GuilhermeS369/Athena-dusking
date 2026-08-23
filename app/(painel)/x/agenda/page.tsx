import { notFound, redirect } from 'next/navigation';

import TwitterAgendaClient from '@/app/x/twitter-agenda-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic='force-dynamic';

export default async function TwitterAgendaPage(){
  const context=await getOrganizationContext();if(!context.user)redirect('/login');if(!context.activeOrganization)redirect('/onboarding');if(!isTwitterModuleEnabled(context.activeOrganization.id))notFound();
  const admin=createSupabaseAdminClient();const organizationId=context.activeOrganization.id;
  const[items,profiles]=await Promise.all([
    admin.from('twitter_publication_items').select('id,program_id,profile_id,content,execute_at,status,amount_micros,attempt_count,next_attempt_at').eq('organization_id',organizationId).in('status',['ready','retry','claimed','processing','outcome_unknown']).order('execute_at').limit(500),
    admin.from('twitter_profiles').select('id,username,display_name').eq('organization_id',organizationId).is('deleted_at',null).order('username'),
  ]);
  if(items.error||profiles.error)throw new Error('Não foi possível carregar a agenda X.');
  return <div className="page-stack"><header className="page-heading"><div><span className="eyebrow">X / Twitter</span><h1>Agenda</h1><p>Somente publicações financiadas do módulo X, no horário de São Paulo.</p></div></header><TwitterAgendaClient items={items.data??[]} profiles={profiles.data??[]} canEdit={context.activeOrganization.role!=='viewer'}/></div>;
}

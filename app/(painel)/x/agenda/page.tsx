import { notFound, redirect } from 'next/navigation';

import TwitterAgendaClient from '@/app/x/twitter-agenda-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic='force-dynamic';

export default async function TwitterAgendaPage(){
  const context=await getOrganizationContext();if(!context.user)redirect('/login');if(!context.activeOrganization)redirect('/onboarding');if(!isTwitterModuleEnabled(context.activeOrganization.id))notFound();
  const admin=createSupabaseAdminClient();const organizationId=context.activeOrganization.id;
  const[items,profiles]=await Promise.all([
    admin.from('twitter_publication_items').select('id,program_id,profile_id,content,execute_at,dispatch_deadline_at,status,preparation_status,amount_micros,attempt_count,next_attempt_at,missed_reason').eq('organization_id',organizationId).in('status',['ready','retry','claimed','processing','outcome_unknown','missed']).order('execute_at').order('id').limit(101),
    fetchAllRows((from,to)=>admin.from('twitter_profiles').select('id,username,display_name').eq('organization_id',organizationId).is('deleted_at',null).order('username').order('id').range(from,to)),
  ]);
  if(items.error||profiles.error)throw new Error('Não foi possível carregar a agenda X.');
  const rows=items.data??[],initial=rows.slice(0,100),last=initial.at(-1);const nextCursor=rows.length>100&&last?Buffer.from(JSON.stringify({executeAt:last.execute_at,id:last.id})).toString('base64url'):null;
  return <div className="page-stack"><header className="page-heading"><div><span className="eyebrow">X / Twitter</span><h1>Agenda</h1><p>Somente publicações financiadas do módulo X, no horário de São Paulo.</p></div></header><TwitterAgendaClient items={initial} profiles={profiles.data} canEdit={context.activeOrganization.role!=='viewer'} initialHasMore={rows.length>100} initialCursor={nextCursor}/></div>;
}

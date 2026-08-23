import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function GET(){
  const auth=await getTwitterRequestContext();if('response'in auth)return auth.response;
  const admin=createSupabaseAdminClient();
  const[snapshots,jobs]=await Promise.all([
    admin.from('twitter_analytics_snapshots').select('id,resource_type,profile_id,publication_item_id,metrics,provider_updated_at,captured_at').eq('organization_id',auth.context.activeOrganization.id).order('captured_at',{ascending:false}).limit(500),
    admin.from('twitter_analytics_jobs').select('id,status,resource_count,reserved_micros,created_at,finished_at').eq('organization_id',auth.context.activeOrganization.id).order('created_at',{ascending:false}).limit(50),
  ]);
  if(snapshots.error||jobs.error)return NextResponse.json({error:'Não foi possível carregar os snapshots locais do X.'},{status:500});
  return NextResponse.json({snapshots:snapshots.data??[],jobs:jobs.data??[]},{headers:{'Cache-Control':'private, no-store'}});
}

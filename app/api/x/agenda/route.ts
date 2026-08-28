import { NextResponse } from 'next/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses=new Set(['ready','retry','claimed','processing','outcome_unknown','missed']);
function decode(value:string|null){if(!value)return null;try{const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'))as{executeAt?:unknown;id?:unknown};return typeof parsed.executeAt==='string'&&typeof parsed.id==='string'&&uuid.test(parsed.id)?{executeAt:parsed.executeAt,id:parsed.id}:null;}catch{return null;}}
function encode(value:{execute_at:string;id:string}){return Buffer.from(JSON.stringify({executeAt:value.execute_at,id:value.id})).toString('base64url');}

export async function GET(request:Request){
  const auth=await getTwitterRequestContext();if('response'in auth)return auth.response;
  const url=new URL(request.url),rawCursor=url.searchParams.get('cursor'),cursor=decode(rawCursor);
  if(rawCursor&&!cursor)return NextResponse.json({error:'Cursor da Agenda X inválido.'},{status:400});
  const limit=Math.min(100,Math.max(1,Number.parseInt(url.searchParams.get('limit')??'100',10)||100));
  const status=statuses.has(url.searchParams.get('status')??'')?url.searchParams.get('status'):null;
  const profileId=uuid.test(url.searchParams.get('profileId')??'')?url.searchParams.get('profileId'):null;
  const days=Math.min(365,Math.max(1,Number.parseInt(url.searchParams.get('days')??'90',10)||90));
  let query=createSupabaseAdminClient().from('twitter_publication_items').select('id,program_id,profile_id,content,execute_at,dispatch_deadline_at,status,preparation_status,amount_micros,attempt_count,next_attempt_at,missed_reason')
    .eq('organization_id',auth.context.activeOrganization.id).in('status',[...(status?[status]:statuses)]).lte('execute_at',new Date(Date.now()+days*86_400_000).toISOString()).order('execute_at').order('id').limit(limit+1);
  if(profileId)query=query.eq('profile_id',profileId);
  if(cursor)query=query.or(`execute_at.gt.${cursor.executeAt},and(execute_at.eq.${cursor.executeAt},id.gt.${cursor.id})`);
  const{data,error}=await query;if(error)return NextResponse.json({error:'Não foi possível consultar a Agenda X.'},{status:500});
  const rows=data??[],items=rows.slice(0,limit),last=items.at(-1);
  return NextResponse.json({items,hasMore:rows.length>limit,nextCursor:rows.length>limit&&last?encode(last):null},{headers:{'Cache-Control':'no-store'}});
}

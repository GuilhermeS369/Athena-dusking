import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getTwitterRequestContext } from '@/lib/twitter/request-context';

function decodeCursor(value:string|null){if(!value)return null;try{const decoded=Buffer.from(value,'base64url').toString('utf8'),separator=decoded.lastIndexOf('|'),createdAt=decoded.slice(0,separator),id=decoded.slice(separator+1);if(separator<1||Number.isNaN(Date.parse(createdAt))||!/^[0-9a-f-]{36}$/i.test(id))return null;return{createdAt,id};}catch{return null;}}
function encodeCursor(createdAt:string,id:string){return Buffer.from(`${createdAt}|${id}`).toString('base64url');}

export async function GET(request:Request) {
  const auth = await getTwitterRequestContext();
  if ('response' in auth) return auth.response;
  const admin = createSupabaseAdminClient();
  const url=new URL(request.url),resource=url.searchParams.get('resource')==='profiles'?'profiles':'groups',limit=Math.min(100,Math.max(1,Number.parseInt(url.searchParams.get('limit')??'100',10)||100)),cursor=decodeCursor(url.searchParams.get('cursor'));
  if(url.searchParams.has('cursor')&&!cursor)return NextResponse.json({error:'Cursor de grupos X inválido.'},{status:400});
  if(resource==='profiles'){
    let query=admin.from('twitter_profiles').select('id,username,display_name,avatar_url,status,created_at').eq('organization_id',auth.context.activeOrganization.id).is('deleted_at',null).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit+1);
    if(cursor)query=query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
    const profiles=await query;if(profiles.error)return NextResponse.json({error:'Não foi possível carregar os perfis dos grupos X.'},{status:500});const rows=(profiles.data??[]).slice(0,limit),ids=rows.map(row=>row.id);const members=ids.length?await admin.from('twitter_group_members').select('group_id,profile_id,created_at').eq('organization_id',auth.context.activeOrganization.id).in('profile_id',ids):{data:[],error:null};if(members.error)return NextResponse.json({error:'Não foi possível carregar os vínculos X.'},{status:500});const hasMore=(profiles.data??[]).length>limit;return NextResponse.json({profiles:rows,memberships:members.data??[],hasMore,nextCursor:hasMore&&rows.length?encodeCursor(rows.at(-1)!.created_at,rows.at(-1)!.id):null,limit});
  }
  let query=admin.from('twitter_groups').select('id,name,description,created_at').eq('organization_id',auth.context.activeOrganization.id).is('deleted_at',null).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(limit+1);
  if(cursor)query=query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const groups=await query;if(groups.error)return NextResponse.json({error:'Não foi possível carregar os grupos X.'},{status:500});const rows=(groups.data??[]).slice(0,limit),ids=rows.map(row=>row.id);const members=ids.length?await admin.from('twitter_group_members').select('group_id,profile_id,created_at').eq('organization_id',auth.context.activeOrganization.id).in('group_id',ids):{data:[],error:null};if(members.error)return NextResponse.json({error:'Não foi possível carregar os vínculos X.'},{status:500});const hasMore=(groups.data??[]).length>limit;return NextResponse.json({groups:rows,memberships:members.data??[],hasMore,nextCursor:hasMore&&rows.length?encodeCursor(rows.at(-1)!.created_at,rows.at(-1)!.id):null,limit});
}

export async function POST(request: Request) {
  const auth = await getTwitterRequestContext('operator');
  if ('response' in auth) return auth.response;
  const body = await request.json().catch(() => ({})) as { name?: unknown; description?: unknown; profileIds?: unknown };
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const profileIds = Array.isArray(body.profileIds) ? body.profileIds.filter((item): item is string => typeof item === 'string') : [];
  if (name.length < 1 || name.length > 120 || description.length > 1000) return NextResponse.json({ error: 'Dados do grupo X inválidos.' }, { status: 400 });
  const admin = createSupabaseAdminClient();
  const groupId = randomUUID();
  const { error } = await admin.from('twitter_groups').insert({
    id: groupId, organization_id: auth.context.activeOrganization.id, name, description: description || null, created_by: auth.context.user.id,
  });
  if (error) return NextResponse.json({ error: error.code === '23505' ? 'Já existe um grupo X com esse nome.' : 'Não foi possível criar o grupo X.' }, { status: error.code === '23505' ? 409 : 500 });
  const { error: memberError } = await admin.rpc('twitter_replace_group_members', {
    p_organization_id: auth.context.activeOrganization.id, p_group_id: groupId,
    p_profile_ids: profileIds, p_actor_user_id: auth.context.user.id,
  });
  if (memberError) {
    await admin.from('twitter_groups').update({ deleted_at: new Date().toISOString() }).eq('id', groupId);
    return NextResponse.json({ error: 'Um ou mais perfis X são inválidos.' }, { status: 400 });
  }
  return NextResponse.json({ id: groupId }, { status: 201 });
}

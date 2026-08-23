import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTwitterRequestContext } from "@/lib/twitter/request-context";

export async function GET(request:Request) {
  const auth=await getTwitterRequestContext();
  if("response" in auth)return auth.response;
  const url=new URL(request.url);
  let query=createSupabaseAdminClient().from("twitter_operation_logs")
    .select("id,item_id,attempt_id,connection_id,profile_id,phase,http_status,provider_code,request_id,post_id,estimated_micros,settled_micros,message,metadata,created_at")
    .eq("organization_id",auth.context.activeOrganization.id)
    .order("created_at",{ascending:false}).order("id",{ascending:false}).limit(101);
  const cursor=url.searchParams.get("cursor");
  if(cursor){
    try{
      const value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"))as{createdAt:string;id:string};
      if(!value.createdAt||!value.id)throw new Error();
      query=query.or(`created_at.lt.${value.createdAt},and(created_at.eq.${value.createdAt},id.lt.${value.id})`);
    }catch{return NextResponse.json({error:"Cursor de logs X inválido."},{status:400});}
  }
  const{data,error}=await query;
  if(error)return NextResponse.json({error:"Não foi possível carregar os logs X."},{status:500});
  const rows=data??[],logs=rows.slice(0,100),last=logs.at(-1);
  return NextResponse.json({logs,hasMore:rows.length>100,nextCursor:rows.length>100&&last?Buffer.from(JSON.stringify({createdAt:last.created_at,id:last.id})).toString("base64url"):null});
}

import { loadEnvConfig } from '@next/env';
import { createSupabaseAdminClient } from '../../lib/supabase/admin';

loadEnvConfig(process.cwd());

async function main(){
  if(process.env.TWITTER_SCALE_BACKFILL_EXECUTE!=='true')throw new Error('Backfill bloqueado: defina TWITTER_SCALE_BACKFILL_EXECUTE=true somente na janela aprovada.');
  const admin=createSupabaseAdminClient();
  const before=await admin.rpc('twitter_publication_scale_audit');if(before.error)throw before.error;
  const totals={futurePreparedForPipeline:0,missed:0,releasedMicros:0};let remaining=1,cycles=0;
  while(remaining>0){if(++cycles>1000)throw new Error('Backfill X excedeu o limite defensivo de ciclos.');const result=await admin.rpc('twitter_backfill_publication_scale',{p_limit:5000});if(result.error)throw result.error;const row=result.data as Record<string,number>;totals.futurePreparedForPipeline+=Number(row.futurePreparedForPipeline??0);totals.missed+=Number(row.missed??0);totals.releasedMicros+=Number(row.releasedMicros??0);remaining=Number(row.remaining??0);}
  const after=await admin.rpc('twitter_publication_scale_audit');if(after.error)throw after.error;
  const left=before.data as Record<string,unknown>,right=after.data as Record<string,unknown>;
  if(left.total!==right.total||left.scheduleDigest!==right.scheduleDigest)throw new Error('Backfill X alterou contagem, horário, status ou identidade do agendamento.');
  if(String(left.reservedHoldMicros)!==String(right.reservedHoldMicros)&&totals.releasedMicros===0)throw new Error('Backfill X alterou reservas sem resolução registrada.');
  console.log(JSON.stringify({cycles,totals,before:{total:left.total,scheduleDigest:left.scheduleDigest,reservedHoldMicros:left.reservedHoldMicros},after:{total:right.total,scheduleDigest:right.scheduleDigest,reservedHoldMicros:right.reservedHoldMicros,withoutDeadline:right.withoutDeadline}},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Falha no backfill X.');process.exitCode=1;});

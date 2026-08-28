import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic='force-dynamic';
const date=(value:string|null)=>value?new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(new Date(value)):'—';
const usd=(value:number)=>new Intl.NumberFormat('pt-BR',{style:'currency',currency:'USD',minimumFractionDigits:3}).format(value/1_000_000);

export default async function TwitterProfileDetailPage({params}:{params:Promise<{profileId:string}>}){
  const context=await getOrganizationContext();if(!context.user)redirect('/login');if(!context.activeOrganization)redirect('/onboarding');if(!isTwitterModuleEnabled(context.activeOrganization.id))notFound();
  const{profileId}=await params;const admin=createSupabaseAdminClient();const organizationId=context.activeOrganization.id;
  const{data:profile,error}=await admin.from('twitter_profiles').select('id,twitter_user_id,identity_confidence,username,display_name,avatar_url,status,account_tier,tier_verified_at,can_post,can_fetch_analytics,analytics_enabled,token_valid,needs_reconnect,current_connection_id,health_issues,last_health_at,last_synced_at,created_at').eq('organization_id',organizationId).eq('id',profileId).is('deleted_at',null).maybeSingle();
  if(error)throw new Error('Não foi possível carregar o perfil X.');if(!profile)notFound();
  const[epochs,connections,memberships,items,snapshots]=await Promise.all([
    admin.from('twitter_profile_connection_epochs').select('id,connection_id,started_at,ended_at,end_reason').eq('organization_id',organizationId).eq('profile_id',profile.id).order('started_at',{ascending:false}).limit(50),
    admin.from('twitter_connections').select('id,label,status,last_sync_at,last_error_code,last_error_message').eq('organization_id',organizationId),
    admin.from('twitter_group_members').select('group_id').eq('organization_id',organizationId).eq('profile_id',profile.id),
    admin.from('twitter_publication_items').select('id,program_id,content,execute_at,status,amount_micros,attempt_count').eq('organization_id',organizationId).eq('profile_id',profile.id).order('execute_at',{ascending:false}).limit(50),
    admin.from('twitter_analytics_snapshots').select('id,resource_type,captured_at,provider_updated_at,metrics').eq('organization_id',organizationId).eq('profile_id',profile.id).order('captured_at',{ascending:false}).limit(50),
  ]);
  if(epochs.error||connections.error||memberships.error||items.error||snapshots.error)throw new Error('Não foi possível carregar o histórico local do perfil X.');
  const groupIds=(memberships.data??[]).map((membership)=>membership.group_id);const groups=groupIds.length?await admin.from('twitter_groups').select('id,name').eq('organization_id',organizationId).in('id',groupIds).is('deleted_at',null):{data:[],error:null};if(groups.error)throw new Error('Não foi possível carregar os grupos X.');
  const connectionById=new Map((connections.data??[]).map((connection)=>[connection.id,connection]));const currentConnection=profile.current_connection_id?connectionById.get(profile.current_connection_id):null;const healthIssues=Array.isArray(profile.health_issues)?profile.health_issues:[];
  return <div className="page-stack"><header className="page-heading"><div><span className="eyebrow">X / Twitter · perfil estável</span><h1>@{profile.username}</h1><p>{profile.display_name??'Sem nome informado'} · ID X {profile.twitter_user_id??'não confirmado'}</p></div><div className="actions-row"><Link className="button button-ghost" href="/x/perfis">Voltar</Link><a className="button button-primary" href={`https://x.com/${encodeURIComponent(profile.username)}`} target="_blank" rel="noreferrer">Abrir no X</a></div></header>
    <section className="summary-grid"><div><span>Status</span><strong>{profile.status}</strong></div><div><span>Analytics</span><strong>{profile.analytics_enabled?'Ativo':'Desligado'}</strong></div><div><span>Publicação</span><strong>{profile.can_post?'Permitida':'Bloqueada'}</strong></div><div><span>Token</span><strong>{profile.token_valid?'Válido':profile.needs_reconnect?'Reconectar':'Inválido'}</strong></div></section>
    <section className="panel"><h2>Conexão atual</h2>{currentConnection?<><p><strong>{currentConnection.label}</strong> · {currentConnection.status}</p><p className="muted">Último sync: {date(currentConnection.last_sync_at)} · Health: {date(profile.last_health_at)}</p>{currentConnection.last_error_message?<p className="field-error-message">{currentConnection.last_error_code??'Erro'}: {currentConnection.last_error_message}</p>:null}</>:<p className="muted">Sem conexão atual. O histórico e a identidade permanecem preservados.</p>}{healthIssues.length?<p className="field-error-message">{healthIssues.length} alerta(s) de health persistido(s). Sincronize pela página Zernio para reavaliar.</p>:null}</section>
    <section className="panel"><h2>Grupos atuais</h2>{groups.data?.length?<p>{groups.data.map((group)=>group.name).join(' · ')}</p>:<p className="muted">Este perfil não pertence a grupos X.</p>}</section>
    <section className="panel"><div className="panel-heading"><div><span className="section-kicker">Épocas imutáveis</span><h2>Histórico de conexão</h2><p>Trocas reais criam nova época; reautenticação da mesma conexão pode manter a atual.</p></div></div>{epochs.data?.length?<div className="content-stack">{epochs.data.map((epoch)=><article key={epoch.id}><strong>{connectionById.get(epoch.connection_id)?.label??epoch.connection_id.slice(0,8)}</strong><p className="muted">{date(epoch.started_at)} → {epoch.ended_at?date(epoch.ended_at):'atual'}{epoch.end_reason?` · ${epoch.end_reason}`:''}</p></article>)}</div>:<p className="muted">Nenhuma época registrada.</p>}</section>
    <section className="panel"><div className="panel-heading"><div><span className="section-kicker">Fila e histórico local</span><h2>Publicações recentes</h2></div></div>{items.data?.length?<div className="content-stack">{items.data.map((item)=><article key={item.id}><strong>{date(item.execute_at)} · {item.status} · {usd(item.amount_micros)}</strong><p>{item.content.length>200?`${item.content.slice(0,200)}…`:item.content}</p><small>Programa {item.program_id.slice(0,8)} · tentativa {item.attempt_count}</small></article>)}</div>:<p className="muted">Nenhuma publicação local deste perfil.</p>}</section>
    <section className="panel"><div className="standalone-header"><div><span className="section-kicker">Sem leitura automática</span><h2>Snapshots locais</h2><p className="muted">{snapshots.data?.length??0} snapshot(s); última coleta {date(snapshots.data?.[0]?.captured_at??null)}.</p></div><Link className="button button-primary" href="/x/analises">Abrir Análises X</Link></div></section>
  </div>;
}

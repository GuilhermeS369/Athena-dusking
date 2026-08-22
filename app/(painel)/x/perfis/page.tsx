import { notFound, redirect } from 'next/navigation';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterProfilesPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from('twitter_profiles')
    .select('id, twitter_user_id, identity_confidence, username, display_name, avatar_url, status, account_tier, tier_verified_at, can_post, token_valid, needs_reconnect, last_synced_at')
    .eq('organization_id', context.activeOrganization.id).is('deleted_at', null).order('username');
  if (error) throw new Error('Não foi possível carregar os perfis X.');
  return <div className="page-stack"><header className="page-heading"><div><span className="eyebrow">X / Twitter</span><h1>Perfis</h1><p>Identidades estáveis e estado de publicação, separados do Instagram.</p></div></header><section className="content-stack">{(data ?? []).length === 0 ? <div className="empty-state"><h2>Nenhum perfil X conectado</h2><p>Use o menu Zernio do X para autorizar e sincronizar uma conta.</p></div> : (data ?? []).map((profile) => <article className="panel" key={profile.id}><div className="standalone-header"><div><h2>@{profile.username}</h2><p>{profile.display_name ?? 'Sem nome informado'}</p></div><span className="status-badge">{profile.status}</span></div><div className="summary-grid"><div><span>Plano confirmado</span><strong>{profile.account_tier === 'unknown' ? 'Não confirmado (280)' : profile.account_tier}</strong></div><div><span>Pode postar</span><strong>{profile.can_post ? 'Sim' : 'Não'}</strong></div><div><span>Identidade</span><strong>{profile.identity_confidence === 'twitter_user_id' ? 'ID imutável do X' : 'ID da conta Zernio'}</strong></div></div></article>)}</section></div>;
}

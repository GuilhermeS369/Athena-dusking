import { notFound, redirect } from 'next/navigation';

import TwitterQueueClient from '@/app/x/twitter-queue-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export const dynamic = 'force-dynamic';

export default async function TwitterQueuePage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  const admin = createSupabaseAdminClient();
  const organizationId = context.activeOrganization.id;
  const [programs, profiles, groups, memberships] = await Promise.all([
    admin.rpc('twitter_program_queue_overview', { p_organization_id:organizationId }),
    admin.from('twitter_profiles').select('id,username,display_name,status').eq('organization_id', organizationId).is('deleted_at', null).order('username'),
    admin.from('twitter_groups').select('id,name').eq('organization_id', organizationId).is('deleted_at', null).order('name'),
    admin.from('twitter_group_members').select('group_id,profile_id').eq('organization_id', organizationId),
  ]);
  if (programs.error || profiles.error || groups.error || memberships.error) throw new Error('Não foi possível carregar a fila X.');
  const programIds = (programs.data ?? []).map((program:{id:string}) => program.id);
  const [shortfalls, items] = programIds.length ? await Promise.all([
    admin.from('twitter_program_shortfalls').select('program_id,profile_id,requested_count,funded_count,unfunded_count').in('program_id', programIds),
    admin.from('twitter_publication_items').select('id,program_id,profile_id,execute_at,content,category,amount_micros,status,attempt_count,next_attempt_at').eq('organization_id', organizationId).eq('program_id', programIds[0]).order('execute_at').order('id').limit(201),
  ]) : [{ data: [], error: null }, { data: [], error: null }];
  if (shortfalls.error || items.error) throw new Error('Não foi possível carregar os detalhes da fila X.');
  return <main className="standalone-page queue-page"><header className="queue-page-header"><div><span>{context.activeOrganization.name} · X / Twitter</span><h1>Fila de publicação</h1><p>Programas, itens financiados, custos e excedentes sem saldo.</p></div><a className="button button-ghost" href="/x/postagem">Nova postagem</a></header><TwitterQueueClient programs={programs.data ?? []} profiles={profiles.data ?? []} groups={groups.data ?? []} memberships={memberships.data ?? []} shortfalls={shortfalls.data ?? []} items={items.data ?? []} canEdit={context.activeOrganization.role !== 'viewer'} /></main>;
}

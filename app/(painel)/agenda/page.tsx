import { redirect } from 'next/navigation';

import AgendaClient from '@/app/agenda/agenda-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function AgendaPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const supabase = await createSupabaseServerClient();
  const { data: profiles, error: profilesError } = await supabase
    .from('instagram_profiles')
    .select('id, username')
    .eq('organization_id', context.activeOrganization.id)
    .is('deleted_at', null)
    .order('username');

  if (profilesError) throw new Error('Não foi possível carregar a agenda.');

  return <AgendaClient activeOrganization={context.activeOrganization} profiles={profiles ?? []} items={[]} />;
}

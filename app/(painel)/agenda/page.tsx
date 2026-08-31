import { redirect } from 'next/navigation';

import AgendaClient from '@/app/agenda/agenda-client';
import { getOrganizationContext } from '@/lib/organizations/server';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function AgendaPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');

  const supabase = await createSupabaseServerClient();
  const organizationId = context.activeOrganization.id;
  // Organizations can hold more profiles than PostgREST's default row cap (1000),
  // which would otherwise silently truncate this list.
  const { data: profiles, error: profilesError } = await fetchAllRows((from, to) => supabase
    .from('instagram_profiles')
    .select('id, username')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    // username não tem constraint de unicidade: sem o desempate por id a ordem
    // não é total e as páginas repetem/perdem perfis.
    .order('username')
    .order('id')
    .range(from, to));

  if (profilesError) throw new Error('Não foi possível carregar a agenda.');

  return <AgendaClient activeOrganization={context.activeOrganization} profiles={profiles} items={[]} />;
}

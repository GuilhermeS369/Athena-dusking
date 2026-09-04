import { redirect } from 'next/navigation';

import MirrorLinkClient from '@/app/administracao/mirror-link-client';
import { authMirrorLinkStateFromRow, type AuthMirrorLinkRow } from '@/lib/auth/mirror-link';
import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export default async function AcessoAdministrationPage() {
  const context = await getOrganizationContext();

  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  if (context.activeOrganization.role !== 'admin') redirect('/perfis');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('auth_mirror_links')
    .select('active, activated_at, created_by_email, last_used_at, use_count')
    .eq('organization_id', context.activeOrganization.id)
    .eq('active', true)
    .maybeSingle<AuthMirrorLinkRow>();

  if (error) throw new Error('Não foi possível carregar o link espelho.');

  return (
    <div className="page">
      <header className="page-header">
        <span className="eyebrow">{context.activeOrganization.name} · Administração</span>
        <h1>Acesso</h1>
        <p>Recursos de acesso que valem para a organização inteira. Só administradores enxergam esta página.</p>
      </header>
      <MirrorLinkClient authMirrorLink={authMirrorLinkStateFromRow(data)} />
    </div>
  );
}

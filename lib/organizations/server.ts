import { cookies } from 'next/headers';
import { cache } from 'react';

import { createSupabaseServerClient } from '@/lib/supabase/server';

export const ACTIVE_ORGANIZATION_COOKIE = 'athena-active-organization';

export type OrganizationRole = 'admin' | 'operator' | 'viewer';

export type Organization = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: OrganizationRole;
};

export type OrganizationContext = {
  user: { id: string; email?: string } | null;
  organizations: Organization[];
  activeOrganization: Organization | null;
};

export const getOrganizationContext = cache(async function getOrganizationContext(): Promise<OrganizationContext> {
  const supabase = await createSupabaseServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) {
    return { user: null, organizations: [], activeOrganization: null };
  }

  const { data, error } = await supabase
    .from('organization_members')
    .select('role, joined_at, organizations!inner(id, name, slug, timezone, deleted_at)')
    .eq('user_id', userData.user.id)
    .is('organizations.deleted_at', null)
    .order('joined_at', { ascending: true });

  if (error) {
    throw new Error('Não foi possível carregar o contexto da organização.');
  }

  const organizations = (data ?? []).flatMap((membership) => {
    const organization = Array.isArray(membership.organizations)
      ? membership.organizations[0]
      : membership.organizations;

    if (!organization) return [];

    return [{
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      timezone: organization.timezone,
      role: membership.role as OrganizationRole,
    }];
  });

  const cookieStore = await cookies();
  const activeId = cookieStore.get(ACTIVE_ORGANIZATION_COOKIE)?.value;
  const activeOrganization = organizations.find((organization) => organization.id === activeId)
    ?? organizations[0]
    ?? null;

  return {
    user: { id: userData.user.id, email: userData.user.email },
    organizations,
    activeOrganization,
  };
});

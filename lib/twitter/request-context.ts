import { NextResponse } from 'next/server';

import { getOrganizationContext } from '@/lib/organizations/server';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export async function getTwitterRequestContext(requiredRole?: 'operator' | 'admin') {
  const context = await getOrganizationContext();
  if (!context.user || !context.activeOrganization) {
    return { response: NextResponse.json({ error: 'Não autenticado.' }, { status: 401 }) } as const;
  }
  if (!isTwitterModuleEnabled(context.activeOrganization.id)) {
    return { response: NextResponse.json({ error: 'O módulo X/Twitter não está habilitado.' }, { status: 404 }) } as const;
  }
  const roles = requiredRole === 'admin' ? ['admin'] : requiredRole === 'operator' ? ['admin', 'operator'] : ['admin', 'operator', 'viewer'];
  if (!roles.includes(context.activeOrganization.role)) {
    return { response: NextResponse.json({ error: 'Ação não permitida.' }, { status: 403 }) } as const;
  }
  return {
    context: {
      ...context,
      user: context.user,
      activeOrganization: context.activeOrganization,
    },
  } as const;
}

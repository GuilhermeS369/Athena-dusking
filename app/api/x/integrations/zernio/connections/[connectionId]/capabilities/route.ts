import { NextResponse } from 'next/server';

import { getTwitterRequestContext } from '@/lib/twitter/request-context';

export async function PATCH() {
  const auth = await getTwitterRequestContext('admin');
  if ('response' in auth) return auth.response;
  return NextResponse.json({
    error: 'Analytics agora é configurado individualmente em X > Perfis.',
    profilesUrl: '/x/perfis',
  }, { status: 410 });
}

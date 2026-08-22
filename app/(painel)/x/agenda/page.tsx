import { notFound, redirect } from 'next/navigation';

import { getOrganizationContext } from '@/lib/organizations/server';
import { isTwitterModuleEnabled } from '@/lib/twitter/feature';

export default async function TwitterAgendaPage() {
  const context = await getOrganizationContext(); if (!context.user) redirect('/login'); if (!context.activeOrganization) redirect('/onboarding'); if (!isTwitterModuleEnabled(context.activeOrganization.id)) notFound();
  return <div className="page-stack"><header className="page-heading"><div><span className="eyebrow">X / Twitter</span><h1>Agenda</h1><p>A agenda exibirá somente itens do X após a confirmação de programas em massa.</p></div></header><div className="empty-state"><h2>Nenhuma publicação X programada</h2><p>Itens do Instagram não aparecem nesta página.</p></div></div>;
}

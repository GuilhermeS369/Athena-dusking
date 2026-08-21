'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import PageLoadingSkeleton from '@/app/components/page-loading-skeleton';

type Organization = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: 'admin' | 'operator' | 'viewer';
};

const navigation = [
  { label: 'Dashboard', icon: 'grid', href: '/' },
  { label: 'Postagem', icon: 'send', href: '/postagem' },
  { label: 'Fila', icon: 'activity', href: '/queue' },
  { label: 'Galeria', icon: 'image', href: '/galeria' },
  { label: 'Perfis', icon: 'user', href: '/perfis' },
  { label: 'Grupos', icon: 'users', href: '/grupos' },
  { label: 'Agenda', icon: 'calendar', href: '/agenda' },
  { label: 'Zernio', icon: 'key', href: '/zernio' },
  { label: 'Bulk Import', icon: 'upload', href: '/bulk-import' },
  { label: 'Status / Logs', icon: 'activity', href: '/operacao' },
];

export default function AppShell({
  children,
  organizations,
  activeOrganization,
}: {
  children: React.ReactNode;
  organizations: Organization[];
  activeOrganization: Organization;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState(activeOrganization.id);
  const [organizationMessage, setOrganizationMessage] = useState('');
  const [isSwitchingOrganization, setIsSwitchingOrganization] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    setPendingHref(null);
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    setSelectedOrganizationId(activeOrganization.id);
  }, [activeOrganization.id]);

  function handleNavigationClick(event: React.MouseEvent<HTMLAnchorElement>, href: string, active: boolean) {
    setMenuOpen(false);

    if (active || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      setPendingHref(null);
      return;
    }

    setPendingHref(href);
  }

  async function switchOrganization(organizationId: string) {
    if (organizationId === selectedOrganizationId) return;
    setSelectedOrganizationId(organizationId);
    setOrganizationMessage('');
    setIsSwitchingOrganization(true);

    try {
      const response = await fetch('/api/organizations/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      });
      if (!response.ok) throw new Error('organization-switch-failed');
      router.refresh();
    } catch {
      setSelectedOrganizationId(activeOrganization.id);
      setOrganizationMessage('Não foi possível trocar de organização.');
    } finally {
      setIsSwitchingOrganization(false);
    }
  }

  const roleLabel = activeOrganization.role === 'admin' ? 'Administrador' : activeOrganization.role === 'operator' ? 'Operador' : 'Somente leitura';

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">✧</div>
          <div><span className="eyebrow">Athena</span><strong>Scheduler</strong></div>
        </div>
        <nav className="main-nav" aria-label="Navegação principal">
          {navigation.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link className={`nav-item ${active ? 'nav-item-active' : ''}`} key={item.href} href={item.href} prefetch={false} onClick={(event) => handleNavigationClick(event, item.href, active)}>
                <span className={`nav-icon nav-icon-${item.icon}`} aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><use href={`#icon-${item.icon}`} /></svg></span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="organization-switcher sidebar-organization-switcher">
          <label htmlFor="sidebar-organization">Organização ativa</label>
          <select id="sidebar-organization" value={selectedOrganizationId} disabled={isSwitchingOrganization} onChange={(event) => switchOrganization(event.target.value)}>
            {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select>
          <small>{roleLabel}</small>
        </div>
      </aside>
      {menuOpen && <button className="sidebar-backdrop" onClick={() => setMenuOpen(false)} aria-label="Fechar menu" type="button" />}
      <main className="main-content" aria-busy={Boolean(pendingHref)}>
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Abrir menu" type="button">☰</button>
          <div className="mobile-brand"><span className="brand-mark small">✧</span><strong>Athena</strong></div>
          <span aria-hidden="true" />
        </header>
        <div className="mobile-organization-switcher organization-switcher">
          <label htmlFor="mobile-organization">Organização ativa</label>
          <select id="mobile-organization" value={selectedOrganizationId} disabled={isSwitchingOrganization} onChange={(event) => switchOrganization(event.target.value)}>
            {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select>
        </div>
        {organizationMessage && <p className="inline-message" role="alert">{organizationMessage}</p>}
        {pendingHref ? <PageLoadingSkeleton variant="cards" /> : children}
      </main>
    </div>
  );
}

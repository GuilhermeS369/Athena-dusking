'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Group = { id: string; name: string; description: string | null };
type Profile = { id: string; username: string; status: string };

export default function TwitterGroupsClient({ groups, profiles, memberships, canEdit }: { groups: Group[]; profiles: Profile[]; memberships: Array<{ group_id: string; profile_id: string }>; canEdit: boolean }) {
  const router = useRouter(); const [name, setName] = useState(''); const [selected, setSelected] = useState<string[]>([]); const [message, setMessage] = useState<string | null>(null);
  async function create(event: React.FormEvent) { event.preventDefault(); const response = await fetch('/api/x/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, profileIds: selected }) }); const body = await response.json() as { error?: string }; if (!response.ok) { setMessage(body.error ?? 'Falha ao criar grupo.'); return; } setName(''); setSelected([]); router.refresh(); }
  async function remove(id: string) { if (!confirm('Remover este grupo X?')) return; await fetch(`/api/x/groups/${id}`, { method: 'DELETE' }); router.refresh(); }
  return <div className="content-stack">{message ? <div className="notice-banner">{message}</div> : null}{canEdit ? <form className="panel auth-form" onSubmit={create}><h2>Novo grupo X</h2><label>Nome<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label><div className="content-stack">{profiles.map((profile) => <label key={profile.id}><input type="checkbox" checked={selected.includes(profile.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, profile.id] : current.filter((id) => id !== profile.id))} /> @{profile.username}</label>)}</div><button className="button button-primary">Criar grupo</button></form> : null}<section className="content-stack">{groups.length === 0 ? <div className="empty-state"><h2>Nenhum grupo X</h2></div> : groups.map((group) => { const memberIds = memberships.filter((item) => item.group_id === group.id).map((item) => item.profile_id); return <article className="panel" key={group.id}><h2>{group.name}</h2><p>{memberIds.length} perfil(is): {profiles.filter((profile) => memberIds.includes(profile.id)).map((profile) => `@${profile.username}`).join(', ') || 'nenhum'}</p>{canEdit ? <button className="button button-danger" onClick={() => void remove(group.id)}>Remover</button> : null}</article>; })}</section></div>;
}

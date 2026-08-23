'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Group = { id: string; name: string; description: string | null };
type Profile = { id: string; username: string; status: string };

export default function TwitterGroupsClient({ groups, profiles, memberships, canEdit }: {
  groups: Group[];
  profiles: Profile[];
  memberships: Array<{ group_id: string; profile_id: string }>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function resetForm() {
    setEditingId(null);
    setName('');
    setDescription('');
    setSelected([]);
  }

  function edit(group: Group) {
    setEditingId(group.id);
    setName(group.name);
    setDescription(group.description ?? '');
    setSelected(memberships.filter((item) => item.group_id === group.id).map((item) => item.profile_id));
    setMessage(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(editingId ? `/api/x/groups/${editingId}` : '/api/x/groups', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, profileIds: selected }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Não foi possível salvar o grupo X.');
      setMessage(editingId ? 'Grupo X atualizado.' : 'Grupo X criado.');
      resetForm();
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha ao salvar o grupo X.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Remover este grupo X? Programas já confirmados não serão alterados.')) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/x/groups/${id}`, { method: 'DELETE' });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Não foi possível remover o grupo X.');
      if (editingId === id) resetForm();
      setMessage('Grupo X removido. Filas já confirmadas permanecem congeladas.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Falha ao remover o grupo X.');
    }
  }

  return <div className="content-stack">
    {message ? <div className="notice-banner">{message}</div> : null}
    {canEdit ? <form className="panel auth-form" onSubmit={save}>
      <h2>{editingId ? 'Editar grupo X' : 'Novo grupo X'}</h2>
      <label>Nome<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
      <label>Descrição<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} rows={3} /></label>
      <div className="content-stack">
        {profiles.length === 0 ? <p className="muted">Nenhum perfil X disponível.</p> : profiles.map((profile) => <label key={profile.id}>
          <input type="checkbox" checked={selected.includes(profile.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, profile.id] : current.filter((id) => id !== profile.id))} />
          @{profile.username} {profile.status !== 'active' ? `(${profile.status})` : ''}
        </label>)}
      </div>
      <div className="button-row">
        <button className="button button-primary" disabled={saving}>{saving ? 'Salvando…' : editingId ? 'Salvar alterações' : 'Criar grupo'}</button>
        {editingId ? <button className="button button-ghost" type="button" onClick={resetForm} disabled={saving}>Cancelar edição</button> : null}
      </div>
    </form> : null}
    <section className="content-stack">
      {groups.length === 0 ? <div className="empty-state"><h2>Nenhum grupo X</h2></div> : groups.map((group) => {
        const memberIds = memberships.filter((item) => item.group_id === group.id).map((item) => item.profile_id);
        return <article className="panel" key={group.id}>
          <h2>{group.name}</h2>
          {group.description ? <p>{group.description}</p> : null}
          <p>{memberIds.length} perfil(is): {profiles.filter((profile) => memberIds.includes(profile.id)).map((profile) => `@${profile.username}`).join(', ') || 'nenhum'}</p>
          {canEdit ? <div className="button-row"><button className="button button-ghost" onClick={() => edit(group)}>Editar</button><button className="button button-danger" onClick={() => void remove(group.id)}>Remover</button></div> : null}
        </article>;
      })}
    </section>
  </div>;
}

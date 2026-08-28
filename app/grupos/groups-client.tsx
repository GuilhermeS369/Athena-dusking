'use client';

import { FormEvent, useMemo, useState } from 'react';

import styles from './groups.module.css';

type Organization = { id: string; name: string; role: 'admin' | 'operator' | 'viewer' };

type Group = {
  id: string;
  name: string;
  description: string | null;
  consumption_mode: 'single_use' | 'reusable';
  default_caption: string | null;
  created_at: string;
  updated_at: string;
};

type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  profile_picture_url: string | null;
  status: 'no_data' | 'online' | 'offline' | 'reauthorization_required';
};

type Membership = { group_id: string; profile_id: string };
type FallenCount = { group_id: string; fallen_profile_count: number };

type ExportRow = {
  group_name: string;
  group_consumption_mode: Group['consumption_mode'];
  row_kind: 'current' | 'fallen';
  username: string;
  zernio_connection_label: string | null;
  profile_added_at: string;
  profile_status: Profile['status'] | 'fallen';
  fallen_at: string | null;
  fall_reason: string | null;
};

type FormState = {
  name: string;
  description: string;
  consumptionMode: Group['consumption_mode'];
  defaultCaption: string;
};

const emptyForm: FormState = { name: '', description: '', consumptionMode: 'single_use', defaultCaption: '' };

const statusLabel: Record<Profile['status'], string> = {
  no_data: 'Sem dados',
  online: 'Conectado',
  offline: 'Desconectado',
  reauthorization_required: 'Reautorizar',
};

function ProfileAvatar({ profile, size = 'regular' }: { profile: Profile; size?: 'small' | 'regular' }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initial = profile.username.trim().charAt(0).toUpperCase() || '@';
  const className = `${styles.avatar} ${size === 'small' ? styles.avatarSmall : ''}`;

  return profile.profile_picture_url && !imageFailed
    ? <img className={className} src={profile.profile_picture_url} alt={`Foto de @${profile.username}`} onError={() => setImageFailed(true)} />
    : <span className={`${className} ${styles.avatarFallback}`} aria-hidden="true">{initial}</span>;
}

function ProfileIdentity({ profile, compact = false }: { profile: Profile; compact?: boolean }) {
  return <div className={styles.profileIdentity}>
    <ProfileAvatar profile={profile} size={compact ? 'small' : 'regular'} />
    <div className={styles.profileText}>
      <strong>@{profile.username}</strong>
      <span>{profile.display_name || 'Perfil profissional'}</span>
    </div>
    <span className={`${styles.statusBadge} ${styles[`status${profile.status}`]}`}>
      <span aria-hidden="true" />{statusLabel[profile.status]}
    </span>
  </div>;
}

export default function GroupsClient({
  activeOrganization,
  groups: initialGroups,
  profiles,
  memberships: initialMemberships,
  fallenCounts,
}: {
  activeOrganization: Organization;
  groups: Group[];
  profiles: Profile[];
  memberships: Membership[];
  fallenCounts: FallenCount[];
}) {
  const canManage = ['admin', 'operator'].includes(activeOrganization.role);
  const [groups, setGroups] = useState(initialGroups);
  const [memberships, setMemberships] = useState(initialMemberships);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [memberModalGroupId, setMemberModalGroupId] = useState<string | null>(null);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);
  const [exportingGroupId, setExportingGroupId] = useState<string | null>(null);

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const fallenCountByGroup = useMemo(() => new Map(fallenCounts.map((item) => [item.group_id, item.fallen_profile_count])), [fallenCounts]);
  const membershipsByGroup = useMemo(() => {
    const result = new Map<string, string[]>();
    memberships.forEach((membership) => result.set(membership.group_id, [...(result.get(membership.group_id) ?? []), membership.profile_id]));
    return result;
  }, [memberships]);
  const groupByProfileId = useMemo(() => {
    const result = new Map<string, string>();
    memberships.forEach((membership) => result.set(membership.profile_id, membership.group_id));
    return result;
  }, [memberships]);
  const sortedGroups = useMemo(() => [...groups].sort((first, second) =>
    first.name.localeCompare(second.name, 'pt-BR', { sensitivity: 'base', numeric: true })
      || first.name.localeCompare(second.name, 'pt-BR', { numeric: true })
      || first.id.localeCompare(second.id)
  ), [groups]);
  const memberModalGroup = groups.find((group) => group.id === memberModalGroupId) ?? null;
  const availableProfiles = useMemo(() => profiles.filter((profile) => !groupByProfileId.has(profile.id)), [groupByProfileId, profiles]);
  const filteredAvailableProfiles = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    if (!term) return availableProfiles;
    return availableProfiles.filter((profile) => `${profile.username} ${profile.display_name ?? ''}`.toLocaleLowerCase('pt-BR').includes(term));
  }, [availableProfiles, search]);
  const groupedProfileCount = groupByProfileId.size;

  function closeForm() {
    setEditingId(null);
    setForm(emptyForm);
    setFormOpen(false);
  }

  function openCreateForm() {
    setMessage('');
    setEditingId(null);
    setForm(emptyForm);
    setFormOpen(true);
  }

  function beginEdit(group: Group) {
    setMessage('');
    setEditingId(group.id);
    setForm({
      name: group.name,
      description: group.description ?? '',
      consumptionMode: group.consumption_mode,
      defaultCaption: group.default_caption ?? '',
    });
    setFormOpen(true);
  }

  function openMemberModal(groupId: string) {
    setMessage('');
    setSearch('');
    setSelectedProfileIds([]);
    setMemberModalGroupId(groupId);
  }

  function closeMemberModal() {
    setMemberModalGroupId(null);
    setSelectedProfileIds([]);
    setSearch('');
  }

  async function saveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage('');

    try {
      const response = await fetch(editingId ? `/api/groups/${editingId}` : '/api/groups', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const payload = await response.json() as { group?: Group; error?: string };
      if (!response.ok || !payload.group) {
        setMessage(payload.error ?? 'Não foi possível salvar o grupo.');
        return;
      }

      if (editingId) {
        setGroups((current) => current.map((group) => group.id === payload.group!.id ? payload.group! : group));
        closeForm();
      } else {
        setGroups((current) => [payload.group!, ...current]);
        closeForm();
        openMemberModal(payload.group.id);
      }
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteGroup(group: Group) {
    if (!window.confirm(`Excluir o grupo “${group.name}”? Os históricos serão preservados.`)) return;
    const response = await fetch(`/api/groups/${group.id}`, { method: 'DELETE' });
    const payload = await response.json() as { error?: string };
    if (!response.ok) {
      setMessage(payload.error ?? 'Não foi possível excluir o grupo.');
      return;
    }
    setGroups((current) => current.filter((item) => item.id !== group.id));
    setMemberships((current) => current.filter((item) => item.group_id !== group.id));
  }

  async function addSelectedProfiles() {
    if (!memberModalGroup || selectedProfileIds.length === 0) return;
    setSavingMembers(true);
    setMessage('');
    try {
      const response = await fetch(`/api/groups/${memberModalGroup.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileIds: selectedProfileIds }),
      });
      const payload = await response.json() as { error?: string; profileIds?: string[] };
      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível adicionar os perfis ao grupo.');
        return;
      }
      const addedIds = payload.profileIds ?? selectedProfileIds;
      setMemberships((current) => [...current, ...addedIds.map((profileId) => ({ group_id: memberModalGroup.id, profile_id: profileId }))]);
      closeMemberModal();
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setSavingMembers(false);
    }
  }

  async function removeProfile(groupId: string, profileId: string) {
    const profile = profileById.get(profileId);
    if (!window.confirm(`Remover @${profile?.username ?? 'perfil'} deste grupo?`)) return;
    setSavingMembers(true);
    setMessage('');
    try {
      const response = await fetch(`/api/groups/${groupId}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível remover o perfil.');
        return;
      }
      setMemberships((current) => current.filter((item) => !(item.group_id === groupId && item.profile_id === profileId)));
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setSavingMembers(false);
    }
  }

  function fileSafeName(value: string) {
    const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'grupo';
  }

  function fileDateStamp() {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}${part('month')}${part('day')}-${part('hour')}${part('minute')}`;
  }

  function formatDate(value: string | null) {
    if (!value) return '';
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  function exportStatusLabel(status: ExportRow['profile_status']) {
    return status === 'fallen' ? 'Caiu' : statusLabel[status];
  }

  async function exportGroup(group: Group) {
    setExportingGroupId(group.id);
    setMessage('');

    try {
      const response = await fetch(`/api/groups/${group.id}/export`);
      const payload = await response.json() as { group?: { name: string }; rows?: ExportRow[]; error?: string };
      if (!response.ok || !payload.group || !payload.rows) {
        setMessage(payload.error ?? 'Não foi possível preparar a exportação do grupo.');
        return;
      }

      const XLSX = await import('xlsx');
      const headers = ['@ do perfil', 'Zernio', 'Data de adição ao sistema', 'Nome do grupo', 'Modo do grupo', 'Situação', 'Status atual', 'Data da queda', 'Motivo da queda'];
      const rows = payload.rows.map((row) => [
        `@${row.username}`,
        row.zernio_connection_label ?? 'Não informado',
        formatDate(row.profile_added_at),
        row.group_name,
        row.group_consumption_mode === 'reusable' ? 'Reutilizável' : 'Uso único',
        row.row_kind === 'fallen' ? 'Caiu' : 'Atual',
        exportStatusLabel(row.profile_status),
        formatDate(row.fallen_at),
        row.fall_reason ?? '',
      ]);
      const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      worksheet['!cols'] = [20, 28, 24, 28, 18, 12, 22, 22, 70].map((wch) => ({ wch }));
      worksheet['!autofilter'] = { ref: `A1:I${Math.max(rows.length + 1, 2)}` };
      worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Perfis do grupo');
      const filename = `grupo-${fileSafeName(payload.group.name)}-${fileDateStamp()}.xlsx`;
      XLSX.writeFile(workbook, filename, { bookType: 'xlsx' });
      setMessage(`Arquivo ${filename} gerado com ${rows.length} perfil(is).`);
    } catch {
      setMessage('Não foi possível gerar o arquivo Excel.');
    } finally {
      setExportingGroupId(null);
    }
  }

  function toggleSelectedProfile(profileId: string) {
    setSelectedProfileIds((current) => current.includes(profileId)
      ? current.filter((item) => item !== profileId)
      : [...current, profileId]);
  }

  return <main className="standalone-page groups-page">
    <header className={`${styles.header} standalone-header`}>
      <div>
        <span className="section-kicker">{activeOrganization.name} · Organização</span>
        <h1>Grupos de perfis</h1>
        <p>Organize seus perfis para publicar com mais clareza. Cada perfil pode participar de apenas um grupo.</p>
      </div>
      {canManage && <button className="button button-primary" type="button" onClick={openCreateForm}>Criar grupo</button>}
    </header>

    <section className={styles.summary} aria-label="Resumo dos grupos">
      <span><strong>{groups.length}</strong> {groups.length === 1 ? 'grupo' : 'grupos'}</span>
      <span><strong>{groupedProfileCount}</strong> perfis agrupados</span>
      <span><strong>{availableProfiles.length}</strong> perfis disponíveis</span>
    </section>

    {message && <p className="inline-message" role="alert">{message}</p>}

    {groups.length === 0 ? <section className="panel empty-state">
      <span className="empty-state-icon" aria-hidden="true">◇</span>
      <h2>Nenhum grupo criado</h2>
      <p>Crie um grupo e escolha os perfis que farão parte dele.</p>
      {canManage && <button className="button button-primary" type="button" onClick={openCreateForm}>Criar primeiro grupo</button>}
    </section> : <section className={styles.grid} aria-label="Grupos de perfis">
      {sortedGroups.map((group) => {
        const memberProfiles = (membershipsByGroup.get(group.id) ?? []).map((id) => profileById.get(id)).filter((profile): profile is Profile => Boolean(profile));
        return <article className={`panel ${styles.card}`} key={group.id}>
          <div className={styles.cardHeader}>
            <div>
              <span className="section-kicker">{group.consumption_mode === 'reusable' ? 'Reutilizável' : 'Uso único'}</span>
              <h2>{group.name}</h2>
            </div>
            <div className={styles.cardCounts}>
              <span className={styles.fallenCount}>{fallenCountByGroup.get(group.id) ?? 0} caíram</span>
              <span className={styles.memberCount}>{memberProfiles.length} {memberProfiles.length === 1 ? 'perfil' : 'perfis'}</span>
            </div>
          </div>
          {group.description && <p className={styles.description}>{group.description}</p>}
          {group.default_caption && <p className={styles.caption}>“{group.default_caption}”</p>}
          <div className={styles.membersPreview}>
            {memberProfiles.length > 0 ? <>
              <div className={styles.avatarStack} aria-label={`${memberProfiles.length} perfis no grupo`}>
                {memberProfiles.slice(0, 5).map((profile) => <ProfileAvatar key={profile.id} profile={profile} size="small" />)}
                {memberProfiles.length > 5 && <span className={styles.moreAvatars}>+{memberProfiles.length - 5}</span>}
              </div>
              <span>{memberProfiles.slice(0, 2).map((profile) => `@${profile.username}`).join(', ')}{memberProfiles.length > 2 ? ' e mais' : ''}</span>
            </> : <span className={styles.emptyMembers}>Nenhum perfil adicionado</span>}
          </div>
          <div className={styles.actions}>
            <button className={styles.exportButton} type="button" aria-label={`Exportar perfis do grupo ${group.name}`} title="Exportar perfis" disabled={exportingGroupId !== null} onClick={() => exportGroup(group)}>
              <span aria-hidden="true">{exportingGroupId === group.id ? '…' : '⇩'}</span>
            </button>
          {canManage && <>
            <button className="button button-primary" type="button" onClick={() => openMemberModal(group.id)}>Gerenciar perfis</button>
            <button className="button button-ghost" type="button" onClick={() => beginEdit(group)}>Editar</button>
            <button className={styles.deleteButton} type="button" onClick={() => deleteGroup(group)}>Excluir</button>
          </>}
          </div>
        </article>;
      })}
    </section>}

    {formOpen && <div className={styles.backdrop} role="presentation" onMouseDown={closeForm}>
      <section className={`panel ${styles.modal}`} role="dialog" aria-modal="true" aria-labelledby="group-form-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className={styles.modalHeader}>
          <div><span className="section-kicker">{editingId ? 'Configuração do grupo' : 'Novo grupo'}</span><h2 id="group-form-title">{editingId ? 'Editar grupo' : 'Criar grupo'}</h2></div>
          <button className={styles.closeButton} type="button" aria-label="Fechar" onClick={closeForm}>×</button>
        </header>
        <form className={styles.form} onSubmit={saveGroup}>
          <label>Nome do grupo<input required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ex.: Perfis de moda" /></label>
          <label>Modo de consumo<select value={form.consumptionMode} onChange={(event) => setForm({ ...form, consumptionMode: event.target.value as FormState['consumptionMode'] })}><option value="single_use">Uso único</option><option value="reusable">Reutilizável</option></select></label>
          <label>Descrição <small>Opcional</small><textarea maxLength={500} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
          <label>Legenda padrão <small>Opcional</small><textarea maxLength={2200} rows={4} value={form.defaultCaption} onChange={(event) => setForm({ ...form, defaultCaption: event.target.value })} /></label>
          <footer className={styles.modalActions}><button className="button button-ghost" type="button" onClick={closeForm}>Cancelar</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Salvando…' : editingId ? 'Salvar alterações' : 'Criar e escolher perfis'}</button></footer>
        </form>
      </section>
    </div>}

    {memberModalGroup && <div className={styles.backdrop} role="presentation" onMouseDown={closeMemberModal}>
      <section className={`panel ${styles.modal} ${styles.memberModal}`} role="dialog" aria-modal="true" aria-labelledby="member-modal-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className={styles.modalHeader}>
          <div><span className="section-kicker">{memberModalGroup.name}</span><h2 id="member-modal-title">Gerenciar perfis</h2><p>Somente perfis sem grupo aparecem nesta lista.</p></div>
          <button className={styles.closeButton} type="button" aria-label="Fechar" onClick={closeMemberModal}>×</button>
        </header>
        <label className={styles.searchLabel}>Buscar perfil<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por @usuário ou nome" autoFocus /></label>
        {filteredAvailableProfiles.length === 0 ? <div className={styles.noProfiles}><strong>{availableProfiles.length === 0 ? 'Todos os perfis já estão em grupos.' : 'Nenhum perfil encontrado.'}</strong><span>{availableProfiles.length === 0 ? 'Remova um perfil de outro grupo para movê-lo.' : 'Tente outro nome ou usuário.'}</span></div> : <div className={styles.profileList}>
          {filteredAvailableProfiles.map((profile) => {
            const selected = selectedProfileIds.includes(profile.id);
            return <label className={`${styles.profileChoice} ${selected ? styles.profileChoiceSelected : ''}`} key={profile.id}>
              <input type="checkbox" checked={selected} onChange={() => toggleSelectedProfile(profile.id)} />
              <ProfileIdentity profile={profile} compact />
              <span className={styles.checkmark} aria-hidden="true">✓</span>
            </label>;
          })}
        </div>}
        <section className={styles.currentMembers} aria-label="Perfis atuais do grupo"><strong>Perfis neste grupo</strong>{(membershipsByGroup.get(memberModalGroup.id) ?? []).length === 0 ? <span>Nenhum perfil adicionado ainda.</span> : <div>{(membershipsByGroup.get(memberModalGroup.id) ?? []).map((profileId) => {
          const profile = profileById.get(profileId);
          if (!profile) return null;
          return <div className={styles.currentMember} key={profileId}><ProfileIdentity profile={profile} compact />{canManage && <button type="button" disabled={savingMembers} onClick={() => removeProfile(memberModalGroup.id, profileId)}>Remover</button>}</div>;
        })}</div>}</section>
        <footer className={styles.modalActions}><span className={styles.selectionCount}>{selectedProfileIds.length} selecionado{selectedProfileIds.length === 1 ? '' : 's'}</span><button className="button button-ghost" type="button" onClick={closeMemberModal}>Concluir</button><button className="button button-primary" type="button" disabled={selectedProfileIds.length === 0 || savingMembers} onClick={addSelectedProfiles}>{savingMembers ? 'Adicionando…' : `Adicionar${selectedProfileIds.length ? ` ${selectedProfileIds.length}` : ''} perfil${selectedProfileIds.length === 1 ? '' : 'is'}`}</button></footer>
      </section>
    </div>}
  </main>;
}

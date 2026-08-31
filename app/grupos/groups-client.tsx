'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useState } from 'react';

import styles from './groups.module.css';

type Organization = { id: string; name: string; role: 'admin' | 'operator' | 'viewer' };

type Group = {
  id: string;
  name: string;
  description: string | null;
  consumption_mode: 'single_use' | 'reusable';
  default_caption: string | null;
  recovery_enabled: boolean;
  /** Preenchido quando ESTE grupo e a esteira de recuperacao de outro. */
  recovery_source_group_id: string | null;
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

type Membership = { group_id: string; profile_id: string; created_at: string };
type MemberSort = 'recent' | 'oldest' | 'username';
type MemberModalTab = 'available' | 'members';
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
  const router = useRouter();
  const [groups, setGroups] = useState(initialGroups);
  const [memberships, setMemberships] = useState(initialMemberships);

  useEffect(() => setGroups(initialGroups), [initialGroups]);
  useEffect(() => setMemberships(initialMemberships), [initialMemberships]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [memberModalGroupId, setMemberModalGroupId] = useState<string | null>(null);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [memberSort, setMemberSort] = useState<MemberSort>('recent');
  const [memberModalTab, setMemberModalTab] = useState<MemberModalTab>('available');
  const [memberFilterSearch, setMemberFilterSearch] = useState('');
  const [moveTargetGroupId, setMoveTargetGroupId] = useState('');
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState('');
  const [recoveryBusyId, setRecoveryBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);
  const [exportingGroupId, setExportingGroupId] = useState<string | null>(null);

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const fallenCountByGroup = useMemo(() => new Map(fallenCounts.map((item) => [item.group_id, item.fallen_profile_count])), [fallenCounts]);
  const membershipsByGroup = useMemo(() => {
    const result = new Map<string, Membership[]>();
    memberships.forEach((membership) => result.set(membership.group_id, [...(result.get(membership.group_id) ?? []), membership]));
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
  const sortedCurrentMemberships = useMemo(() => {
    const list = memberModalGroup ? [...(membershipsByGroup.get(memberModalGroup.id) ?? [])] : [];
    if (memberSort === 'username') {
      list.sort((first, second) => (profileById.get(first.profile_id)?.username ?? '').localeCompare(profileById.get(second.profile_id)?.username ?? '', 'pt-BR', { sensitivity: 'base', numeric: true }));
    } else {
      list.sort((first, second) => memberSort === 'recent' ? second.created_at.localeCompare(first.created_at) : first.created_at.localeCompare(second.created_at));
    }
    return list;
  }, [memberModalGroup, membershipsByGroup, memberSort, profileById]);
  const filteredCurrentMemberships = useMemo(() => {
    const term = memberFilterSearch.trim().toLocaleLowerCase('pt-BR');
    if (!term) return sortedCurrentMemberships;
    return sortedCurrentMemberships.filter((membership) => {
      const profile = profileById.get(membership.profile_id);
      if (!profile) return false;
      return `${profile.username} ${profile.display_name ?? ''}`.toLocaleLowerCase('pt-BR').includes(term);
    });
  }, [sortedCurrentMemberships, memberFilterSearch, profileById]);
  const currentMemberIds = filteredCurrentMemberships.map((membership) => membership.profile_id);
  const availableProfiles = useMemo(() => profiles.filter((profile) => !groupByProfileId.has(profile.id)), [groupByProfileId, profiles]);
  const filteredAvailableProfiles = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('pt-BR');
    if (!term) return availableProfiles;
    return availableProfiles.filter((profile) => `${profile.username} ${profile.display_name ?? ''}`.toLocaleLowerCase('pt-BR').includes(term));
  }, [availableProfiles, search]);
  const groupedProfileCount = groupByProfileId.size;
  const otherGroups = useMemo(() => memberModalGroup ? sortedGroups.filter((group) => group.id !== memberModalGroup.id) : [], [sortedGroups, memberModalGroup]);

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
    setMemberFilterSearch('');
    setMoveTargetGroupId('');
    setSelectedProfileIds([]);
    setSelectedMemberIds([]);
    setMemberModalTab('available');
    setMemberModalGroupId(groupId);
    router.refresh();
  }

  function closeMemberModal() {
    setMemberModalGroupId(null);
    setSelectedProfileIds([]);
    setSelectedMemberIds([]);
    setSearch('');
    setMemberFilterSearch('');
    setMoveTargetGroupId('');
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

  async function toggleRecovery(group: Group, enabled: boolean) {
    setMessage('');
    setRecoveryBusyId(group.id);
    try {
      const response = await fetch(`/api/groups/${group.id}/recovery`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryEnabled: enabled }),
      });
      const payload = await response.json() as { group?: Group; error?: string };
      if (!response.ok || !payload.group) {
        setMessage(payload.error ?? 'Não foi possível mudar a recuperação do grupo.');
        return;
      }
      setGroups((current) => current.map((item) => (
        item.id === group.id ? { ...item, recovery_enabled: enabled } : item
      )));
      setMessage(enabled
        ? `“${group.name}” entrou na análise de recuperação. Rode Recalcular na tela de Recuperação.`
        : `“${group.name}” saiu da análise de recuperação.`);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setRecoveryBusyId(null);
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
      const payload = await response.json() as { error?: string; profileIds?: string[]; conflictProfileIds?: string[] };
      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível adicionar os perfis ao grupo.');
        if (payload.conflictProfileIds?.length) {
          const stale = new Set(payload.conflictProfileIds);
          const staleAt = new Date().toISOString();
          setMemberships((current) => [
            ...current.filter((item) => !stale.has(item.profile_id)),
            ...payload.conflictProfileIds!.map((profileId) => ({ group_id: '__elsewhere__', profile_id: profileId, created_at: staleAt })),
          ]);
          setSelectedProfileIds((current) => current.filter((id) => !stale.has(id)));
        }
        return;
      }
      const addedIds = payload.profileIds ?? selectedProfileIds;
      const addedAt = new Date().toISOString();
      setMemberships((current) => [...current, ...addedIds.map((profileId) => ({ group_id: memberModalGroup.id, profile_id: profileId, created_at: addedAt }))]);
      setSelectedProfileIds([]);
      setSearch('');
      setMemberModalTab('members');
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
      setSelectedMemberIds((current) => current.filter((item) => item !== profileId));
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setSavingMembers(false);
    }
  }

  async function removeSelectedMembers(groupId: string, profileIds: string[]) {
    if (profileIds.length === 0) return;
    const confirmMessage = profileIds.length === 1
      ? `Remover @${profileById.get(profileIds[0])?.username ?? 'perfil'} deste grupo?`
      : `Remover ${profileIds.length} perfis selecionados deste grupo?`;
    if (!window.confirm(confirmMessage)) return;
    setSavingMembers(true);
    setMessage('');
    try {
      const response = await fetch(`/api/groups/${groupId}/members`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileIds }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível remover os perfis selecionados.');
        return;
      }
      setMemberships((current) => current.filter((item) => !(item.group_id === groupId && profileIds.includes(item.profile_id))));
      setSelectedMemberIds([]);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setSavingMembers(false);
    }
  }

  async function moveSelectedMembers(sourceGroupId: string, targetGroupId: string, profileIds: string[]) {
    if (!targetGroupId || profileIds.length === 0) return;
    const targetGroup = groups.find((group) => group.id === targetGroupId);
    const confirmMessage = profileIds.length === 1
      ? `Mover @${profileById.get(profileIds[0])?.username ?? 'perfil'} para o grupo “${targetGroup?.name ?? 'selecionado'}”?`
      : `Mover ${profileIds.length} perfis para o grupo “${targetGroup?.name ?? 'selecionado'}”?`;
    if (!window.confirm(confirmMessage)) return;
    setSavingMembers(true);
    setMessage('');
    try {
      const response = await fetch(`/api/groups/${sourceGroupId}/members/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetGroupId, profileIds }),
      });
      const payload = await response.json() as { error?: string; movedProfileIds?: string[] };
      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível mover os perfis selecionados.');
        return;
      }
      const movedIds = payload.movedProfileIds ?? profileIds;
      const movedAt = new Date().toISOString();
      setMemberships((current) => [
        ...current.filter((item) => !(item.group_id === sourceGroupId && movedIds.includes(item.profile_id))),
        ...movedIds.map((profileId) => ({ group_id: targetGroupId, profile_id: profileId, created_at: movedAt })),
      ]);
      setSelectedMemberIds([]);
      setMoveTargetGroupId('');
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

  function toggleSelectAllProfiles(profileIds: string[]) {
    setSelectedProfileIds((current) => {
      const allSelected = profileIds.length > 0 && profileIds.every((id) => current.includes(id));
      if (allSelected) return current.filter((id) => !profileIds.includes(id));
      return [...new Set([...current, ...profileIds])];
    });
  }

  function toggleSelectedMember(profileId: string) {
    setSelectedMemberIds((current) => current.includes(profileId)
      ? current.filter((item) => item !== profileId)
      : [...current, profileId]);
  }

  function toggleSelectAllMembers(memberIds: string[]) {
    setSelectedMemberIds((current) => {
      const allSelected = memberIds.length > 0 && memberIds.every((id) => current.includes(id));
      if (allSelected) return current.filter((id) => !memberIds.includes(id));
      return [...new Set([...current, ...memberIds])];
    });
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
        const memberProfiles = (membershipsByGroup.get(group.id) ?? []).map((membership) => profileById.get(membership.profile_id)).filter((profile): profile is Profile => Boolean(profile));
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
          {group.recovery_source_group_id
            ? <p className={styles.recoveryNote}>
                Esteira de recuperação. Ela não é analisada como origem — é a coorte em observação.
              </p>
            : canManage && <label className={styles.recoveryToggle}>
                <input
                  type="checkbox"
                  checked={group.recovery_enabled}
                  disabled={recoveryBusyId === group.id}
                  onChange={(event) => toggleRecovery(group, event.target.checked)}
                />
                <span>
                  <strong>Recuperação</strong>
                  {/* A régua compara cada perfil com a mediana do PRÓPRIO grupo,
                      então ligar grupo a grupo é o filtro certo: um grupo com
                      poucos julgáveis não deve entrar. */}
                  <em>Libera este grupo para a análise da tela de Recuperação.</em>
                </span>
              </label>}
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
        {message && <p className={`inline-message inline-message-error ${styles.modalMessage}`} role="alert">{message}</p>}
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
          <div><span className="section-kicker">{memberModalGroup.name}</span><h2 id="member-modal-title">Gerenciar perfis</h2></div>
          <button className={styles.closeButton} type="button" aria-label="Fechar" onClick={closeMemberModal}>×</button>
        </header>
        {message && <p className={`inline-message inline-message-error ${styles.modalMessage}`} role="alert">{message}</p>}

        <div className={styles.memberTabs} role="tablist" aria-label="Seções de perfis do grupo">
          <button type="button" role="tab" aria-selected={memberModalTab === 'available'} className={`${styles.memberTab} ${memberModalTab === 'available' ? styles.memberTabActive : ''}`} onClick={() => setMemberModalTab('available')}>
            Disponíveis{availableProfiles.length > 0 ? ` (${availableProfiles.length})` : ''}
          </button>
          <button type="button" role="tab" aria-selected={memberModalTab === 'members'} className={`${styles.memberTab} ${memberModalTab === 'members' ? styles.memberTabActive : ''}`} onClick={() => setMemberModalTab('members')}>
            Neste grupo{sortedCurrentMemberships.length > 0 ? ` (${sortedCurrentMemberships.length})` : ''}
          </button>
        </div>

        {memberModalTab === 'available' ? <div className={styles.tabPanel} role="tabpanel">
          <label className={styles.searchLabel}>Buscar perfil<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por @usuário ou nome" autoFocus /></label>
          {filteredAvailableProfiles.length > 0 && <div className={styles.listHeader}>
            {selectedProfileIds.length > 0 ? <div className={styles.bulkMemberActions}>
              <span>{selectedProfileIds.length} selecionado{selectedProfileIds.length === 1 ? '' : 's'}</span>
              <button className={styles.bulkClearButton} type="button" onClick={() => setSelectedProfileIds([])}>Limpar</button>
            </div> : <label className={styles.selectAllMembers}>
              <input
                type="checkbox"
                checked={filteredAvailableProfiles.every((profile) => selectedProfileIds.includes(profile.id))}
                ref={(input) => { if (input) input.indeterminate = selectedProfileIds.length > 0 && !filteredAvailableProfiles.every((profile) => selectedProfileIds.includes(profile.id)); }}
                onChange={() => toggleSelectAllProfiles(filteredAvailableProfiles.map((profile) => profile.id))}
              />
              Selecionar todos
            </label>}
          </div>}
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
        </div> : <div className={styles.tabPanel} role="tabpanel">
          <label className={styles.searchLabel}>Buscar perfil neste grupo<input value={memberFilterSearch} onChange={(event) => setMemberFilterSearch(event.target.value)} placeholder="Buscar por @usuário ou nome" autoFocus /></label>
          {sortedCurrentMemberships.length > 0 && <div className={styles.listHeader}>
            {canManage && selectedMemberIds.length > 0 ? <div className={styles.bulkMemberActions}>
              <span>{selectedMemberIds.length} selecionado{selectedMemberIds.length === 1 ? '' : 's'}</span>
              {otherGroups.length > 0 && <>
                <select className={styles.moveGroupSelect} value={moveTargetGroupId} onChange={(event) => setMoveTargetGroupId(event.target.value)} aria-label="Mover selecionados para outro grupo">
                  <option value="">Mover para…</option>
                  {otherGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
                <button className={styles.bulkMoveButton} type="button" disabled={!moveTargetGroupId || savingMembers} onClick={() => moveSelectedMembers(memberModalGroup.id, moveTargetGroupId, selectedMemberIds)}>Mover</button>
              </>}
              <button className={styles.bulkClearButton} type="button" onClick={() => setSelectedMemberIds([])}>Limpar</button>
              <button className={styles.bulkRemoveButton} type="button" disabled={savingMembers} onClick={() => removeSelectedMembers(memberModalGroup.id, selectedMemberIds)}>Remover</button>
            </div> : <>
              {sortedCurrentMemberships.length > 1 && <select className={styles.memberSortSelect} value={memberSort} onChange={(event) => setMemberSort(event.target.value as MemberSort)} aria-label="Ordenar perfis do grupo">
                <option value="recent">Adicionados recentemente</option>
                <option value="oldest">Adicionados há mais tempo</option>
                <option value="username">Usuário (A-Z)</option>
              </select>}
              {canManage && currentMemberIds.length > 0 && <label className={styles.selectAllMembers}>
                <input
                  type="checkbox"
                  checked={currentMemberIds.every((id) => selectedMemberIds.includes(id))}
                  ref={(input) => { if (input) input.indeterminate = selectedMemberIds.length > 0 && !currentMemberIds.every((id) => selectedMemberIds.includes(id)); }}
                  onChange={() => toggleSelectAllMembers(currentMemberIds)}
                />
                Selecionar todos
              </label>}
            </>}
          </div>}
          {sortedCurrentMemberships.length === 0 ? <div className={styles.noProfiles}><strong>Nenhum perfil adicionado ainda.</strong><span>Use a aba “Disponíveis” para adicionar perfis a este grupo.</span></div> : currentMemberIds.length === 0 ? <div className={styles.noProfiles}><strong>Nenhum perfil encontrado.</strong><span>Tente outro nome ou usuário.</span></div> : <div className={styles.memberList}>
            {currentMemberIds.map((profileId) => {
              const profile = profileById.get(profileId);
              if (!profile) return null;
              const selected = selectedMemberIds.includes(profileId);
              return <div className={`${styles.currentMember} ${selected ? styles.currentMemberSelected : ''}`} key={profileId}>
                {canManage && <input type="checkbox" checked={selected} onChange={() => toggleSelectedMember(profileId)} aria-label={`Selecionar @${profile.username}`} />}
                <ProfileIdentity profile={profile} compact />
                {canManage && <button type="button" disabled={savingMembers} onClick={() => removeProfile(memberModalGroup.id, profileId)}>Remover</button>}
              </div>;
            })}
          </div>}
        </div>}

        <footer className={styles.modalActions}>
          {memberModalTab === 'available' ? <>
            <span className={styles.selectionCount}>{selectedProfileIds.length} selecionado{selectedProfileIds.length === 1 ? '' : 's'}</span>
            <button className="button button-ghost" type="button" onClick={closeMemberModal}>Fechar</button>
            <button className="button button-primary" type="button" disabled={selectedProfileIds.length === 0 || savingMembers} onClick={addSelectedProfiles}>{savingMembers ? 'Adicionando…' : `Adicionar${selectedProfileIds.length ? ` ${selectedProfileIds.length}` : ''} perfil${selectedProfileIds.length === 1 ? '' : 'is'}`}</button>
          </> : <button className="button button-ghost" type="button" onClick={closeMemberModal}>Fechar</button>}
        </footer>
      </section>
    </div>}
  </main>;
}

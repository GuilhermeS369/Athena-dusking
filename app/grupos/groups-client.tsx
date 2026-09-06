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
type DeleteScope = 'media' | 'media_profiles';

/** Resumo do dry-run que alimenta o passo de impacto do modal. */
type DeletionSummary = {
  profileTotal: number;
  zernioCount: number;
  metaCount: number;
  connectionLabels: string[];
  mediaExclusive: number;
  mediaShared: number;
  mediaInActivePlan: number;
  scheduledItems: number;
  historyItems: number;
  activePlanCount: number;
};

type DeletionFailure = { kind: 'media' | 'profile'; label: string; detail: string | null; message: string };

type DeletionJob = {
  id: string;
  groupId: string;
  groupName: string;
  scope: DeleteScope;
  status: string;
  terminal: boolean;
  total: number;
  done: number;
  failed: number;
  percent: number;
  media: { total: number; deleted: number; failed: number; detached: number; skipped: number };
  profiles: { total: number; done: number; failed: number };
  historyItemsDeleted: number;
  lastErrorMessage: string | null;
  failures: DeletionFailure[];
  createdAt: string;
  finishedAt: string | null;
};
type MemberSort = 'recent' | 'oldest' | 'username';
type MemberModalTab = 'available' | 'members';
type FallenCount = { group_id: string; fallen_profile_count: number };

type ExportRow = {
  group_id: string;
  group_name: string;
  group_consumption_mode: Group['consumption_mode'];
  row_kind: 'current' | 'fallen';
  username: string;
  connection_label: string | null;
  profile_added_at: string;
  profile_status: Profile['status'] | 'fallen';
  fallen_at: string | null;
  fall_reason: string | null;
  total_views: number | null;
  analytics_synced_at: string | null;
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

const exportHeaders = ['Nome do grupo', 'Modo do grupo', '@ do perfil', 'Conexão', 'Data de adição ao sistema', 'Situação', 'Status atual', 'Views totais', 'Views atualizadas em', 'Data da queda', 'Motivo da queda'];
const exportColumnWidths = [30, 18, 20, 28, 24, 12, 22, 14, 22, 22, 70];

/**
 * A planilha de um grupo e a de todos são a mesma planilha com recortes
 * diferentes, então a montagem é uma só: mudar coluna aqui muda nos dois.
 *
 * O grupo abre a linha porque no arquivo com todos ele é a primeira pergunta de
 * quem lê ("de qual grupo é esta linha?"); no arquivo de um grupo só a coluna
 * repete o mesmo valor e serve de cabeçalho do que foi exportado.
 *
 * "Conexão" é de onde o perfil publica: o app da Meta ou a conta Zernio,
 * resolvido pelo provedor na migration 407. Na linha de queda é o rótulo
 * congelado no incidente, porque depois da queda o vínculo não existe mais.
 * Fica "Não informado" quando quem exporta é viewer — meta_apps e
 * zernio_connections só abrem para admin/operator.
 *
 * "Views totais" vem de profile_analytics_current — o mesmo número da tela de
 * perfis. Perfil sem sincronia de analytics fica vazio de propósito: zero seria
 * uma afirmação, vazio é o que se sabe. Na linha de queda o valor é o congelado
 * no instante da queda, porque dali em diante o perfil parou de sincronizar.
 */
function buildExportSheet(XLSX: typeof import('xlsx'), rows: ExportRow[]) {
  const body = rows.map((row) => [
    row.group_name,
    row.group_consumption_mode === 'reusable' ? 'Reutilizável' : 'Uso único',
    `@${row.username}`,
    row.connection_label ?? 'Não informado',
    formatDate(row.profile_added_at),
    row.row_kind === 'fallen' ? 'Caiu' : 'Atual',
    exportStatusLabel(row.profile_status),
    row.total_views ?? '',
    formatDate(row.analytics_synced_at),
    formatDate(row.fallen_at),
    row.fall_reason ?? '',
  ]);
  const worksheet = XLSX.utils.aoa_to_sheet([exportHeaders, ...body]);
  worksheet['!cols'] = exportColumnWidths.map((wch) => ({ wch }));
  worksheet['!autofilter'] = { ref: `A1:K${Math.max(body.length + 1, 2)}` };
  worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };
  return worksheet;
}

function totalViewsOf(rows: ExportRow[]) {
  return rows.reduce((total, row) => total + (row.total_views ?? 0), 0);
}

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
  const [exportingAll, setExportingAll] = useState(false);
  const [deletionJobs, setDeletionJobs] = useState<DeletionJob[]>([]);
  const [dismissedJobIds, setDismissedJobIds] = useState<string[]>([]);
  // Contador bumpado no clique para religar o laço de acompanhamento sem
  // depender do array otimista, que muda por outros motivos.
  const [deletionNonce, setDeletionNonce] = useState(0);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [deleteScope, setDeleteScope] = useState<DeleteScope | null>(null);
  const [deleteSummary, setDeleteSummary] = useState<DeletionSummary | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [deleteBusy, setDeleteBusy] = useState<'preview' | 'deleting' | null>(null);
  const [deleteError, setDeleteError] = useState('');
  // Marcação otimista: começa no clique, sem esperar a primeira volta do
  // acompanhamento. Sem isto sobra uma janela de segundos com o card destravado,
  // aceitando "editar" e "gerenciar perfis" sobre um grupo que está saindo.
  const [justDeletedGroupIds, setJustDeletedGroupIds] = useState<string[]>([]);

  // ACOMPANHAMENTO QUE SOBREVIVE AO F5.
  //
  // O laco roda no MOUNT, nao a partir do clique. Essa e a diferenca em relacao
  // a /perfis e /galeria, onde o estado comeca `null` e o poll so liga depois de
  // uma exclusao ser disparada nesta aba: la, atualizar a pagina faz o progresso
  // sumir mesmo com a operacao viva no banco. Aqui a tela nao guarda nada — ela
  // pergunta ao servidor quem esta saindo, e o servidor sabe.
  //
  // O laco se desliga sozinho quando nao ha job ativo, para uma tela parada nao
  // ficar batendo no servidor a cada 5s para sempre.
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    // Contagem da volta anterior, guardada aqui e nao em estado: ela decide
    // apenas quando recarregar, e um estado a mais religaria o laco.
    let previousActive = 0;

    async function tick() {
      try {
        const response = await fetch('/api/groups/deletion-jobs', { cache: 'no-store' });
        if (!alive) return;
        if (response.ok) {
          const payload = await response.json() as { jobs?: DeletionJob[] };
          const jobs = payload.jobs ?? [];
          setDeletionJobs(jobs);
          const active = jobs.filter((job) => !job.terminal);
          // Solta a marcacao otimista assim que o servidor assume o caso — ou
          // quando o job termina, para o card nao ficar travado para sempre se
          // a exclusao falhar logo na abertura.
          const activeIds = new Set(active.map((job) => job.groupId));
          setJustDeletedGroupIds((current) => current.filter(
            (id) => activeIds.has(id) || !jobs.some((job) => job.groupId === id),
          ));

          // A fila esvaziou nesta volta: o grupo saiu da listagem no finalize, e
          // recarregar e o que o faz sumir da tela sem exigir F5. Comparar com a
          // volta anterior evita recarregar a cada 5s numa tela que so tem jobs
          // antigos no painel.
          if (!active.length) {
            timer = null;
            if (previousActive > 0) router.refresh();
            previousActive = 0;
            return;
          }
          previousActive = active.length;
        }
      } catch {
        // Uma leitura perdida nao derruba a tela; a proxima volta resolve.
      }
      if (alive) timer = window.setTimeout(() => { void tick(); }, 5000);
    }

    void tick();
    return () => { alive = false; if (timer) window.clearTimeout(timer); };
  }, [deletionNonce, router]);

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
  // Quem esta saindo: o que o servidor reporta como job ativo, mais o que esta
  // aba acabou de disparar. A uniao e o que trava o card.
  const deletingGroupIds = useMemo(() => new Set([
    ...deletionJobs.filter((job) => !job.terminal).map((job) => job.groupId),
    ...justDeletedGroupIds,
  ]), [deletionJobs, justDeletedGroupIds]);
  const visibleJobs = useMemo(
    () => deletionJobs.filter((job) => !dismissedJobIds.includes(job.id)),
    [deletionJobs, dismissedJobIds],
  );
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

  function openDeleteModal(group: Group) {
    setMessage('');
    setDeleteError('');
    setDeleteScope(null);
    setDeleteSummary(null);
    setDeleteConfirmation('');
    setDeleteBusy(null);
    setDeleteGroupTarget(group);
  }

  function closeDeleteModal() {
    if (deleteBusy === 'deleting') return;
    setDeleteGroupTarget(null);
    setDeleteScope(null);
    setDeleteSummary(null);
    setDeleteConfirmation('');
    setDeleteError('');
  }

  /** Escolhido o escopo, o dry-run traz os números do passo de impacto. */
  async function chooseDeleteScope(group: Group, scope: DeleteScope) {
    setDeleteScope(scope);
    setDeleteSummary(null);
    setDeleteConfirmation('');
    setDeleteError('');
    setDeleteBusy('preview');
    try {
      const response = await fetch(`/api/groups/${group.id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, dryRun: true }),
      });
      const payload = await response.json() as { summary?: DeletionSummary; error?: string };
      if (!response.ok || !payload.summary) {
        setDeleteError(payload.error ?? 'Não foi possível medir o que será excluído.');
        return;
      }
      setDeleteSummary(payload.summary);
    } catch {
      setDeleteError('Não foi possível conectar ao servidor.');
    } finally {
      setDeleteBusy(null);
    }
  }

  async function confirmDeleteGroup(group: Group, scope: DeleteScope) {
    setDeleteBusy('deleting');
    setDeleteError('');
    try {
      const response = await fetch(`/api/groups/${group.id}/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, confirmation: deleteConfirmation }),
      });
      const payload = await response.json() as { job?: { id: string }; warning?: string; error?: string };
      if (!response.ok || !payload.job) {
        setDeleteError(payload.error ?? 'Não foi possível excluir o grupo.');
        return;
      }
      // Trava o card antes da primeira volta do acompanhamento.
      setJustDeletedGroupIds((current) => [...new Set([...current, group.id])]);
      setDeletionNonce((current) => current + 1);
      setDeleteGroupTarget(null);
      setDeleteScope(null);
      setDeleteSummary(null);
      setDeleteConfirmation('');
      setMessage(payload.warning ?? `Exclusão de “${group.name}” iniciada. Acompanhe o andamento acima.`);
    } catch {
      setDeleteError('Não foi possível conectar ao servidor.');
    } finally {
      setDeleteBusy(null);
    }
  }

  async function retryDeletion(job: DeletionJob) {
    setRetryingJobId(job.id);
    setMessage('');
    try {
      const response = await fetch(`/api/groups/deletion-jobs/${job.id}/retry`, { method: 'POST' });
      const payload = await response.json() as { requeuedMedia?: number; reopenedProfiles?: number; warning?: string; error?: string };
      if (!response.ok) {
        setMessage(payload.error ?? 'Não foi possível retomar a exclusão.');
        return;
      }
      const parts: string[] = [];
      if (payload.requeuedMedia) parts.push(`${payload.requeuedMedia} mídia(s) de volta na fila`);
      if (payload.reopenedProfiles) parts.push(`${payload.reopenedProfiles} perfil(is) reabertos`);
      setMessage(parts.length ? `${parts.join(' · ')}.` : (payload.warning ?? 'Nada a retomar.'));
      setDeletionNonce((current) => current + 1);
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setRetryingJobId(null);
    }
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
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, buildExportSheet(XLSX, payload.rows), 'Perfis do grupo');
      const filename = `grupo-${fileSafeName(payload.group.name)}-${fileDateStamp()}.xlsx`;
      XLSX.writeFile(workbook, filename, { bookType: 'xlsx' });
      setMessage(`Arquivo ${filename} gerado com ${payload.rows.length} perfil(is) e ${totalViewsOf(payload.rows).toLocaleString('pt-BR')} views.`);
    } catch {
      setMessage('Não foi possível gerar o arquivo Excel.');
    } finally {
      setExportingGroupId(null);
    }
  }

  /**
   * Mesmas colunas da exportação por grupo, numa aba só, com todos os grupos —
   * e a coluna "Nome do grupo" abrindo cada linha para dizer de quem ela é.
   * Grupo sem nenhum perfil e sem nenhuma queda não gera linha, porque a view
   * projeta vínculos e não grupos; por isso a mensagem diz quantos grupos
   * entraram em vez de repetir o total da tela.
   */
  async function exportAllGroups() {
    setExportingAll(true);
    setMessage('');

    try {
      const response = await fetch('/api/groups/export-all');
      const payload = await response.json() as { rows?: ExportRow[]; error?: string };
      if (!response.ok || !payload.rows) {
        setMessage(payload.error ?? 'Não foi possível preparar a exportação dos grupos.');
        return;
      }
      if (payload.rows.length === 0) {
        setMessage('Não há nada para exportar: nenhum grupo tem perfis ou quedas registradas.');
        return;
      }

      const XLSX = await import('xlsx');
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, buildExportSheet(XLSX, payload.rows), 'Perfis por grupo');
      const filename = `grupos-${fileSafeName(activeOrganization.name)}-${fileDateStamp()}.xlsx`;
      XLSX.writeFile(workbook, filename, { bookType: 'xlsx' });
      const groupCount = new Set(payload.rows.map((row) => row.group_id)).size;
      setMessage(`Arquivo ${filename} gerado com ${payload.rows.length} perfil(is) de ${groupCount} grupo(s) e ${totalViewsOf(payload.rows).toLocaleString('pt-BR')} views.`);
    } catch {
      setMessage('Não foi possível gerar o arquivo Excel.');
    } finally {
      setExportingAll(false);
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

  return <main className={`standalone-page groups-page ${styles.page}`}>
    <header className={`${styles.header} standalone-header`}>
      <div>
        <span className="section-kicker">{activeOrganization.name} · Organização</span>
        <h1>Grupos de perfis</h1>
        <p>Organize seus perfis para publicar com mais clareza. Cada perfil pode participar de apenas um grupo.</p>
      </div>
      <div className={styles.headerActions}>
        <button
          className="button button-ghost"
          type="button"
          title="Baixa um único .xlsx com os perfis de todos os grupos, nas mesmas colunas da exportação por grupo."
          disabled={exportingAll || exportingGroupId !== null || groups.length === 0}
          onClick={exportAllGroups}
        >{exportingAll ? 'Exportando…' : '⇩ Exportar todos'}</button>
        {canManage && <button className="button button-primary" type="button" onClick={openCreateForm}>Criar grupo</button>}
      </div>
    </header>

    <section className={styles.summary} aria-label="Resumo dos grupos">
      <span><strong>{groups.length}</strong> {groups.length === 1 ? 'grupo' : 'grupos'}</span>
      <span><strong>{groupedProfileCount}</strong> perfis agrupados</span>
      <span><strong>{availableProfiles.length}</strong> perfis disponíveis</span>
    </section>

    {visibleJobs.map((job) => {
      const doneWidth = job.total > 0 ? (job.done / job.total) * 100 : (job.terminal ? 100 : 0);
      const failedWidth = job.total > 0 ? (job.failed / job.total) * 100 : 0;
      return <section className={`panel ${styles.removalPanel}`} key={job.id} aria-label={`Andamento da exclusão de ${job.groupName}`} aria-live="polite">
        <div className={styles.removalHeader}>
          <span className="section-kicker">{job.terminal ? 'Exclusão concluída' : 'Excluindo grupo'}</span>
          <strong>{job.groupName}</strong>
          <span className={styles.removalPercent}>{job.percent}%</span>
          {job.terminal && <button
            className={styles.removalDismiss}
            type="button"
            onClick={() => setDismissedJobIds((current) => [...current, job.id])}
          >Dispensar</button>}
        </div>

        <div
          className={styles.removalTrack}
          role="progressbar"
          aria-valuenow={job.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Andamento da exclusão de ${job.groupName}`}
        >
          {/* Duas faixas na mesma barra: o que saiu e o que falhou. Uma barra só,
              com a falha escondida no denominador, esconde justamente o que
              precisa de ação. */}
          <span className={styles.removalFillDone} style={{ width: `${doneWidth}%` }} />
          <span className={styles.removalFillFailed} style={{ width: `${failedWidth}%` }} />
        </div>

        <p className={styles.removalHint}>
          {job.media.total > 0 && <>{job.media.deleted} de {job.media.total} mídia(s) apagadas</>}
          {job.media.total > 0 && job.profiles.total > 0 && ' · '}
          {job.profiles.total > 0 && <>{job.profiles.done} de {job.profiles.total} perfil(is) removidos do Athena e da Zernio</>}
          {job.media.total === 0 && job.profiles.total === 0 && 'Nada a apagar neste grupo.'}
          {!job.terminal && ' · O worker de mídia e o de publicação drenam a fila em ciclos; a barra anda sozinha e sobrevive a atualizar a página.'}
        </p>

        {(job.media.detached > 0 || job.media.skipped > 0 || job.historyItemsDeleted > 0) && <p className={styles.removalHint}>
          {job.media.detached > 0 && <>{job.media.detached} mídia(s) compartilhada(s) foram preservadas e só saíram deste grupo. </>}
          {/* Migration 358: mídia presa em plano ativo já ficou bloqueada em
              silêncio uma vez, e ninguém descobriu pela tela. Aqui ela é dita. */}
          {job.media.skipped > 0 && <>{job.media.skipped} mídia(s) não saíram por estarem presas a um agendamento em massa ainda ativo. </>}
          {job.historyItemsDeleted > 0 && <>{job.historyItemsDeleted} publicação(ões) apagadas do histórico.</>}
        </p>}

        {job.lastErrorMessage && <p className={`inline-message inline-message-error ${styles.removalHint}`} role="alert">{job.lastErrorMessage}</p>}

        {job.failures.length > 0 && <>
          <ul className={styles.removalFailures}>
            {job.failures.map((failure, index) => <li key={`${job.id}-${failure.kind}-${index}`}>
              <strong>{failure.label}</strong>
              {failure.detail && <span>{failure.detail}</span>}
              <small>{failure.message}</small>
            </li>)}
          </ul>
          {job.failed > job.failures.length && <p className={styles.removalHint}>
            e mais {job.failed - job.failures.length} falha(s) não listadas.
          </p>}
        </>}

        {job.failed > 0 && <div className={styles.removalActions}>
          <button
            className="button button-ghost"
            type="button"
            disabled={retryingJobId === job.id}
            onClick={() => retryDeletion(job)}
          >{retryingJobId === job.id ? 'Retomando…' : `Tentar novamente (${job.failed})`}</button>
        </div>}
      </section>;
    })}

    {message && <p className="inline-message" role="alert">{message}</p>}

    {groups.length === 0 ? <section className="panel empty-state">
      <span className="empty-state-icon" aria-hidden="true">◇</span>
      <h2>Nenhum grupo criado</h2>
      <p>Crie um grupo e escolha os perfis que farão parte dele.</p>
      {canManage && <button className="button button-primary" type="button" onClick={openCreateForm}>Criar primeiro grupo</button>}
    </section> : <section className={styles.grid} aria-label="Grupos de perfis">
      {sortedGroups.map((group) => {
        const memberProfiles = (membershipsByGroup.get(group.id) ?? []).map((membership) => profileById.get(membership.profile_id)).filter((profile): profile is Profile => Boolean(profile));
        const deleting = deletingGroupIds.has(group.id);
        return <article className={`panel ${styles.card} ${deleting ? styles.cardDeleting : ''}`} key={group.id} aria-busy={deleting}>
          <div className={styles.cardHeader}>
            <div>
              <span className="section-kicker">{group.consumption_mode === 'reusable' ? 'Reutilizável' : 'Uso único'}</span>
              <h2>{group.name}</h2>
            </div>
            <div className={styles.cardCounts}>
              {deleting
                ? <span className={styles.deletingBadge}><span aria-hidden="true" />excluindo…</span>
                : <>
                  <span className={styles.fallenCount}>{fallenCountByGroup.get(group.id) ?? 0} caíram</span>
                  <span className={styles.memberCount}>{memberProfiles.length} {memberProfiles.length === 1 ? 'perfil' : 'perfis'}</span>
                </>}
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
          {group.recovery_source_group_id
            ? <span className={styles.recoveryLane} title="Esta é a esteira de recuperação de outro grupo. Ela não é analisada como origem — é a coorte em observação.">
                Esteira de recuperação
              </span>
            : canManage && <label
                className={styles.recoverySwitch}
                title="Libera este grupo para a análise da tela de Recuperação. A régua compara cada perfil com a mediana do próprio grupo, por isso o interruptor é por grupo."
              >
                <input
                  type="checkbox"
                  checked={group.recovery_enabled}
                  disabled={recoveryBusyId === group.id || deleting}
                  onChange={(event) => toggleRecovery(group, event.target.checked)}
                />
                <span className={styles.recoveryTrack} aria-hidden="true" />
                Recuperação
              </label>}
          <div className={styles.actions}>
            <button className={styles.exportButton} type="button" aria-label={`Exportar perfis do grupo ${group.name}`} title="Exportar perfis" disabled={exportingGroupId !== null || exportingAll || deleting} onClick={() => exportGroup(group)}>
              <span aria-hidden="true">{exportingGroupId === group.id ? '…' : '⇩'}</span>
            </button>
          {canManage && <>
            <button className="button button-primary" type="button" disabled={deleting} onClick={() => openMemberModal(group.id)}>Gerenciar perfis</button>
            <button className="button button-ghost" type="button" disabled={deleting} onClick={() => beginEdit(group)}>Editar</button>
            <button className={styles.deleteButton} type="button" disabled={deleting} onClick={() => openDeleteModal(group)}>
              {deleting ? 'Excluindo…' : 'Excluir'}
            </button>
          </>}
          </div>
        </article>;
      })}
    </section>}

    {deleteGroupTarget && <div className={styles.backdrop} role="presentation" onMouseDown={closeDeleteModal}>
      <section className={`panel ${styles.modal} ${styles.deleteModal}`} role="dialog" aria-modal="true" aria-labelledby="group-delete-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className={styles.modalHeader}>
          <div>
            <span className="section-kicker">Ação irreversível</span>
            {/* "Como excluir" e nao "Tem certeza": a pergunta aqui e sobre o
                escopo, e as duas saidas sao legitimas. */}
            <h2 id="group-delete-title">Como excluir o grupo “{deleteGroupTarget.name}”?</h2>
          </div>
          <button className={styles.closeButton} type="button" aria-label="Fechar" disabled={deleteBusy === 'deleting'} onClick={closeDeleteModal}>×</button>
        </header>

        {deleteError && <p className={`inline-message inline-message-error ${styles.modalMessage}`} role="alert">{deleteError}</p>}

        {!deleteScope ? <>
          <p className="bulk-modal-help">
            As duas opções apagam o grupo e as mídias que só pertencem a ele, junto com o histórico de publicações delas.
            A diferença está nos perfis.
          </p>
          <div className={styles.deleteChoices}>
            <button className={styles.deleteChoice} type="button" onClick={() => chooseDeleteScope(deleteGroupTarget, 'media')}>
              <strong>Grupo e mídias</strong>
              <span>Os perfis continuam existindo e ficam sem grupo, prontos para entrar em outro.</span>
            </button>
            <button className={`${styles.deleteChoice} ${styles.deleteChoiceDanger}`} type="button" onClick={() => chooseDeleteScope(deleteGroupTarget, 'media_profiles')}>
              <strong>Grupo, mídias e perfis</strong>
              <span>Os perfis também saem do Athena e são desconectados na Zernio, liberando a vaga da chave. Não volta.</span>
            </button>
          </div>
          <footer className={styles.modalActions}>
            <button className="button button-secondary" type="button" onClick={closeDeleteModal}>Cancelar</button>
          </footer>
        </> : deleteBusy === 'preview' || !deleteSummary ? <>
          <p className="bulk-modal-help">Medindo o que será excluído…</p>
          <footer className={styles.modalActions}>
            <button className="button button-ghost" type="button" onClick={() => { setDeleteScope(null); setDeleteError(''); }}>Voltar</button>
          </footer>
        </> : <>
          <p className="bulk-modal-help">
            {deleteScope === 'media_profiles'
              ? 'Confira o que sai antes de confirmar. Perfis desconectados na Zernio não voltam.'
              : 'Confira o que sai antes de confirmar. Os arquivos apagados saem do Storage e não voltam.'}
          </p>

          <dl className={styles.deleteImpact}>
            <div>
              <dt>Mídias apagadas</dt>
              <dd>{deleteSummary.mediaExclusive}</dd>
            </div>
            {deleteSummary.mediaShared > 0 && <div>
              <dt>Mídias preservadas</dt>
              <dd>{deleteSummary.mediaShared} <small>estão em outro grupo; só saem deste</small></dd>
            </div>}
            {deleteSummary.mediaInActivePlan > 0 && <div>
              <dt>Mídias que ficam</dt>
              <dd>{deleteSummary.mediaInActivePlan} <small>presas a um agendamento em massa ativo</small></dd>
            </div>}
            <div>
              <dt>Publicações agendadas canceladas</dt>
              <dd>{deleteSummary.scheduledItems}</dd>
            </div>
            <div>
              <dt>Publicações apagadas do histórico</dt>
              <dd>{deleteSummary.historyItems}</dd>
            </div>
            {deleteScope === 'media_profiles' ? <div>
              <dt>Perfis excluídos</dt>
              <dd>
                {deleteSummary.profileTotal}
                {deleteSummary.zernioCount > 0 && <small>
                  {deleteSummary.zernioCount} na Zernio{deleteSummary.connectionLabels.length > 0 ? ` (${deleteSummary.connectionLabels.join(', ')})` : ''}
                  {deleteSummary.metaCount > 0 ? ` · ${deleteSummary.metaCount} da Meta, a remover no Meta Developers (veja /meta)` : ''}
                </small>}
              </dd>
            </div> : <div>
              <dt>Perfis que ficam sem grupo</dt>
              <dd>{deleteSummary.profileTotal}</dd>
            </div>}
            {deleteSummary.activePlanCount > 0 && <div>
              <dt>Agendamentos em massa ativos</dt>
              <dd>{deleteSummary.activePlanCount} <small>continuam existindo; as mídias deles não serão apagadas</small></dd>
            </div>}
          </dl>

          <label className={styles.deleteConfirmLabel}>
            Digite <strong>EXCLUIR</strong> para confirmar
            <input
              value={deleteConfirmation}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
              placeholder="EXCLUIR"
              autoComplete="off"
              autoFocus
              disabled={deleteBusy === 'deleting'}
            />
          </label>

          <footer className={styles.modalActions}>
            <button className="button button-ghost" type="button" disabled={deleteBusy === 'deleting'} onClick={() => { setDeleteScope(null); setDeleteSummary(null); setDeleteConfirmation(''); setDeleteError(''); }}>Voltar</button>
            <button className="button button-secondary" type="button" disabled={deleteBusy === 'deleting'} onClick={closeDeleteModal}>Cancelar</button>
            <button
              className="button button-danger"
              type="button"
              disabled={deleteBusy === 'deleting' || deleteConfirmation.trim().toUpperCase() !== 'EXCLUIR'}
              onClick={() => confirmDeleteGroup(deleteGroupTarget, deleteScope)}
            >{deleteBusy === 'deleting' ? 'Iniciando…' : deleteScope === 'media_profiles' ? 'Excluir grupo, mídias e perfis' : 'Excluir grupo e mídias'}</button>
          </footer>
        </>}
      </section>
    </div>}

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

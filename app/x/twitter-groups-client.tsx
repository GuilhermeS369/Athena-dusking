"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./twitter-groups.module.css";

type Group = { id: string; name: string; description: string | null };
type Profile = { id: string; username: string; display_name: string | null; avatar_url: string | null; status: string };
type Membership = { group_id: string; profile_id: string; created_at: string | null };

const statusLabels: Record<string, string> = {
  active: "Conectado", online: "Conectado", connected: "Conectado", syncing: "Sincronizando",
  pending: "Pendente", reconnect_required: "Reconectar", reauthorization_required: "Reconectar",
  offline: "Desconectado", disabled: "Desativado", error: "Com problema",
};
const statusLabel = (status: string) => statusLabels[status] ?? status.replaceAll("_", " ");
function statusTone(status: string) {
  if (["active", "online", "connected"].includes(status)) return styles.statusOnline;
  if (["syncing", "pending"].includes(status)) return styles.statusPending;
  if (["offline", "disabled", "error", "reconnect_required", "reauthorization_required"].includes(status)) return styles.statusWarning;
  return "";
}

function ProfileAvatar({ profile, small = false }: { profile: Profile; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  const className = `${styles.avatar} ${small ? styles.avatarSmall : ""}`;
  return profile.avatar_url && !failed ? (
    <img className={className} src={profile.avatar_url} alt={`Foto de @${profile.username}`} onError={() => setFailed(true)} />
  ) : (
    <span className={`${className} ${styles.avatarFallback}`} aria-hidden="true">
      {profile.username.trim().charAt(0).toUpperCase() || "X"}
    </span>
  );
}

function ProfileIdentity({ profile }: { profile: Profile }) {
  return <span className={styles.profileIdentity}>
    <ProfileAvatar profile={profile} />
    <span className={styles.profileText}><strong>@{profile.username}</strong><span>{profile.display_name || "Perfil do X"}</span></span>
    <span className={`${styles.statusBadge} ${statusTone(profile.status)}`}><span aria-hidden="true" />{statusLabel(profile.status)}</span>
  </span>;
}

function safeFilename(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "grupo-x";
}
function formatDate(value: string | null) {
  if (!value) return "Não informado";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

export default function TwitterGroupsClient({ organizationName, groups: initialGroups, profiles: initialProfiles, memberships: initialMemberships, canEdit, initialGroupsHasMore, initialGroupsCursor, initialProfilesHasMore, initialProfilesCursor }: {
  organizationName: string; groups: Group[]; profiles: Profile[]; memberships: Membership[]; canEdit: boolean; initialGroupsHasMore:boolean; initialGroupsCursor:string|null; initialProfilesHasMore:boolean; initialProfilesCursor:string|null;
}) {
  const router = useRouter();
  const [groups,setGroups]=useState(initialGroups); const [profiles,setProfiles]=useState(initialProfiles); const [memberships,setMemberships]=useState(initialMemberships);
  const [groupsHasMore,setGroupsHasMore]=useState(initialGroupsHasMore); const [groupsCursor,setGroupsCursor]=useState(initialGroupsCursor);
  const [profilesHasMore,setProfilesHasMore]=useState(initialProfilesHasMore); const [profilesCursor,setProfilesCursor]=useState(initialProfilesCursor); const [loadingMore,setLoadingMore]=useState('');
  const [groupFormOpen, setGroupFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [memberGroupId, setMemberGroupId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);

  async function loadMore(resource:'groups'|'profiles') { const cursor=resource==='groups'?groupsCursor:profilesCursor;if(!cursor||loadingMore)return;setLoadingMore(resource);try{const response=await fetch(`/api/x/groups?resource=${resource}&limit=100&cursor=${encodeURIComponent(cursor)}`,{cache:'no-store'});const body=await response.json() as {groups?:Group[];profiles?:Profile[];memberships?:Membership[];hasMore?:boolean;nextCursor?:string|null;error?:string};if(!response.ok)throw new Error(body.error??'Não foi possível carregar mais dados X.');if(resource==='groups'){setGroups(current=>[...current,...(body.groups??[]).filter(item=>!current.some(known=>known.id===item.id))]);setGroupsHasMore(Boolean(body.hasMore));setGroupsCursor(body.nextCursor??null);}else{setProfiles(current=>[...current,...(body.profiles??[]).filter(item=>!current.some(known=>known.id===item.id))]);setProfilesHasMore(Boolean(body.hasMore));setProfilesCursor(body.nextCursor??null);}setMemberships(current=>[...current,...(body.memberships??[]).filter(item=>!current.some(known=>known.group_id===item.group_id&&known.profile_id===item.profile_id))]);}catch(error){setMessage(error instanceof Error?error.message:'Falha ao carregar dados X.');}finally{setLoadingMore('');}}

  const profilesById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const membershipsByGroup = useMemo(() => {
    const result = new Map<string, Membership[]>();
    memberships.forEach((membership) => result.set(membership.group_id, [...(result.get(membership.group_id) ?? []), membership]));
    return result;
  }, [memberships]);
  const memberGroup = groups.find((group) => group.id === memberGroupId) ?? null;
  const groupedCount = new Set(memberships.map((item) => item.profile_id)).size;
  const availableCount = Math.max(0, profiles.length - groupedCount);
  const statuses = useMemo(() => [...new Set(profiles.map((profile) => profile.status))].sort(), [profiles]);
  const filteredProfiles = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("pt-BR");
    return profiles.filter((profile) => {
      const matchesTerm = !term || `${profile.username} ${profile.display_name ?? ""}`.toLocaleLowerCase("pt-BR").includes(term);
      return matchesTerm && (statusFilter === "all" || profile.status === statusFilter);
    });
  }, [profiles, search, statusFilter]);

  function openCreate() { setEditingId(null); setName(""); setDescription(""); setMessage(null); setGroupFormOpen(true); }
  function openEdit(group: Group) { setEditingId(group.id); setName(group.name); setDescription(group.description ?? ""); setMessage(null); setGroupFormOpen(true); }
  function openMembers(group: Group) {
    setMemberGroupId(group.id);
    setSelected((membershipsByGroup.get(group.id) ?? []).map((item) => item.profile_id));
    setSearch(""); setStatusFilter("all"); setMessage(null);
  }
  function closeGroupForm() { if (!saving) setGroupFormOpen(false); }
  function closeMembers() { if (!saving) setMemberGroupId(null); }

  async function saveGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setMessage(null);
    const currentProfileIds = editingId ? (membershipsByGroup.get(editingId) ?? []).map((item) => item.profile_id) : [];
    try {
      const response = await fetch(editingId ? `/api/x/groups/${editingId}` : "/api/x/groups", {
        method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, profileIds: currentProfileIds }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Não foi possível salvar o grupo X.");
      setMessage(editingId ? "Grupo X atualizado." : "Grupo X criado. Agora você pode adicionar os perfis.");
      setGroupFormOpen(false); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Falha ao salvar o grupo X."); }
    finally { setSaving(false); }
  }

  async function saveMembers() {
    if (!memberGroup) return;
    setSaving(true); setMessage(null);
    try {
      const response = await fetch(`/api/x/groups/${memberGroup.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: memberGroup.name, description: memberGroup.description ?? "", profileIds: selected }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Não foi possível atualizar os perfis.");
      setMessage(`${selected.length} perfil(is) salvo(s) em “${memberGroup.name}”.`);
      setMemberGroupId(null); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Falha ao atualizar os perfis."); }
    finally { setSaving(false); }
  }

  async function removeGroup(group: Group) {
    if (!window.confirm(`Excluir o grupo “${group.name}”? Programas confirmados não serão alterados.`)) return;
    setMessage(null);
    const response = await fetch(`/api/x/groups/${group.id}`, { method: "DELETE" });
    const body = (await response.json()) as { error?: string };
    if (!response.ok) return setMessage(body.error ?? "Não foi possível remover o grupo X.");
    setMessage("Grupo removido. Filas confirmadas permanecem congeladas."); router.refresh();
  }

  async function exportGroup(group: Group) {
    setExportingId(group.id); setMessage(null);
    try {
      const XLSX = await import("xlsx");
      const rows = (membershipsByGroup.get(group.id) ?? [])
        .map((membership) => ({ membership, profile: profilesById.get(membership.profile_id) }))
        .filter((item): item is { membership: Membership; profile: Profile } => Boolean(item.profile))
        .sort((a, b) => a.profile.username.localeCompare(b.profile.username, "pt-BR"))
        .map(({ membership, profile }) => [`@${profile.username}`, profile.display_name ?? "", statusLabel(profile.status), group.name, formatDate(membership.created_at)]);
      const worksheet = XLSX.utils.aoa_to_sheet([["@ do perfil", "Nome", "Status", "Nome do grupo", "Adicionado ao grupo"], ...rows]);
      worksheet["!cols"] = [22, 30, 20, 30, 24].map((wch) => ({ wch }));
      worksheet["!autofilter"] = { ref: `A1:E${Math.max(2, rows.length + 1)}` };
      worksheet["!freeze"] = { xSplit: 0, ySplit: 1 };
      const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, worksheet, "Perfis do grupo");
      const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replaceAll("-", "");
      const filename = `grupo-x-${safeFilename(group.name)}-${stamp}.xlsx`;
      XLSX.writeFile(workbook, filename, { bookType: "xlsx" });
      setMessage(`Arquivo ${filename} gerado com ${rows.length} perfil(is).`);
    } catch { setMessage("Não foi possível gerar o arquivo Excel."); }
    finally { setExportingId(null); }
  }

  function toggleProfile(profileId: string) {
    setSelected((current) => current.includes(profileId) ? current.filter((id) => id !== profileId) : [...current, profileId]);
  }
  function selectVisible() { setSelected((current) => [...new Set([...current, ...filteredProfiles.map((profile) => profile.id)])]); }

  return <main className="standalone-page groups-page">
    <header className={`${styles.header} standalone-header`}>
      <div><span className="section-kicker">{organizationName} · X / Twitter</span><h1>Grupos de perfis</h1><p>Organize os perfis do X para selecionar campanhas e administrar filas com clareza.</p></div>
      {canEdit ? <button className="button button-primary" type="button" onClick={openCreate}>Criar grupo</button> : null}
    </header>

    <section className={styles.summary} aria-label="Resumo dos grupos X">
      <span><strong>{groups.length}</strong> {groups.length === 1 ? "grupo" : "grupos"}</span>
      <span><strong>{groupedCount}</strong> perfis agrupados</span>
      <span><strong>{availableCount}</strong> sem grupo</span>
    </section>
    {message ? <p className="inline-message" role="status">{message}</p> : null}

    {!groups.length ? <section className="panel empty-state">
      <span className="empty-state-icon" aria-hidden="true">◇</span><h2>Nenhum grupo criado</h2><p>Crie um grupo e escolha os perfis X que farão parte dele.</p>
      {canEdit ? <button className="button button-primary" type="button" onClick={openCreate}>Criar primeiro grupo</button> : null}
    </section> : <section className={styles.grid} aria-label="Grupos de perfis X">
      {groups.map((group) => {
        const members = (membershipsByGroup.get(group.id) ?? []).map((membership) => profilesById.get(membership.profile_id)).filter((profile): profile is Profile => Boolean(profile));
        return <article className={`panel ${styles.card}`} key={group.id}>
          <div className={styles.cardHeader}><div className={styles.cardTitle}><span className="section-kicker">Grupo X</span><h2>{group.name}</h2></div><span className={styles.memberCount}>{members.length} {members.length === 1 ? "perfil" : "perfis"}</span></div>
          {group.description ? <p className={styles.description}>{group.description}</p> : <p className={styles.descriptionMuted}>Sem descrição</p>}
          <div className={styles.membersPreview}>{members.length ? <>
            <div className={styles.avatarStack} aria-label={`${members.length} perfis no grupo`}>
              {members.slice(0, 5).map((profile) => <ProfileAvatar key={profile.id} profile={profile} small />)}
              {members.length > 5 ? <span className={styles.moreAvatars}>+{members.length - 5}</span> : null}
            </div>
            <span className={styles.memberNames}>{members.slice(0, 2).map((profile) => `@${profile.username}`).join(", ")}{members.length > 2 ? " e mais" : ""}</span>
          </> : <span className={styles.emptyMembers}>Nenhum perfil adicionado</span>}</div>
          <div className={styles.actions}>
            <button className={styles.exportButton} type="button" disabled={exportingId !== null} onClick={() => void exportGroup(group)} aria-label={`Exportar perfis do grupo ${group.name}`} title="Exportar perfis para XLSX"><span aria-hidden="true">{exportingId === group.id ? "…" : "⇩"}</span><span>Exportar</span></button>
            {canEdit ? <><button className="button button-primary" type="button" onClick={() => openMembers(group)}>Gerenciar perfis</button><button className="button button-ghost" type="button" onClick={() => openEdit(group)}>Editar</button><button className={styles.deleteButton} type="button" onClick={() => void removeGroup(group)}>Excluir</button></> : null}
          </div>
        </article>;
      })}
    </section>}
    {groupsHasMore ? <button className="button button-secondary" type="button" disabled={Boolean(loadingMore)} onClick={()=>void loadMore('groups')}>{loadingMore==='groups'?'Carregando…':'Carregar mais grupos'}</button> : null}

    {groupFormOpen ? <div className={styles.backdrop} role="presentation" onMouseDown={closeGroupForm}>
      <section className={`panel ${styles.modal}`} role="dialog" aria-modal="true" aria-labelledby="x-group-form-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className={styles.modalHeader}><div><span className="section-kicker">{editingId ? "Configuração do grupo" : "Novo grupo"}</span><h2 id="x-group-form-title">{editingId ? "Editar grupo X" : "Criar grupo X"}</h2><p>Defina um nome claro. Os perfis são escolhidos na tela de gerenciamento.</p></div><button className={styles.closeButton} type="button" onClick={closeGroupForm} aria-label="Fechar">×</button></header>
        <form className={styles.form} onSubmit={saveGroup}>
          <label>Nome do grupo<input required minLength={1} maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Campanha de lançamentos" autoFocus /></label>
          <label>Descrição <small>Opcional</small><textarea maxLength={1000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Explique para que este grupo será usado" /></label>
          <footer className={styles.modalActions}><button className="button button-ghost" type="button" onClick={closeGroupForm}>Cancelar</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? "Salvando…" : editingId ? "Salvar alterações" : "Criar grupo"}</button></footer>
        </form>
      </section>
    </div> : null}

    {memberGroup ? <div className={styles.backdrop} role="presentation" onMouseDown={closeMembers}>
      <section className={`panel ${styles.modal} ${styles.memberModal}`} role="dialog" aria-modal="true" aria-labelledby="x-members-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className={styles.modalHeader}><div><span className="section-kicker">{memberGroup.name}</span><h2 id="x-members-title">Gerenciar perfis</h2><p>Um perfil X pode participar de mais de um grupo.</p></div><button className={styles.closeButton} type="button" onClick={closeMembers} aria-label="Fechar">×</button></header>
        <div className={styles.profileToolbar}>
          <label className={styles.searchLabel}>Buscar perfil<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por @usuário ou nome" autoFocus /></label>
          <label className={styles.statusFilter}>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">Todos</option>{statuses.map((status) => <option value={status} key={status}>{statusLabel(status)}</option>)}</select></label>
        </div>
        <div className={styles.selectionBar}><span><strong>{selected.length}</strong> selecionado(s) · {filteredProfiles.length} no filtro</span><div><button type="button" onClick={selectVisible} disabled={!filteredProfiles.length}>Selecionar visíveis</button><button type="button" onClick={() => setSelected([])} disabled={!selected.length}>Limpar seleção</button></div></div>
        <div className={styles.profileList}>{filteredProfiles.length ? filteredProfiles.map((profile) => {
          const checked = selected.includes(profile.id);
          return <label className={`${styles.profileChoice} ${checked ? styles.profileChoiceSelected : ""}`} key={profile.id}><input type="checkbox" checked={checked} onChange={() => toggleProfile(profile.id)} /><ProfileIdentity profile={profile} /><span className={styles.checkmark} aria-hidden="true">✓</span></label>;
        }) : <div className={styles.noProfiles}><strong>Nenhum perfil encontrado</strong><span>Ajuste a busca ou o filtro de status.</span></div>}</div>
        {profilesHasMore?<button className="button button-secondary" type="button" disabled={Boolean(loadingMore)} onClick={()=>void loadMore('profiles')}>{loadingMore==='profiles'?'Carregando…':'Carregar mais perfis'}</button>:null}
        <footer className={styles.modalActions}><span className={styles.selectionCount}>{selected.length} perfil(is) no grupo</span><button className="button button-ghost" type="button" onClick={closeMembers}>Cancelar</button><button className="button button-primary" type="button" disabled={saving} onClick={() => void saveMembers()}>{saving ? "Salvando…" : "Salvar perfis"}</button></footer>
      </section>
    </div> : null}
  </main>;
}

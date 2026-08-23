"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "@/app/grupos/groups.module.css";
type Group = { id: string; name: string; description: string | null };
type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status: string;
};
export default function TwitterGroupsClient({
  organizationName,
  groups,
  profiles,
  memberships,
  canEdit,
}: {
  organizationName: string;
  groups: Group[];
  profiles: Profile[];
  memberships: Array<{ group_id: string; profile_id: string }>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const groupedCount = new Set(memberships.map((item) => item.profile_id)).size;
  const filtered = useMemo(
    () =>
      profiles.filter((profile) =>
        `${profile.username} ${profile.display_name ?? ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      ),
    [profiles, search],
  );
  function open(group?: Group) {
    setEditingId(group?.id ?? null);
    setName(group?.name ?? "");
    setDescription(group?.description ?? "");
    setSelected(
      group
        ? memberships
            .filter((item) => item.group_id === group.id)
            .map((item) => item.profile_id)
        : [],
    );
    setSearch("");
    setFormOpen(true);
    setMessage(null);
  }
  function close() {
    if (saving) return;
    setFormOpen(false);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(
        editingId ? `/api/x/groups/${editingId}` : "/api/x/groups",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description, profileIds: selected }),
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(body.error ?? "Não foi possível salvar o grupo X.");
      setMessage(editingId ? "Grupo X atualizado." : "Grupo X criado.");
      setFormOpen(false);
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Falha ao salvar o grupo X.",
      );
    } finally {
      setSaving(false);
    }
  }
  async function remove(group: Group) {
    if (
      !confirm(
        `Excluir o grupo “${group.name}”? Programas confirmados não serão alterados.`,
      )
    )
      return;
    const response = await fetch(`/api/x/groups/${group.id}`, {
      method: "DELETE",
    });
    const body = (await response.json()) as { error?: string };
    if (!response.ok)
      return setMessage(body.error ?? "Não foi possível remover o grupo X.");
    setMessage("Grupo removido. Filas confirmadas permanecem congeladas.");
    router.refresh();
  }
  const avatar = (profile: Profile) => (
    <>
      {profile.avatar_url ? (
        <img className={styles.avatar} src={profile.avatar_url} alt="" />
      ) : (
        <span className={`${styles.avatar} ${styles.avatarFallback}`}>
          {profile.username.slice(0, 1).toUpperCase()}
        </span>
      )}
    </>
  );
  return (
    <main className="standalone-page groups-page">
      <header className={`${styles.header} standalone-header`}>
        <div>
          <span className="section-kicker">
            {organizationName} · X / Twitter
          </span>
          <h1>Grupos de perfis</h1>
          <p>
            Organize perfis X para selecionar campanhas e cancelar filas com
            clareza.
          </p>
        </div>
        {canEdit ? (
          <button
            className="button button-primary"
            type="button"
            onClick={() => open()}
          >
            Criar grupo
          </button>
        ) : null}
      </header>
      <section className={styles.summary}>
        <span>
          <strong>{groups.length}</strong> grupos
        </span>
        <span>
          <strong>{groupedCount}</strong> perfis agrupados
        </span>
        <span>
          <strong>{profiles.length}</strong> perfis disponíveis
        </span>
      </section>
      {message ? (
        <p className="inline-message" role="status">
          {message}
        </p>
      ) : null}
      {!groups.length ? (
        <section className="panel empty-state">
          <span className="empty-state-icon">◇</span>
          <h2>Nenhum grupo criado</h2>
          <p>Crie um grupo e escolha os perfis X que farão parte dele.</p>
          {canEdit ? (
            <button className="button button-primary" onClick={() => open()}>
              Criar primeiro grupo
            </button>
          ) : null}
        </section>
      ) : (
        <section className={styles.grid}>
          {groups.map((group) => {
            const members = profiles.filter((profile) =>
              memberships.some(
                (item) =>
                  item.group_id === group.id && item.profile_id === profile.id,
              ),
            );
            return (
              <article className={`panel ${styles.card}`} key={group.id}>
                <div className={styles.cardHeader}>
                  <div>
                    <span className="section-kicker">Grupo X</span>
                    <h2>{group.name}</h2>
                  </div>
                  <div className={styles.cardCounts}>
                    <span className={styles.memberCount}>
                      {members.length} perfis
                    </span>
                  </div>
                </div>
                {group.description ? (
                  <p className={styles.description}>{group.description}</p>
                ) : null}
                <div className={styles.membersPreview}>
                  {members.length ? (
                    <>
                      <div className={styles.avatarStack}>
                        {members.slice(0, 5).map((profile) => (
                          <span key={profile.id}>{avatar(profile)}</span>
                        ))}
                        {members.length > 5 ? (
                          <span className={styles.moreAvatars}>
                            +{members.length - 5}
                          </span>
                        ) : null}
                      </div>
                      <span>
                        {members
                          .slice(0, 2)
                          .map((profile) => `@${profile.username}`)
                          .join(", ")}
                        {members.length > 2 ? " e mais" : ""}
                      </span>
                    </>
                  ) : (
                    <span className={styles.emptyMembers}>
                      Nenhum perfil adicionado
                    </span>
                  )}
                </div>
                {canEdit ? (
                  <div className={styles.actions}>
                    <button
                      className="button button-primary"
                      onClick={() => open(group)}
                    >
                      Gerenciar perfis
                    </button>
                    <button
                      className="button button-ghost"
                      onClick={() => open(group)}
                    >
                      Editar
                    </button>
                    <button
                      className={styles.deleteButton}
                      onClick={() => void remove(group)}
                    >
                      Excluir
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      )}
      {formOpen ? (
        <div
          className={styles.backdrop}
          role="presentation"
          onMouseDown={close}
        >
          <section
            className={`panel ${styles.modal} ${styles.memberModal}`}
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className={styles.modalHeader}>
              <div>
                <span className="section-kicker">
                  {editingId ? "Configuração do grupo" : "Novo grupo"}
                </span>
                <h2>{editingId ? "Editar grupo X" : "Criar grupo X"}</h2>
                <p>Um perfil X pode participar de mais de um grupo.</p>
              </div>
              <button
                className={styles.closeButton}
                onClick={close}
                aria-label="Fechar"
              >
                ×
              </button>
            </header>
            <form className={styles.form} onSubmit={save}>
              <label>
                Nome
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Descrição <small>Opcional</small>
                <textarea
                  maxLength={1000}
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label className={styles.searchLabel}>
                Buscar perfil
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Buscar por @usuário ou nome"
                />
              </label>
              <div className={styles.profileList}>
                {filtered.map((profile) => {
                  const checked = selected.includes(profile.id);
                  return (
                    <label
                      className={`${styles.profileChoice} ${checked ? styles.profileChoiceSelected : ""}`}
                      key={profile.id}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelected((current) =>
                            checked
                              ? current.filter((id) => id !== profile.id)
                              : [...current, profile.id],
                          )
                        }
                      />
                      {avatar(profile)}
                      <span>
                        <strong>@{profile.username}</strong>
                        <small>{profile.display_name ?? profile.status}</small>
                      </span>
                      <span className={styles.checkmark}>✓</span>
                    </label>
                  );
                })}
              </div>
              <footer className={styles.modalActions}>
                <span className={styles.selectionCount}>
                  {selected.length} selecionados
                </span>
                <button
                  className="button button-ghost"
                  type="button"
                  onClick={close}
                >
                  Cancelar
                </button>
                <button className="button button-primary" disabled={saving}>
                  {saving
                    ? "Salvando…"
                    : editingId
                      ? "Salvar alterações"
                      : "Criar grupo"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}

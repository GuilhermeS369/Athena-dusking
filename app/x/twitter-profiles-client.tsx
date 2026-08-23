"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  status: string;
  account_tier: string;
  can_post: boolean;
  token_valid: boolean;
  needs_reconnect: boolean;
  available_micros: number;
  group_ids: string[];
  pending_count: number;
  text_count: number;
  image_count: number;
  gif_count: number;
  video_count: number;
};
type Group = { id: string; name: string };
const usd = (value: number) =>
  `US$ ${(value / 1e6).toFixed(3).replace(".", ",")}`;
export default function TwitterProfilesClient({
  organizationName,
  profiles,
  groups,
}: {
  organizationName: string;
  profiles: Profile[];
  groups: Group[];
}) {
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [status, setStatus] = useState("all");
  const filtered = useMemo(
    () =>
      profiles.filter(
        (profile) =>
          (group === "all" || profile.group_ids.includes(group)) &&
          (status === "all" || profile.status === status) &&
          `${profile.username} ${profile.display_name ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [profiles, group, status, search],
  );
  const active = profiles.filter(
    (profile) => profile.status === "active",
  ).length;
  const attention = profiles.length - active;
  return (
    <main className="standalone-page profiles-page">
      <header className="standalone-header">
        <div>
          <span className="section-kicker">
            {organizationName} · X / Twitter
          </span>
          <h1>Contas</h1>
          <p>Perfis X, capacidade de postagem, saldo e carga atual da fila.</p>
        </div>
        <div className="profiles-header-actions">
          <Link className="button button-ghost" href="/x/zernio">
            Sincronizar contas
          </Link>
          <Link className="button button-secondary" href="/x/zernio">
            ＋ Conectar conta
          </Link>
        </div>
      </header>
      {!profiles.length ? (
        <section className="panel empty-state">
          <span className="empty-state-icon">◎</span>
          <h2>Nenhum perfil X conectado</h2>
          <p>Conecte uma identidade Zernio para começar.</p>
          <Link className="button button-secondary" href="/x/zernio">
            Abrir Zernio
          </Link>
        </section>
      ) : (
        <>
          <section className="profiles-toolbar panel">
            <div className="profiles-status-tabs">
              <button
                className={
                  status === "all"
                    ? "profiles-status-tab profiles-status-tab-active"
                    : "profiles-status-tab"
                }
                onClick={() => setStatus("all")}
              >
                <span>Todas</span>
                <strong>{profiles.length}</strong>
              </button>
              <button
                className={
                  status === "active"
                    ? "profiles-status-tab profiles-status-tab-active"
                    : "profiles-status-tab"
                }
                onClick={() => setStatus("active")}
              >
                <span>Online</span>
                <strong>{active}</strong>
              </button>
              <button
                className={
                  status === "needs_reauth"
                    ? "profiles-status-tab profiles-status-tab-active"
                    : "profiles-status-tab"
                }
                onClick={() => setStatus("needs_reauth")}
              >
                <span>Com atenção</span>
                <strong>{attention}</strong>
              </button>
            </div>
            <div className="profiles-toolbar-controls">
              <label>
                Grupo
                <select
                  value={group}
                  onChange={(event) => setGroup(event.target.value)}
                >
                  <option value="all">Todos os grupos</option>
                  {groups.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Status
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                >
                  <option value="all">Todos</option>
                  <option value="active">Online</option>
                  <option value="offline">Offline</option>
                  <option value="needs_reauth">Reautorizar</option>
                </select>
              </label>
              <label>
                Buscar
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="@usuário ou nome"
                />
              </label>
              <span>{filtered.length} perfil(is)</span>
            </div>
          </section>
          {!filtered.length ? (
            <section className="panel empty-state">
              <h2>Nenhum perfil neste filtro</h2>
            </section>
          ) : (
            <section className="profile-grid">
              {filtered.map((profile) => (
                <article
                  className="panel profile-card profile-card-clickable"
                  key={profile.id}
                  onClick={(event) => {
                    if (!(event.target as HTMLElement).closest("a,button"))
                      window.location.assign(`/x/perfis/${profile.id}`);
                  }}
                >
                  <div className="profile-card-header profile-card-header-redesigned">
                    {profile.avatar_url ? (
                      <img
                        className="profile-avatar"
                        src={profile.avatar_url}
                        alt=""
                      />
                    ) : (
                      <span className="profile-avatar profile-avatar-fallback">
                        {profile.username.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div className="profile-card-identity">
                      <h2>
                        <a
                          href={`https://x.com/${encodeURIComponent(profile.username)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          @{profile.username} ↗
                        </a>
                      </h2>
                      <p>{profile.display_name ?? "Perfil X"}</p>
                      <span className="profile-group-chip">
                        {profile.account_tier === "premium"
                          ? "Premium"
                          : "280 caracteres"}
                      </span>
                    </div>
                    <span className="profile-post-count-chip">
                      {profile.pending_count} na fila
                    </span>
                  </div>
                  <div className="profile-analytics-strip">
                    <div>
                      <strong>{profile.text_count}</strong>
                      <span>Texto</span>
                    </div>
                    <div>
                      <strong>{profile.image_count}</strong>
                      <span>Imagens</span>
                    </div>
                    <div>
                      <strong>{profile.gif_count}</strong>
                      <span>GIF</span>
                    </div>
                    <div>
                      <strong>{profile.video_count}</strong>
                      <span>Vídeo</span>
                    </div>
                  </div>
                  <dl className="profile-publication-grid">
                    <div>
                      <dt>Saldo disponível</dt>
                      <dd>{usd(profile.available_micros)}</dd>
                    </div>
                    <div>
                      <dt>Postagem</dt>
                      <dd>{profile.can_post ? "Liberada" : "Bloqueada"}</dd>
                    </div>
                    <div>
                      <dt>Token</dt>
                      <dd>{profile.token_valid ? "Válido" : "Atenção"}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{profile.status}</dd>
                    </div>
                  </dl>
                  <div className="profile-card-actions">
                    <Link
                      className="button button-primary"
                      href={`/x/perfis/${profile.id}`}
                    >
                      Ver detalhes
                    </Link>
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}

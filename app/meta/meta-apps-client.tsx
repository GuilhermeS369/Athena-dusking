'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useMemo, useState } from 'react';

import styles from './meta-apps.module.css';
import {
  META_APP_DEFAULT_SLOT_LIMIT,
  metaAppCapacity,
  sortMetaAppsByFillOrder,
} from '@/lib/integrations/meta-apps';
import {
  META_LONG_LIVED_TOKEN_DAYS,
  META_TOKEN_ALARM_AFTER_DAYS,
  META_TOKEN_REFRESH_AFTER_DAYS,
} from '@/lib/integrations/meta-token-renewal';

type Organization = {
  id: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
};

export type MetaApp = {
  id: string;
  organization_id: string;
  label: string;
  app_id: string;
  instagram_slot_limit: number;
  active: boolean;
  last_connected_at: string | null;
  instagram_profile_count: number;
  created_at: string;
  updated_at: string;
};

export type MetaTokenFleetRow = {
  meta_app_id: string | null;
  total: number;
  healthy: number;
  due: number;
  at_risk: number;
  expired: number;
  unknown: number;
  failing: number;
  oldest_token_refreshed_at: string | null;
};

const EMPTY_FLEET = { total: 0, healthy: 0, due: 0, at_risk: 0, expired: 0, unknown: 0, failing: 0 };

function formatDate(value: string | null) {
  if (!value) return 'Nunca';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function ageInDays(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

export default function MetaAppsClient({
  activeOrganization,
  initialApps,
  unlinkedProfileCount,
  serverAppId,
  initialTokenFleet,
}: {
  activeOrganization: Organization;
  initialApps: MetaApp[];
  unlinkedProfileCount: number;
  serverAppId: string | null;
  initialTokenFleet: MetaTokenFleetRow[];
}) {
  const router = useRouter();
  const canAdmin = activeOrganization.role === 'admin';
  const [apps, setApps] = useState(initialApps);
  const [label, setLabel] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [slotLimit, setSlotLimit] = useState(String(META_APP_DEFAULT_SLOT_LIMIT));
  const [saving, setSaving] = useState(false);
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const [removingApp, setRemovingApp] = useState<MetaApp | null>(null);
  const [renamingApp, setRenamingApp] = useState<MetaApp | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [removeConfirmation, setRemoveConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'neutral' | 'success' | 'error'>('neutral');
  const [refreshingTokens, setRefreshingTokens] = useState(false);
  const [serverAppLabel, setServerAppLabel] = useState('');
  const [adoptingServerApp, setAdoptingServerApp] = useState(false);
  const [tokenMessage, setTokenMessage] = useState('');
  const [tokenMessageTone, setTokenMessageTone] = useState<'neutral' | 'success' | 'error'>('neutral');

  const ordered = useMemo(() => sortMetaAppsByFillOrder(apps), [apps]);
  const fleetByApp = useMemo(
    () => new Map(initialTokenFleet.map((row) => [row.meta_app_id, row])),
    [initialTokenFleet],
  );
  const fleet = useMemo(() => initialTokenFleet.reduce((accumulator, row) => ({
    total: accumulator.total + row.total,
    healthy: accumulator.healthy + row.healthy,
    due: accumulator.due + row.due,
    at_risk: accumulator.at_risk + row.at_risk,
    expired: accumulator.expired + row.expired,
    unknown: accumulator.unknown + row.unknown,
    failing: accumulator.failing + row.failing,
  }), EMPTY_FLEET), [initialTokenFleet]);
  const oldestTokenAge = useMemo(() => initialTokenFleet.reduce<number | null>((oldest, row) => {
    const age = ageInDays(row.oldest_token_refreshed_at);
    if (age === null) return oldest;
    return oldest === null || age > oldest ? age : oldest;
  }, null), [initialTokenFleet]);
  const pendingRenewal = fleet.due + fleet.at_risk;
  const totals = useMemo(() => ordered.reduce((accumulator, app) => {
    const capacity = metaAppCapacity(app);
    return {
      apps: accumulator.apps + 1,
      used: accumulator.used + capacity.usedSlots,
      free: accumulator.free + (app.active ? capacity.freeSlots : 0),
    };
  }, { apps: 0, used: 0, free: 0 }), [ordered]);

  function report(text: string, tone: 'neutral' | 'success' | 'error') {
    setMessage(text);
    setMessageTone(tone);
  }

  async function refreshTokens(scope: 'due' | 'all') {
    if (refreshingTokens) return;
    setRefreshingTokens(true);
    setTokenMessage('');

    try {
      const response = await fetch('/api/integrations/meta/token-refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        message?: string;
        refreshed?: number;
        failed?: number;
        skipped?: number;
        needsReauthorization?: number;
        remaining?: number;
        failures?: Array<{ username: string; message: string }>;
      };

      if (!response.ok) {
        setTokenMessageTone('error');
        setTokenMessage(payload.error ?? 'Não foi possível renovar os tokens.');
        return;
      }

      if (payload.message) {
        setTokenMessageTone('neutral');
        setTokenMessage(payload.message);
        return;
      }

      const parts = [`${payload.refreshed ?? 0} token(s) renovado(s) por mais ${META_LONG_LIVED_TOKEN_DAYS} dias`];
      if (payload.failed) parts.push(`${payload.failed} falha(s)`);
      if (payload.needsReauthorization) parts.push(`${payload.needsReauthorization} precisa(m) de reconexão manual`);
      if (payload.remaining) parts.push(`restam ${payload.remaining} — clique de novo para continuar`);
      const detail = payload.failures?.length
        ? ` Primeiras falhas: ${payload.failures.map((failure) => `@${failure.username} (${failure.message})`).join('; ')}`
        : '';

      setTokenMessageTone(payload.failed ? 'error' : 'success');
      setTokenMessage(`${parts.join('. ')}.${detail}`);
      // O resumo vem do servidor, então recarrega em vez de recalcular na mão:
      // um número inventado aqui divergiria do banco na primeira falha parcial.
      router.refresh();
    } catch {
      setTokenMessageTone('error');
      setTokenMessage('Não foi possível conectar ao servidor.');
    } finally {
      setRefreshingTokens(false);
    }
  }

  async function adoptServerApp() {
    if (adoptingServerApp || !canAdmin) return;
    setAdoptingServerApp(true);
    setMessage('');

    try {
      const response = await fetch('/api/integrations/meta/apps/adopt-env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: serverAppLabel }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string; claimed?: number; reused?: boolean; overflow?: number;
      };

      if (!response.ok) {
        report(payload.error ?? 'Não foi possível cadastrar o app do servidor.', 'error');
        return;
      }

      const overflow = payload.overflow
        ? ` Atenção: o app está com ${payload.overflow} conta(s) além do limite configurado — ajuste as vagas dele.`
        : '';
      report(
        `${payload.reused ? 'App já cadastrado' : `App “${serverAppLabel.trim()}” cadastrado`}. `
        + `${payload.claimed ?? 0} perfil(is) passaram a ocupar as vagas dele.${overflow}`,
        'success',
      );
      setServerAppLabel('');
      // A contagem de vagas e o resumo por app vêm do servidor.
      router.refresh();
      await refreshApps();
    } catch {
      report('Não foi possível conectar ao servidor.', 'error');
    } finally {
      setAdoptingServerApp(false);
    }
  }

  async function refreshApps() {
    const response = await fetch('/api/integrations/meta/apps', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({})) as { apps?: MetaApp[]; error?: string };
    if (response.ok && payload.apps) setApps(payload.apps);
  }

  async function createApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !canAdmin) return;
    setSaving(true);
    setMessage('');

    try {
      const response = await fetch('/api/integrations/meta/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label,
          appId,
          appSecret,
          instagramSlotLimit: Number(slotLimit) || META_APP_DEFAULT_SLOT_LIMIT,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { app?: MetaApp; error?: string };

      if (!response.ok) {
        report(payload.error ?? 'Não foi possível cadastrar o app da Meta.', 'error');
        return;
      }

      setLabel('');
      setAppId('');
      setAppSecret('');
      setSlotLimit(String(META_APP_DEFAULT_SLOT_LIMIT));
      if (payload.app) setApps((current) => [payload.app as MetaApp, ...current]);
      else await refreshApps();
      report(`App “${label}” cadastrado. As vagas começam a ser ocupadas na próxima conexão.`, 'success');
    } catch {
      report('Não foi possível conectar ao servidor.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function renameApp() {
    const app = renamingApp;
    const label = renameLabel.trim().replace(/\s+/g, ' ');
    if (!app || busyAppId || !canAdmin || label.length < 2) return;
    setBusyAppId(app.id);
    setMessage('');

    try {
      const response = await fetch(`/api/integrations/meta/apps/${app.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };

      if (!response.ok) {
        report(payload.error ?? 'Não foi possível renomear o app.', 'error');
        return;
      }

      setApps((current) => current.map((item) => item.id === app.id ? { ...item, label } : item));
      setRenamingApp(null);
      // O nome é o que o operador cola no Bulk Meta e no campo de conectar, e a
      // correspondência é exata: trocar o nome invalida as linhas já geradas.
      report(`App renomeado para “${label}”. As listas do Bulk Meta geradas com o nome antigo deixam de valer.`, 'success');
    } catch {
      report('Não foi possível conectar ao servidor.', 'error');
    } finally {
      setBusyAppId(null);
    }
  }

  async function toggleActive(app: MetaApp) {
    if (busyAppId || !canAdmin) return;
    setBusyAppId(app.id);
    setMessage('');

    try {
      const response = await fetch(`/api/integrations/meta/apps/${app.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !app.active }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };

      if (!response.ok) {
        report(payload.error ?? 'Não foi possível atualizar o app.', 'error');
        return;
      }

      setApps((current) => current.map((item) => item.id === app.id ? { ...item, active: !app.active } : item));
      report(
        app.active
          ? `App “${app.label}” desativado. Ele deixa de aparecer no Bulk Meta e recusa conexões novas; as contas já conectadas continuam publicando.`
          : `App “${app.label}” reativado.`,
        'success',
      );
    } catch {
      report('Não foi possível conectar ao servidor.', 'error');
    } finally {
      setBusyAppId(null);
    }
  }

  async function removeApp(app: MetaApp, confirmConnectedProfiles: boolean) {
    if (busyAppId || !canAdmin) return;
    setBusyAppId(app.id);
    setMessage('');

    try {
      const response = await fetch(`/api/integrations/meta/apps/${app.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmConnectedProfiles }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; connectedProfiles?: number };

      if (response.status === 409 && !confirmConnectedProfiles) {
        setRemovingApp(app);
        setRemoveConfirmation('');
        report(payload.error ?? 'Este app ainda tem perfis conectados.', 'error');
        return;
      }
      if (!response.ok) {
        report(payload.error ?? 'Não foi possível remover o app.', 'error');
        return;
      }

      setApps((current) => current.filter((item) => item.id !== app.id));
      setRemovingApp(null);
      report(`App “${app.label}” removido do cadastro.`, 'success');
    } catch {
      report('Não foi possível conectar ao servidor.', 'error');
    } finally {
      setBusyAppId(null);
    }
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <span className="section-kicker">Instagram</span>
          <h1>API da Meta</h1>
          <p>
            Cada app da Meta comporta um número fixo de contas ({META_APP_DEFAULT_SLOT_LIMIT} por padrão). As vagas
            são preenchidas de uma em uma: o Bulk Meta e a tela de conexão só oferecem apps ativos que ainda têm
            espaço. Todos os apps precisam usar a mesma URL de redirecionamento configurada no painel da Meta.
          </p>
        </div>
        <dl className={styles.totals}>
          <div className={styles.total}><dt>Apps</dt><dd>{totals.apps}</dd></div>
          <div className={styles.total}><dt>Contas</dt><dd>{totals.used}</dd></div>
          <div className={styles.total}><dt>Vagas livres</dt><dd>{totals.free}</dd></div>
        </dl>
      </header>

      {message && (
        <p className={`inline-message inline-message-${messageTone}`} role={messageTone === 'error' ? 'alert' : 'status'}>
          {message}
        </p>
      )}

      {fleet.total > 0 && (
        <section
          className={`${styles.renewal}${pendingRenewal > 0 || fleet.expired > 0 ? ` ${styles.renewalAttention}` : ''}`}
          aria-label="Renovação de tokens"
        >
          <div className={styles.renewalCopy}>
            <span className="section-kicker">Renovação de tokens</span>
            <strong>
              {fleet.expired > 0
                ? `${fleet.expired} token(s) passaram dos ${META_LONG_LIVED_TOKEN_DAYS} dias`
                : pendingRenewal > 0
                  ? `${pendingRenewal} token(s) para renovar`
                  : 'Todos os tokens estão em dia'}
            </strong>
            <p>
              O token da Meta vale {META_LONG_LIVED_TOKEN_DAYS} dias e a renovação é uma chamada de servidor: ninguém
              precisa autorizar nada de novo. Só que ela deixa de funcionar depois dos {META_LONG_LIVED_TOKEN_DAYS} dias
              — aí é reconexão manual, perfil por perfil. Renovamos a partir de {META_TOKEN_REFRESH_AFTER_DAYS} dias
              para sobrar margem; a partir de {META_TOKEN_ALARM_AFTER_DAYS} vira risco.
              {oldestTokenAge !== null && ` O token mais antigo da operação tem ${oldestTokenAge} dia(s).`}
            </p>
            {fleet.failing > 0 && (
              <p className={styles.renewalWarning}>
                {fleet.failing} perfil(is) com falha na última renovação. Enquanto isso não voltar, o relógio deles
                continua correndo.
              </p>
            )}
          </div>

          <dl className={styles.renewalCounts}>
            <div><dt>Em dia</dt><dd>{fleet.healthy}</dd></div>
            <div><dt>A renovar</dt><dd>{fleet.due}</dd></div>
            <div className={fleet.at_risk > 0 ? styles.renewalCountAlert : undefined}><dt>Em risco</dt><dd>{fleet.at_risk}</dd></div>
            <div className={fleet.expired > 0 ? styles.renewalCountAlert : undefined}><dt>Vencidos</dt><dd>{fleet.expired}</dd></div>
          </dl>

          <div className={styles.renewalActions}>
            <button
              className={`button button-primary${refreshingTokens ? ' button-saving' : ''}`}
              type="button"
              disabled={refreshingTokens || pendingRenewal === 0}
              onClick={() => void refreshTokens('due')}
            >
              {refreshingTokens ? 'Renovando…' : 'Renovar agora'}
            </button>
            <button
              className="button button-ghost"
              type="button"
              disabled={refreshingTokens}
              onClick={() => void refreshTokens('all')}
            >
              Renovar todos
            </button>
          </div>

          {tokenMessage && (
            <p className={`inline-message inline-message-${tokenMessageTone} ${styles.renewalMessage}`} role="status">
              {tokenMessage}
            </p>
          )}
        </section>
      )}

      {unlinkedProfileCount > 0 && (
        <section className={styles.legacy} aria-label="Perfis sem app vinculado">
          <div>
            <strong>{unlinkedProfileCount} perfil(is) sem app vinculado</strong>
            {serverAppId ? (
              <>
                <p>
                  O app que conectou esses perfis já está configurado no servidor (App ID {serverAppId}), mas ainda não
                  aparece na lista. Dê um nome a ele e os perfis passam a ocupar as vagas dele, como em qualquer outro
                  app. A chave secreta é lida do servidor: você não precisa colar nada.
                </p>
                {canAdmin && (
                  <div className={styles.legacyForm}>
                    <label htmlFor="meta-server-app-label">
                      Nome do app
                      <input
                        id="meta-server-app-label"
                        value={serverAppLabel}
                        onChange={(event) => setServerAppLabel(event.target.value)}
                        placeholder="Ex: duskingapp"
                        autoComplete="off"
                      />
                    </label>
                    <button
                      className={`button button-primary${adoptingServerApp ? ' button-saving' : ''}`}
                      type="button"
                      disabled={adoptingServerApp || serverAppLabel.trim().length < 2}
                      onClick={() => void adoptServerApp()}
                    >
                      {adoptingServerApp ? 'Cadastrando…' : 'Cadastrar app do servidor'}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p>
                Esses perfis continuam publicando com o token que já possuem, mas não estão contados na vaga de nenhum
                app. Cadastre abaixo o app que os conectou para que eles passem a ocupar as vagas dele.
              </p>
            )}
          </div>
          <span className={styles.legacyCount}>{unlinkedProfileCount}</span>
        </section>
      )}

      {ordered.length === 0 ? (
        <div className={styles.empty}>
          <strong>Nenhum app da Meta cadastrado</strong>
          <p>Sem app cadastrado, /perfis não consegue conectar contas novas.</p>
        </div>
      ) : (
        <div className={styles.list}>
          {ordered.map((app) => {
            const capacity = metaAppCapacity(app);
            const full = capacity.freeSlots === 0;
            const percentage = capacity.slotLimit === 0
              ? 0
              : Math.min(100, Math.round((capacity.usedSlots / capacity.slotLimit) * 100));

            return (
              <article
                key={app.id}
                className={`${styles.card}${app.active ? '' : ` ${styles.cardInactive}`}${full ? ` ${styles.cardFull}` : ''}`}
              >
                <div className={styles.identity}>
                  <span className={styles.avatar} aria-hidden="true">◈</span>
                  <div className={styles.identityText}>
                    <span className={styles.name}>
                      {app.label}
                      <span className={`${styles.badge} ${app.active ? styles.badgeActive : styles.badgeInactive}`}>
                        {app.active ? 'Ativo' : 'Desativado'}
                      </span>
                      {full && app.active && <span className={`${styles.badge} ${styles.badgeFull}`}>Sem vaga</span>}
                    </span>
                    <span className={styles.meta}>
                      App ID: {app.app_id} · {capacity.usedSlots} uso(s) · última conexão {formatDate(app.last_connected_at)}
                    </span>
                    {(() => {
                      const appFleet = fleetByApp.get(app.id);
                      if (!appFleet || (appFleet.due + appFleet.at_risk + appFleet.expired + appFleet.failing) === 0) return null;
                      return (
                        <span className={styles.metaAlert}>
                          Tokens: {[
                            appFleet.due > 0 ? `${appFleet.due} a renovar` : null,
                            appFleet.at_risk > 0 ? `${appFleet.at_risk} em risco` : null,
                            appFleet.expired > 0 ? `${appFleet.expired} vencido(s)` : null,
                            appFleet.failing > 0 ? `${appFleet.failing} com falha` : null,
                          ].filter(Boolean).join(' · ')}
                        </span>
                      );
                    })()}
                  </div>
                </div>

                <div className={styles.capacity}>
                  <div className={styles.capacityNumbers}>
                    <strong>{capacity.usedSlots}/{capacity.slotLimit}</strong>
                    <span>{capacity.freeSlots} vaga(s) livre(s)</span>
                  </div>
                  <div className={styles.gauge}>
                    <div
                      className={`${styles.gaugeFill}${full ? ` ${styles.gaugeFillFull}` : ''}`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>

                {canAdmin && (
                  <div className={styles.cardActions}>
                    <button
                      className="button button-ghost"
                      type="button"
                      disabled={busyAppId === app.id}
                      onClick={() => { setRenamingApp(app); setRenameLabel(app.label); }}
                    >
                      Renomear
                    </button>
                    <button
                      className="button button-ghost"
                      type="button"
                      disabled={busyAppId === app.id}
                      onClick={() => void toggleActive(app)}
                    >
                      {app.active ? 'Desativar' : 'Ativar'}
                    </button>
                    <button
                      className="button button-ghost button-danger"
                      type="button"
                      disabled={busyAppId === app.id}
                      onClick={() => void removeApp(app, false)}
                    >
                      Remover
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {canAdmin && (
        <form className={styles.form} onSubmit={createApp}>
          <span className={styles.formTitle}><span aria-hidden="true">＋</span> Adicionar app do Meta</span>
          <div className={styles.formGrid}>
            <label htmlFor="meta-app-label">
              Nome
              <input
                id="meta-app-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Ex: duskingapp"
                autoComplete="off"
                required
              />
            </label>
            <label htmlFor="meta-app-id">
              App ID do Instagram
              <input
                id="meta-app-id"
                value={appId}
                onChange={(event) => setAppId(event.target.value.replace(/\D/g, ''))}
                placeholder="1571488531125130"
                inputMode="numeric"
                autoComplete="off"
                required
              />
            </label>
            <label htmlFor="meta-app-secret">
              Chave secreta
              <input
                id="meta-app-secret"
                value={appSecret}
                onChange={(event) => setAppSecret(event.target.value)}
                placeholder="App Secret"
                type="password"
                autoComplete="off"
                required
              />
            </label>
            <label htmlFor="meta-app-slots">
              Vagas
              <input
                id="meta-app-slots"
                value={slotLimit}
                onChange={(event) => setSlotLimit(event.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                autoComplete="off"
              />
            </label>
          </div>
          <div className={styles.formFooter}>
            <p className={styles.formHint}>
              O secret é criptografado antes de ser salvo e nunca volta para a tela. Cada app precisa ter a mesma URL de
              redirecionamento configurada no painel da Meta.
            </p>
            <button className={`button button-primary${saving ? ' button-saving' : ''}`} type="submit" disabled={saving}>
              {saving ? 'Cadastrando…' : 'Adicionar app'}
            </button>
          </div>
        </form>
      )}

      {renamingApp && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setRenamingApp(null)}>
          <section
            className={`panel bulk-modal ${styles.modal}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="meta-app-rename-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="meta-app-rename-title">Renomear “{renamingApp.label}”</h2>
            <p>
              Este nome é o que você cola no Bulk Meta e na tela de conectar, e a correspondência é exata — caixa,
              acento e espaço contam. Listas já geradas com o nome antigo deixam de ser reconhecidas.
            </p>
            <label htmlFor="meta-app-rename-input">
              Nome do app
              <input
                id="meta-app-rename-input"
                value={renameLabel}
                onChange={(event) => setRenameLabel(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className={styles.modalActions}>
              <button className="button button-ghost" type="button" onClick={() => setRenamingApp(null)}>Cancelar</button>
              <button
                className="button button-primary"
                type="button"
                disabled={renameLabel.trim().length < 2 || busyAppId === renamingApp.id}
                onClick={() => void renameApp()}
              >
                Salvar nome
              </button>
            </div>
          </section>
        </div>
      )}
      {removingApp && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setRemovingApp(null)}>
          <section
            className={`panel bulk-modal ${styles.modal}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="meta-app-remove-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="meta-app-remove-title">Remover “{removingApp.label}”?</h2>
            <p>
              O app tem {removingApp.instagram_profile_count} perfil(is) conectado(s). Remover não desconecta nada: as
              contas continuam publicando com o token que já têm. O que se perde é o controle de vagas desse app — e o
              nome deixa de valer no Bulk Meta. Se a intenção é apenas parar de receber contas novas, use Desativar.
            </p>
            <label htmlFor="meta-app-remove-confirmation">
              Digite REMOVER para confirmar
              <input
                id="meta-app-remove-confirmation"
                value={removeConfirmation}
                onChange={(event) => setRemoveConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className={styles.modalActions}>
              <button className="button button-ghost" type="button" onClick={() => setRemovingApp(null)}>Cancelar</button>
              <button
                className="button button-danger"
                type="button"
                disabled={removeConfirmation.trim().toUpperCase() !== 'REMOVER' || busyAppId === removingApp.id}
                onClick={() => void removeApp(removingApp, true)}
              >
                Remover mesmo assim
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

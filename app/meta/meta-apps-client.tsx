'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import styles from './meta-apps.module.css';
import {
  META_APP_DEFAULT_SLOT_LIMIT,
  metaAppCapacity,
  sortMetaAppsByPendingRemoval,
} from '@/lib/integrations/meta-apps';
import {
  describeDisconnection,
  orphanPendingDisconnections,
  pendingDisconnectionsByAppId,
  pendingUsernameList,
  selectIncident,
  selectionSummary,
  type MetaPendingDisconnection,
} from '@/lib/integrations/meta-disconnections';
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
  pending_slot_release_count: number;
  // Perfis que saíram deste app para outro e cuja conexão ainda não foi apagada
  // no Meta Developers — vaga presa pela mesma razão da queda, causa diferente.
  transferred_out_count: number;
  // Bloqueio de API do app. "Bloqueado agora" é `api_block_until` no futuro:
  // a janela expira sozinha, e é isso que dispensa qualquer sonda.
  api_blocked_at: string | null;
  api_block_until: string | null;
  api_block_error_message: string | null;
  api_block_window_count: number;
  api_block_ignored_count: number;
  api_last_unblocked_at: string | null;
  // 'blocked' = a Meta pode reabrir e a janela testa sozinha; 'deactivated' = o
  // app foi desativado e as contas precisam ser religadas em outro app.
  api_block_kind: 'blocked' | 'deactivated' | null;
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

/**
 * "Bloqueado agora" é a janela ainda aberta, não uma flag guardada.
 *
 * A Meta fecha o app e o Athena abre uma janela de uma hora, descartando o que
 * vence nela. Quando a janela expira, o próximo item que vencer é tentado — é a
 * própria fila que descobre o desbloqueio, sem sonda nenhuma. Por isso a tela
 * pergunta ao relógio, e não a um booleano que alguém precisaria limpar.
 */
function apiBlockState(app: MetaApp) {
  if (!app.api_block_until) return null;
  const until = Date.parse(app.api_block_until);
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  return {
    until,
    minutesLeft: Math.max(1, Math.ceil((until - Date.now()) / 60_000)),
    since: app.api_blocked_at,
    desativado: app.api_block_kind === 'deactivated',
  };
}

function ageInDays(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((Date.now() - parsed) / 86_400_000);
}

function formatFallDate(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '—';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date(parsed));
}

/**
 * A fila de contas que ainda precisam ser apagadas no painel da Meta.
 *
 * Ela mistura de propósito as que caíram sozinhas e as que alguém mandou
 * remover: a vaga fica presa igual nos dois casos, e separá-las em duas listas
 * daria duas filas para percorrer no mesmo painel da Meta. O que muda é o que a
 * linha diz de si — "caiu · erro 190" ou "removido".
 *
 * O nome é um botão, e não texto, porque este é o único dado que sai daqui:
 * quem usa a lista está com o Meta Developers aberto do lado, procurando conta
 * por conta. Um clique faz as duas coisas que aquele passo pede — copia o nome
 * e marca a linha —, porque separá-las obrigava a voltar no checkbox depois de
 * apagar a conta lá, e é aí que se perde a conta de onde parou. O ✓ some
 * sozinho em 4 s; a marca fica, e sai só pelo próprio checkbox.
 *
 * A arroba aparece na tela mas fica de fora do que é copiado: a busca do painel
 * da Meta quer o nome puro.
 */
function PendingQueue({
  incidents,
  scopeLabel,
  selectedIds,
  copiedIncidentId,
  busy,
  onToggleIncident,
  onToggleAll,
  onCopyOne,
  onCopyMany,
  onConfirm,
}: {
  incidents: MetaPendingDisconnection[];
  scopeLabel: string;
  selectedIds: ReadonlySet<string>;
  copiedIncidentId: string | null;
  busy: boolean;
  onToggleIncident: (incidentId: string) => void;
  onToggleAll: (incidents: MetaPendingDisconnection[], select: boolean) => void;
  onCopyOne: (incident: MetaPendingDisconnection) => void;
  onCopyMany: (incidents: MetaPendingDisconnection[]) => void;
  onConfirm: (incidents: MetaPendingDisconnection[], scopeLabel: string) => void;
}) {
  const summary = selectionSummary(incidents, selectedIds);
  const marked = incidents.filter((incident) => selectedIds.has(incident.id));
  const toCopy = marked.length > 0 ? marked : incidents;

  return (
    <div className={styles.fallPanel}>
      <div className={styles.fallToolbar}>
        <label className={styles.fallSelectAll}>
          <input
            type="checkbox"
            checked={summary.allSelected}
            ref={(element) => { if (element) element.indeterminate = summary.partiallySelected; }}
            onChange={(event) => onToggleAll(incidents, event.target.checked)}
          />
          Selecionar todos ({summary.total})
        </label>
        <div className={styles.fallToolbarActions}>
          <button className="button button-ghost" type="button" onClick={() => onCopyMany(toCopy)}>
            {marked.length > 0
              ? `Copiar os ${marked.length} nomes marcados`
              : `Copiar os ${incidents.length} nomes`}
          </button>
          <button
            className={`button button-primary${busy ? ' button-saving' : ''}`}
            type="button"
            disabled={busy || summary.selectedCount === 0}
            onClick={() => onConfirm(marked, scopeLabel)}
          >
            {busy ? 'Registrando…' : `Já removi ${summary.selectedCount} no Meta Developers`}
          </button>
        </div>
      </div>

      <ul className={styles.fallList}>
        {incidents.map((incident) => {
          const copied = copiedIncidentId === incident.id;
          const motivo = describeDisconnection(incident);
          return (
            <li
              key={incident.id}
              className={`${styles.fallRow}${selectedIds.has(incident.id) ? ` ${styles.fallRowSelected}` : ''}`}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(incident.id)}
                onChange={() => onToggleIncident(incident.id)}
                aria-label={`Marcar @${incident.username_snapshot} como removido no Meta Developers`}
              />
              <button
                className={`${styles.fallUsername}${copied ? ` ${styles.fallUsernameCopied}` : ''}`}
                type="button"
                onClick={() => onCopyOne(incident)}
                title="Clique para copiar o nome (sem a arroba) e marcar esta linha"
              >
                @{incident.username_snapshot}
                <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
              </button>
              <span className={styles.fallDate}>{motivo.verb} {formatFallDate(incident.detected_at)}</span>
              <span className={`${styles.fallCode}${motivo.isFall ? '' : ` ${styles.fallCodeRemoved}`}`}>
                {motivo.badge}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function MetaAppsClient({
  activeOrganization,
  initialApps,
  unlinkedProfileCount,
  serverAppId,
  initialTokenFleet,
  initialPendingDisconnections,
  pendingDisconnectionsFailed,
}: {
  activeOrganization: Organization;
  initialApps: MetaApp[];
  unlinkedProfileCount: number;
  serverAppId: string | null;
  initialTokenFleet: MetaTokenFleetRow[];
  initialPendingDisconnections: MetaPendingDisconnection[];
  pendingDisconnectionsFailed: boolean;
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

  const [pending, setPending] = useState(initialPendingDisconnections);
  const [openAppIds, setOpenAppIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [copiedIncidentId, setCopiedIncidentId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [fallMessage, setFallMessage] = useState('');
  const [fallMessageTone, setFallMessageTone] = useState<'neutral' | 'success' | 'error'>('neutral');
  // Guarda o último lote confirmado só até a próxima ação: a tela não mantém
  // histórico do que foi limpo (foi decisão explícita), mas um "selecionar
  // todos" com 63 linhas não pode ser irreversível por causa disso.
  const [undoBatch, setUndoBatch] = useState<{ ids: string[]; label: string } | null>(null);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setPending(initialPendingDisconnections), [initialPendingDisconnections]);
  useEffect(() => () => { if (copyResetTimer.current) clearTimeout(copyResetTimer.current); }, []);

  const ordered = useMemo(() => sortMetaAppsByPendingRemoval(apps), [apps]);
  const pendingByApp = useMemo(() => pendingDisconnectionsByAppId(pending), [pending]);
  const orphanPending = useMemo(
    () => orphanPendingDisconnections(pending, new Set(apps.map((app) => app.id))),
    [apps, pending],
  );
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
      used: accumulator.used + capacity.activeProfiles,
      free: accumulator.free + (app.active ? capacity.freeSlots : 0),
    };
  }, { apps: 0, used: 0, free: 0 }), [ordered]);
  // Conta a lista inteira, e não a soma dos cartões: a queda de um app já
  // descadastrado não aparece em cartão nenhum e mesmo assim segura vaga.
  const trappedTotal = pending.length;

  function report(text: string, tone: 'neutral' | 'success' | 'error') {
    setMessage(text);
    setMessageTone(tone);
  }

  function reportFall(text: string, tone: 'neutral' | 'success' | 'error') {
    setFallMessage(text);
    setFallMessageTone(tone);
  }

  function toggleApp(appId: string) {
    setOpenAppIds((current) => {
      const next = new Set(current);
      if (next.has(appId)) next.delete(appId);
      else next.add(appId);
      return next;
    });
  }

  function toggleIncident(incidentId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(incidentId)) next.delete(incidentId);
      else next.add(incidentId);
      return next;
    });
  }

  function toggleAll(incidents: MetaPendingDisconnection[], select: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const incident of incidents) {
        if (select) next.add(incident.id);
        else next.delete(incident.id);
      }
      return next;
    });
  }

  async function copyToClipboard(text: string, incidentId: string | null, successText: string) {
    try {
      await navigator.clipboard.writeText(text);
      if (incidentId) {
        // O riscado de "copiado" é o que evita perder o lugar numa fila de 63
        // contas com o painel da Meta aberto do lado. Ele se apaga sozinho para
        // não virar um estado permanente que a tela não sabe recuperar.
        setCopiedIncidentId(incidentId);
        if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
        copyResetTimer.current = setTimeout(() => setCopiedIncidentId(null), 4000);

        // Copiar já marca a linha: quem clica no nome está indo apagar aquela
        // conta no painel da Meta, e voltar para marcar o checkbox depois é um
        // segundo passo que só existia por falta deste. Marca e nunca desmarca
        // — clicar de novo para recopiar não pode desfazer o trabalho; para
        // tirar a marca existe o próprio checkbox.
        setSelectedIds((current) => selectIncident(current, incidentId));
      }
      if (successText) reportFall(successText, 'success');
    } catch {
      reportFall('Não foi possível copiar. Selecione o texto e copie manualmente.', 'error');
    }
  }

  // Vai para a área de transferência só o que está depois da arroba: é o que a
  // busca do Meta Developers espera. A arroba fica na tela e não no clipboard.
  function copyIncidentUsername(incident: MetaPendingDisconnection) {
    void copyToClipboard(incident.username_snapshot, incident.id, '');
  }

  function copyIncidentList(incidents: MetaPendingDisconnection[]) {
    void copyToClipboard(
      pendingUsernameList(incidents),
      null,
      `${incidents.length} nome(s) copiados, um por linha, sem a arroba.`,
    );
  }

  function confirmSlotRelease(incidents: MetaPendingDisconnection[], scopeLabel: string) {
    void submitSlotRelease(incidents.map((incident) => incident.id), false, scopeLabel);
  }

  async function submitSlotRelease(incidentIds: string[], undo: boolean, label: string) {
    if (confirming || incidentIds.length === 0) return;
    setConfirming(true);
    setFallMessage('');

    try {
      const response = await fetch('/api/integrations/meta/disconnections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentIds, action: undo ? 'undo' : 'confirm' }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        applied?: number;
        unchanged?: number;
        pending?: MetaPendingDisconnection[] | null;
      };

      if (!response.ok) {
        reportFall(payload.error ?? 'Não foi possível registrar a remoção.', 'error');
        return;
      }

      // A fila nova vem do servidor. Recalcular aqui inventaria um número que
      // diverge do banco assim que duas abas mexerem na mesma lista.
      if (payload.pending) setPending(payload.pending);
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of incidentIds) next.delete(id);
        return next;
      });

      const applied = payload.applied ?? 0;
      const unchanged = payload.unchanged ?? 0;
      const aviso = unchanged > 0
        ? ` ${unchanged} já ${undo ? 'estava(m) na fila' : 'tinha(m) sido confirmado(s)'} — provavelmente em outra aba.`
        : '';

      if (undo) {
        setUndoBatch(null);
        reportFall(`${applied} perfil(is) voltaram para a fila de ${label}.${aviso}`, 'neutral');
      } else {
        setUndoBatch(applied > 0 ? { ids: incidentIds, label } : null);
        reportFall(
          `${applied} vaga(s) liberadas em ${label}. Elas voltam a ser oferecidas no Bulk Meta.${aviso}`,
          'success',
        );
      }

      // O medidor de vagas é calculado no servidor, mas `router.refresh()`
      // sozinho não o atualiza: `apps` é `useState(initialApps)` e só lê a prop
      // uma vez, então os números novos chegam do servidor e o estado local
      // ignora. O efeito era o pior possível — a fila encolhia e o cartão
      // continuava dizendo "45 presas", como se a confirmação não tivesse
      // valido. Buscar a lista é o que `adoptServerApp` já fazia pelo mesmo
      // motivo.
      router.refresh();
      await refreshApps();
    } catch {
      reportFall('Não foi possível conectar ao servidor.', 'error');
    } finally {
      setConfirming(false);
    }
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

  async function unblockApp(app: MetaApp) {
    if (busyAppId || !canAdmin) return;
    setBusyAppId(app.id);
    setMessage('');

    try {
      const response = await fetch(`/api/integrations/meta/apps/${app.id}/unblock`, { method: 'POST' });
      const payload = await response.json().catch(() => ({})) as { error?: string; app?: MetaApp };

      if (!response.ok) {
        report(payload.error ?? 'Não foi possível desbloquear o app.', 'error');
        return;
      }

      // A linha volta do servidor: a tela mostra o estado que o banco tem, e
      // não o que ela supõe ter acontecido.
      setApps((current) => current.map((item) => item.id === app.id
        ? (payload.app ?? { ...item, api_blocked_at: null, api_block_until: null, api_block_error_message: null })
        : item));
      report(
        `App “${app.label}” desbloqueado. A fila retoma do próximo horário — o que venceu durante o bloqueio ficou ignorado.`,
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
          <div className={`${styles.total}${trappedTotal > 0 ? ` ${styles.totalAlert}` : ''}`}>
            <dt>Vagas presas</dt><dd>{trappedTotal}</dd>
          </div>
          <div className={styles.total}><dt>Vagas livres</dt><dd>{totals.free}</dd></div>
        </dl>
      </header>

      {pendingDisconnectionsFailed && (
        <p className="inline-message inline-message-error" role="alert">
          Não foi possível carregar as contas caídas. O resto da tela funciona; recarregue para tentar de novo.
        </p>
      )}

      {trappedTotal > 0 && (
        <section className={styles.trapped} aria-label="Vagas presas">
          <div>
            <span className="section-kicker">Contas a remover no Meta Developers</span>
            <strong>{trappedTotal} vaga(s) presas no painel da Meta</strong>
            <p>
              Toda conta que sai do Athena continua ocupando a vaga do app no Meta Developers até alguém apagá-la lá —
              tanto as que o worker removeu sozinho quando a Meta exigiu verificação (erro 190 com checkpoint) quanto
              as que você mandou excluir em /perfis, na Recuperação ou apagando um grupo. A API da Meta não expõe essa
              lista, então não há como fazer a limpeza daqui. Abra a fila do app, apague as contas no painel da Meta e
              confirme aqui: só então a vaga volta a ser oferecida no Bulk Meta.
            </p>
          </div>
          <span className={styles.trappedCount}>{trappedTotal}</span>
        </section>
      )}

      {fallMessage && (
        <p
          className={`inline-message inline-message-${fallMessageTone}`}
          role={fallMessageTone === 'error' ? 'alert' : 'status'}
        >
          {fallMessage}
          {undoBatch && (
            <>
              {' '}
              <button
                className={styles.undoButton}
                type="button"
                disabled={confirming}
                onClick={() => void submitSlotRelease(undoBatch.ids, true, undoBatch.label)}
              >
                Desfazer
              </button>
            </>
          )}
        </p>
      )}

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
            const share = (slots: number) => (capacity.slotLimit === 0
              ? 0
              : Math.min(100, Math.round((slots / capacity.slotLimit) * 100)));
            const activePercentage = share(capacity.activeProfiles);
            // O teto de 100 e por faixa; somadas elas nao passam da barra
            // porque a presa so recebe o que sobrou da ativa.
            const trappedPercentage = Math.min(share(capacity.trappedSlots), 100 - activePercentage);
            const appPending = pendingByApp.get(app.id) ?? [];
            const queueOpen = openAppIds.has(app.id);
            const apiBlock = apiBlockState(app);

            return (
              <article
                key={app.id}
                className={`${styles.card}${app.active ? '' : ` ${styles.cardInactive}`}${full ? ` ${styles.cardFull}` : ''}${apiBlock ? ` ${styles.cardBlocked}` : ''}`}
              >
                {apiBlock && (
                  <div className={styles.apiBlock} role="status">
                    <strong className={styles.apiBlockTitle}>
                      {apiBlock.desativado ? 'API desativada pela Meta' : 'API bloqueada pela Meta'}
                    </strong>
                    <p className={styles.apiBlockText}>
                      Nenhum dos {app.instagram_profile_count} perfil(is) deste app publica enquanto isso.
                      Desde {formatDate(apiBlock.since)} · {app.api_block_ignored_count} publicação(ões) já ignorada(s)
                      {app.api_block_window_count > 1 ? ` · ${app.api_block_window_count} janelas` : ''}.
                    </p>
                    {app.api_block_error_message && (
                      <p className={styles.apiBlockReason}>Meta: {app.api_block_error_message}</p>
                    )}
                    <p className={styles.apiBlockText}>
                      {apiBlock.desativado
                        // Desativado não volta sozinho: dizer "aguarde" aqui
                        // faria o operador esperar por algo que não vem.
                        ? `A fila segue testando de hora em hora, mas app desativado não costuma voltar — o caminho é religar as ${app.instagram_profile_count} conta(s) em outro app. O que vencer até lá é ignorado.`
                        : `A fila tenta de novo sozinha em ${apiBlock.minutesLeft} min. O que vencer até lá é ignorado — destrave o app no Meta Developers e use o botão para retomar na hora.`}
                    </p>
                    <p className={styles.apiBlockText}>
                      {/* A saída quando o app não volta: reconectar as contas por
                          outro app. O perfil é o mesmo — fila agendada, grupos e
                          histórico continuam, porque tudo aponta para o perfil e
                          não para o app. Ver migration 399. */}
                      Se o app não voltar, reconecte as contas por outro app pelo <strong>Bulk Meta</strong>, em
                      Perfis. O perfil continua o mesmo: fila agendada, grupos e histórico vão junto.
                      {app.transferred_out_count > 0
                        && ` ${app.transferred_out_count} conta(s) já saíram daqui — a conexão delas continua
                            ocupando vaga neste app até ser apagada no Meta Developers.`}
                    </p>
                    {canAdmin && (
                      <button
                        className="button button-ghost"
                        type="button"
                        disabled={busyAppId === app.id}
                        onClick={() => void unblockApp(app)}
                      >
                        Já desbloqueei na Meta
                      </button>
                    )}
                  </div>
                )}
                <div className={styles.cardMain}>
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
                      style={{ width: `${activePercentage}%` }}
                    />
                    {/* A faixa presa vem depois da ativa, na mesma barra: e o
                        unico jeito de "94/100" e "0 vagas livres" pararem de
                        parecer contradicao no mesmo cartao. */}
                    <div className={styles.gaugeFillTrapped} style={{ width: `${trappedPercentage}%` }} />
                  </div>
                  {capacity.trappedSlots > 0 && (
                    <span className={styles.capacityBreakdown}>
                      {capacity.activeProfiles} publicando + {capacity.trappedSlots} presa(s)
                      {app.transferred_out_count > 0 && (
                        // Vaga presa tem duas causas e elas pedem ações
                        // diferentes: a queda exige apagar a conexão no Meta
                        // Developers, a transferência é a conta que já está
                        // publicando por outro app. Somar sem separar esconderia
                        // qual das duas é.
                        <> · {app.pending_slot_release_count} por queda
                        {' · '}{app.transferred_out_count} movido(s) para outro app</>
                      )}
                    </span>
                  )}
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
                </div>

                {appPending.length > 0 && (
                  <>
                    <button
                      className={styles.fallToggle}
                      type="button"
                      aria-expanded={queueOpen}
                      onClick={() => toggleApp(app.id)}
                    >
                      <span aria-hidden="true">{queueOpen ? '▾' : '▸'}</span>
                      <strong>{appPending.length}</strong> conta(s) esperando remoção no Meta Developers
                      <span className={styles.fallToggleHint}>{queueOpen ? 'ocultar' : 'abrir fila'}</span>
                    </button>
                    {queueOpen && (
                      <PendingQueue
                        incidents={appPending}
                        scopeLabel={`“${app.label}”`}
                        selectedIds={selectedIds}
                        copiedIncidentId={copiedIncidentId}
                        busy={confirming}
                        onToggleIncident={toggleIncident}
                        onToggleAll={toggleAll}
                        onCopyOne={copyIncidentUsername}
                        onCopyMany={copyIncidentList}
                        onConfirm={confirmSlotRelease}
                      />
                    )}
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}

      {orphanPending.length > 0 && (
        <section className={styles.orphanFalls} aria-label="Contas caídas sem app identificado">
          <div className={styles.orphanFallsHead}>
            <div>
              <span className="section-kicker">Sem app identificado</span>
              <strong>{orphanPending.length} conta(s) fora de qualquer cartão</strong>
              <p>
                Ou entraram pela credencial global antes do cadastro de apps existir, ou entraram por um app que já
                foi descadastrado. Não dá para dizer qual app prende a vaga delas — mas a conexão continua no Meta
                Developers de algum, então vale procurar o @ no painel e apagar do mesmo jeito.
              </p>
            </div>
          </div>
          <PendingQueue
            incidents={orphanPending}
            scopeLabel="contas sem app identificado"
            selectedIds={selectedIds}
            copiedIncidentId={copiedIncidentId}
            busy={confirming}
            onToggleIncident={toggleIncident}
            onToggleAll={toggleAll}
            onCopyOne={copyIncidentUsername}
            onCopyMany={copyIncidentList}
            onConfirm={confirmSlotRelease}
          />
        </section>
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

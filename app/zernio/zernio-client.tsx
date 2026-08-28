'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { parseZernioConnectionImport } from '@/lib/integrations/zernio-connection-import';

type Organization = {
  id: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
};

type ZernioConnection = {
  id: string;
  organization_id: string;
  label: string;
  configured: boolean;
  zernio_profile_id: string | null;
  status: 'no_data' | 'online' | 'offline' | 'reauthorization_required';
  balance_cents: number;
  balance_currency: string;
  supported_platforms: string[];
  last_checked_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_sync_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  instagram_slot_limit: number;
  active_slot_reservation_count: number;
  instagram_profile_count: number;
  remote_instagram_account_count: number | null;
  remote_inventory_checked_at: string | null;
  remote_inventory_error_code: string | null;
  remote_inventory_error_message: string | null;
  platform_counts: Record<string, number> | null;
};

type ZernioSyncPayload = {
  error?: string;
  synced?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  conflicts?: number;
  billing?: { balanceCents?: number; balanceCurrency?: string } | null;
  health?: { available: boolean; total: number; healthy: number; unhealthy: number; error: string | null };
  refreshJob?: RefreshJobSummary | null;
};
type ZernioOrganizationSyncPayload = { error?: string; status?: 'queued' | 'already_running'; batchId?: string; totalConnections?: number };
type ZernioOrganizationSyncProgress = { id: string; status: 'processing' | 'completed' | 'completed_with_errors' | 'failed'; totalConnections: number; processedConnections: number; processingConnections: number; synced: number; conflicts: number; failures: number; completedAt: string | null };

type RefreshJobSummary = { job_id: string; status: string; total_count: number; reused: boolean; reason: string };
type RefreshJobStatus = { id: string; status: string; total_count: number; processed_count: number; synced_count: number; partial_count: number; no_data_count: number; skipped_count: number; failed_count: number; retry_pending_count: number; dead_letter_count: number; last_error_message: string | null };
type ZernioImportItem = { status: 'queued' | 'processing' | 'succeeded' | 'failed'; last_error_message: string | null; line_number: number; label: string };
type ZernioImportBatch = { id: string; status: 'queued' | 'processing' | 'completed' | 'completed_with_errors'; total_count: number; created_at: string; started_at: string | null; completed_at: string | null; zernio_connection_import_items: ZernioImportItem[] };

const statusLabel: Record<ZernioConnection['status'], string> = {
  no_data: 'Sem dados',
  online: 'Online',
  offline: 'Offline',
  reauthorization_required: 'Reautorizar',
};

function formatDate(value: string | null) {
  if (!value) return 'Nunca';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function formatBalance(connection: ZernioConnection) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: connection.balance_currency || 'USD' }).format((connection.balance_cents ?? 0) / 100);
}

function connectionOptionLabel(connection: ZernioConnection) {
  // A ocupação remota já é filtrada pelo profile canônico desta conexão.
  // Reservas são apenas futuros slots e não podem transformar uma chave 1/2
  // em 2/2 quando a única reserva corresponde à conta já observada remotamente.
  const usedSlots = Math.max(
    connection.remote_instagram_account_count ?? 0,
    (connection.instagram_profile_count ?? 0) + (connection.active_slot_reservation_count ?? 0),
  );
  return `${connection.label} (${usedSlots}/${connection.instagram_slot_limit ?? 2})`;
}

function formatZernioSyncMessage(payload: ZernioSyncPayload) {
  const refreshJob = payload.refreshJob;
  const reconciled = payload.synced ?? 0;
  const details = [
    `${payload.created ?? 0} criada(s)`,
    `${payload.updated ?? 0} atualizada(s)`,
    `${payload.unchanged ?? 0} sem alteração`,
    `${payload.conflicts ?? 0} conflito(s)`,
  ].join(', ');
  const health = payload.health?.available
    ? ` Saúde: ${payload.health.healthy}/${payload.health.total} conta(s) saudável(is)${payload.health.unhealthy > 0 ? `, ${payload.health.unhealthy} com alerta` : ''}.`
    : ' Saúde detalhada indisponível nesta execução.';
  const billing = payload.billing ? ' Cobrança atualizada.' : ' Cobrança indisponível nesta execução.';
  const base = `Sincronização da chave concluída: ${reconciled} conta(s) reconciliada(s) (${details}).${health}${billing}`;
  if (!refreshJob) return base;
  if (refreshJob.reason === 'active_job') return `${base} Atualização de métricas já estava em andamento (${refreshJob.total_count} perfil(is)).`;
  if (refreshJob.reason === 'nothing_stale') return `${base} Métricas já estão dentro do cache.`;
  return `${base} Atualização de métricas enfileirada para ${refreshJob.total_count} perfil(is).`;
}

function refreshJobMessage(job: RefreshJobStatus | null) {
  if (!job) return '';
  if (job.status === 'completed') return `Métricas atualizadas: ${job.synced_count} perfil(is), ${job.no_data_count} sem dados no período.`;
  if (job.status === 'completed_with_errors') return `Atualização finalizada com avisos: ${job.synced_count} atualizados, ${job.partial_count} parciais, ${job.failed_count} falhas (${job.dead_letter_count} em dead-letter).`;
  if (job.status === 'failed') return job.last_error_message ?? 'Atualização de métricas falhou.';
  if (job.retry_pending_count > 0) return `Atualizando métricas: ${job.processed_count}/${job.total_count}. ${job.retry_pending_count} aguardando nova tentativa automática.`;
  return `Atualizando métricas em segundo plano: ${job.processed_count}/${job.total_count}.`;
}

export default function ZernioClient({ activeOrganization, initialConnections, initialDefaultInstagramSlotLimit }: { activeOrganization: Organization; initialConnections: ZernioConnection[]; initialDefaultInstagramSlotLimit: number }) {
  const canAdmin = activeOrganization.role === 'admin';
  const canManage = activeOrganization.role === 'admin' || activeOrganization.role === 'operator';
  const [connections, setConnections] = useState(initialConnections);
  const connectionOperationRef = useRef<string | null>(null);
  const organizationSyncRef = useRef(false);
  const [namesText, setNamesText] = useState('');
  const [apiKeysText, setApiKeysText] = useState('');
  const [saving, setSaving] = useState(false);
  const [importBatches, setImportBatches] = useState<ZernioImportBatch[]>([]);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [activeSyncBatchId, setActiveSyncBatchId] = useState<string | null>(null);
  const [syncBatchProgress, setSyncBatchProgress] = useState<ZernioOrganizationSyncProgress | null>(null);
  const [editingConnection, setEditingConnection] = useState<ZernioConnection | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<ZernioConnection | null>(null);
  const [totalDeletingConnection, setTotalDeletingConnection] = useState<ZernioConnection | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [editingInstagramSlotLimit, setEditingInstagramSlotLimit] = useState(2);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [totalDeleteConfirmation, setTotalDeleteConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'neutral' | 'success' | 'error'>('neutral');
  const [activeRefreshJobId, setActiveRefreshJobId] = useState<string | null>(null);
  const [refreshJobStatus, setRefreshJobStatus] = useState<RefreshJobStatus | null>(null);
  const [defaultInstagramSlotLimit, setDefaultInstagramSlotLimit] = useState(initialDefaultInstagramSlotLimit);
  const [savingDefaultLimit, setSavingDefaultLimit] = useState(false);

  const totals = useMemo(() => connections.reduce((summary, connection) => ({
    apis: summary.apis + 1,
    instagram: summary.instagram + (connection.instagram_profile_count ?? 0),
    online: summary.online + (connection.status === 'online' ? 1 : 0),
  }), { apis: 0, instagram: 0, online: 0 }), [connections]);
  const importDraft = useMemo(() => parseZernioConnectionImport(namesText, apiKeysText), [namesText, apiKeysText]);
  const latestImport = importBatches[0] ?? null;

  function showMessage(text: string, tone: 'neutral' | 'success' | 'error' = 'neutral') {
    setMessage(text);
    setMessageTone(tone);
  }

  async function refreshConnections() {
    const response = await fetch('/api/integrations/zernio/connections', { cache: 'no-store' });
    const payload = await response.json() as { connections?: ZernioConnection[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? 'Não foi possível atualizar as contas Zernio.');
    setConnections(payload.connections ?? []);
  }

  async function refreshImportBatches() {
    const response = await fetch('/api/integrations/zernio/import-batches', { cache: 'no-store' });
    const payload = await response.json() as { batches?: ZernioImportBatch[]; error?: string };
    if (!response.ok) throw new Error(payload.error ?? 'Não foi possível atualizar os lotes Zernio.');
    setImportBatches(payload.batches ?? []);
  }

  async function saveDefaultInstagramSlotLimit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdmin || savingDefaultLimit) return;
    setSavingDefaultLimit(true);
    try {
      const response = await fetch('/api/integrations/zernio/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultInstagramSlotLimit }),
      });
      const payload = await response.json() as { error?: string; settings?: { default_instagram_slot_limit: number } };
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível salvar o limite padrão.');
      setDefaultInstagramSlotLimit(payload.settings?.default_instagram_slot_limit ?? defaultInstagramSlotLimit);
      showMessage('Limite padrão salvo. Ele será aplicado somente às novas contas Zernio.', 'success');
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Não foi possível salvar o limite padrão.', 'error');
    } finally {
      setSavingDefaultLimit(false);
    }
  }

  useEffect(() => {
    void refreshImportBatches().catch(() => undefined);
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshImportBatches().catch(() => undefined); }, 5000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function restoreActiveBatch() {
      const response = await fetch('/api/integrations/zernio/sync-batches/active', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as { batchId?: string | null };
      if (cancelled || !response.ok || !payload.batchId) return;
      setActiveSyncBatchId(payload.batchId);
      setSyncingAll(true);
      showMessage('Uma sincronia Zernio em andamento foi recuperada.', 'neutral');
    }
    void restoreActiveBatch();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!activeRefreshJobId) return;
    let cancelled = false;
    async function poll() {
      const response = await fetch(`/api/profile-analytics/refresh-jobs/${activeRefreshJobId}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as { job?: RefreshJobStatus };
      if (!cancelled && response.ok && payload.job) {
        setRefreshJobStatus(payload.job);
        if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(payload.job.status)) {
          setActiveRefreshJobId(null);
          if (['completed', 'completed_with_errors'].includes(payload.job.status) && payload.job.processed_count > 0) {
            void refreshConnections().catch(() => undefined);
          }
        }
      }
    }
    void poll();
    const interval = window.setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeRefreshJobId]);

  useEffect(() => {
    if (!activeSyncBatchId) return;
    let cancelled = false;
    async function poll() {
      const response = await fetch(`/api/integrations/zernio/sync-batches/${activeSyncBatchId}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({})) as { batch?: ZernioOrganizationSyncProgress };
      if (cancelled || !response.ok || !payload.batch) return;
      setSyncBatchProgress(payload.batch);
      if (payload.batch.status !== 'processing') {
        setActiveSyncBatchId(null);
        setSyncingAll(false);
        void refreshConnections().catch(() => undefined);
        const summary = `${payload.batch.synced} perfil(is) reconciliado(s); ${payload.batch.conflicts} conflito(s); ${payload.batch.failures} falha(s).`;
        showMessage(`Sincronia de contas finalizada: ${summary}`, payload.batch.status === 'completed' ? 'success' : 'neutral');
      }
    }
    void poll();
    const interval = window.setInterval(() => void poll(), 3000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [activeSyncBatchId]);

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAdmin) return;
    if (!importDraft.valid) {
      showMessage('Revise os avisos das duas colunas antes de enfileirar o lote.', 'error');
      return;
    }
    const firstConfirm = window.confirm(`Enfileirar ${importDraft.rows.length} conta(s) Zernio para ${activeOrganization.name}?`);
    if (!firstConfirm) return;
    const secondConfirm = window.confirm('Confirma novamente que os nomes e API keys estão pareados na mesma ordem?');
    if (!secondConfirm) return;

    setSaving(true);
    showMessage('');
    try {
      const response = await fetch('/api/integrations/zernio/import-batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ namesText, apiKeysText }),
      });
      const payload = await response.json() as { error?: string; issues?: Array<{ lineNumber?: number; message?: string }>; outcome?: { status?: string } };
      if (!response.ok) {
        const issueDetails = (payload.issues ?? [])
          .map((issue) => `${issue.lineNumber ? `Linha ${issue.lineNumber}: ` : ''}${issue.message ?? ''}`)
          .filter(Boolean)
          .join(' ');
        showMessage(issueDetails || payload.error || 'Não foi possível cadastrar a conta Zernio.', 'error');
        return;
      }
      setNamesText('');
      setApiKeysText('');
      await Promise.all([refreshConnections(), refreshImportBatches()]);
      showMessage(payload.outcome?.status === 'waiting' ? 'Lote enfileirado. Outra importação está em processamento nesta organização.' : 'Lote Zernio processado. Confira o resumo abaixo.', 'success');
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Não foi possível conectar ao servidor.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function retryImport(batchId: string) {
    setSaving(true);
    try {
      const response = await fetch('/api/integrations/zernio/import-batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retryBatchId: batchId }),
      });
      const payload = await response.json() as { error?: string; outcome?: { status?: string } };
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível retomar o lote.');
      await Promise.all([refreshConnections(), refreshImportBatches()]);
      showMessage(payload.outcome?.status === 'waiting' ? 'Retomada enfileirada; outra importação ainda está em andamento.' : 'Falhas do lote retomadas.', 'success');
    } catch (error) {
      showMessage(error instanceof Error ? error.message : 'Não foi possível retomar o lote.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function syncConnection(connection: ZernioConnection) {
    if (!canManage || connectionOperationRef.current !== null || organizationSyncRef.current || busyConnectionId !== null || syncingAll || activeSyncBatchId) return;
    connectionOperationRef.current = connection.id;
    setBusyConnectionId(connection.id);
    showMessage('');
    try {
      const response = await fetch(`/api/integrations/zernio/connections/${connection.id}/sync`, { method: 'POST' });
      const payload = await response.json() as ZernioSyncPayload;
      if (!response.ok) {
        showMessage(payload.error ?? 'Não foi possível sincronizar a conta Zernio.', 'error');
        return;
      }
      await refreshConnections();
      if (payload.refreshJob?.job_id) setActiveRefreshJobId(payload.refreshJob.job_id);
      showMessage(formatZernioSyncMessage(payload), 'success');
    } catch {
      showMessage('Não foi possível conectar ao servidor.', 'error');
    } finally {
      connectionOperationRef.current = null;
      setBusyConnectionId(null);
    }
  }

  async function syncAllConnections() {
    if (!canAdmin || organizationSyncRef.current || connectionOperationRef.current !== null || syncingAll || busyConnectionId !== null) return;
    organizationSyncRef.current = true;
    setSyncingAll(true);
    showMessage('A sincronia geral foi enfileirada para a VPS. O andamento por chave será atualizado nesta tela.');
    try {
      const response = await fetch('/api/integrations/zernio/sync-all', { method: 'POST' });
      const payload = await response.json() as ZernioOrganizationSyncPayload;
      if (!response.ok) throw new Error(payload.error ?? 'Não foi possível sincronizar todas as chaves Zernio.');
      if (!payload.batchId) throw new Error('O lote de sincronia não foi criado.');
      setActiveSyncBatchId(payload.batchId);
      showMessage(payload.status === 'already_running'
        ? 'Uma sincronia já estava em andamento; exibindo o progresso do lote atual.'
        : `Sincronia enfileirada: ${payload.totalConnections ?? 0} chave(s) aguardando a VPS.`, 'neutral');
    } catch (error) {
      setSyncingAll(false);
      showMessage(error instanceof Error ? error.message : 'Não foi possível conectar ao servidor.', 'error');
    } finally {
      organizationSyncRef.current = false;
    }
  }

  async function renameConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingConnection) return;
    const firstConfirm = window.confirm(`Renomear "${editingConnection.label}" para "${renameLabel.trim()}"?`);
    if (!firstConfirm) return;
    const secondConfirm = window.confirm('Confirma novamente a alteração do nome desta conta Zernio?');
    if (!secondConfirm) return;

    setBusyConnectionId(editingConnection.id);
    try {
      const response = await fetch(`/api/integrations/zernio/connections/${editingConnection.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: renameLabel, instagramSlotLimit: editingInstagramSlotLimit }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        showMessage(payload.error ?? 'Não foi possível renomear a conta Zernio.', 'error');
        return;
      }
      setEditingConnection(null);
      setRenameLabel('');
      setEditingInstagramSlotLimit(2);
      await refreshConnections();
      showMessage('Conta Zernio atualizada com sucesso.', 'success');
    } catch {
      showMessage('Não foi possível conectar ao servidor.', 'error');
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function deleteConnection() {
    if (!deletingConnection) return;
    const firstConfirm = window.confirm(`Excluir a API key "${deletingConnection.label}" do Atena? Esta ação não remove perfis Instagram na Zernio.`);
    if (!firstConfirm) return;
    const secondConfirm = window.confirm('Confirma novamente a exclusão desta API key? Perfis vinculados precisam ser removidos antes.');
    if (!secondConfirm) return;

    setBusyConnectionId(deletingConnection.id);
    try {
      const response = await fetch(`/api/integrations/zernio/connections/${deletingConnection.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: deleteConfirmation }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        showMessage(payload.error ?? 'Não foi possível excluir a conta Zernio.', 'error');
        return;
      }
      setDeletingConnection(null);
      setDeleteConfirmation('');
      await refreshConnections();
      showMessage('Conta Zernio excluída com segurança.', 'success');
    } catch {
      showMessage('Não foi possível conectar ao servidor.', 'error');
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function totalDeleteConnection() {
    if (!totalDeletingConnection || totalDeleteConfirmation !== 'EXCLUIR TOTALMENTE') return;
    setBusyConnectionId(totalDeletingConnection.id);
    showMessage('');
    try {
      const response = await fetch(`/api/integrations/zernio/connections/${totalDeletingConnection.id}/total-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: totalDeleteConfirmation, idempotencyKey: crypto.randomUUID() }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        result?: { blocked?: boolean; profilesDeleted?: number; blockedItemIds?: string[] };
      };
      if (!response.ok) {
        const blocked = payload.result?.blocked;
        showMessage(blocked
          ? `${payload.result?.blockedItemIds?.length ?? 0} publicação(ões) estão em processamento. Aguarde terminar e tente novamente; nada foi removido.`
          : payload.error ?? 'Não foi possível concluir a exclusão total local.', 'error');
        return;
      }
      const profilesDeleted = payload.result?.profilesDeleted ?? 0;
      setTotalDeletingConnection(null);
      setTotalDeleteConfirmation('');
      await refreshConnections();
      showMessage(`Exclusão total local concluída: ${profilesDeleted} perfil(is) e a API key foram removidos do Atena. Nenhuma chamada foi enviada à Zernio.`, 'success');
    } catch {
      showMessage('Não foi possível conectar ao servidor.', 'error');
    } finally {
      setBusyConnectionId(null);
    }
  }

  return (
    <main className="standalone-page zernio-page">
      <header className="standalone-header zernio-hero">
        <div>
          <span className="section-kicker">{activeOrganization.name} · Zernio</span>
          <h1>Contas Zernio</h1>
          <p>Cadastre várias API keys, acompanhe status e sincronize perfis Instagram com métricas automaticamente após conectar ou sincronizar.</p>
        </div>
        {canAdmin && <button className="button button-primary" type="button" disabled={syncingAll || busyConnectionId !== null || connections.length === 0} onClick={() => void syncAllConnections()}>{syncingAll ? 'Sincronia em andamento…' : 'Sincronizar todas as contas'}</button>}
      </header>

      <section className="top-notification-region" aria-live="polite" aria-atomic="true">
        {message && <p className={`inline-message inline-message-${messageTone}`} role={messageTone === 'error' ? 'alert' : 'status'}>{message}</p>}
        {refreshJobStatus && <p className="inline-message inline-message-neutral" role="status">{refreshJobMessage(refreshJobStatus)}</p>}
        {syncBatchProgress && <p className="inline-message inline-message-neutral" role="status">Sincronia Zernio: {syncBatchProgress.processedConnections}/{syncBatchProgress.totalConnections} chave(s) concluída(s), {syncBatchProgress.processingConnections} em processamento · {syncBatchProgress.synced} perfil(is) reconciliado(s) · {syncBatchProgress.conflicts} conflito(s) · {syncBatchProgress.failures} falha(s).</p>}
      </section>

      <section className="zernio-metrics" aria-label="Resumo Zernio">
        <article className="metric-card"><span className="metric-label">APIs salvas</span><strong>{totals.apis}</strong><span className="metric-caption">Contas Zernio cadastradas</span></article>
        <article className="metric-card"><span className="metric-label">Instagram</span><strong>{totals.instagram}</strong><span className="metric-caption">Perfis vinculados no Atena</span></article>
        <article className="metric-card"><span className="metric-label">Online</span><strong>{totals.online}</strong><span className="metric-caption">Contas saudáveis agora</span></article>
      </section>

      {canAdmin && (
        <section className="panel zernio-create-panel" aria-label="Adicionar conta Zernio">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">Importação em massa</span>
              <h2>Adicionar contas Zernio</h2>
              <p>Cole um nome por linha à esquerda e a API key correspondente na mesma linha à direita. O lote é salvo com segurança e processado uma conta por vez.</p>
            </div>
          </div>
          <form className="zernio-default-limit-form" onSubmit={saveDefaultInstagramSlotLimit}>
            <label htmlFor="zernio-default-instagram-slot-limit">
              <strong>Limite padrão para novas contas</strong>
              <span>Aplica-se somente às contas adicionadas depois de salvar.</span>
            </label>
            <input id="zernio-default-instagram-slot-limit" type="number" min={1} max={100} step={1} value={defaultInstagramSlotLimit} onChange={(event) => setDefaultInstagramSlotLimit(Number(event.target.value))} disabled={savingDefaultLimit} />
            <button className="button button-secondary" type="submit" disabled={savingDefaultLimit || !Number.isInteger(defaultInstagramSlotLimit) || defaultInstagramSlotLimit < 1 || defaultInstagramSlotLimit > 100}>{savingDefaultLimit ? 'Salvando…' : 'Salvar limite'}</button>
          </form>
          <form className="zernio-create-form" onSubmit={createConnection}>
            <div className="zernio-import-editor-grid">
              <label className="panel zernio-import-textarea-panel" htmlFor="zernio-names">
                <span><strong>Nomes das contas</strong><small>{importDraft.nameCount} linha(s)</small></span>
                <em>Um nome por linha — será exibido em Perfis.</em>
                <textarea id="zernio-names" value={namesText} onChange={(event) => setNamesText(event.target.value)} placeholder={'Conta Pex\nConta Ágata'} disabled={saving} spellCheck={false} />
              </label>
              <label className="panel zernio-import-textarea-panel" htmlFor="zernio-api-keys">
                <span><strong>API keys</strong><small>{importDraft.apiKeyCount} linha(s)</small></span>
                <em>Uma por linha — pareada com o nome à esquerda.</em>
                <textarea id="zernio-api-keys" value={apiKeysText} onChange={(event) => setApiKeysText(event.target.value)} placeholder={'sk_...\nsk_...'} disabled={saving} spellCheck={false} autoComplete="off" />
              </label>
            </div>
            <section className="zernio-import-alert-stack" aria-live="polite">
              {importDraft.nameCount === importDraft.apiKeyCount && importDraft.rows.length > 0 && importDraft.issues.length === 0 && <p className="zernio-import-ready-alert">{importDraft.rows.length} nome(s) e {importDraft.rows.length} API key(s) pareados. O salvamento está liberado.</p>}
              {importDraft.issues.map((issue, index) => <p className="zernio-import-error-alert" key={`${issue.field}-${issue.lineNumber}-${index}`}>{issue.lineNumber ? `Linha ${issue.lineNumber}: ` : ''}{issue.message}</p>)}
            </section>
            <button className="button button-primary zernio-import-submit" type="submit" disabled={saving || !importDraft.valid}>{saving ? 'Enfileirando…' : `Salvar ${importDraft.rows.length || ''} conta(s) Zernio`}</button>
          </form>
        </section>
      )}

      {latestImport && (
        <section className="panel zernio-import-progress" aria-live="polite">
          <div>
            <span className="section-kicker">Último lote</span>
            <h2>{latestImport.status === 'queued' ? 'Aguardando a fila da organização' : latestImport.status === 'processing' ? 'Importação Zernio em processamento' : latestImport.status === 'completed_with_errors' ? 'Importação concluída com falhas' : 'Importação concluída'}</h2>
            <p>{latestImport.zernio_connection_import_items.filter((item) => item.status === 'succeeded').length} concluída(s), {latestImport.zernio_connection_import_items.filter((item) => item.status === 'failed').length} falha(s) de {latestImport.total_count}. A tela atualiza automaticamente.</p>
          </div>
          {canAdmin && latestImport.status === 'completed_with_errors' && <button className="button button-secondary" type="button" disabled={saving} onClick={() => void retryImport(latestImport.id)}>Retomar falhas</button>}
          {latestImport.zernio_connection_import_items.filter((item) => item.status === 'failed').slice(0, 5).map((item) => <p className="zernio-import-item-error" key={item.line_number}>Linha {item.line_number} · {item.label}: {item.last_error_message ?? 'Falha ao cadastrar.'}</p>)}
        </section>
      )}

      <section className="zernio-connection-grid" aria-label="Contas Zernio cadastradas">
        {connections.length === 0 ? (
          <article className="panel empty-state zernio-empty-state"><span className="empty-state-icon" aria-hidden="true">◇</span><h2>Nenhuma conta Zernio cadastrada</h2><p>Adicione a primeira API key para liberar o seletor de conexão Zernio em Perfis.</p></article>
        ) : connections.map((connection) => (
          <article className="panel zernio-connection-card" key={connection.id}>
            <div className="zernio-card-topline">
              <span className={`profile-status profile-status-${connection.status}`}><span className="status-dot" />{statusLabel[connection.status]}</span>
              <span className="zernio-balance-pill">{formatBalance(connection)}</span>
            </div>
            <div className="zernio-card-title">
              <h2>{connectionOptionLabel(connection)}</h2>
              <p>Profile Zernio: {connection.zernio_profile_id ?? 'Será criado ao conectar'}</p>
            </div>
            <dl className="zernio-card-details">
              <div><dt>Adicionada em</dt><dd>{formatDate(connection.created_at)}</dd></div>
              <div><dt>Última checagem</dt><dd>{formatDate(connection.last_checked_at)}</dd></div>
              <div><dt>Última sincronização</dt><dd>{formatDate(connection.last_sync_at)}</dd></div>
              <div><dt>Plataformas</dt><dd>{(connection.supported_platforms ?? ['instagram']).join(', ')}</dd></div>
            </dl>
            <div className="zernio-platform-strip">
              <span><strong>{connection.remote_instagram_account_count ?? '—'}/{connection.instagram_slot_limit ?? 2}</strong> na Zernio · <strong>{connection.instagram_profile_count ?? 0}</strong> vínculo(s) no Atena · {connection.active_slot_reservation_count ?? 0} reserva(s)</span>
              <span><strong>{connection.platform_counts?.tiktok ?? 0}</strong> TikTok</span>
              <span><strong>{connection.platform_counts?.youtube ?? 0}</strong> YouTube</span>
            </div>
            {connection.last_error_message && <p className="profile-error">{connection.last_error_message}</p>}
            <div className="zernio-card-actions">
              {canManage && <a className="button button-primary" href={`/api/integrations/zernio/start?returnTo=%2Fperfis&connectionId=${encodeURIComponent(connection.id)}`}>Conectar Instagram</a>}
              {canManage && <button className="button button-ghost" type="button" disabled={busyConnectionId !== null || syncingAll || Boolean(activeSyncBatchId)} onClick={() => void syncConnection(connection)}>{busyConnectionId === connection.id ? 'Sincronizando contas…' : 'Sincronizar contas'}</button>}
              {canAdmin && <button className="button button-secondary" type="button" onClick={() => { setEditingConnection(connection); setRenameLabel(connection.label); setEditingInstagramSlotLimit(connection.instagram_slot_limit ?? 2); }}>Configurar</button>}
              {canAdmin && <button className="button button-danger" type="button" onClick={() => { setDeletingConnection(connection); setDeleteConfirmation(''); }}>Excluir API</button>}
              {canAdmin && <button className="button button-danger" type="button" disabled={busyConnectionId !== null} onClick={() => { setTotalDeletingConnection(connection); setTotalDeleteConfirmation(''); }}>Exclusão total</button>}
            </div>
          </article>
        ))}
      </section>

      {editingConnection && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setEditingConnection(null)}>
          <form className="panel bulk-modal zernio-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="rename-zernio-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={renameConnection}>
            <div><span className="section-kicker">Configuração</span><h2 id="rename-zernio-title">Configurar conta Zernio</h2></div>
            <p className="bulk-modal-help">O limite é a capacidade real usada pela reserva antes do OAuth. Ao salvar, duas confirmações do navegador serão exigidas.</p>
            <label className="bulk-operation-field">Novo nome<input value={renameLabel} onChange={(event) => setRenameLabel(event.target.value)} /></label>
            <label className="bulk-operation-field">Limite de slots Instagram<input type="number" min="1" max="100" value={editingInstagramSlotLimit} onChange={(event) => setEditingInstagramSlotLimit(Number(event.target.value))} /></label>
            <button className="button button-primary" type="submit" disabled={busyConnectionId !== null || renameLabel.trim().length < 2 || !Number.isInteger(editingInstagramSlotLimit) || editingInstagramSlotLimit < 1 || editingInstagramSlotLimit > 100}>Salvar configuração</button>
            <button className="button button-ghost" type="button" onClick={() => setEditingConnection(null)}>Cancelar</button>
          </form>
        </div>
      )}

      {deletingConnection && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeletingConnection(null)}>
          <section className="panel bulk-modal zernio-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-zernio-title" onMouseDown={(event) => event.stopPropagation()}>
            <div><span className="section-kicker">Zona de risco</span><h2 id="delete-zernio-title">Excluir API “{deletingConnection.label}”?</h2></div>
            <p className="bulk-modal-help">Essa ação remove a chave do Atena, mas não desconecta automaticamente perfis na Zernio. Por segurança, perfis vinculados precisam ser removidos primeiro. Digite EXCLUIR e confirme duas vezes.</p>
            <label className="bulk-operation-field">Confirmação<input value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder="EXCLUIR" /></label>
            <button className="button button-danger" type="button" disabled={busyConnectionId !== null || deleteConfirmation !== 'EXCLUIR'} onClick={() => void deleteConnection()}>Excluir API Zernio</button>
            <button className="button button-ghost" type="button" onClick={() => setDeletingConnection(null)}>Cancelar</button>
          </section>
        </div>
      )}
      {totalDeletingConnection && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => busyConnectionId === null && setTotalDeletingConnection(null)}>
          <section className="panel bulk-modal zernio-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="total-delete-zernio-title" onMouseDown={(event) => event.stopPropagation()}>
            <div><span className="section-kicker">Zona de risco · somente Atena</span><h2 id="total-delete-zernio-title">Exclusão total de “{totalDeletingConnection.label}”?</h2></div>
            <p className="bulk-modal-help"><strong>Nenhuma chamada será enviada à Zernio.</strong> Esta ação remove do Atena os {totalDeletingConnection.instagram_profile_count ?? 0} perfil(is) vinculados, seus grupos, publicações futuras e a API key local. A conta e os perfis podem continuar existindo na Zernio.</p>
            <p className="bulk-modal-help">Se houver uma publicação já em processamento, toda a operação será bloqueada e nada será removido.</p>
            <label className="bulk-operation-field">Confirmação<input value={totalDeleteConfirmation} onChange={(event) => setTotalDeleteConfirmation(event.target.value)} placeholder="EXCLUIR TOTALMENTE" disabled={busyConnectionId !== null} autoComplete="off" spellCheck={false} /></label>
            <button className="button button-danger" type="button" disabled={busyConnectionId !== null || totalDeleteConfirmation !== 'EXCLUIR TOTALMENTE'} onClick={() => void totalDeleteConnection()}>{busyConnectionId === totalDeletingConnection.id ? 'Excluindo localmente…' : 'Excluir tudo do Atena'}</button>
            <button className="button button-ghost" type="button" disabled={busyConnectionId !== null} onClick={() => setTotalDeletingConnection(null)}>Cancelar</button>
          </section>
        </div>
      )}
    </main>
  );
}

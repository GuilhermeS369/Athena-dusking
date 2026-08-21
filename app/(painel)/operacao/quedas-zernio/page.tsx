import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getOrganizationContext } from '@/lib/organizations/server';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { formatDateTimeInSaoPaulo } from '@/lib/time/sao-paulo';

import ClearZernioSyncConflictsButton from './clear-zernio-sync-conflicts-button';
import ZernioGlobalRemovalButton from './zernio-global-removal-button';

export const dynamic = 'force-dynamic';

type Incident = {
  id: string;
  username_snapshot: string;
  connection_label_snapshot: string | null;
  normalized_identity: string | null;
  retained_zernio_connection_id: string | null;
  retained_zernio_account_id: string | null;
  retained_connection_label_snapshot: string | null;
  removed_zernio_connection_id: string | null;
  removed_zernio_account_id: string | null;
  removed_connection_label_snapshot: string | null;
  canonical_rule: string | null;
  retained_profile_id: string | null;
  signal: string;
  state: string;
  defer_reason: string | null;
  occurrence_count: number;
  remote_http_status: number | null;
  remote_result: string | null;
  detected_at: string;
  finalized_at: string | null;
  ignored_item_count: number;
  interrupted_plan_count: number;
  analytics_followers_count_snapshot: number | null;
  analytics_views_snapshot: number | null;
  analytics_posts_count_snapshot: number | null;
  analytics_synced_at_snapshot: string | null;
  analytics_status_snapshot: 'synced' | 'partial' | null;
};

type RecyclingJob = {
  id: string;
  incident_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  deferred_reason: string | null;
  last_outcome: string | null;
  reopened_count: number;
  next_attempt_at: string;
  dead_letter_at: string | null;
  completed_at: string | null;
};

type SyncConflict = {
  id: string;
  batch_id: string | null;
  zernio_connection_id: string | null;
  zernio_account_id: string | null;
  instagram_identity: string | null;
  conflict_profile_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
};

function resultLabel(incident: Incident) {
  if (incident.signal === 'duplicate_identity_auto_removed' && incident.remote_result === 'remote_deleted') return 'Removida automaticamente: identidade duplicada na Zernio';
  if (incident.signal === 'duplicate_identity_auto_removed' && incident.state === 'deferred') return 'Duplicidade preservada; remoção automática congelada';
  if (incident.signal === 'duplicate_identity_auto_removed' && incident.state === 'retry_scheduled') return 'Nova tentativa de remoção agendada';
  if (incident.signal === 'duplicate_identity_auto_removed' && incident.state === 'dead_letter') return 'Remoção bloqueada após falha terminal ou tentativas esgotadas';
  if (incident.signal === 'duplicate_identity_auto_removed' && incident.state === 'remote_removal_pending') return 'Remoção automática de duplicidade pendente';
  if (incident.remote_result === 'already_disconnected_404') return 'Conta já desconectada — removida localmente (404)';
  if (incident.remote_result === 'remote_deleted') return 'Removida na Zernio com sucesso';
  if (incident.state === 'retry_scheduled') return 'Nova tentativa de remoção agendada';
  if (incident.state === 'dead_letter') return 'Requer revisão manual';
  if (incident.state === 'deferred') return 'Aguardando liberação segura';
  if (incident.state === 'remote_removal_pending') return 'Remoção remota pendente';
  return incident.state;
}

function reasonLabel(reason: string | null | undefined) {
  if (reason === 'automatic_removal_frozen') return 'Remoções automáticas congeladas';
  if (reason === 'active_publication') return 'Publicação ativa no perfil preservado';
  if (reason === 'retryable_error') return 'Falha transitória na Zernio';
  if (reason === 'max_attempts_exhausted') return 'Limite de tentativas esgotado';
  if (reason === 'terminal_error') return 'Falha terminal na Zernio';
  return reason ?? 'Sem bloqueio informado';
}

function canonicalRuleLabel(rule: string | null) {
  if (rule === 'existing_local_profile_same_organization') return 'Preservar o perfil local canônico já vinculado nesta organização';
  return rule ?? 'Regra canônica não registrada';
}

function rowPresentation(incident: Incident) {
  if (incident.state === 'dead_letter') return { row: 'operation-row-critical', dot: 'status-dot-negative' };
  if (incident.state === 'deferred' || incident.state === 'retry_scheduled') return { row: 'operation-row-warning', dot: 'status-dot-warning' };
  if (incident.state === 'remote_removal_pending') return { row: 'operation-row-info', dot: 'status-dot-neutral' };
  return { row: '', dot: 'status-dot-positive' };
}

function formatMetric(value: number) {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export default async function ZernioDisconnectionsPage() {
  const context = await getOrganizationContext();
  if (!context.user) redirect('/login');
  if (!context.activeOrganization) redirect('/onboarding');
  const activeOrganization = context.activeOrganization;

  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  const [{ data, error }, { data: conflictLogData, error: conflictLogError }] = await Promise.all([supabase
    .from('zernio_profile_disconnection_incidents')
    .select('id, username_snapshot, connection_label_snapshot, normalized_identity, retained_profile_id, retained_zernio_connection_id, retained_zernio_account_id, retained_connection_label_snapshot, removed_zernio_connection_id, removed_zernio_account_id, removed_connection_label_snapshot, canonical_rule, signal, state, defer_reason, occurrence_count, remote_http_status, remote_result, detected_at, finalized_at, ignored_item_count, interrupted_plan_count, analytics_followers_count_snapshot, analytics_views_snapshot, analytics_posts_count_snapshot, analytics_synced_at_snapshot, analytics_status_snapshot')
    .eq('organization_id', activeOrganization.id)
    .order('detected_at', { ascending: false })
    .limit(100),
  admin.from('zernio_sync_log_items')
    .select('id, batch_id, zernio_connection_id, zernio_account_id, instagram_identity, conflict_profile_id, error_code, error_message, created_at')
    .eq('organization_id', activeOrganization.id)
    .eq('status', 'conflict')
    .order('created_at', { ascending: false })
    .limit(500)]);
  if (error) throw new Error('Não foi possível carregar as quedas Zernio.');
  if (conflictLogError) throw new Error('Não foi possível carregar os conflitos de sincronização Zernio.');
  const incidents = (data ?? []) as Incident[];
  const rawSyncConflicts = (conflictLogData ?? []) as SyncConflict[];
  const resolvedIdentities = new Set(incidents
    .filter((incident) => incident.state === 'completed' && ['remote_deleted', 'already_disconnected_404'].includes(incident.remote_result ?? ''))
    .map((incident) => incident.normalized_identity?.toLocaleLowerCase('en-US'))
    .filter((identity): identity is string => Boolean(identity)));
  const syncConflictOccurrences = new Map<string, number>();
  const syncConflicts = rawSyncConflicts.filter((conflict) => {
    if (!conflict.zernio_account_id || !conflict.instagram_identity) return false;
    if (resolvedIdentities.has(conflict.instagram_identity.toLocaleLowerCase('en-US'))) return false;
    const key = `${conflict.zernio_connection_id ?? 'none'}:${conflict.zernio_account_id ?? conflict.instagram_identity ?? conflict.id}`;
    const count = syncConflictOccurrences.get(key) ?? 0;
    syncConflictOccurrences.set(key, count + 1);
    return count === 0;
  });
  const conflictConnectionIds = [...new Set(syncConflicts.map((conflict) => conflict.zernio_connection_id).filter((id): id is string => Boolean(id)))];
  const conflictProfileIds = [...new Set(syncConflicts.map((conflict) => conflict.conflict_profile_id).filter((id): id is string => Boolean(id)))];
  const [{ data: conflictConnections }, { data: conflictProfiles }] = await Promise.all([
    conflictConnectionIds.length ? admin.from('zernio_connections').select('id, label').in('id', conflictConnectionIds) : Promise.resolve({ data: [] }),
    conflictProfileIds.length ? admin.from('instagram_profiles').select('id, username, zernio_account_id, zernio_connection_id, organization_id, deleted_at').in('id', conflictProfileIds) : Promise.resolve({ data: [] }),
  ]);
  const connectionLabelById = new Map((conflictConnections ?? []).map((connection) => [connection.id, connection.label]));
  const conflictProfileById = new Map((conflictProfiles ?? []).map((profile) => [profile.id, profile]));
  const incidentIds = incidents.map((incident) => incident.id);
  const { data: jobsData, error: jobsError } = incidentIds.length
    ? await supabase
      .from('zernio_profile_recycling_jobs')
      .select('id, incident_id, status, attempt_count, max_attempts, deferred_reason, last_outcome, reopened_count, next_attempt_at, dead_letter_at, completed_at')
      .in('incident_id', incidentIds)
    : { data: [], error: null };
  if (jobsError) throw new Error('Não foi possível carregar o estado das remoções Zernio.');
  const jobsByIncident = new Map(((jobsData ?? []) as RecyclingJob[]).map((job) => [job.incident_id, job]));
  const completed = incidents.filter((incident) => incident.state === 'completed').length;
  const alreadyDisconnected = incidents.filter((incident) => incident.remote_result === 'already_disconnected_404').length;
  const waiting = incidents.filter((incident) => ['deferred', 'remote_removal_pending', 'retry_scheduled'].includes(incident.state)).length;
  const deadLetter = incidents.filter((incident) => incident.state === 'dead_letter').length;

  return <main className="standalone-page operation-page">
    <header className="standalone-header operation-hero">
      <div><span className="section-kicker">{activeOrganization.name} · Operação</span><h1>Quedas Zernio</h1><p>Histórico auditável de quedas, duplicidades, adiamentos e remoções. Não são falhas da fila de publicações.</p></div>
      <div className="operation-header-actions"><Link className="button button-secondary" href="/operacao">Voltar à operação</Link><Link className="button button-primary" href="/zernio">Cadastrar perfil na Zernio</Link></div>
    </header>
    <section className="operation-metrics"><article className={`metric-card${syncConflicts.length > 0 ? ' operation-metric-danger' : ''}`}><span className="metric-label">Conflitos de sincronização</span><strong>{syncConflicts.length}</strong><small className="metric-caption">Ocorrências atuais por chave/conta</small></article><article className="metric-card"><span className="metric-label">Aguardando ação segura</span><strong>{waiting}</strong></article><article className={`metric-card${deadLetter > 0 ? ' operation-metric-danger' : ''}`}><span className="metric-label">Revisão manual</span><strong>{deadLetter}</strong><small className="metric-caption">Dead-letter</small></article><article className="metric-card"><span className="metric-label">Concluídas / 404</span><strong>{completed} / {alreadyDisconnected}</strong></article></section>
    <section className="panel operation-events-panel">
      <div className="panel-heading"><div><span className="section-kicker">Conflitos encontrados pelo worker</span><h2>Conflitos de sincronização</h2><p>Esta lista vem diretamente do resultado que alimenta o contador da Sincronia de contas. Nenhum conflito fica escondido por não ter virado incidente de remoção.</p></div><ClearZernioSyncConflictsButton count={syncConflicts.length} /><span className="queue-count">{syncConflicts.length}</span></div>
      <div className="operation-list operation-issue-list">{syncConflicts.length === 0 ? <div className="operation-empty"><strong>Nenhum conflito de sincronização</strong><p>O último inventário não encontrou contas disputando identidade ou vínculo entre chaves.</p></div> : syncConflicts.map((conflict) => {
        const retained = conflict.conflict_profile_id ? conflictProfileById.get(conflict.conflict_profile_id) : null;
        const occurrenceKey = `${conflict.zernio_connection_id ?? 'none'}:${conflict.zernio_account_id ?? conflict.instagram_identity ?? conflict.id}`;
        const occurrences = syncConflictOccurrences.get(occurrenceKey) ?? 1;
        const crossOrganization = Boolean(retained && retained.organization_id !== activeOrganization.id);
        const conflictType = crossOrganization
          ? 'Identidade vinculada a outra empresa'
          : conflict.error_message?.includes('accountId')
            ? 'Account ID vinculado a outra chave Zernio'
            : 'Mesmo Instagram vinculado a outra chave Zernio';
        return <article className="operation-row operation-row-critical" key={conflict.id}>
          <span className="status-dot status-dot-negative" />
          <div className="zernio-incident-content">
            <strong>@{conflict.instagram_identity ?? retained?.username ?? 'identidade não informada'}</strong>
            <div className="operation-row-meta"><span className="queue-provider-badge queue-provider-zernio">CONFLITO NÃO RESOLVIDO</span><span>{conflictType}</span><span>Detectado {formatDateTimeInSaoPaulo(conflict.created_at)}</span></div>
            <div className="zernio-incident-audit-grid">
              <section className="zernio-incident-audit-card zernio-incident-retained"><span>Perfil preservado no Atena</span><strong>@{retained?.username ?? conflict.instagram_identity ?? 'não identificado'}</strong><code>{retained?.zernio_account_id ?? conflict.conflict_profile_id ?? 'Account ID não registrado'}</code></section>
              <section className="zernio-incident-audit-card zernio-incident-removed"><span>Ocorrência conflitante na Zernio</span><strong>{conflict.zernio_connection_id ? connectionLabelById.get(conflict.zernio_connection_id) ?? 'Chave não encontrada' : 'Chave não registrada'}</strong><code>{conflict.zernio_account_id ?? 'Account ID não registrado'}</code></section>
            </div>
            <small>Tipo: {conflictType}</small>
            <small>Motivo técnico: {conflict.error_message ?? 'A reconciliação recusou sobrescrever o perfil canônico.'}</small>
            <small>{occurrences} ocorrência(s) registrada(s) para esta conta/chave · Lote {conflict.batch_id ?? 'adição individual'}</small>
            <small>{crossOrganization ? 'Ação bloqueada: o perfil preservado pertence a outra empresa.' : 'Ação disponível no incidente estruturado correspondente, no relatório abaixo. A remoção revalida as duas chaves antes do DELETE.'}</small>
          </div>
        </article>;
      })}</div>
    </section>
    <section className="panel operation-events-panel">
      <div className="panel-heading"><div><span className="section-kicker">Remoções e quedas</span><h2>Relatório de desconexões</h2><p>Duplicidades mostram separadamente a ocorrência preservada e a excedente. Resposta 404 continua sendo sucesso idempotente.</p></div><span className="queue-count">{incidents.length}</span></div>
      <div className="operation-list operation-issue-list">{incidents.length === 0 ? <div className="operation-empty"><strong>Nenhuma queda Zernio registrada</strong><p>Contas removidas após ACCOUNT_DISCONNECTED, auth_expired ou duplicidade confirmada aparecerão aqui.</p></div> : incidents.map((incident) => {
        const job = jobsByIncident.get(incident.id);
        const presentation = rowPresentation(incident);
        const duplicate = incident.signal === 'duplicate_identity_auto_removed';
        const username = incident.normalized_identity ?? incident.username_snapshot;
        const hasAnalyticsSnapshot = incident.analytics_followers_count_snapshot !== null
          && incident.analytics_views_snapshot !== null
          && incident.analytics_posts_count_snapshot !== null;
        const canRemoveSharedAccount = activeOrganization.role === 'admin'
          && duplicate
          && Boolean(incident.retained_profile_id)
          && Boolean(incident.retained_zernio_account_id)
          && incident.retained_zernio_account_id === incident.removed_zernio_account_id
          && ['deferred', 'retry_scheduled', 'remote_removal_pending'].includes(incident.state);
        return <article className={`operation-row zernio-disconnection-row ${presentation.row}`} key={incident.id}>
          <span className={`status-dot ${presentation.dot}`} />
          <div className="zernio-incident-content">
            <strong>@{username}</strong>
            <div className="operation-row-meta"><span className="queue-provider-badge queue-provider-zernio">{resultLabel(incident)}</span><span>Estado: {incident.state}</span>{incident.remote_http_status && <span>HTTP {incident.remote_http_status}</span>}</div>
            {duplicate && <div className="zernio-incident-audit-grid">
              <section className="zernio-incident-audit-card zernio-incident-retained"><span>Ocorrência preservada</span><strong>{incident.retained_connection_label_snapshot ?? 'Chave canônica indisponível'}</strong><code>{incident.retained_zernio_account_id ?? 'Account ID não registrado'}</code></section>
              <section className="zernio-incident-audit-card zernio-incident-removed"><span>Ocorrência excedente</span><strong>{incident.removed_connection_label_snapshot ?? incident.connection_label_snapshot ?? 'Chave excedente indisponível'}</strong><code>{incident.removed_zernio_account_id ?? 'Account ID não registrado'}</code></section>
            </div>}
            {duplicate && <small>Regra canônica: {canonicalRuleLabel(incident.canonical_rule)}</small>}
            <small>Motivo atual: {reasonLabel(job?.deferred_reason ?? incident.defer_reason)} · Detectado {formatDateTimeInSaoPaulo(incident.detected_at)}{incident.occurrence_count > 1 ? ` · ${incident.occurrence_count} observações` : ''}</small>
            {job && <small>Job: {job.status} · Tentativas {job.attempt_count}/{job.max_attempts} · Reaberturas {job.reopened_count} · Próxima avaliação {formatDateTimeInSaoPaulo(job.next_attempt_at)}</small>}
            <small>{incident.ignored_item_count} publicação(ões) ignorada(s) · {incident.interrupted_plan_count} plano(s) interrompido(s)</small>
          </div>
          <aside className="zernio-disconnection-metrics" aria-label={`Últimas métricas de @${username}`}>
            <span className="zernio-disconnection-metrics-title">Últimas métricas</span>
            {hasAnalyticsSnapshot ? <>
              <dl className="zernio-disconnection-metrics-grid">
                <div><dt>Seguidores</dt><dd>{formatMetric(incident.analytics_followers_count_snapshot!)}</dd></div>
                <div><dt>Visualizações</dt><dd>{formatMetric(incident.analytics_views_snapshot!)}</dd></div>
                <div><dt>Posts</dt><dd>{formatMetric(incident.analytics_posts_count_snapshot!)}</dd></div>
              </dl>
              <small>{incident.analytics_status_snapshot === 'partial' ? 'Coleta parcial' : 'Coletadas'} em {formatDateTimeInSaoPaulo(incident.analytics_synced_at_snapshot!)}</small>
            </> : <small className="zernio-disconnection-metrics-empty">Sem métricas registradas antes da queda.</small>}
          </aside>
          {(canRemoveSharedAccount || incident.remote_result === 'already_disconnected_404') && <div className="operation-row-actions">
            {canRemoveSharedAccount && <ZernioGlobalRemovalButton incidentId={incident.id} username={username} accountId={incident.retained_zernio_account_id!} retainedConnectionLabel={incident.retained_connection_label_snapshot ?? 'chave preservada'} removedConnectionLabel={incident.removed_connection_label_snapshot ?? incident.connection_label_snapshot ?? 'chave excedente'} />}
            {incident.remote_result === 'already_disconnected_404' && <Link className="row-link" href="/zernio">Testar novo perfil</Link>}
          </div>}
        </article>;
      })}</div>
    </section>
  </main>;
}

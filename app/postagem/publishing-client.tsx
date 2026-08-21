'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { BulkPlanProgressFeed } from '@/app/components/bulk-plan-progress-list';
import { formatSaoPauloDateTime, ScheduledCountsByFormat, ScheduledSlotsByFormat } from '@/lib/publications/composer';
import { ProfilePublicationMetrics } from '@/lib/publications/composer';
import BulkPublishingClient from './bulk-publishing-client';
import GroupComposer, { GroupRunMode, PublicationDraftItem } from './group-composer-next';

type Organization = {
  id: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
};

type Profile = {
  id: string;
  username: string;
  display_name: string | null;
  profile_picture_url?: string | null;
  status: 'no_data' | 'online' | 'offline' | 'reauthorization_required';
  provider: IntegrationProvider;
  zernio_account_id: string | null;
  zernio_connection_id: string | null;
  zernio_connection_label?: string | null;
  scheduled_post_count: number;
  scheduled_by_time: Record<string, number>;
  scheduled_by_format_and_time: ScheduledCountsByFormat;
  scheduled_execute_ats?: string[];
  scheduled_execute_ats_by_format?: ScheduledSlotsByFormat;
  publication_metrics?: ProfilePublicationMetrics;
};

type Group = {
  id: string;
  name: string;
  description: string | null;
  consumption_mode: 'single_use' | 'reusable';
  default_caption: string | null;
  profile_group_members: Array<{ profile_id: string }> | null;
};

type Asset = {
  id: string;
  original_name: string;
  mime_type: string;
  kind: 'image' | 'video';
  size_bytes: number;
  signed_url: string | null;
  thumbnail_url?: string | null;
  publication_state?: {
    scheduled_count: number;
    next_scheduled_at: string | null;
    has_published: boolean;
  } | null;
};

type Assignment = { media_asset_id: string; group_id: string };

type IntegrationProvider = 'meta_official' | 'zernio';

type DispatchResponse = { started?: boolean; claimed?: number; error?: string; mode?: 'vps_worker_primary' | 'scheduled_queue' };

type GenerationJobResponse = {
  id?: string;
  status?: string;
  expected_items?: number | null;
};

type PublicationGenerationJob = {
  id: string;
  name: string | null;
  status: string;
  scheduled_for: string | null;
  expected_items: number | null;
  generated_items: number;
  failed_items: number;
  chunk_size: number;
  chunk_count: number;
  attempt_count: number;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  metadata?: Record<string, unknown> | null;
};

type PublicationCreateResponse = {
  batch?: unknown;
  generationJob?: GenerationJobResponse;
  async?: boolean;
  acceptedItems?: number;
  error?: string;
  dispatch?: DispatchResponse;
};

type Batch = unknown;

const formats: Array<{ value: PublicationDraftItem['format']; label: string; help: string }> = [
  { value: 'image', label: 'Imagem', help: 'Uma imagem no feed.' },
  { value: 'reel', label: 'Reel', help: 'Um vídeo vertical.' },
  { value: 'story', label: 'Story', help: 'Uma imagem ou vídeo para Stories.' },
  { value: 'carousel', label: 'Carrossel', help: 'De 2 a 10 mídias ordenadas.' },
];

function formatDate(value: string | null) {
  return formatSaoPauloDateTime(value);
}

function formatProfileMetrics(profile: Profile) {
  const metrics = profile.publication_metrics;
  if (!metrics) return `${profile.scheduled_post_count} agendada(s)`;
  return `Ag R${metrics.scheduled.reel} S${metrics.scheduled.story} I${metrics.scheduled.image} C${metrics.scheduled.carousel} · Pub R${metrics.published.reel} S${metrics.published.story} I${metrics.published.image} C${metrics.published.carousel}`;
}

export default function PublishingClient({
  activeOrganization,
  profiles,
  assets,
  batches: initialBatches,
  groups,
  assignments,
  bulkPublishingEnabled,
}: {
  activeOrganization: Organization;
  profiles: Profile[];
  assets: Asset[];
  batches: Batch[];
  groups: Group[];
  assignments: Assignment[];
  bulkPublishingEnabled: boolean;
}) {
  const canManage = ['admin', 'operator'].includes(activeOrganization.role);
  const [profileId, setProfileId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [scheduleMode, setScheduleMode] = useState<'immediate' | 'scheduled' | 'bulk'>('immediate');
  const [batchName, setBatchName] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [composerAssets] = useState(assets);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [groupDraftItems, setGroupDraftItems] = useState<PublicationDraftItem[]>([]);
  const [singleProfileDraftItems, setSingleProfileDraftItems] = useState<PublicationDraftItem[]>([]);
  const [bulkDraftDirty, setBulkDraftDirty] = useState(false);

  const selectedGroup = groups.find((group) => group.id === groupId);
  const selectedProfile = profiles.find((profile) => profile.id === profileId);
  const selectedProfileGroup = selectedProfile
    ? groups.find((group) => (group.profile_group_members ?? []).some((member) => member.profile_id === selectedProfile.id))
    : undefined;
  const hasTarget = Boolean(selectedGroup || selectedProfile);
  const runMode: GroupRunMode = scheduleMode === 'scheduled' ? 'scheduled' : 'immediate';
  const singleProfileScheduleRange = singleProfileDraftItems
    .map((item) => item.executeAt)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  const invalidSingleProfileScheduleCount = scheduleMode === 'scheduled'
    ? singleProfileDraftItems.filter((item) => {
      const executeAt = item.executeAt;
      const conflicts = executeAt && selectedProfile?.scheduled_execute_ats?.some((value) => new Date(value).getTime() >= new Date(executeAt).getTime() && new Date(value).getTime() < new Date(executeAt).getTime() + 60_000);
      return item.scheduleTime ? false : !executeAt || new Date(executeAt).getTime() <= Date.now() || conflicts;
    }).length
    : 0;
  const scheduledGroupItems = groupDraftItems.filter((item) => Boolean(item.executeAt || item.scheduleTime));
  const groupScheduleRange = scheduledGroupItems
    .map((item) => item.executeAt)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  const invalidGroupScheduleCount = scheduleMode === 'scheduled'
    ? groupDraftItems.filter((item) => {
      const profile = profiles.find((candidate) => candidate.id === item.profileId);
      const executeAt = item.executeAt;
      const conflicts = executeAt && profile?.scheduled_execute_ats?.some((value) => new Date(value).getTime() >= new Date(executeAt).getTime() && new Date(value).getTime() < new Date(executeAt).getTime() + 60_000);
      return item.scheduleTime ? false : !item.executeAt || new Date(item.executeAt).getTime() <= Date.now() || conflicts;
    }).length
    : 0;

  function selectTarget(kind: 'profile' | 'group', value: string) {
    if (kind === 'profile') {
      setProfileId(value);
      setGroupId('');
      setSingleProfileDraftItems([]);
      return;
    }

    setGroupId(value);
    setProfileId('');
    setGroupDraftItems([]);
    const group = groups.find((item) => item.id === value);
  }

  function changeScheduleMode(nextMode: 'immediate' | 'scheduled' | 'bulk') {
    if (nextMode === scheduleMode) return;
    const traditionalDirty = Boolean(profileId || groupId || batchName.trim() || groupDraftItems.length || singleProfileDraftItems.length);
    const currentDirty = scheduleMode === 'bulk' ? bulkDraftDirty : traditionalDirty;
    if (currentDirty && !window.confirm('Trocar o modo de publicação? O rascunho atual será preservado para quando você voltar.')) return;
    setScheduleMode(nextMode);
    setMessage('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');

    if (saving) return;

    if (!profileId && !groupId) {
      setMessage('Selecione um perfil ou grupo de destino.');
      return;
    }

    const plannedItems = groupId ? groupDraftItems : singleProfileDraftItems;

    if (plannedItems.length === 0 || plannedItems.some((item) => !item.mediaIds.length)) {
      setMessage('Selecione uma mídia para a publicação.');
      return;
    }

    if ((groupId && invalidGroupScheduleCount > 0) || (!groupId && invalidSingleProfileScheduleCount > 0)) {
      setMessage('Todas as postagens desta run programada precisam de um horário futuro válido.');
      return;
    }

    if (!reviewed) {
      setMessage('Confirme a revisão antes de colocar a publicação na fila.');
      return;
    }

    setSaving(true);
    try {
      // A prévia recorrente usa o horário-base exato para mostrar a ordem das
      // ocorrências. No envio, ele vira uma referência de data para que a RPC
      // reserve um minuto aleatório dentro da respectiva janela de dez minutos.
      // Datas únicas continuam enviadas literalmente em `executeAt`.
      const itemsForQueue = plannedItems.map((item) => item.scheduleTime
        ? { ...item, scheduleBaseAt: item.executeAt, executeAt: null }
        : item);
      const response = await fetch('/api/publications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: batchName,
          scheduledFor: null,
          items: itemsForQueue,
        }),
      });
      const payload = await response.json() as PublicationCreateResponse;

      if (!response.ok || (!payload.batch && !payload.generationJob)) {
        setMessage(payload.error ?? 'Não foi possível criar a publicação.');
        return;
      }

      if (payload.generationJob) {
        const expectedItems = payload.acceptedItems ?? payload.generationJob.expected_items ?? itemsForQueue.length;
        setProfileId('');
        setGroupId('');
        setGroupDraftItems([]);
        setSingleProfileDraftItems([]);
        setScheduleMode('immediate');
        setBatchName('');
        setReviewed(false);
        setMessage(`Agendamento grande enviado para processamento. Job criado com ${expectedItems.toLocaleString('pt-BR')} publicações. Acompanhe em /queue.`);
        return;
      }

      setProfileId('');
      setGroupId('');
      setGroupDraftItems([]);
      setSingleProfileDraftItems([]);
      setScheduleMode('immediate');
      setBatchName('');
      setReviewed(false);
      setMessage(payload.dispatch?.mode === 'vps_worker_primary'
        ? 'Publicação enviada para a fila da VPS. Acompanhe em /queue.'
        : payload.dispatch?.started ? 'Publicação iniciada. Acompanhe em /queue.' : payload.dispatch?.error ?? 'Publicação adicionada à fila. Acompanhe em /queue.');
    } catch {
      setMessage('Não foi possível conectar ao servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="standalone-page publishing-page">
      <header className="standalone-header">
        <div>
          <span className="section-kicker">{activeOrganization.name} · Fila de publicação</span>
          <h1>Nova postagem</h1>
          <p>Monte, revise e envie uma publicação para a mesma fila usada pelos agendamentos.</p>
        </div>
      </header>

      {message && <p className={`inline-message ${message === 'Publicação iniciada.' ? 'inline-message-success' : ''}`} role="status">{message}</p>}

      {!canManage && <p className="inline-message" role="alert">Seu papel permite acompanhar a fila, mas não criar publicações.</p>}

      <div className={`publishing-workspace ${scheduleMode === 'bulk' ? 'publishing-workspace-bulk' : ''}`}>
        <fieldset className={`panel publishing-mode-picker schedule-picker ${scheduleMode === 'bulk' ? 'publishing-mode-picker-bulk' : ''}`} disabled={!canManage}>
          <legend>Modo de publicação</legend>
          <div className="schedule-segmented" role="radiogroup" aria-label="Modo de publicação">
            <label className={scheduleMode === 'immediate' ? 'schedule-segment-active' : ''}>
              <input type="radio" name="scheduleMode" value="immediate" checked={scheduleMode === 'immediate'} onChange={() => changeScheduleMode('immediate')} />
              <span>Agora</span>
            </label>
            <label className={scheduleMode === 'scheduled' ? 'schedule-segment-active' : ''}>
              <input type="radio" name="scheduleMode" value="scheduled" checked={scheduleMode === 'scheduled'} onChange={() => changeScheduleMode('scheduled')} />
              <span>Programar</span>
            </label>
            {bulkPublishingEnabled && <label className={scheduleMode === 'bulk' ? 'schedule-segment-active' : ''}>
              <input type="radio" name="scheduleMode" value="bulk" checked={scheduleMode === 'bulk'} onChange={() => changeScheduleMode('bulk')} />
              <span>Programar em massa</span>
            </label>}
          </div>
          <p className="muted-text">{scheduleMode === 'bulk' ? 'Crie uma rotação compacta para vários perfis online sem expandir publicações no navegador.' : scheduleMode === 'scheduled' ? 'Defina data única ou horários recorrentes no card do perfil.' : 'Envie publicações para execução imediata.'}</p>
        </fieldset>

        <div className="publishing-layout" hidden={scheduleMode === 'bulk'}>
        <form className="panel publishing-form" onSubmit={submit}>
          <div className="panel-heading">
            <div><span className="section-kicker">Compositor</span><h2>Defina o destino e o conteúdo</h2></div>
          </div>

          <div className="form-grid publishing-basics">
            <label>Destino<select required value={profileId ? `profile:${profileId}` : groupId ? `group:${groupId}` : ''} onChange={(event) => { const [kind, value] = event.target.value.split(':'); if ((kind === 'profile' || kind === 'group') && value) selectTarget(kind, value); }} disabled={!canManage}><option value="">Selecione um perfil ou grupo</option>{groups.length > 0 && <optgroup label="Grupos">{groups.map((group) => <option key={group.id} value={`group:${group.id}`}>{group.name} · {(group.profile_group_members ?? []).length} perfil(is)</option>)}</optgroup>}<optgroup label="Perfis">{profiles.map((profile) => <option key={profile.id} value={`profile:${profile.id}`}>@{profile.username}{profile.display_name ? ` · ${profile.display_name}` : ''} · {formatProfileMetrics(profile)}</option>)}</optgroup></select></label>
            <label>Nome interno (opcional)<input maxLength={160} value={batchName} onChange={(event) => setBatchName(event.target.value)} disabled={!canManage} placeholder="Ex.: campanha de sexta" /></label>
          </div>

          {!hasTarget ? <div className="publishing-target-empty"><strong>Selecione um destino para continuar</strong><span>Depois de escolher um perfil ou grupo, você poderá definir formato, mídia, legenda e horário.</span></div> : selectedGroup ? <GroupComposer group={selectedGroup} groups={groups} profiles={profiles} assets={composerAssets} assignments={assignments} disabled={!canManage} runMode={runMode} onChange={setGroupDraftItems} /> : selectedProfile ? <GroupComposer group={selectedProfileGroup ?? { id: `single:${selectedProfile.id}`, name: selectedProfile.username, consumption_mode: 'reusable', default_caption: null, profile_group_members: [{ profile_id: selectedProfile.id }] }} groups={groups} profiles={profiles} assets={composerAssets} assignments={assignments} disabled={!canManage} runMode={runMode} onChange={setSingleProfileDraftItems} singleProfile={selectedProfile} submissionGroupId={null} /> : null}

          {hasTarget && <><label className="review-check"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} disabled={!canManage} /><span>Revisei perfil, formato, mídia, legenda e horário antes de confirmar.</span></label>
          <button className={`button button-secondary ${saving ? 'button-saving' : ''}`} type="submit" disabled={!canManage || saving || (!selectedGroup && invalidSingleProfileScheduleCount > 0)} aria-busy={saving}>{saving ? 'Adicionando à fila…' : scheduleMode === 'immediate' ? 'Adicionar à fila imediata' : 'Agendar publicações'}</button></>}
        </form>

        {hasTarget && <aside className="panel publication-preview">
          <span className="section-kicker">Revisão</span>
          <h2>{batchName || 'Publicação sem nome'}</h2>
          <dl className="summary-list">
            <div><dt>Destino</dt><dd>{selectedProfile ? `@${selectedProfile.username}` : selectedGroup ? `${selectedGroup.name} · ${(selectedGroup.profile_group_members ?? []).length} perfis` : 'Não selecionado'}</dd></div>
            <div><dt>Formato</dt><dd>{selectedGroup ? 'Individual por perfil' : singleProfileDraftItems[0]?.format ? formats.find((option) => option.value === singleProfileDraftItems[0]?.format)?.label : 'Não definido'}</dd></div>
            <div><dt>Mídias</dt><dd>{selectedGroup ? `${groupDraftItems.length} postagem(ns)` : `${singleProfileDraftItems.length} postagem(ns)`}</dd></div>
            <div><dt>Execução</dt><dd>{selectedGroup ? scheduleMode === 'immediate' ? `${groupDraftItems.length} publicação(ns) imediata(s)` : invalidGroupScheduleCount > 0 ? `${invalidGroupScheduleCount} horário(s) pendente(s)` : groupScheduleRange.length ? `${scheduledGroupItems.length} agendada(s) · ${formatDate(groupScheduleRange[0])}${groupScheduleRange.length > 1 ? ` até ${formatDate(groupScheduleRange.at(-1) ?? null)}` : ''}` : 'Nenhum horário definido' : scheduleMode === 'immediate' ? `${singleProfileDraftItems.length} publicação(ns) imediata(s)` : invalidSingleProfileScheduleCount > 0 ? `${invalidSingleProfileScheduleCount} horário(s) pendente(s)` : singleProfileScheduleRange.length ? `${singleProfileDraftItems.length} agendada(s) · ${formatDate(singleProfileScheduleRange[0])}${singleProfileScheduleRange.length > 1 ? ` até ${formatDate(singleProfileScheduleRange.at(-1) ?? null)}` : ''}` : 'Nenhum horário definido'}</dd></div>
          </dl>
          {!selectedGroup && singleProfileDraftItems[0]?.caption && <p className="preview-caption">{singleProfileDraftItems[0].caption}</p>}
        </aside>}
        </div>

        <div hidden={scheduleMode !== 'bulk'}>
          <BulkPublishingClient
            canManage={canManage}
            profiles={profiles}
            groups={groups}
            onDirtyChange={setBulkDraftDirty}
          />
        </div>
      </div>

      <section className="queue-section publication-queue-cta">
        <div className="panel queue-cta-panel">
          <div>
            <span className="section-kicker">Histórico e operação</span>
            <h2>Fila de publicação agora fica em /queue</h2>
            <p className="queue-heading-description">O compositor continua otimizado para criar postagens. Acompanhe lotes, jobs, falhas, detalhes e ações operacionais na nova tela dedicada.</p>
          </div>
          <Link className="button queue-refresh-button" href="/queue" prefetch={false}>Abrir fila operacional</Link>
        </div>
      </section>
      <BulkPlanProgressFeed location="postagem" />
    </main>
  );
}

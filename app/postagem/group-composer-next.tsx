'use client';

import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildRepeatedPublicationSchedule,
  buildRecurringSchedule,
  captionExceedsMaximumLength,
  captionForIndex,
  captionsFromInput,
  CaptionMode,
  DEFAULT_EXTENDED_POSTING_TIMES,
  DEFAULT_POSTING_TIMES,
  distributeMediaBetweenProfiles,
  formatSaoPauloDateTime,
  formatSaoPauloDateTimeInput,
  formatSaoPauloTime,
  mediaIsCompatible,
  normalizeRecurringRepeatDays,
  normalizeSequenceRepeatCount,
  nextUnusedPostingTime,
  normalizeDailyTimes,
  MAX_PUBLICATION_CAPTION_LENGTH,
  parseSaoPauloDateTimeInput,
  POSTING_TIME_SLOTS,
  projectExactDailySequence,
  ProfilePublicationPlan,
  ProfilePublicationMetrics,
  recurringPublicationSlotCount,
  repeatMediaSequence,
  ScheduledCountsByFormat,
  ScheduledSlotsByFormat,
} from '@/lib/publications/composer';
import type { MouseEvent } from 'react';
import { galleryPageState } from '@/lib/gallery/pagination';
import styles from './publication-composer.module.css';

export type ComposerProfile = {
  id: string;
  username: string;
  display_name: string | null;
  profile_picture_url?: string | null;
  status: string;
  scheduled_post_count?: number;
  scheduled_by_time?: Record<string, number>;
  scheduled_by_format_and_time?: ScheduledCountsByFormat;
  scheduled_execute_ats?: string[];
  scheduled_execute_ats_by_format?: ScheduledSlotsByFormat;
  publication_metrics?: ProfilePublicationMetrics;
};

export type ComposerGroup = {
  id: string;
  name: string;
  consumption_mode: 'single_use' | 'reusable';
  default_caption: string | null;
  profile_group_members: Array<{ profile_id: string }> | null;
};

export type ComposerAsset = {
  id: string;
  original_name: string;
  kind: 'image' | 'video';
  signed_url: string | null;
  thumbnail_url?: string | null;
  publication_state?: {
    scheduled_count: number;
    next_scheduled_at: string | null;
    has_published: boolean;
  } | null;
};

export type Assignment = { media_asset_id: string; group_id: string };

export type PublicationDraftItem = {
  profileId: string;
  groupId?: string;
  format: ProfilePublicationPlan['format'];
  mediaIds: string[];
  caption: string | null;
  executeAt: string | null;
  scheduleTime?: string | null;
};

type BulkConfig = {
  format: 'image' | 'reel' | 'story';
  captions: string;
  captionMode: CaptionMode;
  executeAt: string;
  mode: 'recurring' | 'one_time';
  dailyTimes: string[];
  repeatEnabled: boolean;
  repeatDays: number;
  distribution: 'sequential' | 'random' | 'repeat';
  sequenceRepeatCount: number;
  action: 'append' | 'replace';
};

export type GroupRunMode = 'immediate' | 'scheduled';
type LibraryUsageFilter = 'available' | 'all' | 'scheduled' | 'published';
type ComposerMediaPage = { assets?: ComposerAsset[]; hasMore?: boolean; nextCursor?: string | null; total?: number; error?: string };

const makePlan = (profileId: string, caption: string | null): ProfilePublicationPlan => ({
  profileId,
  format: 'reel',
  mediaIds: [],
  captions: caption ? [caption] : [],
  captionMode: 'shared',
  scheduleMode: 'recurring',
  executeAt: null,
  executeAtByMedia: {},
  dailyTimes: ['12:00'],
  repeatEnabled: false,
  repeatDays: 1,
  repeatExecuteAts: [],
  sequenceExecuteAts: [],
});

function buildPlanRecurringSchedule(profile: ComposerProfile | undefined, plan: ProfilePublicationPlan, mediaIds = plan.mediaIds, extraOccupied: string[] = []) {
  const occupied = [...(profile?.scheduled_execute_ats ?? []), ...extraOccupied];
  if (plan.repeatEnabled) {
    return buildRepeatedPublicationSchedule(mediaIds, new Date(), plan.dailyTimes, plan.repeatDays, occupied).map((item) => item.executeAt);
  }

  return buildRecurringSchedule(mediaIds.length, new Date(), plan.dailyTimes, occupied);
}

function mediaPreview(asset: ComposerAsset) {
  if (asset.kind === 'image' && asset.signed_url) return <img loading="lazy" src={asset.signed_url} alt="" />;
  if (asset.kind === 'video' && asset.thumbnail_url) return <img loading="lazy" src={asset.thumbnail_url} alt={`Miniatura de ${asset.original_name}`} />;
  return asset.kind === 'video' ? '▶' : '▣';
}

function makeDraftItems(
  groupId: string | null,
  runMode: GroupRunMode,
  selectedProfileIds: string[],
  plans: Record<string, ProfilePublicationPlan>,
) {
  return selectedProfileIds.flatMap((profileId): PublicationDraftItem[] => {
    const plan = plans[profileId];
    if (!plan?.mediaIds.length) return [];
    if (plan.scheduleMode === 'one_time' && plan.format !== 'carousel' && plan.mediaIds.length !== 1) return [];

    const exactSequence = runMode === 'scheduled'
      && plan.sequenceExecuteAts?.length === plan.mediaIds.length
      ? plan.sequenceExecuteAts
      : null;
    if (exactSequence) {
      return plan.mediaIds.map((mediaId, index) => ({
        profileId,
        groupId: groupId ?? undefined,
        format: plan.format,
        mediaIds: [mediaId],
        caption: captionForIndex(plan.captions, index, plan.captionMode),
        executeAt: exactSequence[index],
        scheduleTime: null,
      }));
    }

    const repeatEnabled = runMode === 'scheduled' && plan.scheduleMode === 'recurring' && plan.repeatEnabled;
    if (repeatEnabled) {
      const repeatExecuteAts = plan.repeatExecuteAts ?? [];
      if (!repeatExecuteAts.length) return [];

      if (plan.format === 'carousel') {
        if (plan.mediaIds.length < 2) return [];
        return repeatExecuteAts.map((executeAt, index) => ({
          profileId,
          groupId: groupId ?? undefined,
          format: plan.format,
          mediaIds: plan.mediaIds,
          caption: captionForIndex(plan.captions, index, plan.captionMode),
          executeAt,
          scheduleTime: formatSaoPauloTime(executeAt) || null,
        }));
      }

      return repeatExecuteAts.map((executeAt, index) => {
        const mediaId = plan.mediaIds[index % plan.mediaIds.length];
        return {
          profileId,
          groupId: groupId ?? undefined,
          format: plan.format,
          mediaIds: [mediaId],
          caption: captionForIndex(plan.captions, index, plan.captionMode),
          executeAt,
          scheduleTime: formatSaoPauloTime(executeAt) || null,
        };
      });
    }

    if (plan.format === 'carousel') {
      if (plan.mediaIds.length < 2) return [];
      return [{
        profileId,
        groupId: groupId ?? undefined,
        format: plan.format,
        mediaIds: plan.mediaIds,
        caption: captionForIndex(plan.captions, 0, plan.captionMode),
        executeAt: runMode === 'immediate'
          ? null
          : plan.scheduleMode === 'one_time' ? plan.executeAt : plan.executeAtByMedia[plan.mediaIds[0]] ?? null,
        scheduleTime: runMode === 'scheduled' && plan.scheduleMode === 'recurring'
          ? formatSaoPauloTime(plan.executeAtByMedia[plan.mediaIds[0]]) || null
          : null,
      }];
    }

    return plan.mediaIds.map((mediaId, index) => ({
      profileId,
      groupId: groupId ?? undefined,
      format: plan.format,
      mediaIds: [mediaId],
        caption: captionForIndex(plan.captions, index, plan.captionMode),
        executeAt: runMode === 'immediate'
          ? null
          : plan.scheduleMode === 'one_time' ? plan.executeAt : plan.executeAtByMedia[mediaId] ?? null,
        scheduleTime: runMode === 'scheduled' && plan.scheduleMode === 'recurring'
          ? formatSaoPauloTime(plan.executeAtByMedia[mediaId]) || null
        : null,
    }));
  });
}

function MediaCard({
  asset,
  selected,
  disabled,
  onToggle,
}: {
  asset: ComposerAsset;
  selected: boolean;
  disabled: boolean;
  onToggle: (shiftKey: boolean) => void;
}) {
  const draggable = useDraggable({ id: `asset:${asset.id}`, disabled });

  return (
    <article
      ref={draggable.setNodeRef}
      {...draggable.attributes}
      style={{ transform: CSS.Translate.toString(draggable.transform) }}
      className={`${styles.mediaCard} ${selected ? styles.mediaCardSelected : ''} ${disabled ? styles.mediaCardDisabled : ''}`}
      onClick={(event) => !disabled && onToggle(event.shiftKey)}
    >
      <button className={styles.mediaSelect} type="button" onClick={(event) => { event.stopPropagation(); onToggle(event.shiftKey); }} disabled={disabled}>
        {selected ? '✓' : '+'}
      </button>
      <button className={styles.mediaDrag} type="button" {...draggable.listeners} disabled={disabled}>
        <span className={styles.thumb}>{mediaPreview(asset)}</span>
        <span>
          <strong>{asset.original_name}</strong>
          <small>{asset.kind === 'video' ? 'Vídeo' : 'Imagem'}</small>
          {asset.publication_state?.scheduled_count ? <em className={styles.mediaState}>Agendada{asset.publication_state.scheduled_count > 1 ? ` (${asset.publication_state.scheduled_count})` : ''}{asset.publication_state.next_scheduled_at ? ` · ${formatSaoPauloDateTime(asset.publication_state.next_scheduled_at)}` : ''}</em> : asset.publication_state?.has_published ? <em className={styles.mediaState}>Postada</em> : null}
        </span>
      </button>
    </article>
  );
}

function ProfilePlanCard({
  profile,
  plan,
  assets,
  disabled,
  runMode,
  patch,
  remove,
  automatic,
  updateRecurringTimes,
  updateRepeat,
  openRepeatHelp,
  openMediaPicker,
}: {
  profile: ComposerProfile;
  plan: ProfilePublicationPlan;
  assets: Map<string, ComposerAsset>;
  disabled: boolean;
  runMode: GroupRunMode;
  patch: (next: Partial<ProfilePublicationPlan>) => void;
  remove: (assetId: string) => void;
  automatic: () => void;
  updateRecurringTimes: (times: string[]) => void;
  updateRepeat: (enabled: boolean, days?: number) => void;
  openRepeatHelp: () => void;
  openMediaPicker: () => void;
}) {
  const drop = useDroppable({ id: `profile:${profile.id}`, disabled });
  const carouselInvalid = plan.format === 'carousel' && plan.mediaIds.length === 1;
  const isOneTime = plan.scheduleMode === 'one_time';
  const oneTimeCapacityExceeded = plan.format !== 'carousel' && plan.mediaIds.length > 1;
  const oneTimeMinuteConflict = Boolean(plan.executeAt && profile.scheduled_execute_ats?.some((value) => (
    new Date(value).getTime() >= new Date(plan.executeAt!).getTime()
      && new Date(value).getTime() < new Date(plan.executeAt!).getTime() + 60_000
  )));
  const nextTime = nextUnusedPostingTime(plan.dailyTimes);
  const captionTooLong = plan.captions.some(captionExceedsMaximumLength);
  const normalizedRepeatDays = normalizeRecurringRepeatDays(plan.repeatDays);
  const repeatedSlotCount = recurringPublicationSlotCount(plan.dailyTimes, normalizedRepeatDays);
  const schedulePreview = plan.sequenceExecuteAts?.length === plan.mediaIds.length
    ? plan.sequenceExecuteAts
    : plan.repeatEnabled ? plan.repeatExecuteAts : plan.mediaIds.map((id) => plan.executeAtByMedia[id]).filter((value): value is string => Boolean(value));

  return (
    <article className={styles.profileCard}>
      <aside className={styles.identity}>
        {profile.profile_picture_url ? (
          <img className={styles.avatar} src={profile.profile_picture_url} alt="" />
        ) : <span className={styles.avatar}>@</span>}
        <strong>@{profile.username}</strong>
        <small>{profile.display_name ?? 'Perfil selecionado'}</small>
        <div className={styles.profileMetrics} aria-label={`Resumo de publicações de ${profile.username}`}>
          <section className={styles.planMetric}>
            <span>No plano atual</span>
            <strong>{plan.mediaIds.length} {plan.mediaIds.length === 1 ? 'mídia' : 'mídias'}</strong>
          </section>
          <section className={styles.scheduleMetric}>
            <span>Agendadas</span>
            <strong>{profile.publication_metrics?.scheduled.total ?? 0}</strong>
            <small>Reels {profile.publication_metrics?.scheduled.reel ?? 0} · Stories {profile.publication_metrics?.scheduled.story ?? 0} · Imagens {profile.publication_metrics?.scheduled.image ?? 0} · Carrosséis {profile.publication_metrics?.scheduled.carousel ?? 0}</small>
          </section>
          <section className={styles.publishedMetric}>
            <span>Publicadas</span>
            <strong>{profile.publication_metrics?.published.total ?? 0}</strong>
            <small>Reels {profile.publication_metrics?.published.reel ?? 0} · Stories {profile.publication_metrics?.published.story ?? 0} · Imagens {profile.publication_metrics?.published.image ?? 0} · Carrosséis {profile.publication_metrics?.published.carousel ?? 0}</small>
          </section>
        </div>
      </aside>

      <section className={styles.profileContent}>
        <div className={styles.bulkFields}>
          <label className={styles.field}>
            Formato
            <select
              value={plan.format}
              disabled={disabled}
              onChange={(event) => patch({ format: event.target.value as ProfilePublicationPlan['format'] })}
            >
              <option value="image">Imagem</option>
              <option value="reel">Reel</option>
              <option value="story">Story</option>
              <option value="carousel">Carrossel</option>
            </select>
          </label>
          {runMode === 'scheduled' && <label className={styles.field}>
            Agendamento
            <select
              value={plan.scheduleMode}
              disabled={disabled}
              onChange={(event) => patch({
                scheduleMode: event.target.value as ProfilePublicationPlan['scheduleMode'],
                executeAt: null,
              })}
            >
              <option value="recurring">Horários recorrentes por dia</option>
              <option value="one_time" disabled={oneTimeCapacityExceeded}>Data única</option>
            </select>
          </label>}
        </div>

        <div ref={drop.setNodeRef} className={`${styles.dropZone} ${drop.isOver ? styles.dropZoneActive : ''}`} role="button" tabIndex={disabled ? -1 : 0} onClick={() => !disabled && openMediaPicker()} onKeyDown={(event) => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openMediaPicker(); } }}>
          <span className={styles.dropHint}>Arraste mídias ou aplique pela biblioteca.</span>
          {plan.mediaIds.map((id, index) => (
            <span className={styles.assignedMedia} key={id}>
              <span>{assets.get(id) ? mediaPreview(assets.get(id)!) : '▣'}</span>
              <small>{index + 1}</small>
              <button type="button" disabled={disabled} onClick={(event) => { event.stopPropagation(); remove(id); }}>×</button>
            </span>
          ))}
        </div>

        {carouselInvalid && <p className={styles.validation}>Carrossel precisa de pelo menos duas mídias.</p>}
          {runMode === 'scheduled' && isOneTime && oneTimeCapacityExceeded && <p className={styles.validation}>Data única permite somente uma postagem por perfil. Remova as mídias excedentes ou use horários recorrentes.</p>}
          {runMode === 'scheduled' && isOneTime && oneTimeMinuteConflict && <p className={styles.validation}>Já há uma postagem agendada para este horário.</p>}

        {runMode === 'scheduled' && <>
          {isOneTime ? (
          <label className={styles.field}>
            Data e hora
            <input
              type="datetime-local"
              step="60"
              className={oneTimeMinuteConflict ? styles.fieldError : ''}
              disabled={disabled}
              value={formatSaoPauloDateTimeInput(plan.executeAt)}
              onChange={(event) => patch({
                executeAt: event.target.value ? parseSaoPauloDateTimeInput(event.target.value) : null,
              })}
            />
            <small>Uma postagem por perfil. Horários são definidos no fuso de São Paulo.</small>
          </label>
          ) : (
          <>
            <div className={styles.scheduleActions}>
              <button type="button" disabled={disabled} onClick={automatic}>
                Usar 4 horários automáticos ({DEFAULT_POSTING_TIMES.join(' · ')})
              </button>
              <button type="button" disabled={disabled} onClick={() => updateRecurringTimes(DEFAULT_EXTENDED_POSTING_TIMES)}>
                Usar 10 horários automáticos ({DEFAULT_EXTENDED_POSTING_TIMES.join(' · ')})
              </button>
            </div>
            <div className={styles.dailyTimeEditor}>
              <span>Horários recorrentes por dia — primeiro número: formato atual; segundo: todos os formatos</span>
              {plan.dailyTimes.map((time, index) => (
                <label key={`${time}-${index}`}>
                  <select value={time} disabled={disabled} onChange={(event) => updateRecurringTimes(plan.dailyTimes.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}>{POSTING_TIME_SLOTS.map((slot) => { const specific = profile.scheduled_by_format_and_time?.[plan.format][slot] ?? 0; const total = profile.scheduled_by_time?.[slot] ?? 0; return <option key={slot} value={slot}>{`${slot} (${specific})(${total})`}</option>; })}</select>
                  <button type="button" disabled={disabled || plan.dailyTimes.length === 1} onClick={() => updateRecurringTimes(plan.dailyTimes.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                </label>
              ))}
              <button type="button" disabled={disabled || !nextTime} onClick={() => nextTime && updateRecurringTimes([...plan.dailyTimes, nextTime])}>+ Horário</button>
            </div>
            <div className={styles.repeatControls}>
              <label className={styles.repeatCheck}>
                <input type="checkbox" checked={plan.repeatEnabled} disabled={disabled} onChange={(event) => updateRepeat(event.target.checked)} />
                Repetir postagem
              </label>
              <label className={styles.repeatDaysField}>
                <span>Dias</span>
                <input type="number" min="1" max="365" step="1" value={normalizedRepeatDays} disabled={disabled || !plan.repeatEnabled} onChange={(event) => updateRepeat(true, normalizeRecurringRepeatDays(event.target.value))} />
              </label>
              <button type="button" className={styles.infoButton} onClick={openRepeatHelp} aria-label="Como funciona repetir postagem">ⓘ</button>
              {plan.repeatEnabled && <small>{repeatedSlotCount} publicação(ões) planejada(s), repetindo as mídias em ordem circular.</small>}
            </div>
            {plan.mediaIds.length > 0 && <ol className={styles.resolvedSchedule}>
              {plan.repeatEnabled || plan.sequenceExecuteAts?.length === plan.mediaIds.length
                ? schedulePreview.slice(0, 20).map((executeAt, index) => {
                  const mediaIndex = plan.format === 'carousel' ? 0 : index % plan.mediaIds.length;
                  return <li key={`${executeAt}-${index}`}>Postagem {index + 1}: <strong>{formatSaoPauloDateTime(executeAt)}</strong> · mídia {mediaIndex + 1}</li>;
                })
                : plan.mediaIds.map((id, index) => <li key={id}>Postagem {index + 1}: <strong>{plan.executeAtByMedia[id] ? formatSaoPauloDateTime(plan.executeAtByMedia[id]) : 'sem vaga nos próximos 365 dias'}</strong></li>)}
              {(plan.repeatEnabled || plan.sequenceExecuteAts?.length === plan.mediaIds.length) && schedulePreview.length > 20 && <li>+ {schedulePreview.length - 20} publicação(ões) no restante da fila.</li>}
            </ol>}
          </>
          )}
        </>}

        <div className={styles.captionSection}>
          <div className={styles.captionMode} role="radiogroup" aria-label={`Modo de legenda para ${profile.username}`}>
            <label><input type="radio" checked={plan.captionMode === 'shared'} disabled={disabled} onChange={() => patch({ captionMode: 'shared', captions: [plan.captions.join('\n')] })} /> Uma legenda para todas</label>
            <label><input type="radio" checked={plan.captionMode === 'per_post'} disabled={disabled} onChange={() => patch({ captionMode: 'per_post', captions: captionsFromInput(plan.captions.join('\n'), 'per_post') })} /> Uma por postagem</label>
          </div>
          <label className={styles.field}>
          {plan.captionMode === 'shared' ? 'Legenda para todas as postagens' : 'Legendas — uma por linha; serão repetidas quando necessário'}
          <textarea
            disabled={disabled}
            value={plan.captions.join('\n')}
            maxLength={plan.captionMode === 'shared' ? MAX_PUBLICATION_CAPTION_LENGTH : undefined}
            onChange={(event) => patch({ captions: captionsFromInput(event.target.value, plan.captionMode) })}
          />
          <small>{plan.captionMode === 'shared'
            ? `${plan.captions[0]?.length ?? 0}/${MAX_PUBLICATION_CAPTION_LENGTH} caracteres. Quebras de linha e emojis serão preservados.`
            : 'Cada linha é uma legenda separada e pode ter até 2.200 caracteres.'}</small>
          {captionTooLong && <p className={styles.validation}>Cada legenda pode ter no máximo {MAX_PUBLICATION_CAPTION_LENGTH} caracteres.</p>}
        </label>
        </div>
      </section>
    </article>
  );
}

export default function GroupComposerNext({
  group,
  groups,
  profiles,
  assets,
  assignments,
  disabled,
  runMode,
  onChange,
  singleProfile,
  submissionGroupId,
}: {
  group: ComposerGroup;
  groups: ComposerGroup[];
  profiles: ComposerProfile[];
  assets: ComposerAsset[];
  assignments: Assignment[];
  disabled: boolean;
  runMode: GroupRunMode;
  onChange: (items: PublicationDraftItem[]) => void;
  /** Reutiliza o mesmo card de grupo para um único perfil de destino. */
  singleProfile?: ComposerProfile;
  /** O destino único não deve ser enviado como publicação em grupo. */
  submissionGroupId?: string | null;
}) {
  const members = useMemo(() => {
    if (singleProfile) return [singleProfile];
    const ids = new Set((group.profile_group_members ?? []).map((item) => item.profile_id));
    return profiles.filter((profile) => ids.has(profile.id));
  }, [group.profile_group_members, profiles, singleProfile]);
  const [profileIds, setProfileIds] = useState<string[]>(() => singleProfile ? [singleProfile.id] : []);
  const [plans, setPlans] = useState<Record<string, ProfilePublicationPlan>>({});
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const [librarySelectionAnchorId, setLibrarySelectionAnchorId] = useState<string | null>(null);
  const [destinations, setDestinations] = useState<string[]>([]);
  const [source, setSource] = useState<'group' | 'ungrouped' | 'other'>('group');
  const [sourceGroupId, setSourceGroupId] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [previewingBulk, setPreviewingBulk] = useState(false);
  const [repeatHelpOpen, setRepeatHelpOpen] = useState(false);
  const [mediaPickerProfileId, setMediaPickerProfileId] = useState<string | null>(null);
  const [mediaPickerSelectedIds, setMediaPickerSelectedIds] = useState<string[]>([]);
  const [mediaPickerSelectionAnchorId, setMediaPickerSelectionAnchorId] = useState<string | null>(null);
  const [libraryUsage, setLibraryUsage] = useState<LibraryUsageFilter>('available');
  const [libraryAssets, setLibraryAssets] = useState<ComposerAsset[]>(assets);
  const [knownAssets, setKnownAssets] = useState<ComposerAsset[]>(assets);
  const [libraryCursor, setLibraryCursor] = useState<string | null>(null);
  const [libraryHasMore, setLibraryHasMore] = useState(true);
  const [libraryTotal, setLibraryTotal] = useState(assets.length);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState('');
  const [quantityPickerTarget, setQuantityPickerTarget] = useState<'library' | 'profile' | null>(null);
  const [quantityValue, setQuantityValue] = useState('');
  const [quantityMessage, setQuantityMessage] = useState('');
  const [selectingQuantity, setSelectingQuantity] = useState(false);
  const [showIndividualProfiles, setShowIndividualProfiles] = useState(true);
  const [expandedScheduleProfileIds, setExpandedScheduleProfileIds] = useState<string[]>([]);
  const libraryRequestRef = useRef(0);
  const libraryScrollRef = useRef<HTMLDivElement>(null);
  const librarySentinelRef = useRef<HTMLDivElement>(null);
  const mediaPickerScrollRef = useRef<HTMLDivElement>(null);
  const mediaPickerSentinelRef = useRef<HTMLDivElement>(null);
  const quantityInputRef = useRef<HTMLInputElement>(null);
  const [bulk, setBulk] = useState<BulkConfig>({
    format: 'reel',
    captions: '',
    captionMode: 'shared',
    executeAt: '',
    mode: 'recurring',
    dailyTimes: ['12:00'],
    repeatEnabled: false,
    repeatDays: 1,
    distribution: 'sequential',
    sequenceRepeatCount: 1,
    action: 'replace',
  });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor),
  );

  const assetById = useMemo(() => new Map(knownAssets.map((asset) => [asset.id, asset])), [knownAssets]);

  const activeProfiles = members.filter((profile) => profileIds.includes(profile.id));
  const getPlan = (profileId: string, sourcePlans = plans) => (
    sourcePlans[profileId] ?? makePlan(profileId, group.default_caption)
  );
  const emittedItems = useMemo(
    () => makeDraftItems(submissionGroupId === undefined ? group.id : submissionGroupId, runMode, profileIds, plans),
    [group.id, plans, profileIds, runMode, submissionGroupId],
  );

  useEffect(() => {
    onChange(emittedItems);
  }, [emittedItems, onChange]);

  useEffect(() => {
    setDestinations((current) => current.filter((profileId) => profileIds.includes(profileId)));
  }, [profileIds]);

  useEffect(() => {
    setProfileIds(singleProfile ? [singleProfile.id] : []);
    setPlans({});
    setSelectedMediaIds([]);
    setLibrarySelectionAnchorId(null);
    setDestinations([]);
    setPreviewingBulk(false);
    setRepeatHelpOpen(false);
    setMediaPickerProfileId(null);
    setMediaPickerSelectedIds([]);
    setMediaPickerSelectionAnchorId(null);
  }, [group.id, singleProfile?.id]);

  useEffect(() => {
    const stored = window.localStorage.getItem('publication-composer-show-individual-profiles');
    if (stored !== null) setShowIndividualProfiles(stored !== 'false');
  }, []);

  useEffect(() => {
    if (bulk.distribution !== 'repeat') return;
    if (group.consumption_mode === 'reusable' && runMode === 'scheduled' && bulk.mode === 'recurring') return;
    setBulk((current) => current.distribution === 'repeat' ? { ...current, distribution: 'sequential' } : current);
  }, [bulk.distribution, bulk.mode, group.consumption_mode, runMode]);

  function changeIndividualProfilesVisibility(visible: boolean) {
    setShowIndividualProfiles(visible);
    window.localStorage.setItem('publication-composer-show-individual-profiles', String(visible));
  }

  function change(mutator: (current: Record<string, ProfilePublicationPlan>) => Record<string, ProfilePublicationPlan>) {
    setPlans((current) => mutator(current));
  }

  function patch(profileId: string, next: Partial<ProfilePublicationPlan>) {
    change((current) => ({
      ...current,
      [profileId]: { ...getPlan(profileId, current), ...next },
    }));
  }

  function add(profileId: string, ids: string[], config?: Partial<ProfilePublicationPlan>) {
    if (!profileIds.includes(profileId)) return;
    change((current) => {
      const currentPlan = { ...getPlan(profileId, current), ...config };
      const occupied = new Set(
        group.consumption_mode === 'single_use'
          ? Object.entries(current)
            .filter(([id]) => id !== profileId)
            .flatMap(([, value]) => value.mediaIds)
          : [],
      );
      const valid = ids.filter((id) => {
        const asset = assetById.get(id);
        return asset
          && mediaIsCompatible(currentPlan.format, asset.kind)
          && !occupied.has(id)
          && !currentPlan.mediaIds.includes(id);
      });
      const allowed = currentPlan.scheduleMode === 'one_time' && currentPlan.format !== 'carousel'
        ? valid.slice(0, Math.max(0, 1 - currentPlan.mediaIds.length))
        : valid;
      const mediaIds = currentPlan.format === 'carousel'
        ? [...currentPlan.mediaIds, ...allowed].slice(0, 10)
        : [...currentPlan.mediaIds, ...allowed];
      const profile = members.find((item) => item.id === profileId);
      const schedule = runMode === 'scheduled' && currentPlan.scheduleMode === 'recurring'
        ? buildPlanRecurringSchedule(profile, currentPlan, mediaIds)
        : [];
      return {
        ...current,
        [profileId]: {
          ...currentPlan,
          mediaIds,
          executeAtByMedia: currentPlan.scheduleMode === 'recurring'
            ? Object.fromEntries(mediaIds.map((id, index) => [id, schedule[index] ?? null]))
            : currentPlan.executeAtByMedia,
          repeatExecuteAts: currentPlan.scheduleMode === 'recurring' && currentPlan.repeatEnabled ? schedule : [],
        },
      };
    });
  }

  function resolveRecurringSchedule(profileId: string, times: string[]) {
    const profile = members.find((item) => item.id === profileId);
    const current = getPlan(profileId);
    const dailyTimes = normalizeDailyTimes(times);
    const nextPlan = { ...current, dailyTimes };
    const dates = buildPlanRecurringSchedule(profile, nextPlan);
    patch(profileId, {
      scheduleMode: 'recurring',
      executeAt: null,
      dailyTimes,
      executeAtByMedia: Object.fromEntries(current.mediaIds.map((id, index) => [id, dates[index] ?? null])),
      repeatExecuteAts: current.repeatEnabled ? dates : [],
    });
  }

  function updateProfileRepeat(profileId: string, enabled: boolean, days = getPlan(profileId).repeatDays) {
    const profile = members.find((item) => item.id === profileId);
    const current = getPlan(profileId);
    const repeatDays = normalizeRecurringRepeatDays(days);
    const nextPlan = { ...current, repeatEnabled: enabled, repeatDays };
    const dates = buildPlanRecurringSchedule(profile, nextPlan);
    patch(profileId, {
      scheduleMode: 'recurring',
      executeAt: null,
      repeatEnabled: enabled,
      repeatDays,
      repeatExecuteAts: enabled ? dates : [],
      executeAtByMedia: Object.fromEntries(current.mediaIds.map((id, index) => [id, dates[index] ?? null])),
    });
  }

  function applyAutomaticSchedule(profileId: string) {
    resolveRecurringSchedule(profileId, DEFAULT_POSTING_TIMES);
  }

  const libraryGroupFilter = source === 'group' ? group.id : source === 'ungrouped' ? 'none' : sourceGroupId;
  const visibleAssets = libraryAssets;
  const mediaPickerProfile = mediaPickerProfileId ? members.find((profile) => profile.id === mediaPickerProfileId) ?? null : null;
  const mediaPickerPlan = mediaPickerProfile ? getPlan(mediaPickerProfile.id) : null;
  const mediaPickerAssets = mediaPickerProfile && mediaPickerPlan ? visibleAssets.filter((asset) => {
    if (!mediaIsCompatible(mediaPickerPlan.format, asset.kind)) return false;
    if (mediaPickerPlan.format === 'carousel' && mediaPickerPlan.mediaIds.length >= 10) return false;
    if (mediaPickerPlan.scheduleMode === 'one_time' && mediaPickerPlan.format !== 'carousel' && mediaPickerPlan.mediaIds.length >= 1) return false;
    if (group.consumption_mode !== 'single_use') return true;
    return !Object.entries(plans).some(([profileId, profilePlan]) => profileId !== mediaPickerProfile.id && profilePlan.mediaIds.includes(asset.id));
  }) : [];

  const libraryPageState = galleryPageState({ displayed: visibleAssets.length, total: libraryTotal, hasMore: libraryHasMore, nextCursor: libraryCursor });
  const mediaPickerPageState = galleryPageState({ displayed: mediaPickerAssets.length, total: libraryTotal, hasMore: libraryHasMore, nextCursor: libraryCursor });

  function librarySummary(selectedCount: number, displayedCount: number, state: ReturnType<typeof galleryPageState>) {
    return `${selectedCount} mídia(s) selecionada(s) · exibindo ${displayedCount} de ${state.total} · restam ${state.remaining}`;
  }

  function maybeLoadMoreFromScroll(element: HTMLDivElement) {
    if (libraryLoading || !libraryHasMore || !libraryCursor) return;
    const distanceToEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceToEnd <= 220) void loadLibraryPage(true);
  }

  function libraryUrl(cursor: string | null, usage = libraryUsage) {
    const params = new URLSearchParams({ composer: 'true', limit: '30', usage });
    if (libraryGroupFilter) params.set('group', libraryGroupFilter);
    if (cursor) params.set('cursor', cursor);
    return `/api/media?${params.toString()}`;
  }

  async function loadLibraryPage(append = false, usage = libraryUsage) {
    if (libraryLoading || (append && (!libraryHasMore || !libraryCursor))) return [] as ComposerAsset[];
    setLibraryLoading(true);
    setLibraryError('');
    try {
      const response = await fetch(libraryUrl(append ? libraryCursor : null, usage), { cache: 'no-store' });
      const payload = await response.json() as ComposerMediaPage;
      if (!response.ok || !payload.assets) throw new Error(payload.error ?? 'Não foi possível carregar as mídias.');
      const nextAssets = payload.assets;
      setLibraryAssets((current) => append ? [...current, ...nextAssets.filter((asset) => !current.some((item) => item.id === asset.id))] : nextAssets);
      setKnownAssets((current) => [...current, ...nextAssets.filter((asset) => !current.some((item) => item.id === asset.id))]);
      setLibraryHasMore(Boolean(payload.hasMore));
      setLibraryCursor(payload.nextCursor ?? null);
      setLibraryTotal(payload.total ?? (append ? libraryTotal : nextAssets.length));
      return nextAssets;
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : 'Não foi possível carregar as mídias.');
      return [] as ComposerAsset[];
    } finally {
      setLibraryLoading(false);
    }
  }

  useEffect(() => {
    const requestId = ++libraryRequestRef.current;
    setLibraryAssets([]);
    setLibraryCursor(null);
    setLibraryHasMore(true);
    setLibraryTotal(0);
    setLibraryError('');
    void (async () => {
      setLibraryLoading(true);
      try {
        const response = await fetch(libraryUrl(null), { cache: 'no-store' });
        const payload = await response.json() as ComposerMediaPage;
        if (requestId !== libraryRequestRef.current) return;
        if (!response.ok || !payload.assets) throw new Error(payload.error ?? 'Não foi possível carregar as mídias.');
        setLibraryAssets(payload.assets);
        setKnownAssets((current) => [...current, ...payload.assets!.filter((asset) => !current.some((item) => item.id === asset.id))]);
        setLibraryHasMore(Boolean(payload.hasMore));
        setLibraryCursor(payload.nextCursor ?? null);
        setLibraryTotal(payload.total ?? payload.assets.length);
      } catch (error) {
        if (requestId === libraryRequestRef.current) setLibraryError(error instanceof Error ? error.message : 'Não foi possível carregar as mídias.');
      } finally {
        if (requestId === libraryRequestRef.current) setLibraryLoading(false);
      }
    })();
  // A API é a fonte de verdade: trocar origem ou filtro reinicia o cursor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryGroupFilter, libraryUsage]);

  useEffect(() => {
    if (!libraryHasMore || libraryLoading || !libraryCursor) return;
    const observers: IntersectionObserver[] = [];
    const pairs = [
      { root: libraryScrollRef.current, target: librarySentinelRef.current },
      { root: mediaPickerScrollRef.current, target: mediaPickerSentinelRef.current },
    ];
    pairs.forEach(({ root, target }) => {
      if (!root || !target) return;
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadLibraryPage(true);
      }, { root, rootMargin: '240px' });
      observer.observe(target);
      observers.push(observer);
    });
    return () => observers.forEach((observer) => observer.disconnect());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryCursor, libraryHasMore, libraryLoading, libraryUsage, libraryGroupFilter, mediaPickerProfileId]);

  useEffect(() => {
    if (!quantityPickerTarget) return;
    const timer = window.setTimeout(() => quantityInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [quantityPickerTarget]);

  useEffect(() => {
    if (!quantityPickerTarget) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !selectingQuantity) setQuantityPickerTarget(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [quantityPickerTarget, selectingQuantity]);

  function changeLibraryUsage(nextUsage: LibraryUsageFilter) {
    if (nextUsage === libraryUsage) return;
    setSelectedMediaIds([]);
    setMediaPickerSelectedIds([]);
    setLibrarySelectionAnchorId(null);
    setMediaPickerSelectionAnchorId(null);
    setQuantityPickerTarget(null);
    setQuantityMessage('');
    setLibraryUsage(nextUsage);
  }

  function toggleSelectionRange(
    current: string[],
    orderedAssets: ComposerAsset[],
    assetId: string,
    shiftKey: boolean,
    anchorId: string | null,
  ) {
    if (!shiftKey || !anchorId) {
      return current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId];
    }

    const anchorIndex = orderedAssets.findIndex((asset) => asset.id === anchorId);
    const targetIndex = orderedAssets.findIndex((asset) => asset.id === assetId);
    if (anchorIndex < 0 || targetIndex < 0) {
      return current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId];
    }

    const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
    const rangeIds = orderedAssets.slice(start, end + 1).map((asset) => asset.id);
    return [...new Set([...current, ...rangeIds])];
  }

  function toggleLibrarySelection(assetId: string, shiftKey: boolean) {
    setSelectedMediaIds((current) => toggleSelectionRange(current, visibleAssets, assetId, shiftKey, librarySelectionAnchorId));
    setLibrarySelectionAnchorId(assetId);
  }

  function toggleMediaPickerSelection(assetId: string, shiftKey: boolean) {
    setMediaPickerSelectedIds((current) => toggleSelectionRange(current, mediaPickerAssets, assetId, shiftKey, mediaPickerSelectionAnchorId));
    setMediaPickerSelectionAnchorId(assetId);
  }

  function openQuantityPicker(target: 'library' | 'profile') {
    setQuantityValue('');
    setQuantityMessage('');
    setQuantityPickerTarget(target);
  }

  function closeQuantityPicker() {
    if (selectingQuantity) return;
    setQuantityPickerTarget(null);
    setQuantityMessage('');
  }

  async function selectByQuantity() {
    const amount = Number(quantityValue);
    if (!Number.isSafeInteger(amount) || amount < 1) {
      setQuantityMessage('Informe uma quantidade inteira maior que zero.');
      return;
    }
    if (!quantityPickerTarget || selectingQuantity) return;

    setSelectingQuantity(true);
    setQuantityMessage('Buscando mídias na biblioteca…');
    try {
      let cursor: string | null = null;
      let hasMore = true;
      const selected: ComposerAsset[] = [];
      while (hasMore && selected.length < amount) {
        const response = await fetch(libraryUrl(cursor), { cache: 'no-store' });
        const payload = await response.json() as ComposerMediaPage;
        if (!response.ok || !payload.assets) throw new Error(payload.error ?? 'Não foi possível selecionar as mídias.');
        const eligible = quantityPickerTarget === 'profile' && mediaPickerPlan && mediaPickerProfile
          ? payload.assets.filter((asset) => mediaIsCompatible(mediaPickerPlan.format, asset.kind)
            && !mediaPickerPlan.mediaIds.includes(asset.id)
            && !(mediaPickerPlan.format === 'carousel' && mediaPickerPlan.mediaIds.length >= 10)
            && !(mediaPickerPlan.scheduleMode === 'one_time' && mediaPickerPlan.format !== 'carousel' && mediaPickerPlan.mediaIds.length >= 1)
            && (group.consumption_mode !== 'single_use' || !Object.entries(plans).some(([profileId, plan]) => profileId !== mediaPickerProfile.id && plan.mediaIds.includes(asset.id))))
          : payload.assets;
        selected.push(...eligible.slice(0, amount - selected.length));
        cursor = payload.nextCursor ?? null;
        hasMore = Boolean(payload.hasMore && cursor);
      }
      const ids = selected.map((asset) => asset.id);
      setLibraryAssets((current) => [...current, ...selected.filter((asset) => !current.some((item) => item.id === asset.id))]);
      setKnownAssets((current) => [...current, ...selected.filter((asset) => !current.some((item) => item.id === asset.id))]);
      if (quantityPickerTarget === 'profile') setMediaPickerSelectedIds(ids);
      else setSelectedMediaIds(ids);
      if (quantityPickerTarget === 'profile') setMediaPickerSelectionAnchorId(ids.at(-1) ?? null);
      else setLibrarySelectionAnchorId(ids.at(-1) ?? null);
      setQuantityMessage(ids.length === amount
        ? `${ids.length} mídia(s) selecionada(s).`
        : `Foram encontradas ${ids.length} mídia(s) para esta lista.`);
      window.setTimeout(() => setQuantityPickerTarget(null), 700);
    } catch (error) {
      setQuantityMessage(error instanceof Error ? error.message : 'Não foi possível selecionar as mídias.');
    } finally {
      setSelectingQuantity(false);
    }
  }

  const bulkDistribution = useMemo(
    () => distributeMediaBetweenProfiles(selectedMediaIds, destinations, bulk.distribution),
    [bulk.distribution, destinations, selectedMediaIds],
  );
  const bulkSequenceRepeatCount = normalizeSequenceRepeatCount(bulk.sequenceRepeatCount);
  const bulkPlanDistribution = useMemo(() => new Map([...bulkDistribution.entries()].map(([profileId, mediaIds]) => [
    profileId,
    bulk.distribution === 'repeat' ? repeatMediaSequence(mediaIds, bulkSequenceRepeatCount) : mediaIds,
  ])), [bulk.distribution, bulkDistribution, bulkSequenceRepeatCount]);
  const repeatIsAvailable = group.consumption_mode === 'reusable' && runMode === 'scheduled' && bulk.mode === 'recurring';
  const bulkCount = [...bulkPlanDistribution.values()].filter((ids) => ids.length > 0).length;
  const bulkCompatibleCount = selectedMediaIds.filter((id) => {
    const asset = assetById.get(id);
    return asset && mediaIsCompatible(bulk.format, asset.kind);
  }).length;
  const bulkProjectedPublicationCount = bulk.distribution === 'repeat'
    ? destinations.reduce((total, profileId) => total + bulkCompatibleCount * bulkSequenceRepeatCount
      + (bulk.action === 'append' ? getPlan(profileId).mediaIds.length : 0), 0)
    : [...bulkPlanDistribution.values()].reduce((total, mediaIds) => total + mediaIds.filter((id) => {
      const asset = assetById.get(id);
      return Boolean(asset && mediaIsCompatible(bulk.format, asset.kind));
    }).length, 0);
  const repeatPreviewByProfile = useMemo(() => new Map(destinations.map((profileId) => {
    const profile = members.find((item) => item.id === profileId);
    const selectedSequence = (bulkDistribution.get(profileId) ?? []).filter((id) => {
      const asset = assetById.get(id);
      return Boolean(asset && mediaIsCompatible(bulk.format, asset.kind));
    });
    const previous = getPlan(profileId);
    const incomingMedia = repeatMediaSequence(selectedSequence, bulkSequenceRepeatCount);
    const previousExactSchedule = previous.sequenceExecuteAts?.length === previous.mediaIds.length
      ? previous.sequenceExecuteAts
      : [];
    const projection = projectExactDailySequence({
      media: bulk.action === 'append' ? incomingMedia : selectedSequence,
      repeatCount: bulk.action === 'append' ? 1 : bulkSequenceRepeatCount,
      now: new Date(),
      time: bulk.dailyTimes[0] ?? '',
      occupied: [
        ...(profile?.scheduled_execute_ats ?? []),
        ...previousExactSchedule,
      ],
    });
    const executeAts = bulk.action === 'append' ? [...previousExactSchedule, ...projection.executeAts] : projection.executeAts;
    return [profileId, { media: bulk.action === 'append' ? [...previous.mediaIds, ...incomingMedia] : projection.media, executeAts, firstExecuteAt: executeAts[0] ?? null, lastExecuteAt: executeAts.at(-1) ?? null }] as const;
  })), [assetById, bulk.action, bulk.dailyTimes, bulk.format, bulkDistribution, bulkSequenceRepeatCount, destinations, members, plans]);
  const repeatFirstExecuteAt = [...repeatPreviewByProfile.values()].map((item) => item.firstExecuteAt).filter((value): value is string => Boolean(value)).sort().at(0) ?? null;
  const repeatLastExecuteAt = [...repeatPreviewByProfile.values()].map((item) => item.lastExecuteAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const allDestinationsSelected = activeProfiles.length > 0 && activeProfiles.every((profile) => destinations.includes(profile.id));
  const updateBulkDailyTimes = (times: string[]) => setBulk((current) => ({ ...current, dailyTimes: normalizeDailyTimes(times) }));
  const nextBulkTime = nextUnusedPostingTime(bulk.dailyTimes);
  const bulkCaptionValues = captionsFromInput(bulk.captions, bulk.captionMode);
  const bulkCaptionTooLong = bulkCaptionValues.some(captionExceedsMaximumLength);
  const bulkRepeatDays = normalizeRecurringRepeatDays(bulk.repeatDays);
  const bulkRepeatedSlotCount = recurringPublicationSlotCount(bulk.dailyTimes, bulkRepeatDays);
  const bulkProblems = useMemo(() => [...new Set(activeProfiles.flatMap((profile) => {
    const distributed = bulkPlanDistribution.get(profile.id) ?? [];
    const compatible = distributed.filter((id) => {
      const asset = assetById.get(id);
      return asset && mediaIsCompatible(bulk.format, asset.kind);
    });
    if (!compatible.length) return [];
    const current = getPlan(profile.id);
    if (bulk.action === 'append' && current.mediaIds.length && current.format !== bulk.format) {
      return [`@${profile.username}: o plano existente usa formato ${current.format}; substitua-o ou distribua mídias do mesmo formato.`];
    }
    if (bulk.distribution === 'repeat' && bulk.action === 'append' && current.mediaIds.length
      && current.sequenceExecuteAts?.length !== current.mediaIds.length) {
      return [`@${profile.username}: para adicionar uma sequência, o plano atual precisa já ser uma sequência exata. Use Substituir ou finalize o plano atual.`];
    }
    if (bulk.mode === 'one_time' && compatible.length + (bulk.action === 'append' ? current.mediaIds.length : 0) > 1) {
      return [`@${profile.username}: Data única aceita somente uma postagem por perfil.`];
    }
    if (bulk.distribution === 'repeat' && group.consumption_mode === 'single_use') {
      return ['A distribuição Repetir exige um grupo com mídias reutilizáveis.'];
    }
    return [];
  })), ...(bulkProjectedPublicationCount > 50_000
    ? [`A projeção de ${bulkProjectedPublicationCount.toLocaleString('pt-BR')} publicações excede o limite de 50.000 por envio.`]
    : [])], [activeProfiles, assetById, bulk.action, bulk.format, bulk.mode, bulk.distribution, bulkPlanDistribution, bulkProjectedPublicationCount, group.consumption_mode, plans]);

  function applyBulk() {
    if (!selectedMediaIds.length || !destinations.length) return;
    change((current) => {
      const base = { ...current };
      if (bulk.action === 'replace') {
        destinations.forEach((profileId) => { delete base[profileId]; });
      }

      const used = new Set(
        group.consumption_mode === 'single_use'
          ? Object.entries(base).flatMap(([, profilePlan]) => profilePlan.mediaIds)
          : [],
      );

      bulkPlanDistribution.forEach((ids, profileId) => {
        const previous = bulk.action === 'replace'
          ? makePlan(profileId, group.default_caption)
          : getPlan(profileId, base);
        const compatible = ids.filter((id) => {
          const asset = assetById.get(id);
          return asset
            && mediaIsCompatible(bulk.format, asset.kind)
            && (bulk.distribution === 'repeat' || (!used.has(id) && !previous.mediaIds.includes(id)));
        });
        if (bulk.distribution !== 'repeat') compatible.forEach((id) => used.add(id));
        const allMediaIds = bulk.distribution === 'repeat'
          ? (bulk.action === 'append' ? [...previous.mediaIds, ...compatible] : compatible)
          : [...previous.mediaIds, ...compatible];
        if (!compatible.length) return;
        const profile = members.find((item) => item.id === profileId);
        const existingAssignments = bulk.action === 'append'
          ? Object.values(previous.executeAtByMedia).filter((value): value is string => Boolean(value))
          : [];
        const nextPlan = {
          ...previous,
          dailyTimes: normalizeDailyTimes(bulk.dailyTimes),
          repeatEnabled: bulk.repeatEnabled,
          repeatDays: bulkRepeatDays,
        };
        const newSchedule = runMode === 'scheduled' && bulk.mode === 'recurring' && bulk.distribution !== 'repeat'
          ? buildPlanRecurringSchedule(profile, nextPlan, bulk.repeatEnabled ? allMediaIds : compatible, existingAssignments)
          : [];
        const exactSequenceProjection = runMode === 'scheduled' && bulk.mode === 'recurring' && bulk.distribution === 'repeat' && profile
          ? projectExactDailySequence({ media: compatible, repeatCount: 1, now: new Date(), time: bulk.dailyTimes[0] ?? '', occupied: [
            ...(profile.scheduled_execute_ats ?? []),
            ...(bulk.action === 'append' ? previous.sequenceExecuteAts ?? [] : []),
          ] })
          : null;
        base[profileId] = {
          ...previous,
          format: bulk.format,
            captions: captionsFromInput(bulk.captions, bulk.captionMode),
          captionMode: bulk.captionMode,
          mediaIds: allMediaIds,
          scheduleMode: bulk.mode,
          executeAt: runMode === 'scheduled' && bulk.executeAt ? parseSaoPauloDateTimeInput(bulk.executeAt) : null,
          dailyTimes: normalizeDailyTimes(bulk.dailyTimes),
          repeatEnabled: bulk.mode === 'recurring' && bulk.distribution !== 'repeat' ? bulk.repeatEnabled : false,
          repeatDays: bulkRepeatDays,
          repeatExecuteAts: bulk.mode === 'recurring' && bulk.repeatEnabled ? newSchedule : [],
          sequenceExecuteAts: bulk.action === 'append'
            ? [...(previous.sequenceExecuteAts ?? []), ...(exactSequenceProjection?.executeAts ?? [])]
            : exactSequenceProjection?.executeAts ?? [],
          executeAtByMedia: bulk.mode === 'recurring'
            ? { ...previous.executeAtByMedia, ...Object.fromEntries(compatible.map((id, index) => [id, newSchedule[index] ?? null])) }
            : {},
        };
      });
      return base;
    });
    setSelectedMediaIds([]);
    setLibrarySelectionAnchorId(null);
    setExpandedScheduleProfileIds([]);
    setPreviewingBulk(false);
  }

  function dragEnd(event: DragEndEvent) {
    setDraggingId(null);
    const profileId = event.over ? String(event.over.id).replace('profile:', '') : '';
    const assetId = String(event.active.id).replace('asset:', '');
    if (profileId) add(profileId, selectedMediaIds.includes(assetId) ? selectedMediaIds : [assetId]);
  }

  const dragging = draggingId ? assetById.get(draggingId) : null;
  const bulkReady = selectedMediaIds.length > 0
    && destinations.length > 0
    && bulkCompatibleCount > 0
    && bulkProblems.length === 0
    && !bulkCaptionTooLong
    && (runMode !== 'scheduled' || bulk.mode === 'recurring' || Boolean(parseSaoPauloDateTimeInput(bulk.executeAt)))
    && (bulk.distribution !== 'repeat' || (runMode === 'scheduled' && bulk.mode === 'recurring' && bulk.dailyTimes.length === 1));

  return (
    <section className={styles.composer}>
      {!singleProfile && <section className={styles.profileSelector}>
        <header className={styles.header}>
          <div>
            <span className="section-kicker">1. Perfis do grupo</span>
            <h3>Escolha quem vai publicar</h3>
            <p>As configurações só aparecem para os perfis marcados.</p>
          </div>
          <span>{profileIds.length} de {members.length}</span>
        </header>
        <div className={styles.selectorActions}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setProfileIds(members
              .filter((item) => ['online', 'active'].includes(item.status))
              .map((item) => item.id))}
          >
            Selecionar todos
          </button>
          <button type="button" disabled={disabled} onClick={() => setProfileIds([])}>Limpar</button>
        </div>
        <div className={styles.profileChoiceList}>
          {members.map((profile) => {
            const unavailable = !['online', 'active'].includes(profile.status);
            const selected = profileIds.includes(profile.id);
            return (
              <label key={profile.id} className={`${styles.profileChoice} ${selected ? styles.profileChoiceActive : ''}`}>
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={disabled || unavailable}
                  onChange={() => setProfileIds((current) => current.includes(profile.id)
                    ? current.filter((id) => id !== profile.id)
                    : [...current, profile.id])}
                />
                {profile.profile_picture_url ? <img src={profile.profile_picture_url} alt="" /> : <span className={styles.avatar}>@</span>}
                <span>
                  <strong>@{profile.username}</strong>
                  <small>{unavailable ? 'Perfil indisponível' : profile.display_name ?? 'Perfil do grupo'}</small>
                </span>
              </label>
            );
          })}
        </div>
      </section>}

      {activeProfiles.length > 0 && (
        <>
          <div className={styles.summary}>
            <strong>{group.name}</strong>
            <span>· {activeProfiles.length} perfil(is) selecionado(s)</span>
            <span>· {selectedMediaIds.length} mídia(s) marcada(s)</span>
            <span>· {emittedItems.length} postagem(ns) pronta(s)</span>
            <label className={styles.repeatCheck}>
              <input type="checkbox" checked={showIndividualProfiles} onChange={(event) => changeIndividualProfilesVisibility(event.target.checked)} />
              Exibir perfis individualmente
            </label>
          </div>

          <DndContext
            sensors={sensors}
            onDragStart={(event) => setDraggingId(String(event.active.id).replace('asset:', ''))}
            onDragEnd={dragEnd}
            onDragCancel={() => setDraggingId(null)}
          >
            {showIndividualProfiles ? <section className={styles.profileList}>
              {activeProfiles.map((profile) => (
                <ProfilePlanCard
                  key={profile.id}
                  profile={profile}
                  plan={getPlan(profile.id)}
                  assets={assetById}
                  disabled={disabled}
                  runMode={runMode}
                  patch={(next) => patch(profile.id, next)}
                  remove={(assetId) => patch(profile.id, {
                    mediaIds: getPlan(profile.id).mediaIds.filter((id) => id !== assetId),
                    repeatExecuteAts: getPlan(profile.id).repeatEnabled
                      ? buildPlanRecurringSchedule(profile, getPlan(profile.id), getPlan(profile.id).mediaIds.filter((id) => id !== assetId))
                      : [],
                  })}
                  automatic={() => applyAutomaticSchedule(profile.id)}
                  updateRecurringTimes={(times) => resolveRecurringSchedule(profile.id, times)}
                  updateRepeat={(enabled, days) => updateProfileRepeat(profile.id, enabled, days)}
                  openRepeatHelp={() => setRepeatHelpOpen(true)}
                  openMediaPicker={() => setMediaPickerProfileId(profile.id)}
                />
              ))}
            </section> : <section className={styles.profileList} aria-label="Horários programados por perfil">
              <header className={styles.header}>
                <div><span className="section-kicker">Horários programados</span><h3>Prévia agregada por perfil</h3><p>Os planos continuam ativos; apenas os cards individuais estão ocultos.</p></div>
              </header>
              {activeProfiles.map((profile) => {
                const plan = getPlan(profile.id);
                const schedule = plan.sequenceExecuteAts?.length === plan.mediaIds.length
                  ? plan.sequenceExecuteAts
                  : plan.repeatEnabled ? plan.repeatExecuteAts : plan.mediaIds.map((id) => plan.executeAtByMedia[id]).filter((value): value is string => Boolean(value));
                const expanded = expandedScheduleProfileIds.includes(profile.id);
                const visibleSchedule = expanded ? schedule : schedule.slice(0, 20);
                return <article className={styles.profileCard} key={profile.id}>
                  <aside className={styles.identity}><strong>@{profile.username}</strong><small>{plan.mediaIds.length} publicação(ões) no plano</small></aside>
                  <section className={styles.profileContent}>
                    {schedule.length > 0 && <div className={styles.scheduleOverview}><span>Primeira: <strong>{formatSaoPauloDateTime(schedule[0])}</strong></span><span>Última: <strong>{formatSaoPauloDateTime(schedule.at(-1))}</strong></span></div>}
                    {!schedule.length ? <p className={styles.empty}>Nenhum horário resolvido para este perfil.</p> : <ol className={styles.resolvedSchedule}>
                      {visibleSchedule.map((executeAt, index) => <li key={`${executeAt}-${index}`}>Postagem {index + 1}: <strong>{formatSaoPauloDateTime(executeAt)}</strong> · mídia {(index % Math.max(plan.mediaIds.length, 1)) + 1}</li>)}
                    </ol>}
                    {schedule.length > 20 && <button className={styles.scheduleExpand} type="button" onClick={() => setExpandedScheduleProfileIds((current) => expanded ? current.filter((id) => id !== profile.id) : [...current, profile.id])}>{expanded ? 'Mostrar somente as 20 primeiras' : `Ver as ${schedule.length.toLocaleString('pt-BR')} publicações`}</button>}
                  </section>
                </article>;
              })}
            </section>}

            {!singleProfile && <section className={styles.library}>
              <header className={styles.libraryHeader}>
                <div>
                  <span className="section-kicker">2. Biblioteca de mídias</span>
                  <h3>Selecione, configure e distribua</h3>
                </div>
              </header>

              <section className={styles.bulkPanel}>
                <div className={styles.bulkDestinations}>
                  <div className={styles.bulkDestinationHeader}>
                    <strong>Destinos ({destinations.length})</strong>
                    <button type="button" disabled={disabled || !activeProfiles.length} onClick={() => setDestinations(allDestinationsSelected ? [] : activeProfiles.map((profile) => profile.id))}>{allDestinationsSelected ? 'Limpar destinos' : 'Selecionar todos'}</button>
                  </div>
                  <div className={styles.destinationList}>
                    {activeProfiles.map((profile) => (
                      <label className={styles.destination} key={profile.id}>
                        <input
                          type="checkbox"
                          checked={destinations.includes(profile.id)}
                          disabled={disabled}
                          onChange={() => setDestinations((current) => current.includes(profile.id)
                            ? current.filter((id) => id !== profile.id)
                            : [...current, profile.id])}
                        />
                        {profile.profile_picture_url ? <img src={profile.profile_picture_url} alt="" /> : <span className={styles.destinationAvatar}>@</span>}
                        @{profile.username}
                      </label>
                    ))}
                  </div>
                </div>
                <div className={styles.bulkSettings}>
                  <div className={styles.bulkFields}>
                  <label className={styles.field}>
                    Formato inicial
                    <select value={bulk.format} disabled={disabled} onChange={(event) => setBulk((current) => ({ ...current, format: event.target.value as BulkConfig['format'] }))}>
                      <option value="image">Imagem</option>
                      <option value="reel">Reel</option>
                      <option value="story">Story</option>
                    </select>
                  </label>
                  {runMode === 'scheduled' && <label className={styles.field}>
                    Agendamento
                    <select value={bulk.mode} disabled={disabled} onChange={(event) => setBulk((current) => ({ ...current, mode: event.target.value as BulkConfig['mode'] }))}>
                      <option value="recurring">Horários recorrentes por dia</option>
                      <option value="one_time">Data única</option>
                    </select>
                  </label>}
                  {runMode === 'scheduled' && bulk.mode === 'one_time' && (
                    <label className={styles.field}>
                      Data e hora
                      <input type="datetime-local" step="600" value={bulk.executeAt} disabled={disabled} onChange={(event) => setBulk((current) => ({ ...current, executeAt: event.target.value }))} />
                    </label>
                  )}
                  {runMode === 'scheduled' && bulk.mode === 'recurring' && (
                    <>
                      {bulk.distribution !== 'repeat' && <div className={styles.scheduleActions}>
                        <button type="button" disabled={disabled} onClick={() => updateBulkDailyTimes(DEFAULT_POSTING_TIMES)}>
                          Usar 4 horários automáticos ({DEFAULT_POSTING_TIMES.join(' · ')})
                        </button>
                        <button type="button" disabled={disabled} onClick={() => updateBulkDailyTimes(DEFAULT_EXTENDED_POSTING_TIMES)}>
                          Usar 10 horários automáticos ({DEFAULT_EXTENDED_POSTING_TIMES.join(' · ')})
                        </button>
                      </div>}
                      <div className={styles.dailyTimeEditor}>
                        <span>{bulk.distribution === 'repeat' ? 'Horário diário exato da sequência' : 'Horários recorrentes por dia'}</span>
                        {bulk.dailyTimes.map((time, index) => (
                          <label key={`${time}-${index}`}>
                            <select value={time} disabled={disabled} onChange={(event) => updateBulkDailyTimes(bulk.dailyTimes.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}>{POSTING_TIME_SLOTS.map((slot) => <option key={slot} value={slot}>{slot}</option>)}</select>
                            <button type="button" disabled={disabled || bulk.dailyTimes.length === 1 || bulk.distribution === 'repeat'} onClick={() => updateBulkDailyTimes(bulk.dailyTimes.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                          </label>
                        ))}
                        <button type="button" disabled={disabled || !nextBulkTime || bulk.distribution === 'repeat'} onClick={() => nextBulkTime && updateBulkDailyTimes([...bulk.dailyTimes, nextBulkTime])}>+ Horário</button>
                      </div>
                      {bulk.distribution === 'repeat' ? <div className={styles.repeatControls}>
                        <label className={styles.repeatDaysField}>
                          <span>Repetir a sequência</span>
                          <input type="number" min="1" max="1000" step="1" value={bulkSequenceRepeatCount} disabled={disabled} onChange={(event) => setBulk((current) => ({ ...current, sequenceRepeatCount: normalizeSequenceRepeatCount(event.target.value) }))} />
                        </label>
                        <small>Cada perfil recebe todas as mídias na mesma ordem, {bulkSequenceRepeatCount} vez(es), no horário exato informado.</small>
                      </div> : <div className={styles.repeatControls}>
                        <label className={styles.repeatCheck}>
                          <input type="checkbox" checked={bulk.repeatEnabled} disabled={disabled} onChange={(event) => setBulk((current) => ({ ...current, repeatEnabled: event.target.checked }))} />
                          Repetir postagem
                        </label>
                        <label className={styles.repeatDaysField}>
                          <span>Dias</span>
                          <input type="number" min="1" max="365" step="1" value={bulkRepeatDays} disabled={disabled || !bulk.repeatEnabled} onChange={(event) => setBulk((current) => ({ ...current, repeatEnabled: true, repeatDays: normalizeRecurringRepeatDays(event.target.value) }))} />
                        </label>
                        <button type="button" className={styles.infoButton} onClick={() => setRepeatHelpOpen(true)} aria-label="Como funciona repetir postagem">ⓘ</button>
                        {bulk.repeatEnabled && <small>{bulkRepeatedSlotCount} publicação(ões) por perfil/destino com mídias repetidas em ordem.</small>}
                      </div>
                      }
                    </>
                  )}
                  <label className={styles.field}>
                    Distribuição
                    <select value={bulk.distribution} disabled={disabled} onChange={(event) => setBulk((current) => {
                      const distribution = event.target.value as BulkConfig['distribution'];
                      return { ...current, distribution, dailyTimes: distribution === 'repeat' ? current.dailyTimes.slice(0, 1) : current.dailyTimes };
                    })}>
                      <option value="sequential">Sequencial</option>
                      <option value="random">Aleatória</option>
                      <option value="repeat" disabled={!repeatIsAvailable}>Repetir</option>
                    </select>
                    {bulk.distribution === 'repeat' && <small>{bulkCompatibleCount} mídia(s) × {bulkSequenceRepeatCount} sequência(s) × {destinations.length} perfil(is) = {bulkProjectedPublicationCount.toLocaleString('pt-BR')} publicação(ões).</small>}
                    {!repeatIsAvailable && <small>Repetir exige programação recorrente e grupo com mídias reutilizáveis.</small>}
                  </label>
                  <label className={styles.field}>
                    Ação
                    <select value={bulk.action} disabled={disabled} onChange={(event) => setBulk((current) => ({ ...current, action: event.target.value as BulkConfig['action'] }))}>
                      <option value="replace">Substituir</option>
                      <option value="append">Adicionar ao plano</option>
                    </select>
                  </label>
                  </div>
                  <section className={styles.bulkCaptionSection}>
                    <div className={styles.captionMode} role="radiogroup" aria-label="Modo de legenda da distribuição">
                      <label><input type="radio" checked={bulk.captionMode === 'shared'} disabled={disabled} onChange={() => setBulk((current) => ({ ...current, captionMode: 'shared' }))} /> Uma legenda para todas</label>
                      <label><input type="radio" checked={bulk.captionMode === 'per_post'} disabled={disabled} onChange={() => setBulk((current) => ({ ...current, captionMode: 'per_post' }))} /> Uma por postagem</label>
                    </div>
                    <label className={styles.field}>
                      {bulk.captionMode === 'shared' ? 'Legenda para todas as postagens' : 'Legendas — uma por linha; serão repetidas quando necessário'}
                      <textarea
                        value={bulk.captions}
                        disabled={disabled}
                        maxLength={bulk.captionMode === 'shared' ? MAX_PUBLICATION_CAPTION_LENGTH : undefined}
                        onChange={(event) => setBulk((current) => ({ ...current, captions: event.target.value }))}
                      />
                      <small>{bulk.captionMode === 'shared'
                        ? `${bulk.captions.length}/${MAX_PUBLICATION_CAPTION_LENGTH} caracteres. Quebras de linha e emojis serão preservados.`
                        : 'Cada linha é uma legenda separada e pode ter até 2.200 caracteres.'}</small>
                      {bulkCaptionTooLong && <p className={styles.validation}>Cada legenda pode ter no máximo {MAX_PUBLICATION_CAPTION_LENGTH} caracteres.</p>}
                    </label>
                    <div className={styles.bulkActionRow}>
                      <button className={styles.reviewDistributionButton} type="button" disabled={disabled || !bulkReady} onClick={() => setPreviewingBulk(true)}>
                        Revisar distribuição
                      </button>
                    </div>
                  </section>
                  {bulkProblems.length > 0 && <div className={styles.validation}>{bulkProblems.map((problem) => <p key={problem}>{problem}</p>)}</div>}
                </div>
              </section>

              <div className={styles.toolbar}>
                <span>{librarySummary(selectedMediaIds.length, visibleAssets.length, libraryPageState)}</span>
                <div className={styles.toolbarActions}>
                  <button type="button" disabled={disabled || !visibleAssets.length} onClick={() => { setSelectedMediaIds((current) => [...new Set([...current, ...visibleAssets.map((asset) => asset.id)])]); setLibrarySelectionAnchorId(visibleAssets.at(-1)?.id ?? null); }}>Selecionar visíveis</button>
                  <button type="button" disabled={disabled} onClick={() => openQuantityPicker('library')}>Quantidade</button>
                  <button type="button" disabled={disabled} onClick={() => { setSelectedMediaIds([]); setLibrarySelectionAnchorId(null); }}>Limpar seleção</button>
                </div>
                <div className={styles.libraryFilters}>
                  <label className={styles.field}>
                    Origem
                    <select value={source} disabled={disabled} onChange={(event) => setSource(event.target.value as typeof source)}>
                      <option value="group">Mídias deste grupo</option>
                      <option value="ungrouped">Mídias sem grupo</option>
                      <option value="other">Mídias de outro grupo</option>
                    </select>
                  </label>
                  <label className={styles.field}>
                    Exibir
                    <select value={libraryUsage} disabled={disabled} onChange={(event) => changeLibraryUsage(event.target.value as LibraryUsageFilter)}>
                      <option value="available">Disponíveis</option>
                      <option value="published">Postadas</option>
                      <option value="scheduled">Agendadas</option>
                      <option value="all">Todas as mídias</option>
                    </select>
                  </label>
                  {source === 'other' && <label className={styles.field}>
                    Grupo de origem
                    <select value={sourceGroupId} disabled={disabled} onChange={(event) => setSourceGroupId(event.target.value)}>
                      <option value="">Selecione</option>
                      {groups.filter((item) => item.id !== group.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </label>}
                </div>
              </div>

              {selectedMediaIds.length > bulkCompatibleCount && (
                <p className={styles.validation}>
                  {selectedMediaIds.length - bulkCompatibleCount} mídia(s) não são compatíveis com o formato escolhido e serão ignoradas.
                </p>
              )}

              <div ref={libraryScrollRef} className={styles.gallery} onScroll={(event) => maybeLoadMoreFromScroll(event.currentTarget)}>
                {visibleAssets.map((asset) => (
                  <MediaCard
                    key={asset.id}
                    asset={asset}
                    selected={selectedMediaIds.includes(asset.id)}
                    disabled={disabled}
                    onToggle={(shiftKey) => toggleLibrarySelection(asset.id, shiftKey)}
                  />
                ))}
                <div className={styles.librarySentinel} ref={librarySentinelRef} aria-hidden="true" />
              </div>
              {libraryLoading && <p className={styles.libraryStatus} role="status">Carregando mais mídias…</p>}
              {!libraryLoading && !libraryError && libraryPageState.canLoadMore && <div className={styles.loadMore}><button type="button" disabled={disabled} onClick={() => void loadLibraryPage(true)}>Carregar mais mídias ({libraryPageState.remaining} restante(s))</button></div>}
              {libraryError && <div className={styles.loadMore}><p className={styles.validation}>{libraryError}</p><button type="button" disabled={libraryLoading} onClick={() => void loadLibraryPage(visibleAssets.length > 0)}>Tentar novamente</button></div>}
              {!libraryLoading && !libraryError && !libraryHasMore && visibleAssets.length > 0 && <p className={styles.libraryStatus} role="status">Todas as mídias deste filtro foram carregadas.</p>}
            </section>}

            <DragOverlay>
              {dragging && <div className={styles.overlay}><span className={styles.thumb}>{mediaPreview(dragging)}</span>{dragging.original_name}</div>}
            </DragOverlay>
          </DndContext>
        </>
      )}

      {quantityPickerTarget && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={closeQuantityPicker}>
          <section className={`${styles.modal} ${styles.quantityModal}`} role="dialog" aria-modal="true" aria-labelledby="quantity-picker-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className={styles.quantityModalHeader}>
              <div>
                <span className="section-kicker">Seleção rápida</span>
                <h3 id="quantity-picker-title">Selecionar por quantidade</h3>
              </div>
              <button className={styles.modalClose} type="button" onClick={closeQuantityPicker} disabled={selectingQuantity} aria-label="Fechar seleção por quantidade">×</button>
            </header>
            <p>Informe quantas mídias deseja marcar na lista atual.</p>
            <div className={styles.quantityForm}>
              <label className={styles.field}>
                Quantidade de mídias
                <input ref={quantityInputRef} type="number" inputMode="numeric" min="1" step="1" value={quantityValue} disabled={selectingQuantity} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void selectByQuantity(); } }} onChange={(event) => { setQuantityValue(event.target.value); setQuantityMessage(''); }} placeholder="Ex.: 100" />
              </label>
              {quantityMessage && <p className={quantityMessage.startsWith('Informe') || quantityMessage.startsWith('Não foi') ? styles.validation : styles.quantityFeedback} role="status">{quantityMessage}</p>}
              <div className={styles.modalActions}>
                <button type="button" onClick={closeQuantityPicker} disabled={selectingQuantity}>Cancelar</button>
                <button type="button" className="button primary" disabled={selectingQuantity} onClick={() => void selectByQuantity()}>{selectingQuantity ? 'Selecionando…' : 'Selecionar mídias'}</button>
              </div>
            </div>
          </section>
        </div>
      )}

      {repeatHelpOpen && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setRepeatHelpOpen(false)}>
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="repeat-help-title" onMouseDown={(event) => event.stopPropagation()}>
            <h3 id="repeat-help-title">Como funciona repetir postagem</h3>
            <p>Quando marcado, o sistema usa todos os horários recorrentes configurados e cria publicações pela quantidade de dias informada, contando o primeiro dia agendável.</p>
            <p>As mídias entram em ordem circular: se houver 3 mídias e 4 horários, o quarto horário volta para a mídia 1; no dia seguinte a fila continua na próxima mídia.</p>
            <p>Carrossel conta como uma única publicação e repete o mesmo conjunto de mídias em cada horário.</p>
            <div className={styles.modalActions}>
              <button type="button" className="button primary" onClick={() => setRepeatHelpOpen(false)}>Entendi</button>
            </div>
          </section>
        </div>
      )}

      {previewingBulk && (
        <div className={styles.modalBackdrop} role="presentation">
          <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="bulk-preview-title">
            <h3 id="bulk-preview-title">Confirmar distribuição</h3>
            <p>
              {selectedMediaIds.length} mídia(s) selecionada(s), {bulkCompatibleCount} compatível(is), em {bulkCount} perfil(is).
              {' '}{runMode === 'immediate'
                ? 'Esta é uma run imediata: as mídias aplicadas não receberão horário.'
                : 'Esta é uma run programada: a configuração de horário será aplicada aos destinos.'}
            </p>
            <ul className={styles.previewList}>
              {activeProfiles.filter((profile) => (bulkPlanDistribution.get(profile.id) ?? []).length > 0).map((profile) => (
                <li key={profile.id}><strong>@{profile.username}</strong><span>{bulkPlanDistribution.get(profile.id)?.length} mídia(s) · {bulk.distribution === 'repeat' ? `${bulkSequenceRepeatCount} sequência(s) · ${bulk.dailyTimes[0]} exato · ${formatSaoPauloDateTime(repeatPreviewByProfile.get(profile.id)?.firstExecuteAt)} até ${formatSaoPauloDateTime(repeatPreviewByProfile.get(profile.id)?.lastExecuteAt)}` : bulk.mode === 'one_time' ? 'data única' : `${bulk.dailyTimes.length} horário(s)/dia`}</span></li>
              ))}
            </ul>
            {bulk.distribution === 'repeat' && <p>Resumo: {bulkCompatibleCount} mídias × {bulkSequenceRepeatCount} ciclos × {destinations.length} perfis = <strong>{bulkProjectedPublicationCount.toLocaleString('pt-BR')} publicações</strong>. Horário literal: <strong>{bulk.dailyTimes[0]}</strong>. Janela global: <strong>{formatSaoPauloDateTime(repeatFirstExecuteAt)}</strong> até <strong>{formatSaoPauloDateTime(repeatLastExecuteAt)}</strong>.</p>}
            {bulk.action === 'replace' && <p className={styles.validation}>A substituição remove o plano atual somente dos destinos acima.</p>}
            <div className={styles.modalActions}>
              <button type="button" onClick={() => setPreviewingBulk(false)}>Voltar</button>
              <button type="button" className="button primary" onClick={applyBulk}>Confirmar e aplicar</button>
            </div>
          </section>
        </div>
      )}

      {mediaPickerProfile && mediaPickerPlan && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={() => setMediaPickerProfileId(null)}>
          <section className={`${styles.modal} ${styles.mediaPickerModal}`} role="dialog" aria-modal="true" aria-labelledby="media-picker-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className={styles.mediaPickerHeader}>
              <div>
                <span className="section-kicker">Biblioteca de mídias</span>
                <h3 id="media-picker-title">Adicionar para @{mediaPickerProfile.username}</h3>
                <p>{mediaPickerPlan.format === 'carousel' ? 'Selecione de 2 a 10 mídias para o carrossel.' : `Selecione ${mediaPickerPlan.format === 'reel' ? 'um vídeo' : mediaPickerPlan.format === 'image' ? 'uma imagem' : 'uma imagem ou vídeo'} por postagem.`}</p>
              </div>
                  <button className={styles.modalClose} type="button" onClick={() => { setMediaPickerProfileId(null); setMediaPickerSelectedIds([]); setMediaPickerSelectionAnchorId(null); }} aria-label="Fechar biblioteca">×</button>
            </header>
            <div className={styles.toolbar}>
              <span>{librarySummary(mediaPickerSelectedIds.length, mediaPickerAssets.length, mediaPickerPageState)}</span>
              <div className={styles.toolbarActions}>
                <button type="button" disabled={disabled || !mediaPickerAssets.length} onClick={() => { const ids = mediaPickerAssets.filter((asset) => !mediaPickerPlan.mediaIds.includes(asset.id)).map((asset) => asset.id); setMediaPickerSelectedIds(ids); setMediaPickerSelectionAnchorId(ids.at(-1) ?? null); }}>Selecionar visíveis</button>
                <button type="button" disabled={disabled} onClick={() => openQuantityPicker('profile')}>Quantidade</button>
                <button type="button" disabled={disabled} onClick={() => { setMediaPickerSelectedIds([]); setMediaPickerSelectionAnchorId(null); }}>Limpar seleção</button>
              </div>
              <div className={styles.libraryFilters}>
                <label className={styles.field}>Origem<select value={source} disabled={disabled} onChange={(event) => setSource(event.target.value as typeof source)}><option value="group">Mídias deste grupo</option><option value="ungrouped">Mídias sem grupo</option><option value="other">Mídias de outro grupo</option></select></label>
                <label className={styles.field}>Exibir<select value={libraryUsage} disabled={disabled} onChange={(event) => changeLibraryUsage(event.target.value as LibraryUsageFilter)}><option value="available">Disponíveis</option><option value="published">Postadas</option><option value="scheduled">Agendadas</option><option value="all">Todas as mídias</option></select></label>
                {source === 'other' && <label className={styles.field}>Grupo de origem<select value={sourceGroupId} disabled={disabled} onChange={(event) => setSourceGroupId(event.target.value)}><option value="">Selecione</option>{groups.filter((item) => item.id !== group.id).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
              </div>
            </div>
            <div ref={mediaPickerScrollRef} className={styles.mediaPickerGrid} onScroll={(event) => maybeLoadMoreFromScroll(event.currentTarget)}>
              {mediaPickerAssets.length === 0 ? <p className={styles.emptyPicker}>Nenhuma mídia compatível nesta origem.</p> : mediaPickerAssets.map((asset) => {
                const selected = mediaPickerPlan.mediaIds.includes(asset.id);
                const reachedLimit = mediaPickerPlan.format === 'carousel' && mediaPickerPlan.mediaIds.length >= 10;
                const pending = mediaPickerSelectedIds.includes(asset.id);
                return <button key={asset.id} type="button" className={`${styles.pickerAsset} ${selected || pending ? styles.pickerAssetSelected : ''}`} disabled={disabled || selected || reachedLimit} onClick={(event: MouseEvent<HTMLButtonElement>) => toggleMediaPickerSelection(asset.id, event.shiftKey)}><span className={styles.thumb}>{mediaPreview(asset)}</span><span><strong>{asset.original_name}</strong><small>{asset.kind === 'video' ? 'Vídeo' : 'Imagem'}{selected ? ' · já adicionada' : asset.publication_state?.scheduled_count ? ' · agendada' : asset.publication_state?.has_published ? ' · postada' : ''}</small></span><em>{selected ? '✓' : pending ? '✓' : '+'}</em></button>;
              })}
              <div className={styles.librarySentinel} ref={mediaPickerSentinelRef} aria-hidden="true" />
            </div>
            {libraryLoading && <p className={styles.libraryStatus} role="status">Carregando mais mídias…</p>}
            {!libraryLoading && !libraryError && mediaPickerPageState.canLoadMore && <div className={styles.loadMore}><button type="button" disabled={disabled} onClick={() => void loadLibraryPage(true)}>Carregar mais mídias ({mediaPickerPageState.remaining} restante(s))</button></div>}
            {libraryError && <div className={styles.loadMore}><p className={styles.validation}>{libraryError}</p><button type="button" disabled={libraryLoading} onClick={() => void loadLibraryPage(mediaPickerAssets.length > 0)}>Tentar novamente</button></div>}
            <footer className={styles.mediaPickerFooter}><span>{mediaPickerPlan.mediaIds.length} {mediaPickerPlan.mediaIds.length === 1 ? 'mídia adicionada' : 'mídias adicionadas'}</span><button type="button" disabled={disabled || !mediaPickerSelectedIds.length} onClick={() => { add(mediaPickerProfile.id, mediaPickerSelectedIds); setMediaPickerSelectedIds([]); setMediaPickerSelectionAnchorId(null); }}>Adicionar selecionadas</button><button type="button" className="button primary" onClick={() => { setMediaPickerProfileId(null); setMediaPickerSelectedIds([]); setMediaPickerSelectionAnchorId(null); }}>Concluir</button></footer>
          </section>
        </div>
      )}
    </section>
  );
}

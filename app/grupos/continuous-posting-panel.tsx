'use client';

import { FormEvent, RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  CONTINUOUS_POSTING_DEFAULT_POSTS_PER_DAY,
  CONTINUOUS_POSTING_MAX_CAPTION_LENGTH,
  CONTINUOUS_POSTING_MAX_POSTS_PER_DAY,
  CONTINUOUS_POSTING_MINUTES_PER_DAY,
  CONTINUOUS_POSTING_NOTICE_KINDS,
} from '@/lib/publications/continuous-posting';
import type {
  ContinuousPostingFormat,
  ContinuousPostingNotice,
  ContinuousPostingNoticeKind,
  ContinuousPostingRotationMode,
  ContinuousPostingRule,
} from '@/lib/publications/continuous-posting';

import styles from './continuous-posting-panel.module.css';
// Fundo, caixa, cabeçalho e rodapé do modal são os mesmos da tela de Grupos.
import groupStyles from './groups.module.css';

// Postagem contínua por grupo (migration 443): chave liga/desliga e Configurar por
// formato, mais o painel de avisos. Componentes independentes, montados pela tela
// de Grupos. Todo horário aqui é exibido em horário de Brasília.

export type ContinuousPostingGroupOption = { id: string; name: string };

export type ContinuousPostingRulesResult = {
  allowed: boolean;
  rules: ContinuousPostingRule[];
  /** Preenchido só quando a consulta falhou; `allowed` vem false nesse caso. */
  error?: string;
};

const FORMATS: ContinuousPostingFormat[] = ['reel', 'story'];
const FORMAT_LABEL: Record<ContinuousPostingFormat, string> = { reel: 'Reels', story: 'Stories' };
// Faixa padrão do story (decisão do dono em 10/10/2026): 07:00 às 23:59, editável na tela.
const DEFAULT_STORY_WINDOW = { start: 7 * 60, end: 23 * 60 + 59 };
const NOTICE_PAGE_SIZE = 200;

const ROTATION_OPTIONS: Array<{ value: ContinuousPostingRotationMode; label: string; help: string }> = [
  { value: 'diversified', label: 'Diversificada', help: 'Cada perfil percorre as mídias numa sequência própria, então perfis diferentes postam mídias diferentes no mesmo horário.' },
  { value: 'same_order', label: 'Mesma ordem', help: 'Todos os perfis seguem a ordem em que as mídias foram enviadas, da mais antiga para a mais nova.' },
];

const NOTICE_KIND_LABEL: Record<ContinuousPostingNoticeKind, string> = {
  skipped_late: 'Pulado: passou do horário',
  skipped_no_media: 'Pulado: origem sem mídia',
  skipped_slot_conflict: 'Pulado: conflito com outro agendamento',
  profile_rest: 'Em descanso (Meta limitou ações)',
  rule_paused: 'Regra pausada por falhas',
  post_failed: 'Falhou',
  post_expired: 'Venceu sem postar',
  post_cancelled: 'Cancelado',
  profile_disconnected: 'Perfil caiu',
};

const dateTimeFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatDateTime(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateTimeFormatter.format(date).replace(',', '');
}

function formatNumber(value: number, fractionDigits = 0) {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: fractionDigits });
}

/** Duração em minutos na menor unidade que ainda se lê bem: min, h ou dias. */
function formatSpan(minutes: number) {
  if (minutes < 120) return `${formatNumber(minutes, 1)} min`;
  if (minutes < 2 * CONTINUOUS_POSTING_MINUTES_PER_DAY) return `${formatNumber(minutes / 60, 1)} h`;
  return `${formatNumber(minutes / CONTINUOUS_POSTING_MINUTES_PER_DAY, 1)} dias`;
}

function minuteToTimeValue(minute: number) {
  const clamped = Math.min(Math.max(minute, 0), CONTINUOUS_POSTING_MINUTES_PER_DAY) % CONTINUOUS_POSTING_MINUTES_PER_DAY;
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

function timeValueToMinute(value: string) {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function mediaWord(format: ContinuousPostingFormat, count: number) {
  if (format === 'reel') return count === 1 ? 'vídeo' : 'vídeos';
  return count === 1 ? 'mídia' : 'mídias';
}

async function readJson(response: Response) {
  return await response.json().catch(() => null) as Record<string, unknown> | null;
}

function payloadError(payload: Record<string, unknown> | null, fallback: string) {
  return typeof payload?.error === 'string' && payload.error ? payload.error : fallback;
}

/**
 * Regras de postagem contínua da organização ativa. A tela chama uma vez ao abrir
 * e de novo no `onChanged`. Organização não liberada volta `allowed: false`, e é
 * isso que esconde o recurso.
 */
export async function loadContinuousPostingRules(): Promise<ContinuousPostingRulesResult> {
  try {
    const response = await fetch('/api/groups/continuous-posting', { cache: 'no-store' });
    const payload = await readJson(response);
    if (!response.ok) return { allowed: false, rules: [], error: payloadError(payload, 'Não foi possível consultar a postagem contínua.') };
    return {
      allowed: payload?.allowed === true,
      rules: Array.isArray(payload?.rules) ? payload.rules as ContinuousPostingRule[] : [],
    };
  } catch {
    return { allowed: false, rules: [], error: 'Não foi possível consultar a postagem contínua.' };
  }
}

/** Foco preso no modal, Esc fecha e o foco volta para quem abriu. */
function useModalFocus(dialogRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    // O primeiro campo, não o × do cabeçalho.
    (dialog?.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0] ?? dialog)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      opener?.focus();
    };
  }, [dialogRef]);
}

type ConfigModalProps = {
  group: ContinuousPostingGroupOption;
  groups: ContinuousPostingGroupOption[];
  format: ContinuousPostingFormat;
  rule: ContinuousPostingRule | null;
  onClose: () => void;
  onSaved: (rule: ContinuousPostingRule) => void;
};

const SOURCE_PREVIEW_LIMIT = 24;

type SourcePreviewAsset = { id: string; originalName: string; kind: 'image' | 'video'; thumbnailUrl: string | null };
type SourcePreviewState = { status: 'loading' | 'ready' | 'error'; assets: SourcePreviewAsset[]; hasMore: boolean };

/**
 * Miniatura de uma mídia da origem. Vídeo sem miniatura gerada chega com a URL
 * do próprio arquivo: o <video> com `preload="metadata"` mostra o primeiro
 * quadro sem baixar o vídeo inteiro.
 */
function SourcePreviewThumb({ asset }: { asset: SourcePreviewAsset }) {
  const [broken, setBroken] = useState(false);
  const [asVideo, setAsVideo] = useState(false);
  if (!asset.thumbnailUrl || broken) return <span className={styles.previewThumb} title={asset.originalName} aria-label={asset.originalName}>{asset.kind === 'video' ? '▶' : '▣'}</span>;
  if (asVideo) return <video className={styles.previewThumb} src={`${asset.thumbnailUrl}#t=0.1`} muted playsInline preload="metadata" title={asset.originalName} onError={() => setBroken(true)} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={styles.previewThumb} src={asset.thumbnailUrl} alt={asset.originalName} title={asset.originalName} loading="lazy" onError={() => { if (asset.kind === 'video') setAsVideo(true); else setBroken(true); }} />;
}

function ContinuousPostingConfigModal({ group, groups, format, rule, onClose, onSaved }: ConfigModalProps) {
  const titleId = useId();
  const fieldId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const [sourceGroupId, setSourceGroupId] = useState(rule?.sourceGroupId ?? group.id);
  const [rotationMode, setRotationMode] = useState<ContinuousPostingRotationMode>(rule?.rotationMode ?? 'diversified');
  const [postsPerDayText, setPostsPerDayText] = useState(String(rule?.postsPerDay ?? CONTINUOUS_POSTING_DEFAULT_POSTS_PER_DAY[format]));
  const [windowStart, setWindowStart] = useState(minuteToTimeValue(rule?.windowStartMinute ?? DEFAULT_STORY_WINDOW.start));
  const [windowEnd, setWindowEnd] = useState(minuteToTimeValue(rule?.windowEndMinute ?? DEFAULT_STORY_WINDOW.end));
  const [caption, setCaption] = useState(rule?.caption ?? '');
  // A legenda fica recolhida: a maioria das regras não usa, e o campo ocupava
  // um terço do modal. Já nasce aberta quando a regra tem legenda.
  const [captionOpen, setCaptionOpen] = useState(Boolean(rule?.caption));
  const [preview, setPreview] = useState<SourcePreviewState>({ status: 'loading', assets: [], hasMore: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const close = useCallback(() => { if (!saving) onClose(); }, [saving, onClose]);
  useModalFocus(dialogRef, close);

  // A origem salva pode ser um grupo que já não está na lista da tela.
  // Prévia da origem: as primeiras mídias que a regra vai postar, pela mesma rota
  // de revisão do plano em massa (mesma regra de elegibilidade da 085).
  useEffect(() => {
    let alive = true;
    setPreview({ status: 'loading', assets: [], hasMore: false });
    const query = new URLSearchParams({ originType: 'group', groupId: sourceGroupId, format, limit: String(SOURCE_PREVIEW_LIMIT) });
    fetch(`/api/bulk-publications/media?${query.toString()}`)
      .then(async (response) => {
        const payload = await response.json() as { assets?: SourcePreviewAsset[]; hasMore?: boolean; error?: string };
        if (!alive) return;
        if (!response.ok || !payload.assets) setPreview({ status: 'error', assets: [], hasMore: false });
        else setPreview({ status: 'ready', assets: payload.assets, hasMore: Boolean(payload.hasMore) });
      })
      .catch(() => { if (alive) setPreview({ status: 'error', assets: [], hasMore: false }); });
    return () => { alive = false; };
  }, [format, sourceGroupId]);

  const sourceOptions = useMemo(() => {
    const options = groups.some((option) => option.id === group.id) ? [...groups] : [group, ...groups];
    if (rule && !options.some((option) => option.id === rule.sourceGroupId)) {
      options.push({ id: rule.sourceGroupId, name: rule.sourceGroupName ?? 'Origem atual' });
    }
    return options;
  }, [groups, group, rule]);

  const maxPostsPerDay = CONTINUOUS_POSTING_MAX_POSTS_PER_DAY[format];
  const postsPerDay = /^\d+$/.test(postsPerDayText.trim()) ? Number(postsPerDayText.trim()) : NaN;
  const postsPerDayValid = Number.isInteger(postsPerDay) && postsPerDay >= 1 && postsPerDay <= maxPostsPerDay;

  const startMinute = timeValueToMinute(windowStart);
  // O campo de hora não escreve 24:00: fim em 00:00 quer dizer meia-noite do fim do dia.
  const rawEndMinute = timeValueToMinute(windowEnd);
  const endMinute = rawEndMinute === 0 ? CONTINUOUS_POSTING_MINUTES_PER_DAY : rawEndMinute;
  const windowValid = format !== 'story' || (startMinute !== null && endMinute !== null && startMinute < endMinute);

  let intervalText = '';
  if (postsPerDayValid) {
    if (format === 'reel') {
      intervalText = `Um post a cada ${formatSpan(CONTINUOUS_POSTING_MINUTES_PER_DAY / postsPerDay)} por perfil, o dia inteiro.`;
    } else if (windowValid && startMinute !== null && endMinute !== null) {
      intervalText = postsPerDay === 1
        ? 'Um story por dia por perfil, em horário sorteado dentro da faixa.'
        : `Um story a cada ${formatSpan((endMinute - startMinute) / postsPerDay)} por perfil, dentro da faixa.`;
    }
  }

  // Os números da regra valem para a origem SALVA; trocando a origem no select,
  // eles deixam de descrever o que está na tela.
  const statsApply = rule !== null && rule.sourceGroupId === sourceGroupId;
  const eligibleMedia = statsApply ? rule.stats.eligibleMedia : null;
  let repeatText = '';
  let repeatWarning = false;
  if (eligibleMedia !== null && postsPerDayValid) {
    if (eligibleMedia === 0) {
      repeatText = `A origem não tem ${format === 'reel' ? 'nenhum vídeo pronto' : 'nenhuma mídia pronta'}: a chave não liga enquanto estiver vazia.`;
      repeatWarning = true;
    } else {
      const repeatMinutes = (eligibleMedia / postsPerDay) * CONTINUOUS_POSTING_MINUTES_PER_DAY;
      repeatText = `${formatNumber(eligibleMedia)} ${mediaWord(format, eligibleMedia)}: cada perfil repete ${format === 'reel' ? 'um vídeo' : 'uma mídia'} a cada ${formatSpan(repeatMinutes)}.`;
      repeatWarning = repeatMinutes < 7 * CONTINUOUS_POSTING_MINUTES_PER_DAY;
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!postsPerDayValid) {
      setError(`Posts por dia deve ficar entre 1 e ${maxPostsPerDay}.`);
      return;
    }
    if (!windowValid) {
      setError('O início da faixa de horário precisa ser antes do fim.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/groups/${group.id}/continuous-posting`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          sourceGroupId,
          rotationMode,
          postsPerDay,
          windowStartMinute: format === 'story' ? startMinute : null,
          windowEndMinute: format === 'story' ? endMinute : null,
          caption: captionOpen ? caption.trim() || null : null,
        }),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload?.rule) {
        setError(payloadError(payload, 'Não foi possível salvar a configuração.'));
        return;
      }
      onSaved(payload.rule as ContinuousPostingRule);
    } catch {
      setError('Não foi possível salvar a configuração. Confira a conexão e tente de novo.');
    } finally {
      setSaving(false);
    }
  }

  // O modal sai do card por um portal: o card tem `overflow: hidden` e ganha
  // `transform` no hover, e um `position: fixed` ali dentro fica preso e cortado
  // no card. O destino e a raiz da tela de Grupos, onde moram os outros modais
  // e os tokens `--grp-*`.
  const portalTarget = typeof document === 'undefined'
    ? null
    : document.querySelector(`.${groupStyles.page}`) ?? document.body;
  if (!portalTarget) return null;

  return createPortal(<div className={groupStyles.backdrop} role="presentation" onMouseDown={close}>
    <section
      ref={dialogRef}
      tabIndex={-1}
      className={`panel ${groupStyles.modal}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className={groupStyles.modalHeader}>
        <div>
          <span className="section-kicker">Postagem contínua · {FORMAT_LABEL[format]}</span>
          <h2 id={titleId}>Configurar “{group.name}”</h2>
          <p>Salvar não liga nada: a postagem só começa quando a chave for ligada.</p>
        </div>
        <button className={groupStyles.closeButton} type="button" aria-label="Fechar" disabled={saving} onClick={close}>×</button>
      </header>

      {error && <p className={`inline-message inline-message-error ${styles.modalMessage}`} role="alert">{error}</p>}

      <form className={styles.form} onSubmit={save}>
        <div className={styles.field}>
          <label htmlFor={`${fieldId}-source`}>Origem das mídias</label>
          <select id={`${fieldId}-source`} data-autofocus value={sourceGroupId} onChange={(event) => setSourceGroupId(event.target.value)}>
            {sourceOptions.map((option) => <option key={option.id} value={option.id}>
              {option.id === group.id ? `${option.name} (este grupo)` : option.name}
            </option>)}
          </select>
          <small>{format === 'reel' ? 'Entram os vídeos prontos do grupo escolhido.' : 'Entram as fotos e os vídeos prontos do grupo escolhido.'} O ciclo recomeça quando as mídias acabam.</small>
          <div className={styles.preview} aria-live="polite">
            {preview.status === 'loading' && <p className={styles.note}>Carregando as mídias da origem…</p>}
            {preview.status === 'error' && <p className={styles.warning}>Não foi possível carregar a prévia das mídias desta origem.</p>}
            {preview.status === 'ready' && preview.assets.length === 0 && <p className={styles.warning}>Esta origem não tem {format === 'reel' ? 'vídeo pronto' : 'mídia pronta'}. Com ela a chave não liga.</p>}
            {preview.status === 'ready' && preview.assets.length > 0 && <>
              <p className={styles.note}>
                {preview.hasMore
                  ? `As ${preview.assets.length} primeiras mídias da origem (há mais):`
                  : `${preview.assets.length === 1 ? 'A única mídia' : `As ${preview.assets.length} mídias`} da origem:`}
              </p>
              <div className={styles.previewGrid}>
                {preview.assets.map((asset) => <SourcePreviewThumb key={asset.id} asset={asset} />)}
              </div>
            </>}
          </div>
        </div>

        <fieldset className={styles.choices}>
          <legend>Ordem das mídias</legend>
          {ROTATION_OPTIONS.map((option) => <label key={option.value} className={`${styles.choice} ${rotationMode === option.value ? styles.choiceSelected : ''}`}>
            <input
              type="radio"
              name={`${fieldId}-rotation`}
              value={option.value}
              checked={rotationMode === option.value}
              onChange={() => setRotationMode(option.value)}
            />
            <span><strong>{option.label}</strong><small>{option.help}</small></span>
          </label>)}
        </fieldset>

        <div className={styles.field}>
          <label htmlFor={`${fieldId}-posts`}>Posts por dia, por perfil</label>
          <input
            id={`${fieldId}-posts`}
            type="number"
            inputMode="numeric"
            min={1}
            max={maxPostsPerDay}
            step={1}
            required
            value={postsPerDayText}
            aria-describedby={`${fieldId}-posts-help`}
            aria-invalid={!postsPerDayValid}
            onChange={(event) => setPostsPerDayText(event.target.value)}
          />
          <small id={`${fieldId}-posts-help`}>
            {postsPerDayValid ? intervalText : `De 1 a ${maxPostsPerDay}.`}
          </small>
        </div>

        {format === 'story' && <fieldset className={styles.window}>
          <legend>Faixa de horário (horário de Brasília)</legend>
          <div className={styles.field}>
            <label htmlFor={`${fieldId}-start`}>Das</label>
            <input id={`${fieldId}-start`} type="time" required value={windowStart} aria-invalid={!windowValid} onChange={(event) => setWindowStart(event.target.value)} />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${fieldId}-end`}>Até</label>
            <input id={`${fieldId}-end`} type="time" required value={windowEnd} aria-invalid={!windowValid} onChange={(event) => setWindowEnd(event.target.value)} />
          </div>
          <small>{windowValid ? 'Até 00:00 vale como meia-noite, o fim do dia.' : 'O início precisa ser antes do fim.'}</small>
        </fieldset>}

        <div className={styles.field}>
          <label className={styles.checkLine}>
            <input type="checkbox" checked={captionOpen} onChange={(event) => setCaptionOpen(event.target.checked)} />
            Postar com legenda
          </label>
          {captionOpen && <>
            <textarea id={`${fieldId}-caption`} aria-label="Legenda" rows={3} maxLength={CONTINUOUS_POSTING_MAX_CAPTION_LENGTH} value={caption} onChange={(event) => setCaption(event.target.value)} />
            <small>A mesma legenda vai em todos os posts desta regra.</small>
          </>}
        </div>

        {rule && <div className={styles.sourceFacts} aria-live="polite">
          {statsApply ? <>
            <span><strong>{formatNumber(rule.stats.eligibleMedia)}</strong> {mediaWord(format, rule.stats.eligibleMedia)} {format === 'reel' ? 'pronto' : 'pronta'}{rule.stats.eligibleMedia === 1 ? '' : 's'} na origem</span>
            <span><strong>{formatNumber(rule.stats.eligibleProfiles)}</strong> {rule.stats.eligibleProfiles === 1 ? 'perfil apto' : 'perfis aptos'} a postar</span>
            {repeatText && <p className={repeatWarning ? styles.warning : styles.note}>{repeatText}</p>}
            {rule.stats.eligibleProfiles === 0 && <p className={styles.warning}>Nenhum perfil do grupo pode postar agora: só entram perfis conectados pela API oficial da Meta.</p>}
          </> : <p className={styles.note}>Os números da nova origem aparecem depois de salvar.</p>}
        </div>}

        <footer className={groupStyles.modalActions}>
          <button className="button button-ghost" type="button" disabled={saving} onClick={close}>Cancelar</button>
          <button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Salvando…' : 'Salvar configuração'}</button>
        </footer>
      </form>
    </section>
  </div>, portalTarget);
}

type GroupControlsProps = {
  group: ContinuousPostingGroupOption;
  /** Grupos da organização, para o select de origem das mídias. */
  groups: ContinuousPostingGroupOption[];
  canManage: boolean;
  /** Regras da organização (ou só as do grupo): o componente filtra por `group.id`. */
  rules: ContinuousPostingRule[];
  /** Chamado depois de salvar ou de mudar a chave, com a regra como o servidor devolveu. */
  onChanged?: (rule: ContinuousPostingRule) => void;
};

type RuleOverride = { rule: ContinuousPostingRule; propSnapshot: string };

export function ContinuousPostingGroupControls({ group, groups, canManage, rules, onChanged }: GroupControlsProps) {
  // A regra devolvida por salvar/ligar vale na hora, sem esperar a tela recarregar.
  // Ela é descartada assim que a regra recebida por props mudar.
  const [overrides, setOverrides] = useState<Partial<Record<ContinuousPostingFormat, RuleOverride>>>({});
  const [busyFormat, setBusyFormat] = useState<ContinuousPostingFormat | null>(null);
  const [configFormat, setConfigFormat] = useState<ContinuousPostingFormat | null>(null);
  const [errors, setErrors] = useState<Partial<Record<ContinuousPostingFormat, string>>>({});

  function propRule(format: ContinuousPostingFormat) {
    return rules.find((rule) => rule.groupId === group.id && rule.format === format) ?? null;
  }

  function currentRule(format: ContinuousPostingFormat) {
    const fromProps = propRule(format);
    const override = overrides[format];
    return override && override.propSnapshot === JSON.stringify(fromProps) ? override.rule : fromProps;
  }

  function applyRule(rule: ContinuousPostingRule) {
    setOverrides((current) => ({ ...current, [rule.format]: { rule, propSnapshot: JSON.stringify(propRule(rule.format)) } }));
    onChanged?.(rule);
  }

  async function setEnabled(format: ContinuousPostingFormat, rule: ContinuousPostingRule, enabled: boolean) {
    const label = FORMAT_LABEL[format].toLowerCase();
    const question = enabled
      ? `Ligar a postagem contínua de ${label} no grupo “${group.name}”?\n\nCada perfil apto passa a postar ${rule.postsPerDay} ${rule.postsPerDay === 1 ? 'vez' : 'vezes'} por dia, até a conta cair ou a chave ser desligada.`
      : `Desligar a postagem contínua de ${label} no grupo “${group.name}”?\n\nO que já está em andamento termina; nenhum post novo é criado.`;
    if (!window.confirm(question)) return;

    setBusyFormat(format);
    setErrors((current) => ({ ...current, [format]: '' }));
    try {
      const response = await fetch(`/api/groups/${group.id}/continuous-posting/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, enabled }),
      });
      const payload = await readJson(response);
      if (!response.ok || !payload?.rule) {
        setErrors((current) => ({ ...current, [format]: payloadError(payload, enabled ? 'Não foi possível ligar.' : 'Não foi possível desligar.') }));
        return;
      }
      applyRule(payload.rule as ContinuousPostingRule);
    } catch {
      setErrors((current) => ({ ...current, [format]: 'Não foi possível falar com o servidor. Confira a conexão e tente de novo.' }));
    } finally {
      setBusyFormat(null);
    }
  }

  return <div className={styles.controls} role="group" aria-label={`Postagem contínua do grupo ${group.name}`}>
    <span className={styles.controlsTitle}>Postagem contínua</span>
    {FORMATS.map((format) => {
      const rule = currentRule(format);
      const busy = busyFormat === format;
      const paused = Boolean(rule?.enabled && rule.pausedAt);
      const status = !rule
        ? 'Não configurado'
        : paused
          ? `Pausado: ${rule.pauseReason?.trim() || 'muitas falhas seguidas'}`
          : rule.enabled
            ? `Ligado desde ${formatDateTime(rule.enabledAt) || 'agora'}`
            : 'Desligado';
      const statusClass = !rule || !rule.enabled ? styles.statusOff : paused ? styles.statusPaused : styles.statusOn;
      const stats = rule?.stats;
      return <div className={styles.formatRow} key={format}>
        <div className={styles.formatHead}>
          <button
            type="button"
            role="switch"
            className={styles.switch}
            aria-checked={Boolean(rule?.enabled)}
            aria-label={`Postagem contínua de ${FORMAT_LABEL[format]} no grupo ${group.name}`}
            title={!rule ? 'Configure antes de ligar.' : !canManage ? 'Só administradores e operadores mudam a chave.' : undefined}
            disabled={!rule || !canManage || busy}
            onClick={() => rule && setEnabled(format, rule, !rule.enabled)}
          >
            <span className={styles.switchTrack} aria-hidden="true" />
          </button>
          <span className={styles.formatName}>{FORMAT_LABEL[format]}</span>
          <span className={`${styles.status} ${statusClass}`}>{busy ? 'Aguarde…' : status}</span>
          {canManage && paused && rule && <button className={styles.linkButton} type="button" disabled={busy} onClick={() => setEnabled(format, rule, true)}>Retomar</button>}
          {canManage && <button className={styles.configButton} type="button" disabled={busy} onClick={() => setConfigFormat(format)}>Configurar</button>}
        </div>
        {rule && stats && <p className={styles.stats}>
          <span>{rule.postsPerDay}/dia</span>
          <span>Hoje: <strong>{formatNumber(stats.postedToday)}</strong> {stats.postedToday === 1 ? 'postado' : 'postados'}</span>
          <span><strong>{formatNumber(stats.inFlight)}</strong> em andamento</span>
          <span className={stats.skippedToday > 0 ? styles.statWarn : undefined}><strong>{formatNumber(stats.skippedToday)}</strong> {stats.skippedToday === 1 ? 'pulado' : 'pulados'}</span>
          <span className={stats.failedToday > 0 ? styles.statBad : undefined}><strong>{formatNumber(stats.failedToday)}</strong> {stats.failedToday === 1 ? 'falha' : 'falhas'}</span>
          <span className={stats.restingProfiles > 0 ? styles.statWarn : undefined}><strong>{formatNumber(stats.restingProfiles)}</strong> em descanso</span>
          {rule.enabled && !paused && <span>Próximo: {formatDateTime(stats.nextPostAt) || '—'}</span>}
        </p>}
        {errors[format] && <p className={styles.rowError} role="alert">{errors[format]}</p>}
      </div>;
    })}

    {configFormat && <ContinuousPostingConfigModal
      key={configFormat}
      group={group}
      groups={groups}
      format={configFormat}
      rule={currentRule(configFormat)}
      onClose={() => setConfigFormat(null)}
      onSaved={(rule) => { setConfigFormat(null); applyRule(rule); }}
    />}
  </div>;
}

type NoticesProps = {
  groups: ContinuousPostingGroupOption[];
  canManage: boolean;
};

function noticeKey(notice: ContinuousPostingNotice) {
  return `${notice.source}:${notice.source === 'item' ? notice.itemId ?? notice.id : notice.id}`;
}

export function ContinuousPostingNotices({ groups, canManage }: NoticesProps) {
  const filterId = useId();
  const [notices, setNotices] = useState<ContinuousPostingNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [groupFilter, setGroupFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<ContinuousPostingNoticeKind | ''>('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clearing, setClearing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async (groupId: string) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const query = groupId ? `?groupId=${encodeURIComponent(groupId)}` : '';
      const response = await fetch(`/api/groups/continuous-posting/notices${query}`, { cache: 'no-store' });
      const payload = await readJson(response);
      if (requestId !== requestRef.current) return;
      if (response.status === 404) {
        setUnavailable(true);
        return;
      }
      if (!response.ok) {
        setError(payloadError(payload, 'Não foi possível consultar os avisos.'));
        return;
      }
      setNotices(Array.isArray(payload?.notices) ? payload.notices as ContinuousPostingNotice[] : []);
      setSelected(new Set());
    } catch {
      if (requestId === requestRef.current) setError('Não foi possível consultar os avisos. Confira a conexão e tente de novo.');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(groupFilter); }, [load, groupFilter]);

  const filtered = useMemo(() => {
    const term = search.trim().replace(/^@/, '').toLowerCase();
    return notices.filter((notice) => (!kindFilter || notice.kind === kindFilter)
      && (!term || (notice.username ?? '').toLowerCase().includes(term)));
  }, [notices, kindFilter, search]);

  const selectedVisible = useMemo(() => filtered.filter((notice) => selected.has(noticeKey(notice))), [filtered, selected]);
  const allVisibleSelected = filtered.length > 0 && selectedVisible.length === filtered.length;

  function toggleSelected(notice: ContinuousPostingNotice) {
    const key = noticeKey(notice);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected(allVisibleSelected ? new Set() : new Set(filtered.map(noticeKey)));
  }

  async function clear(targets: ContinuousPostingNotice[], everything: boolean) {
    if (targets.length === 0) return;
    const question = everything
      ? `Limpar os ${targets.length} avisos que estão na lista?`
      : `Limpar ${targets.length} ${targets.length === 1 ? 'aviso selecionado' : 'avisos selecionados'}?`;
    if (!window.confirm(`${question}\n\nLimpar só tira o aviso da lista: não recria nem republica nenhum post.`)) return;

    setClearing(true);
    setError('');
    setFeedback('');
    try {
      const response = await fetch('/api/groups/continuous-posting/notices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          noticeIds: targets.filter((notice) => notice.source === 'notice').map((notice) => notice.id),
          itemIds: targets.filter((notice) => notice.source === 'item').map((notice) => notice.itemId ?? notice.id),
        }),
      });
      const payload = await readJson(response);
      if (!response.ok) {
        setError(payloadError(payload, 'Não foi possível limpar os avisos.'));
        return;
      }
      const cleared = typeof payload?.cleared === 'number' ? payload.cleared : targets.length;
      setFeedback(`${cleared} ${cleared === 1 ? 'aviso limpo' : 'avisos limpos'}.`);
      await load(groupFilter);
    } catch {
      setError('Não foi possível limpar os avisos. Confira a conexão e tente de novo.');
    } finally {
      setClearing(false);
    }
  }

  // Organização fora da lista de liberação: o painel não existe.
  if (unavailable) return null;

  const filtering = Boolean(groupFilter || kindFilter || search.trim());

  return <section className={`panel ${styles.notices}`} aria-labelledby={`${filterId}-title`}>
    <header className={styles.noticesHeader}>
      <div>
        <span className="section-kicker">Postagem contínua</span>
        <h2 id={`${filterId}-title`}>Avisos</h2>
        <p>Posts que ficaram de fora e o motivo. Horários em horário de Brasília.</p>
      </div>
      <button className="button button-ghost" type="button" disabled={loading || clearing} onClick={() => load(groupFilter)}>{loading ? 'Atualizando…' : 'Atualizar'}</button>
    </header>

    <div className={styles.filters}>
      <div className={styles.field}>
        <label htmlFor={`${filterId}-group`}>Grupo</label>
        <select id={`${filterId}-group`} value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
          <option value="">Todos os grupos</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor={`${filterId}-kind`}>Tipo</label>
        <select id={`${filterId}-kind`} value={kindFilter} onChange={(event) => setKindFilter(event.target.value as ContinuousPostingNoticeKind | '')}>
          <option value="">Todos os tipos</option>
          {CONTINUOUS_POSTING_NOTICE_KINDS.map((kind) => <option key={kind} value={kind}>{NOTICE_KIND_LABEL[kind]}</option>)}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor={`${filterId}-search`}>Perfil</label>
        <input id={`${filterId}-search`} type="search" value={search} placeholder="@usuario" autoComplete="off" onChange={(event) => setSearch(event.target.value)} />
      </div>
    </div>

    {error && <div className={`inline-message inline-message-error ${styles.noticesMessage}`} role="alert">
      <span>{error}</span>
      <button className={styles.linkButton} type="button" disabled={loading} onClick={() => load(groupFilter)}>Tentar de novo</button>
    </div>}
    {feedback && !error && <p className={`inline-message inline-message-success ${styles.noticesMessage}`} role="status">{feedback}</p>}

    {canManage && filtered.length > 0 && <div className={styles.bulkBar}>
      <span>{selectedVisible.length > 0 ? `${selectedVisible.length} de ${filtered.length} selecionados` : `${filtered.length} ${filtered.length === 1 ? 'aviso' : 'avisos'} na lista`}</span>
      <button className="button button-ghost" type="button" disabled={clearing || selectedVisible.length === 0} onClick={() => clear(selectedVisible, false)}>
        {clearing ? 'Limpando…' : `Limpar selecionados (${selectedVisible.length})`}
      </button>
      <button className="button button-danger" type="button" disabled={clearing} onClick={() => clear(filtered, true)}>
        Limpar todos os filtrados ({filtered.length})
      </button>
    </div>}

    {loading && notices.length === 0 && !error
      ? <p className={styles.empty} role="status">Carregando avisos…</p>
      : filtered.length === 0
        ? !error && <div className={styles.empty} role="status">
          <strong>{filtering && notices.length > 0 ? 'Nenhum aviso com esses filtros' : 'Nenhum aviso'}</strong>
          <span>{filtering && notices.length > 0 ? 'Mude o tipo ou a busca para ver os demais.' : 'Quando um post for pulado, falhar ou um perfil entrar em descanso, aparece aqui.'}</span>
        </div>
        : <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {canManage && <th scope="col" className={styles.checkCell}>
                  <input type="checkbox" checked={allVisibleSelected} aria-label="Selecionar todos os avisos da lista" onChange={toggleAllVisible} />
                </th>}
                <th scope="col">Perfil</th>
                <th scope="col">Grupo</th>
                <th scope="col">Formato</th>
                <th scope="col">Horário devido</th>
                <th scope="col">Motivo</th>
                <th scope="col" className={styles.numberCell}>Atraso</th>
                <th scope="col" className={styles.numberCell}>Posts de fora</th>
                <th scope="col">Erro</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((notice) => {
                const key = noticeKey(notice);
                const who = notice.username ? `@${notice.username}` : 'Grupo inteiro';
                return <tr key={key} className={selected.has(key) ? styles.rowSelected : undefined}>
                  {canManage && <td className={styles.checkCell}>
                    <input type="checkbox" checked={selected.has(key)} aria-label={`Selecionar aviso de ${who}`} onChange={() => toggleSelected(notice)} />
                  </td>}
                  <th scope="row">{who}</th>
                  <td>{notice.groupName ?? '—'}</td>
                  <td>{FORMAT_LABEL[notice.format] ?? notice.format}</td>
                  <td className={styles.timeCell}>{formatDateTime(notice.slotAt) || '—'}</td>
                  <td>
                    {NOTICE_KIND_LABEL[notice.kind] ?? notice.kind}
                    {notice.kind === 'profile_rest' && notice.restingUntil && <small className={styles.cellNote}>volta em {formatDateTime(notice.restingUntil)}</small>}
                  </td>
                  <td className={styles.numberCell}>{typeof notice.delaySeconds === 'number' ? `${formatNumber(Math.round(notice.delaySeconds / 60))} min` : '—'}</td>
                  <td className={styles.numberCell}>{typeof notice.skippedCount === 'number' ? formatNumber(notice.skippedCount) : '—'}</td>
                  <td className={styles.errorCell}>
                    {notice.errorCode || notice.errorMessage ? <>
                      {notice.errorCode && <code>{notice.errorCode}</code>}
                      {notice.errorMessage && <span>{notice.errorMessage}</span>}
                    </> : '—'}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>}

    {notices.length >= NOTICE_PAGE_SIZE && <p className={styles.note}>
      A lista mostra os {NOTICE_PAGE_SIZE} avisos mais recentes. Limpe ou filtre por grupo para ver os anteriores.
    </p>}
  </section>;
}

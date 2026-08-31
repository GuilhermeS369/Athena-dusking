'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  EMPTY_DATE_RANGE,
  WEEKDAY_INITIALS,
  addMonths,
  buildMonthGrid,
  buildPresets,
  describeRange,
  isDayInRange,
  monthLabel,
  normalizeRange,
  previewRange,
  rangesAreEqual,
  startOfMonth,
  type DateRange,
} from '@/lib/profiles/date-range';

import styles from './date-range-picker.module.css';

/**
 * Calendário próprio porque o popup de <input type="date"> é desenhado pelo
 * navegador: CSS não alcança nada além de color-scheme, e ele não sabe fazer
 * intervalo. Aqui a grade é nossa, então dá para pintar o intervalo, mostrar a
 * prévia sob o ponteiro e manter a aparência do painel.
 *
 * O clique segue o ritmo do uso real: o primeiro já aplica o dia sozinho (o caso
 * comum é olhar um dia só) e o segundo estende para intervalo. Não existe botão
 * "Aplicar" — cada clique é uma resposta.
 */
export default function DateRangePicker({
  value,
  today,
  onChange,
}: {
  value: DateRange;
  today: string;
  onChange: (range: DateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(value.from ?? today));
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Reabrir o seletor deve mostrar o mês do que já está filtrado, não o mês em
  // que a pessoa parou de navegar da última vez.
  //
  // O efeito depende só de `open`, e é por isso que os valores entram por ref:
  // com `value.from` nas dependências, o primeiro clique de um intervalo
  // disparava o efeito de novo (o popover continua aberto) e zerava o próprio
  // pendingStart que acabara de definir — o segundo clique então recomeçava em
  // vez de fechar o intervalo.
  const latest = useRef({ from: value.from, today });
  latest.current = { from: value.from, today };

  useEffect(() => {
    if (!open) return;
    setMonthAnchor(startOfMonth(latest.current.from ?? latest.current.today));
    setPendingStart(null);
    setHovered(null);
  }, [open]);

  const grid = useMemo(() => buildMonthGrid(monthAnchor), [monthAnchor]);
  const presets = useMemo(() => buildPresets(today), [today]);

  // Enquanto a segunda ponta não foi escolhida, o que se pinta é a prévia sob o
  // ponteiro — assim dá para ver o tamanho do intervalo antes de fechá-lo.
  const painted = pendingStart && hovered ? previewRange(pendingStart, hovered)
    : pendingStart ? { from: pendingStart, to: pendingStart }
    : value;

  function pickDay(iso: string) {
    if (pendingStart) {
      const range = normalizeRange(pendingStart, iso);
      setPendingStart(null);
      setHovered(null);
      onChange(range);
      return;
    }
    setPendingStart(iso);
    setHovered(null);
    onChange({ from: iso, to: iso });
  }

  function applyPreset(range: DateRange) {
    setPendingStart(null);
    setHovered(null);
    setMonthAnchor(startOfMonth(range.from ?? today));
    onChange(range);
  }

  const hasValue = Boolean(value.from || value.to);

  return (
    <div className={styles.wrapper} ref={containerRef}>
      <button
        type="button"
        className={`${styles.trigger} ${hasValue ? styles.triggerActive : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.triggerIcon} aria-hidden="true">▦</span>
        <span className={styles.triggerLabel}>{describeRange(value)}</span>
        <span className={styles.triggerCaret} aria-hidden="true">▾</span>
      </button>

      {hasValue && (
        <button
          type="button"
          className={styles.clear}
          aria-label="Limpar filtro de data de adição"
          title="Limpar data"
          onClick={() => { setPendingStart(null); onChange(EMPTY_DATE_RANGE); }}
        >
          ×
        </button>
      )}

      {open && (
        <div className={styles.popover} role="dialog" aria-label="Filtrar por data de adição">
          <div className={styles.presets}>
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={rangesAreEqual(preset.range, value) ? styles.presetActive : styles.preset}
                onClick={() => applyPreset(preset.range)}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className={styles.monthBar}>
            <button
              type="button"
              className={styles.monthNav}
              aria-label="Mês anterior"
              onClick={() => setMonthAnchor((current) => addMonths(current, -1))}
            >
              ‹
            </button>
            <strong className={styles.monthLabel}>{monthLabel(monthAnchor)}</strong>
            <button
              type="button"
              className={styles.monthNav}
              aria-label="Próximo mês"
              disabled={startOfMonth(monthAnchor) >= startOfMonth(today)}
              onClick={() => setMonthAnchor((current) => addMonths(current, 1))}
            >
              ›
            </button>
          </div>

          <div className={styles.weekdays} aria-hidden="true">
            {WEEKDAY_INITIALS.map((initial, index) => <span key={index}>{initial}</span>)}
          </div>

          <div className={styles.grid} onMouseLeave={() => setHovered(null)}>
            {grid.map((cell) => {
              const future = cell.iso > today;
              const selected = isDayInRange(cell.iso, painted);
              const isStart = painted.from === cell.iso;
              const isEnd = (painted.to ?? painted.from) === cell.iso;
              const classes = [
                styles.day,
                cell.inMonth ? '' : styles.dayOutside,
                selected ? styles.daySelected : '',
                selected && !(isStart && isEnd) ? styles.dayInRange : '',
                isStart ? styles.dayStart : '',
                isEnd ? styles.dayEnd : '',
                cell.iso === today ? styles.dayToday : '',
              ].filter(Boolean).join(' ');
              return (
                <button
                  key={cell.iso}
                  type="button"
                  className={classes}
                  disabled={future}
                  aria-pressed={selected}
                  aria-label={cell.iso}
                  onMouseEnter={() => setHovered(cell.iso)}
                  onClick={() => pickDay(cell.iso)}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>

          <div className={styles.footer}>
            <span className={styles.hint}>
              {pendingStart ? 'Escolha o fim do intervalo, ou feche para ficar no dia.' : 'Clique num dia, e num segundo para formar um intervalo.'}
            </span>
            <button
              type="button"
              className={styles.footerAction}
              disabled={!hasValue}
              onClick={() => { setPendingStart(null); onChange(EMPTY_DATE_RANGE); }}
            >
              Limpar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * KpiConfigMenu — popover that lets the operator hide, show, and
 * reorder the cards in the Analytics KPI strip.
 *
 * Lives entirely in the client today: layout persists to localStorage
 * keyed per workspace. The shape is intentionally a single ordered
 * array of `{ key, visible }` rather than two separate lists — that
 * way reorder and visibility round-trip together in one write and
 * never desync, and the strip can render straight from the array
 * with a `.filter(visible)` instead of zipping two structures.
 *
 * Server-backed persistence is out of scope for the v1 — when an
 * endpoint lands, swap `loadLayout` / `saveLayout` for an API call.
 *
 * Drag-and-drop uses the native HTML5 DnD API rather than a library:
 * the strip has a fixed 8-card universe, so the simplest implementation
 * that handles keyboard fallback (labelled Move up/down buttons)
 * + visual drop indicator is faster than pulling in dnd-kit. We don't
 * use pointer events because native DnD gives us "drop on the gap
 * between rows" semantics for free via the row's top/bottom half.
 */

import {
  type FocusEvent,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDialogStack } from "../../hooks/useDialogStack";
import { popDialog, pushDialog } from "../../lib/dialogStack";

import "../../styles-analytics-popups.css";

/**
 * Stable keys for the 8 KPI cards rendered in the Analytics strip.
 * Mirrored in the page's per-key `<KpiCard>` map. Adding a card means
 * adding a key here AND a render branch in the page — the page treats
 * unknown keys as "skip" so a future card is opt-in (won't appear in
 * a returning user's saved layout until they reset).
 */
export type KpiKey =
  | "subscribers"
  | "opens"
  | "clicks"
  | "replies"
  | "bounces"
  | "unsubs"
  | "deliverability"
  | "revenue";

export interface KpiEntry {
  key: KpiKey;
  visible: boolean;
}

/**
 * Default layout — order matches the pre-feature hard-coded JSX in
 * Analytics.tsx so a fresh load looks identical. `revenue` ships
 * visible because the page already hides it when the workspace has
 * zero captured revenue (the card renders `null`), so leaving it on
 * is a no-op for workspaces without commerce data.
 */
export const DEFAULT_KPI_LAYOUT: ReadonlyArray<KpiEntry> = [
  { key: "subscribers", visible: true },
  { key: "opens", visible: true },
  { key: "clicks", visible: true },
  { key: "replies", visible: true },
  { key: "bounces", visible: true },
  { key: "unsubs", visible: true },
  { key: "deliverability", visible: true },
  { key: "revenue", visible: true },
];

/** Human-readable labels for the config menu rows. */
const KPI_LABELS: Record<KpiKey, string> = {
  subscribers: "Subscribers",
  opens: "Open rate",
  clicks: "Click rate",
  replies: "Reply rate",
  bounces: "Bounce rate",
  unsubs: "Unsubscribes",
  deliverability: "Deliverability",
  revenue: "Revenue",
};

const ALL_KEYS = DEFAULT_KPI_LAYOUT.map((e) => e.key) as ReadonlyArray<KpiKey>;
const VALID_KEY_SET: ReadonlySet<KpiKey> = new Set(ALL_KEYS);

/** Identity-scoped localStorage key; the historical global record is removed
 * because its owning workspace cannot be proven after an account switch. */
const LS_KEY = "postwave.analytics.kpi-layout.v1";
const STORAGE_SCOPE_RE = /^[A-Za-z0-9._-]{1,64}$/u;

/** Visibility floor + ceiling per the acceptance criteria. The popover
 *  disables the last visible checkbox so the operator can't reduce
 *  the strip to zero, and disables further toggles past the cap so
 *  the grid layout stays readable. */
export const MIN_VISIBLE_KPIS = 4;
export const MAX_VISIBLE_KPIS = 8;

/**
 * Normalise an arbitrary persisted blob back into a clean layout.
 * Drops unknown keys (e.g. a card we removed), appends any missing
 * default keys to the tail so a returning user picks up new cards
 * with visible=false (opt-in), and clamps visible-count into the
 * supported [4..8] window.
 */
export function normalizeLayout(input: unknown): KpiEntry[] {
  const fallback = DEFAULT_KPI_LAYOUT.map((e) => ({ ...e }));
  if (!Array.isArray(input)) return fallback;
  const seen = new Set<KpiKey>();
  const cleaned: KpiEntry[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as { key?: unknown; visible?: unknown };
    if (typeof r.key !== "string") continue;
    if (!VALID_KEY_SET.has(r.key as KpiKey)) continue;
    if (seen.has(r.key as KpiKey)) continue;
    seen.add(r.key as KpiKey);
    cleaned.push({
      key: r.key as KpiKey,
      visible: r.visible !== false,
    });
  }
  // Append any default keys the persisted layout didn't mention so
  // newly-introduced cards show up (defaulting to hidden — see comment
  // at the top about opt-in for returning users).
  for (const entry of DEFAULT_KPI_LAYOUT) {
    if (!seen.has(entry.key)) {
      cleaned.push({ key: entry.key, visible: false });
    }
  }
  // Clamp visible count into [MIN..MAX]. If under-min, promote the
  // first hidden entries in order. If over-max, demote from the tail.
  const visibleCount = cleaned.filter((e) => e.visible).length;
  if (visibleCount < MIN_VISIBLE_KPIS) {
    let need = MIN_VISIBLE_KPIS - visibleCount;
    for (const e of cleaned) {
      if (need <= 0) break;
      if (!e.visible) {
        e.visible = true;
        need -= 1;
      }
    }
  } else if (visibleCount > MAX_VISIBLE_KPIS) {
    let extra = visibleCount - MAX_VISIBLE_KPIS;
    for (let i = cleaned.length - 1; i >= 0 && extra > 0; i -= 1) {
      const entry = cleaned[i];
      if (entry && entry.visible) {
        entry.visible = false;
        extra -= 1;
      }
    }
  }
  return cleaned;
}

function layoutStorageKey(scope: string | null): string | null {
  return scope && STORAGE_SCOPE_RE.test(scope) ? `${LS_KEY}:${scope}` : null;
}

export function loadLayout(scope: string | null): KpiEntry[] {
  if (typeof window === "undefined") {
    return DEFAULT_KPI_LAYOUT.map((e) => ({ ...e }));
  }
  try {
    window.localStorage.removeItem(LS_KEY);
    const key = layoutStorageKey(scope);
    if (!key) return DEFAULT_KPI_LAYOUT.map((e) => ({ ...e }));
    const raw = window.localStorage.getItem(key);
    if (!raw) return DEFAULT_KPI_LAYOUT.map((e) => ({ ...e }));
    return normalizeLayout(JSON.parse(raw));
  } catch {
    return DEFAULT_KPI_LAYOUT.map((e) => ({ ...e }));
  }
}

export function saveLayout(scope: string | null, layout: KpiEntry[]): void {
  if (typeof window === "undefined") return;
  const key = layoutStorageKey(scope);
  if (!key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(normalizeLayout(layout)));
  } catch {
    /* quota or disabled-storage profiles — preference loss is fine */
  }
}

interface Props {
  layout: KpiEntry[];
  onChange: (next: KpiEntry[]) => void;
}

interface PopoverInteractionOptions {
  closePopover: (restoreFocus?: boolean) => void;
  open: boolean;
  popoverId: string;
  popoverRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

function useKpiPopoverInteraction({
  closePopover,
  open,
  popoverId,
  popoverRef,
  triggerRef,
}: PopoverInteractionOptions): void {
  const { isTop } = useDialogStack(popoverId);

  useEffect(() => {
    if (!open) return;
    pushDialog(popoverId);
    return () => popDialog(popoverId);
  }, [open, popoverId]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      popoverRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open, popoverRef]);

  useEffect(() => {
    if (!open || !isTop) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.isComposing ||
        event.keyCode === 229 ||
        event.key !== "Escape"
      ) {
        return;
      }
      event.preventDefault();
      closePopover(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closePopover, isTop, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      closePopover(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closePopover, open, popoverRef, triggerRef]);
}

export function KpiConfigMenu({ layout, onChange }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const popoverId = useId();
  const triggerId = useId();
  const headingId = useId();
  const descriptionId = useId();
  /**
   * Drag-and-drop state. `dragKey` is the row being dragged;
   * `dropKey` is the row the pointer is currently hovering over.
   * We split these so the row can render its own drop-indicator
   * without re-querying the dragged element on every dragover tick.
   */
  const [dragKey, setDragKey] = useState<KpiKey | null>(null);
  const [dropKey, setDropKey] = useState<KpiKey | null>(null);

  const closePopover = useCallback((restoreFocus = false): void => {
    setOpen(false);
    setDragKey(null);
    setDropKey(null);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useKpiPopoverInteraction({
    closePopover,
    open,
    popoverId,
    popoverRef,
    triggerRef,
  });

  const visibleCount = useMemo(
    () => layout.filter((e) => e.visible).length,
    [layout],
  );

  function toggleVisible(key: KpiKey): void {
    const entry = layout.find((e) => e.key === key);
    if (!entry) return;
    // Floor: the last visible card can't be hidden — the strip needs
    // at least MIN_VISIBLE_KPIS cards so the auto-reflow grid has
    // something to render. Cap: pinning visibility past MAX_VISIBLE_KPIS
    // would break the 4-column reflow target.
    if (entry.visible && visibleCount <= MIN_VISIBLE_KPIS) return;
    if (!entry.visible && visibleCount >= MAX_VISIBLE_KPIS) return;
    onChange(
      layout.map((e) => (e.key === key ? { ...e, visible: !e.visible } : e)),
    );
    const nextVisibleCount = visibleCount + (entry.visible ? -1 : 1);
    setAnnouncement(
      `${KPI_LABELS[key]} ${entry.visible ? "hidden" : "shown"}. ${nextVisibleCount} of ${layout.length} cards visible.`,
    );
  }

  function moveTo(srcKey: KpiKey, destKey: KpiKey): void {
    if (srcKey === destKey) return;
    const srcIdx = layout.findIndex((e) => e.key === srcKey);
    const destIdx = layout.findIndex((e) => e.key === destKey);
    if (srcIdx < 0 || destIdx < 0) return;
    const next = layout.slice();
    const [moved] = next.splice(srcIdx, 1);
    if (!moved) return;
    next.splice(destIdx, 0, moved);
    onChange(next);
    const nextPosition = next.findIndex((entry) => entry.key === srcKey) + 1;
    setAnnouncement(
      `${KPI_LABELS[srcKey]} moved to position ${nextPosition} of ${next.length}.`,
    );
  }

  /** Native Move up/down buttons provide the keyboard equivalent of drag. */
  function moveByOffset(key: KpiKey, offset: -1 | 1): void {
    const idx = layout.findIndex((e) => e.key === key);
    if (idx < 0) return;
    const dest = idx + offset;
    if (dest < 0 || dest >= layout.length) return;
    const next = layout.slice();
    const [moved] = next.splice(idx, 1);
    if (!moved) return;
    next.splice(dest, 0, moved);
    onChange(next);
    setAnnouncement(
      `${KPI_LABELS[key]} moved to position ${dest + 1} of ${next.length}.`,
    );
  }

  function reset(): void {
    onChange(DEFAULT_KPI_LAYOUT.map((e) => ({ ...e })));
    setAnnouncement("KPI cards restored to the default order and visibility.");
  }

  function handlePopoverBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget as Node | null;
    if (next && popoverRef.current?.contains(next)) return;
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && popoverRef.current?.contains(active)) return;
      closePopover(false);
    });
  }

  return (
    <div className="analytics-popup-anchor">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="btn btn-sm"
        onClick={() => (open ? closePopover(false) : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
        aria-label="Configure KPI cards"
        style={{
          // Square-ish button matches the visual weight of a gear icon
          // glyph sitting at the end of the strip without a label.
          padding: "0 8px",
          minWidth: 32,
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        <span aria-hidden>⚙</span>
      </button>
      {open ? (
        <div
          ref={popoverRef}
          id={popoverId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          aria-describedby={descriptionId}
          tabIndex={-1}
          className="analytics-popup analytics-popup--kpi"
          onBlurCapture={handlePopoverBlur}
        >
          <div className="analytics-kpi-header">
            <div>
              <h2 id={headingId} className="analytics-popup-heading">
                KPI cards
              </h2>
              <p id={descriptionId} className="analytics-popup-description">
                {visibleCount} of {layout.length} visible. Drag rows, or use
                each row&apos;s Move up and Move down buttons.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={reset}
              aria-label="Reset KPI cards to default order and visibility"
              style={{
                fontSize: 11,
                padding: "2px 8px",
              }}
            >
              Reset
            </button>
          </div>
          <span className="visually-hidden" role="status" aria-live="polite">
            {announcement}
          </span>
          <ul className="analytics-kpi-list">
            {layout.map((entry, index) => {
              const isDragging = dragKey === entry.key;
              const isDropTarget =
                dropKey === entry.key &&
                dragKey !== null &&
                dragKey !== entry.key;
              const isOnlyVisible =
                entry.visible && visibleCount <= MIN_VISIBLE_KPIS;
              const wouldExceedMax =
                !entry.visible && visibleCount >= MAX_VISIBLE_KPIS;
              const limitReason = isOnlyVisible
                ? `Keep at least ${MIN_VISIBLE_KPIS} cards visible.`
                : wouldExceedMax
                  ? `At most ${MAX_VISIBLE_KPIS} cards can be visible.`
                  : null;
              const limitReasonId = `${popoverId}-${entry.key}-limit`;
              return (
                // A list item is the pointer drag target; the adjacent native
                // Move buttons provide the equivalent keyboard operation.
                // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                <li
                  key={entry.key}
                  draggable
                  onDragStart={(e) => {
                    setDragKey(entry.key);
                    // setData is required by Firefox to actually start
                    // the drag — empty string is fine, we keep the
                    // source key in React state.
                    e.dataTransfer.setData("text/plain", entry.key);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (dragKey === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dropKey !== entry.key) setDropKey(entry.key);
                  }}
                  onDragLeave={() => {
                    // Only clear when the leave matches the current
                    // target so adjacent enter/leave events don't
                    // strobe the indicator.
                    if (dropKey === entry.key) setDropKey(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragKey && dragKey !== entry.key) {
                      moveTo(dragKey, entry.key);
                    }
                    setDragKey(null);
                    setDropKey(null);
                  }}
                  onDragEnd={() => {
                    setDragKey(null);
                    setDropKey(null);
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "16px 1fr auto",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 6,
                    cursor: "grab",
                    background: isDragging
                      ? "color-mix(in srgb, var(--pw-accent) 12%, transparent)"
                      : "transparent",
                    borderTop: isDropTarget
                      ? "2px solid var(--pw-accent)"
                      : "2px solid transparent",
                    opacity: isDragging ? 0.6 : 1,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      color: "var(--pw-fg-subtle)",
                      fontSize: 14,
                      lineHeight: 1,
                      userSelect: "none",
                    }}
                  >
                    ⋮⋮
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <label
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        fontSize: 12,
                        color: "var(--pw-fg)",
                        cursor:
                          isOnlyVisible || wouldExceedMax
                            ? "not-allowed"
                            : "pointer",
                        userSelect: "none",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={entry.visible}
                        disabled={isOnlyVisible || wouldExceedMax}
                        aria-describedby={
                          limitReason ? limitReasonId : undefined
                        }
                        onChange={() => toggleVisible(entry.key)}
                        style={{ accentColor: "var(--pw-accent)" }}
                      />
                      <span>{KPI_LABELS[entry.key]}</span>
                    </label>
                    {limitReason ? (
                      <span
                        id={limitReasonId}
                        className="analytics-kpi-limit-reason"
                      >
                        {limitReason}
                      </span>
                    ) : null}
                  </div>
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 2,
                    }}
                  >
                    <span
                      className="muted"
                      style={{ fontSize: 10, marginRight: 2 }}
                    >
                      {entry.visible ? "shown" : "hidden"}
                    </span>
                    <button
                      type="button"
                      className="link-button"
                      disabled={index === 0}
                      aria-label={`Move ${KPI_LABELS[entry.key]} up`}
                      onClick={() => moveByOffset(entry.key, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      disabled={index === layout.length - 1}
                      aria-label={`Move ${KPI_LABELS[entry.key]} down`}
                      onClick={() => moveByOffset(entry.key, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="analytics-kpi-footer">
            Saved in this browser · drag or use the labelled move buttons
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Helper for the page: derive the grid-template-columns value from the
 *  visible-card count. Per acceptance criteria: 4 → 4 cols, 6 → 3 cols,
 *  8 → 4 cols. Other counts (5, 7) fall through to the closest fit so
 *  the strip never overflows into a single row of awkward widths. */
export function gridColumnsFor(visibleCount: number): number {
  if (visibleCount <= 4) return 4;
  if (visibleCount === 5) return 5;
  if (visibleCount === 6) return 3;
  if (visibleCount === 7) return 4;
  return 4;
}

/** Pure helper exported for the page render path. Returns only the
 *  visible keys in their persisted order. */
export function visibleKeys(layout: KpiEntry[]): KpiKey[] {
  return layout.filter((e) => e.visible).map((e) => e.key);
}

/**
 * DashboardToolbar — top row: title context + range picker +
 * refresh button + a slot for the live/stale indicator.
 *
 * Stateless. All actions bubble to the page.
 */

import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { type DashboardRange } from "../../lib/api-client";
import { Icon } from "../Icon";

interface Props {
  range: DashboardRange;
  loading: boolean;
  liveSlot?: ReactNode;
  onRangeChange: (r: DashboardRange) => void;
  onRefresh: () => void | Promise<void>;
  /** PR 2: copies a markdown snapshot of the visible metrics. */
  onShare?: () => Promise<boolean>;
  shareAvailable?: boolean;
  /** Full-surface wiring (2026-06): toggles the section reorder mode.
   *  Button only renders when the handler is provided. */
  editingLayout?: boolean;
  layoutSaving?: boolean;
  onToggleEditLayout?: () => void;
}

const RANGES: {
  value: DashboardRange;
  label: string;
  accessibleName: string;
}[] = [
  { value: "7d", label: "7d", accessibleName: "Last 7 days" },
  { value: "30d", label: "30d", accessibleName: "Last 30 days" },
  { value: "90d", label: "90d", accessibleName: "Last 90 days" },
];

export function DashboardToolbar({
  range,
  loading,
  liveSlot,
  onRangeChange,
  onRefresh,
  onShare,
  shareAvailable = true,
  editingLayout = false,
  layoutSaving = false,
  onToggleEditLayout,
}: Props): ReactElement {
  const rangeLabelId = useId();
  const refreshActiveRef = useRef(true);
  const refreshBusyRef = useRef(false);
  const refreshAttemptRef = useRef(0);
  const [refreshPending, setRefreshPending] = useState(false);
  useEffect(() => {
    refreshActiveRef.current = true;
    return () => {
      refreshActiveRef.current = false;
    };
  }, []);
  useEffect(() => {
    refreshAttemptRef.current += 1;
    refreshBusyRef.current = false;
    setRefreshPending(false);
  }, [range]);
  const refreshing = loading || refreshPending;
  const refresh = async (): Promise<void> => {
    if (refreshing || refreshBusyRef.current) return;
    const attempt = ++refreshAttemptRef.current;
    refreshBusyRef.current = true;
    setRefreshPending(true);
    try {
      await onRefresh();
    } catch {
      // The owning controller exposes a stable inline failure state.
    } finally {
      if (attempt !== refreshAttemptRef.current) return;
      refreshBusyRef.current = false;
      if (refreshActiveRef.current) setRefreshPending(false);
    }
  };
  return (
    <div className="dash-toolbar" role="group" aria-label="Dashboard controls">
      <div className="dash-toolbar-range">
        <span id={rangeLabelId} className="dash-toolbar-label">
          Reporting window
        </span>
        <div
          className="lib-segmented"
          role="group"
          aria-labelledby={rangeLabelId}
        >
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              className={range === r.value ? "is-active" : ""}
              aria-pressed={range === r.value}
              aria-label={r.accessibleName}
              onClick={() => onRangeChange(r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div className="dash-toolbar-end">
        {liveSlot ? (
          <div className="dash-toolbar-live" aria-label="Data freshness">
            {liveSlot}
          </div>
        ) : null}
        <div className="dash-toolbar-actions">
          {onShare ? (
            <ShareButton onShare={onShare} available={shareAvailable} />
          ) : null}
          {onToggleEditLayout ? (
            <button
              type="button"
              className={
                editingLayout
                  ? "btn btn-primary dash-toolbar-button"
                  : "btn dash-toolbar-button"
              }
              onClick={() => {
                if (!layoutSaving) onToggleEditLayout();
              }}
              aria-pressed={editingLayout}
              aria-disabled={layoutSaving || undefined}
              aria-busy={layoutSaving || undefined}
              aria-label={
                layoutSaving
                  ? "Saving dashboard layout"
                  : editingLayout
                    ? "Finish rearranging dashboard sections"
                    : "Rearrange the dashboard's card sections"
              }
            >
              <Icon
                name={editingLayout ? "shield-check" : "pencil"}
                size={14}
              />
              {layoutSaving
                ? "Saving layout…"
                : editingLayout
                  ? "Done"
                  : "Edit layout"}
            </button>
          ) : null}
          <button
            type="button"
            className="btn dash-toolbar-button"
            onClick={() => void refresh()}
            aria-disabled={refreshing || undefined}
            aria-busy={refreshing || undefined}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Local inline-feedback wrapper — the toast can be missed if the page
 *  is busy, so we also flash the button label to "Copied!" briefly. */
function ShareButton({
  onShare,
  available,
}: {
  onShare: () => Promise<boolean>;
  available: boolean;
}): ReactElement {
  const activeRef = useRef(true);
  const busyRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const descriptionId = useId();
  const statusId = useId();
  const [feedback, setFeedback] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const share = async (): Promise<void> => {
    if (!available || busyRef.current) return;
    busyRef.current = true;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setFeedback("idle");
    setBusy(true);
    let copied = false;
    try {
      copied = await onShare();
    } catch {
      copied = false;
    }
    if (!activeRef.current) return;
    busyRef.current = false;
    setBusy(false);
    if (!copied) {
      setFeedback("failed");
      return;
    }
    setFeedback("copied");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      if (activeRef.current) setFeedback("idle");
      timerRef.current = null;
    }, 1500);
  };

  return (
    <span className="dash-toolbar-action">
      <button
        type="button"
        className="btn dash-toolbar-button"
        onClick={() => void share()}
        aria-disabled={!available || busy || undefined}
        aria-busy={busy || undefined}
        aria-label={
          available
            ? "Share dashboard snapshot"
            : "Share dashboard snapshot — available after metrics load"
        }
        aria-describedby={`${descriptionId} ${statusId}`}
      >
        {busy
          ? "Copying…"
          : !available
            ? "Share after load"
            : feedback === "copied"
              ? "Copied!"
              : feedback === "failed"
                ? "Retry share"
                : "Share"}
      </button>
      <span id={descriptionId} className="visually-hidden">
        {available
          ? "Copy a Markdown snapshot of the visible dashboard metrics."
          : "Dashboard metrics must finish loading before a snapshot can be copied."}
      </span>
      <span
        id={statusId}
        className={
          feedback === "idle" ? "visually-hidden" : "dash-toolbar-feedback"
        }
        role="status"
        aria-live="polite"
      >
        {feedback === "copied"
          ? "Dashboard snapshot copied."
          : feedback === "failed"
            ? "Copy failed. Try again."
            : ""}
      </span>
    </span>
  );
}

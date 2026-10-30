import {
  type CSSProperties,
  type FocusEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useDialogStack } from "../../hooks/useDialogStack";
import { useMenuInteraction } from "../../hooks/useMenuInteraction";
import { anchoredPopoverPosition } from "../../lib/anchored-popover-position";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import type { SavedSegment } from "../../lib/api-client";
import {
  type SavedPreviewEntry,
  savedCountIsStale,
  savedPreviewIsStale,
} from "./saved-segment-preview-state";

interface Props {
  segments: SavedSegment[];
  activeSegmentId?: string | null;
  loading: boolean;
  error: string | null;
  previews: Record<string, SavedPreviewEntry>;
  open: boolean;
  atLimit: boolean;
  maxItems: number;
  onToggle: () => void;
  onApply: (segment: SavedSegment) => void;
  onRemove: (segment: SavedSegment) => void;
  onOpenSaveCurrent: () => void;
  onRetry?: () => void;
  onRequestPreview: (segmentId: string, force?: boolean) => void;
  canMutate: boolean;
}

export function SubscribersSavedSegmentsMenu({
  segments,
  activeSegmentId = null,
  loading,
  error,
  previews,
  open,
  atLimit,
  maxItems,
  onToggle,
  onApply,
  onRemove,
  onOpenSaveCurrent,
  onRetry,
  onRequestPreview,
  canMutate,
}: Props): ReactElement {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const closingRef = useRef(false);
  const menuId = useId();
  const triggerId = useId();
  const saveReasonId = useId();
  const [, setPositionRevision] = useState(0);
  const [activeActionKey, setActiveActionKey] = useState<string | null>(null);
  const { isTop } = useDialogStack(menuId);
  const closeMenu = useCallback((): void => {
    if (!open || closingRef.current) return;
    closingRef.current = true;
    onToggle();
  }, [onToggle, open]);

  useEffect(() => {
    if (!open) return;
    closingRef.current = false;
    pushDialog(menuId);
    return () => popDialog(menuId);
  }, [menuId, open]);

  useEffect(() => {
    if (!open) return;
    let frame: number | null = null;
    const refreshPosition = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setPositionRevision((revision) => revision + 1);
      });
    };
    refreshPosition();
    window.addEventListener("resize", refreshPosition);
    window.addEventListener("scroll", refreshPosition, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", refreshPosition);
      window.removeEventListener("scroll", refreshPosition, true);
    };
  }, [open]);

  const firstActionKey = error
    ? "retry"
    : segments.length > 0
      ? `apply:${segments[0]!.id}`
      : "save";
  const actionExists =
    activeActionKey === "save" ||
    (activeActionKey === "retry" && Boolean(error)) ||
    segments.some(({ id }) =>
      [`apply:${id}`, `refresh:${id}`, `delete:${id}`].includes(
        activeActionKey ?? "",
      ),
    );
  const rovingActionKey = actionExists ? activeActionKey : firstActionKey;

  useMenuInteraction({
    isTop,
    itemSelector: '[role="menuitem"]:not([data-menu-static="true"])',
    menuRef,
    onClose: closeMenu,
    open,
    selectedItemSelector: '[data-roving-current="true"]',
    trigger: triggerRef.current,
  });

  const handoff = (action: () => void): void => {
    triggerRef.current?.focus();
    closeMenu();
    action();
  };
  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (
      next &&
      (menuRef.current?.contains(next) || triggerRef.current?.contains(next))
    ) {
      return;
    }
    window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        (active && menuRef.current?.contains(active)) ||
        (active && triggerRef.current?.contains(active))
      ) {
        return;
      }
      closeMenu();
    });
  };
  const anchor = triggerRef.current?.getBoundingClientRect() ?? {
    bottom: 8,
    left: 8,
    right: 8,
    top: 8,
  };
  const position = anchoredPopoverPosition(
    anchor,
    window.innerWidth,
    window.innerHeight,
    { preferredWidth: 380, minimumHeight: 220 },
  );
  const activeSegment = segments.find(({ id }) => id === activeSegmentId);

  return (
    <div style={{ display: "inline-flex" }}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="btn btn-sm"
        onClick={() => (open ? closeMenu() : onToggle())}
        onKeyDown={(event) => {
          if (
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            (event.key === "ArrowDown" || event.key === "ArrowUp")
          ) {
            event.preventDefault();
            if (!open) onToggle();
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={
          activeSegment
            ? `Saved segments. Active view: ${activeSegment.name}`
            : "Saved segments"
        }
      >
        {activeSegment ? `View: ${activeSegment.name}` : "Saved segments"}
        {!activeSegment && segments.length > 0 ? ` (${segments.length})` : ""}
        <span aria-hidden="true" style={{ marginLeft: 4 }}>
          ▾
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-labelledby={triggerId}
              onBlurCapture={handleBlur}
              style={menuStyle(position)}
            >
              <MenuContent
                segments={segments}
                activeSegmentId={activeSegmentId}
                loading={loading}
                error={error}
                previews={previews}
                rovingActionKey={rovingActionKey}
                menuId={menuId}
                canMutate={canMutate}
                onActionFocus={setActiveActionKey}
                onApply={(segment) => handoff(() => onApply(segment))}
                onRemove={(segment) => handoff(() => onRemove(segment))}
                onRetry={onRetry}
                onRequestPreview={onRequestPreview}
              />
              <div role="separator" className="subscribers-saved-separator" />
              <button
                type="button"
                role="menuitem"
                tabIndex={rovingActionKey === "save" ? 0 : -1}
                data-roving-current={
                  rovingActionKey === "save" ? "true" : undefined
                }
                className="btn btn-sm btn-ghost"
                aria-label="Save current segment"
                aria-disabled={!canMutate || atLimit || undefined}
                aria-describedby={saveReasonId}
                style={{ width: "100%", justifyContent: "flex-start" }}
                onFocus={() => setActiveActionKey("save")}
                onClick={() => {
                  if (canMutate && !atLimit) handoff(onOpenSaveCurrent);
                }}
              >
                Save current segment…
              </button>
              <div id={saveReasonId} role="none" className="pw-action-status">
                {!canMutate
                  ? "Viewer access can apply segments but can’t save them."
                  : atLimit
                    ? `The workspace limit of ${maxItems.toLocaleString()} saved segments has been reached.`
                    : "Choose personal or workspace sharing before saving the exact Directory view."}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function MenuContent(props: {
  segments: SavedSegment[];
  activeSegmentId: string | null;
  loading: boolean;
  error: string | null;
  previews: Record<string, SavedPreviewEntry>;
  rovingActionKey: string | null;
  menuId: string;
  canMutate: boolean;
  onActionFocus: (key: string) => void;
  onApply: (segment: SavedSegment) => void;
  onRemove: (segment: SavedSegment) => void;
  onRetry?: () => void;
  onRequestPreview: (segmentId: string, force?: boolean) => void;
}): ReactElement {
  const hasVerifiedItems = props.segments.length > 0;
  if (props.error && !hasVerifiedItems) {
    return (
      <div role="none" className="subscribers-saved-menu-state">
        <div className="muted" role="alert">
          Saved segments unavailable: {props.error}
        </div>
        <button
          type="button"
          role="menuitem"
          className="btn btn-sm btn-ghost"
          tabIndex={props.rovingActionKey === "retry" ? 0 : -1}
          data-roving-current={
            props.rovingActionKey === "retry" ? "true" : undefined
          }
          aria-disabled={props.loading || undefined}
          onFocus={() => props.onActionFocus("retry")}
          onClick={() => {
            if (!props.loading) props.onRetry?.();
          }}
        >
          {props.loading ? "Retrying saved segments…" : "Retry saved segments"}
        </button>
      </div>
    );
  }
  if (props.loading && !hasVerifiedItems) {
    return (
      <div
        role="menuitem"
        aria-disabled="true"
        tabIndex={-1}
        data-menu-static="true"
        className="muted subscribers-saved-menu-static"
      >
        Loading saved segments…
      </div>
    );
  }
  if (!hasVerifiedItems) {
    return (
      <div
        role="menuitem"
        aria-disabled="true"
        tabIndex={-1}
        data-menu-static="true"
        className="muted subscribers-saved-menu-static"
      >
        No saved segments yet.
      </div>
    );
  }
  return (
    <>
      {props.error ? (
        <div role="none" className="subscribers-saved-menu-state">
          <div className="muted" role="alert">
            Refresh failed: {props.error} The last verified list remains
            available.
          </div>
          <button
            type="button"
            role="menuitem"
            className="btn btn-sm btn-ghost"
            tabIndex={props.rovingActionKey === "retry" ? 0 : -1}
            data-roving-current={
              props.rovingActionKey === "retry" ? "true" : undefined
            }
            aria-disabled={props.loading || undefined}
            onFocus={() => props.onActionFocus("retry")}
            onClick={() => {
              if (!props.loading) props.onRetry?.();
            }}
          >
            {props.loading
              ? "Retrying saved segments…"
              : "Retry saved segments"}
          </button>
        </div>
      ) : props.loading ? (
        <div
          role="menuitem"
          aria-disabled="true"
          tabIndex={-1}
          data-menu-static="true"
          className="muted subscribers-saved-menu-static"
        >
          Refreshing saved segments… The last verified list remains available.
        </div>
      ) : null}
      {props.segments.map((segment) => (
        <SavedSegmentMenuRow
          key={segment.id}
          segment={segment}
          active={segment.id === props.activeSegmentId}
          entry={props.previews[segment.id]}
          menuId={props.menuId}
          rovingActionKey={props.rovingActionKey}
          canMutate={props.canMutate}
          onActionFocus={props.onActionFocus}
          onApply={() => props.onApply(segment)}
          onRemove={() => props.onRemove(segment)}
          onRequestPreview={props.onRequestPreview}
        />
      ))}
    </>
  );
}

function SavedSegmentMenuRow(props: {
  segment: SavedSegment;
  active: boolean;
  entry: SavedPreviewEntry | undefined;
  menuId: string;
  rovingActionKey: string | null;
  canMutate: boolean;
  onActionFocus: (key: string) => void;
  onApply: () => void;
  onRemove: () => void;
  onRequestPreview: (segmentId: string, force?: boolean) => void;
}): ReactElement {
  const applyKey = `apply:${props.segment.id}`;
  const refreshKey = `refresh:${props.segment.id}`;
  const deleteKey = `delete:${props.segment.id}`;
  const deleteReasonId = `${props.menuId}-${props.segment.id}-delete-reason`;
  const loading = props.entry?.kind === "loading";
  return (
    <div role="none" className="subscribers-saved-menu-row">
      <button
        type="button"
        className="btn btn-sm btn-ghost subscribers-saved-apply"
        role="menuitem"
        tabIndex={props.rovingActionKey === applyKey ? 0 : -1}
        data-roving-current={
          props.rovingActionKey === applyKey ? "true" : undefined
        }
        aria-current={props.active ? "true" : undefined}
        onPointerEnter={() => props.onRequestPreview(props.segment.id)}
        onFocus={() => {
          props.onActionFocus(applyKey);
          props.onRequestPreview(props.segment.id);
        }}
        onClick={props.onApply}
      >
        <span>{props.segment.name}</span>
        {props.active ? <span className="muted">Active</span> : null}
        <SavedSegmentCount segment={props.segment} entry={props.entry} />
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        role="menuitem"
        tabIndex={props.rovingActionKey === refreshKey ? 0 : -1}
        data-roving-current={
          props.rovingActionKey === refreshKey ? "true" : undefined
        }
        aria-label={`Refresh live count for ${props.segment.name}`}
        aria-disabled={loading || undefined}
        onFocus={() => props.onActionFocus(refreshKey)}
        onClick={() => {
          if (!loading) props.onRequestPreview(props.segment.id, true);
        }}
      >
        {loading ? "Checking…" : "Refresh count"}
      </button>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        role="menuitem"
        tabIndex={props.rovingActionKey === deleteKey ? 0 : -1}
        data-roving-current={
          props.rovingActionKey === deleteKey ? "true" : undefined
        }
        aria-label={`Delete ${props.segment.name}`}
        aria-disabled={!props.canMutate || undefined}
        aria-describedby={props.canMutate ? undefined : deleteReasonId}
        onFocus={() => props.onActionFocus(deleteKey)}
        onClick={() => {
          if (props.canMutate) props.onRemove();
        }}
      >
        Delete
        {!props.canMutate ? (
          <span id={deleteReasonId} className="visually-hidden">
            Viewer access cannot delete saved segments.
          </span>
        ) : null}
      </button>
    </div>
  );
}

function SavedSegmentCount({
  segment,
  entry,
}: {
  segment: SavedSegment;
  entry: SavedPreviewEntry | undefined;
}): ReactElement {
  if (entry?.kind === "loading") {
    return (
      <span className="pw-action-status" aria-busy="true" aria-live="polite">
        Verifying aggregate count…
      </span>
    );
  }
  if (entry?.kind === "unevaluable") {
    return (
      <span className="pw-action-status">
        Older definition · live count unavailable
      </span>
    );
  }
  if (entry?.kind === "err") {
    return (
      <span className="pw-action-status" role="alert">
        Live count unavailable · {entry.failure.message} Use Refresh count to
        retry.
      </span>
    );
  }
  if (entry?.kind === "ok") {
    const stale = savedPreviewIsStale(entry);
    return (
      <span className="pw-action-status" aria-live="polite">
        <span className="badge">
          {entry.preview.count.toLocaleString()} match
          {entry.preview.count === 1 ? "" : "es"}
        </span>{" "}
        · {entry.preview.count.toLocaleString()} of{" "}
        {entry.preview.workspace_total.toLocaleString()} subscribers ·{" "}
        {entry.preview.workspace_percentage.toLocaleString()}% of workspace ·{" "}
        {stale ? "stale; refresh required" : "aggregate verified"} · generated{" "}
        <time dateTime={entry.preview.generated_at}>
          {formatSavedCountTime(entry.preview.generated_at)}
        </time>
      </span>
    );
  }
  if (segment.last_count != null && segment.last_evaluated_at) {
    const stale = savedCountIsStale(segment.last_evaluated_at);
    return (
      <span className="pw-action-status">
        {segment.last_count.toLocaleString()} stored match
        {segment.last_count === 1 ? "" : "es"} · {stale ? "stale" : "recent"} ·{" "}
        focus or refresh to verify
      </span>
    );
  }
  return (
    <span className="pw-action-status">
      Count not verified · focus or refresh to check
    </span>
  );
}

function formatSavedCountTime(value: string): string {
  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function menuStyle(
  position: ReturnType<typeof anchoredPopoverPosition>,
): CSSProperties {
  return {
    ...position,
    background: "var(--pw-bg-elev)",
    border: "1px solid var(--pw-border)",
    borderRadius: 8,
    boxShadow:
      "0 12px 32px color-mix(in srgb, var(--pw-shadow-color) 24%, transparent)",
    padding: 8,
    zIndex: "var(--pw-layer-popover, 400)",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    overflowY: "auto",
  };
}

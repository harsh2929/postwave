import {
  type FocusEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { useDialogStack } from "../../hooks/useDialogStack";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import { SavedViewNamingModal } from "./SavedViewNamingModal";
import { SavedViewsPopover } from "./SavedViewsPopover";
import {
  MAX_SAVED_VIEWS,
  type AnalyticsRange,
  type SavedView,
  useEncryptedSavedViews,
} from "./saved-views-storage";

import "../../styles-analytics-popups.css";

export type { AnalyticsRange, SavedView } from "./saved-views-storage";

interface Props {
  current: { range: AnalyticsRange; vsPrevious: boolean };
  onApply: (view: SavedView) => void;
  storageScope: string | null;
}

function createSavedViewId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `v-${uuid}`;
  } catch {
    /* The bounded, non-secret fallback below is sufficient for a local ID. */
  }
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function SavedViewsMenu({
  current,
  onApply,
  storageScope,
}: Props): ReactElement {
  const storage = useEncryptedSavedViews(storageScope);
  const [open, setOpen] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const pendingDeletedIndexRef = useRef<number | null>(null);
  const actionPendingRef = useRef(false);
  const actionTokenRef = useRef(0);
  const mountedRef = useRef(true);
  const scopeRef = useRef(storageScope);
  const popoverId = useId();
  const triggerId = useId();
  const headingId = useId();
  const descriptionId = useId();
  const storageStatusId = useId();
  const { isTop } = useDialogStack(popoverId);
  scopeRef.current = storageScope;

  const closePopover = useCallback((restoreFocus = false): void => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setOpen(false);
    setShowSaveDialog(false);
    setAnnouncement("");
    pendingDeletedIndexRef.current = null;
    actionTokenRef.current += 1;
    actionPendingRef.current = false;
  }, [storageScope]);

  useEffect(() => {
    if (!open) return;
    pushDialog(popoverId);
    return () => popDialog(popoverId);
  }, [open, popoverId]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      popoverRef.current
        ?.querySelector<HTMLElement>("[data-saved-view-action]")
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || pendingDeletedIndexRef.current == null) return;
    const deletedIndex = pendingDeletedIndexRef.current;
    pendingDeletedIndexRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const applyButtons = Array.from(
        popoverRef.current?.querySelectorAll<HTMLElement>(
          "[data-saved-view-apply]",
        ) ?? [],
      );
      const nextIndex = Math.min(deletedIndex, applyButtons.length - 1);
      const fallback = popoverRef.current?.querySelector<HTMLElement>(
        "[data-saved-view-create]",
      );
      (applyButtons[nextIndex] ?? fallback)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, storage.views]);

  useEffect(() => {
    if (!open || !isTop) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || event.key !== "Escape") {
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
  }, [closePopover, open]);

  const matchingView = useMemo(
    () =>
      storage.views.find(
        (view) =>
          view.range === current.range &&
          view.vsPrevious === current.vsPrevious,
      ),
    [current.range, current.vsPrevious, storage.views],
  );
  const limitReached = storage.views.length >= MAX_SAVED_VIEWS;
  const canMutate =
    !storage.loading && !storage.unavailable && !storage.busy && !limitReached;
  const statusMessage = storage.loading
    ? "Loading encrypted saved views…"
    : storage.notice ??
      (storage.unavailable
        ? "Encrypted saved views are unavailable for this workspace."
        : limitReached
          ? "Maximum 20 saved views reached. Remove one before saving another."
          : null);

  function addView(): void {
    if (!canMutate) return;
    setShowSaveDialog(true);
    closePopover(false);
  }

  function dismissSaveDialog(): void {
    if (storage.busy) return;
    setShowSaveDialog(false);
    queueMicrotask(() => {
      queueMicrotask(() => triggerRef.current?.focus());
    });
  }

  async function saveNamedView(name: string): Promise<string | null> {
    if (actionPendingRef.current) return "A saved-view change is already running.";
    const view: SavedView = {
      id: createSavedViewId(),
      name,
      range: current.range,
      vsPrevious: current.vsPrevious,
    };
    const actionToken = ++actionTokenRef.current;
    actionPendingRef.current = true;
    const scope = storageScope;
    const result = await storage.add(view).catch(() => ({
      ok: false,
      stale: false,
      error: "The encrypted saved-view operation ended unexpectedly. Try again.",
    }));
    if (actionToken === actionTokenRef.current) actionPendingRef.current = false;
    if (!mountedRef.current || scope !== scopeRef.current || result.stale) {
      return "Workspace changed before the view could be saved.";
    }
    if (!result.ok) return result.error ?? "The saved view could not be stored.";
    setAnnouncement(`Saved view ${name}.`);
    return null;
  }

  async function removeView(
    id: string,
    name: string,
    index: number,
  ): Promise<void> {
    if (actionPendingRef.current || storage.busy) return;
    const actionToken = ++actionTokenRef.current;
    actionPendingRef.current = true;
    pendingDeletedIndexRef.current = index;
    const scope = storageScope;
    const result = await storage.remove(id).catch(() => ({
      ok: false,
      stale: false,
      error: "The encrypted saved-view operation ended unexpectedly. Try again.",
    }));
    if (actionToken === actionTokenRef.current) actionPendingRef.current = false;
    if (!mountedRef.current || scope !== scopeRef.current || result.stale) return;
    if (!result.ok) {
      pendingDeletedIndexRef.current = null;
      return;
    }
    setAnnouncement(`Deleted saved view ${name}.`);
  }

  function applyView(view: SavedView): void {
    onApply(view);
    setAnnouncement(`Applied saved view ${view.name}.`);
    closePopover(true);
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
      >
        {matchingView ? `View · ${matchingView.name}` : "Views ▾"}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
      {open ? (
        <SavedViewsPopover
          popoverRef={popoverRef}
          popoverId={popoverId}
          headingId={headingId}
          descriptionId={descriptionId}
          storageStatusId={storageStatusId}
          storage={storage}
          statusMessage={statusMessage}
          canMutate={canMutate}
          onBlur={handlePopoverBlur}
          onApply={applyView}
          onDelete={(view, index) =>
            void removeView(view.id, view.name, index)
          }
          onCreate={addView}
        />
      ) : null}
      <SavedViewNamingModal
        key={storageScope ?? "unresolved"}
        open={showSaveDialog}
        current={current}
        busy={storage.busy}
        onClose={dismissSaveDialog}
        onSave={saveNamedView}
      />
    </div>
  );
}

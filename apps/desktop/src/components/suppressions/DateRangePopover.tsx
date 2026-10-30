/** Compact, explicit date-added filter task for the suppressions table. */

import {
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
import { anchoredPopoverPosition } from "../../lib/anchored-popover-position";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import { fmtDayMonth } from "../../lib/format-date";
import "../../styles-suppressions-popovers.css";

interface Props {
  from: string;
  to: string;
  onChange: (next: { from: string; to: string }) => void;
}

export function DateRangePopover({ from, to, onChange }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const [, setPositionRevision] = useState(0);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const panelId = useId();
  const titleId = useId();
  const dialogId = useId();
  const { isTop } = useDialogStack(dialogId);

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    setDraftFrom(from);
    setDraftTo(to);
    pushDialog(dialogId);
    const frame = window.requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      popDialog(dialogId);
    };
  }, [dialogId, from, open, to]);

  useEffect(() => {
    if (!open || !isTop) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229 || event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close, isTop, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  useEffect(() => {
    if (!open) return;
    let frame: number | null = null;
    const refresh = (): void => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        setPositionRevision((revision) => revision + 1);
      });
    };
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, [open]);

  const active = Boolean(from || to);
  const label = !active
    ? "Any time"
    : from && to
      ? `${fmtDayMonth(from)} – ${fmtDayMonth(to)}`
      : from
        ? `From ${fmtDayMonth(from)}`
        : `Until ${fmtDayMonth(to)}`;
  const invalid = Boolean(draftFrom && draftTo && draftFrom > draftTo);
  const position = triggerRef.current
    ? anchoredPopoverPosition(
        triggerRef.current.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        { preferredWidth: 300, minimumHeight: 250 },
      )
    : { position: "fixed" as const, left: 8, top: 8, width: 300, maxHeight: 250 };

  const apply = (): void => {
    if (invalid) return;
    onChange({ from: draftFrom, to: draftTo });
    close(true);
  };
  const clear = (): void => {
    setDraftFrom("");
    setDraftTo("");
    onChange({ from: "", to: "" });
    close(true);
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (next && (panelRef.current?.contains(next) || triggerRef.current?.contains(next))) return;
    window.requestAnimationFrame(() => {
      if (panelRef.current?.contains(document.activeElement)) return;
      close(false);
    });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`chip${active ? " is-active" : ""}`}
        aria-label={`Filter suppressions by date added: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        Added: {label}
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              className="suppression-date-popover"
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              style={position}
              onBlurCapture={onBlur}
            >
              <h2 id={titleId} className="suppression-date-popover-title">
                Filter by date added
              </h2>
              <div className="suppression-date-popover-fields">
                <label className="suppression-date-popover-label">
                  <span>From</span>
                  <input
                    ref={firstFieldRef}
                    type="date"
                    className="input"
                    value={draftFrom}
                    max={draftTo || undefined}
                    onChange={(event) => setDraftFrom(event.target.value)}
                  />
                </label>
                <label className="suppression-date-popover-label">
                  <span>To</span>
                  <input
                    type="date"
                    className="input"
                    value={draftTo}
                    min={draftFrom || undefined}
                    onChange={(event) => setDraftTo(event.target.value)}
                  />
                </label>
              </div>
              {invalid ? (
                <p className="field-error" role="alert">
                  The end date must be on or after the start date.
                </p>
              ) : null}
              <div className="suppression-date-popover-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-ghost suppression-date-clear"
                  onClick={clear}
                >
                  Clear
                </button>
                <button type="button" className="btn btn-sm" onClick={() => close(true)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={invalid}
                  onClick={apply}
                >
                  Apply
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

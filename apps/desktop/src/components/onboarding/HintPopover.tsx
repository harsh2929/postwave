/**
 * HintPopover — a small inline `?` affordance that expands a canonical
 * contextual hint (CONTEXTUAL_HINTS from @postwave/onboarding-schema) in a
 * collision-safe top-layer surface.
 *
 * The lighter-weight cousin of a tour step: sits next to a complex field
 * (DKIM record, consent capture, …) and opens a short explanation on
 * click / Enter / Space. Authored once in the shared schema; this is the
 * desktop renderer.
 *
 * Accessibility:
 *   - The trigger is a real <button> with `aria-expanded` + `aria-controls`
 *     and an aria-label sourced from the hint title.
 *   - The panel is `role="dialog"` + `aria-modal="false"` (non-blocking,
 *     like the tour tooltip) and is labelled/described by its own ids.
 *   - Esc closes and returns focus to the trigger; an outside pointer also
 *     closes. Focus moves into the panel on open.
 *
 * Styling reuses the existing `.hint-*` tokens (see styles.css) and the
 * shared --pw-* CSS vars — no new design primitives.
 */

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

import { CONTEXTUAL_HINTS } from "@postwave/onboarding-schema";
import { useDialogStack } from "../../hooks/useDialogStack";
import { anchoredPopoverPosition } from "../../lib/anchored-popover-position";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import { ExternalLink } from "../ExternalLink";
import "../../styles-hint-popover.css";

interface HintPopoverProps {
  /** Key into CONTEXTUAL_HINTS (e.g. "sending-identity.dkim"). */
  hintKey: string;
  /** Optional placement of the panel relative to the trigger. */
  placement?: "top" | "bottom";
  /** Optional extra class on the trigger button. */
  className?: string;
}

export function HintPopover({
  hintKey,
  placement = "bottom",
  className,
}: HintPopoverProps): ReactElement | null {
  const hint = CONTEXTUAL_HINTS[hintKey];
  const [open, setOpen] = useState(false);
  const [, setPositionRevision] = useState(0);
  const panelId = useId();
  const titleId = useId();
  const bodyId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dialogId = useId();
  const { isTop } = useDialogStack(dialogId);

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    pushDialog(dialogId);
    return () => popDialog(dialogId);
  }, [dialogId, open]);

  /* Esc closes + restores focus to the trigger; outside pointer closes. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!e.isComposing && e.keyCode !== 229 && e.key === "Escape" && isTop) {
        e.preventDefault();
        close(true);
      }
    };
    const onDoc = (e: PointerEvent): void => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      close(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDoc, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDoc, true);
    };
  }, [close, isTop, open]);

  /* Move focus into the panel when it opens so screen readers announce it. */
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

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

  // Unknown key — render nothing rather than an empty affordance.
  if (!hint) return null;

  const position = triggerRef.current
    ? anchoredPopoverPosition(
        triggerRef.current.getBoundingClientRect(),
        window.innerWidth,
        window.innerHeight,
        { preferredWidth: 280, minimumHeight: 140, placement },
      )
    : { position: "fixed" as const, left: 8, top: 8, width: 280, maxHeight: 180 };
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (next && (panelRef.current?.contains(next) || triggerRef.current?.contains(next))) return;
    window.requestAnimationFrame(() => {
      if (panelRef.current?.contains(document.activeElement)) return;
      close(false);
    });
  };

  return (
    <span className="hint-popover">
      <button
        ref={triggerRef}
        type="button"
        className={`hint-popover-trigger${className ? ` ${className}` : ""}`}
        aria-label={`More info: ${hint.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span aria-hidden="true">?</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              className={`hint-popover-panel is-${placement}`}
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              aria-describedby={bodyId}
              tabIndex={-1}
              style={position}
              onBlurCapture={onBlur}
            >
              <div id={titleId} className="hint-popover-title">
                {hint.title}
              </div>
              <p id={bodyId} className="hint-popover-body">
                {hint.body}
              </p>
              {hint.learnMoreUrl ? (
                <ExternalLink
                  className="hint-popover-link"
                  href={hint.learnMoreUrl}
                >
                  Learn more
                </ExternalLink>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

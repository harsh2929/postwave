/**
 * SlideoverShell — standardized slideover chrome.
 *
 * Wraps the overlay + panel + header + body + footer pattern so new
 * slideovers don't reinvent header markup. Honors the v2 CSS classes
 * (`.slideover-v2`, `.slideover-md`, `.slideover-header`, etc.) and
 * auto-wires the escape key, focus trap, and body scroll lock.
 *
 * Existing slideovers can migrate when convenient. For the gradual
 * migration path, see `useSlideoverBehavior` — that hook gives an
 * existing slideover the standard escape/focus/scroll-lock behavior
 * without requiring a full markup rewrite.
 *
 *   <SlideoverShell
 *     open={open}
 *     onClose={onClose}
 *     size="md"
 *     eyebrow="Subscriber"
 *     title="alice@example.com"
 *     subtitle="Tagged founder · joined 4 months ago"
 *     footer={
 *       <>
 *         <button className="btn" onClick={onClose}>Close</button>
 *         <button className="btn btn-primary" onClick={save}>Save</button>
 *       </>
 *     }
 *   >
 *     ...body content...
 *   </SlideoverShell>
 */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The labelled, independently scrollable dialog body must remain keyboard-scrollable when its content has no focusable controls. */

import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
} from "react";

import { useSlideoverBehavior } from "../hooks/useSlideoverBehavior";

interface Props {
  open: boolean;
  onClose: () => void;
  size?: "sm" | "md" | "lg" | "xl";
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned actions next to the close button. */
  headerActions?: ReactNode;
  /** Footer slot — usually a button row. */
  footer?: ReactNode;
  /** Element that receives focus when the slideover opens. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Stable opener to restore after pointer, Escape, or close-button dismissal. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Disable outside-click dismissal for dirty/high-consequence tasks. */
  closeOnBackdrop?: boolean;
  /** Disable Escape and close controls while work is in flight. */
  busy?: boolean;
  /** Optional route-owned class for scoped presentation or evidence rules. */
  className?: string;
  children: ReactNode;
}

export function SlideoverShell({
  open,
  onClose,
  size = "md",
  eyebrow,
  title,
  subtitle,
  headerActions,
  footer,
  initialFocusRef,
  returnFocusRef,
  closeOnBackdrop = true,
  busy = false,
  className,
  children,
}: Props): ReactElement | null {
  const dialogRef = useRef<HTMLElement | null>(null);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();

  const close = (): void => {
    if (!busy) onClose();
  };

  useSlideoverBehavior({
    open,
    onClose: close,
    dialogRef,
    isolationRef: layerRef,
    initialFocusRef,
    returnFocusRef,
    disableEscape: busy,
  });
  if (!open) return null;
  return (
    <div ref={layerRef} className="slideover-layer">
      <div
        className="slideover-overlay slideover-overlay-v2"
        onPointerDown={(event) => {
          if (closeOnBackdrop && !busy) {
            // Keep the pointer sequence from moving focus onto the backdrop
            // after the dialog cleanup restores the explicit opener.
            event.preventDefault();
            close();
          }
        }}
        role="presentation"
      />
      <aside
        ref={dialogRef}
        className={["slideover", "slideover-v2", `slideover-${size}`, className]
          .filter(Boolean)
          .join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        aria-busy={busy ? "true" : undefined}
        tabIndex={-1}
      >
        <header className="slideover-header">
          <div style={{ minWidth: 0 }}>
            {eyebrow ? (
              <div className="slideover-eyebrow">{eyebrow}</div>
            ) : null}
            <h2 id={titleId} className="slideover-title">
              {title}
            </h2>
            {subtitle ? (
              <div id={subtitleId} className="slideover-subtitle">
                {subtitle}
              </div>
            ) : null}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {headerActions}
            <button
              type="button"
              className="slideover-close"
              onClick={close}
              aria-label="Close"
              disabled={busy}
            >
              ✕
            </button>
          </div>
        </header>
        <div
          className="slideover-body"
          role="region"
          tabIndex={0}
          aria-labelledby={titleId}
        >
          {children}
        </div>
        {footer ? <footer className="slideover-footer">{footer}</footer> : null}
      </aside>
    </div>
  );
}

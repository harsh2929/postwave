import { type ReactElement, type RefObject, useId, useRef } from "react";

import { useSlideoverBehavior } from "../hooks/useSlideoverBehavior";

interface LazySlideoverFallbackProps {
  label: string;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/** Accessible feedback while an interaction-only detail chunk is fetched. */
export function LazySlideoverFallback({
  label,
  onClose,
  returnFocusRef,
}: LazySlideoverFallbackProps): ReactElement {
  const dialogRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useSlideoverBehavior({
    open: true,
    onClose,
    dialogRef,
    returnFocusRef,
  });

  return (
    <>
      <div className="slideover-overlay" onClick={onClose} aria-hidden="true" />
      <section
        ref={dialogRef}
        className="slideover"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy="true"
      >
        <button
          type="button"
          className="slideover-close"
          onClick={onClose}
          aria-label={`Close ${label}`}
        >
          ×
        </button>
        <h2 id={titleId}>{label}</h2>
        <div role="status" aria-live="polite">
          Loading details…
        </div>
      </section>
    </>
  );
}

/**
 * Pager — cursor-aware Prev/Next footer for Commerce keyset lists.
 *
 * The API only exposes an opaque `next_cursor`; owners retain the cursor
 * trail that made the current page so Previous can return to a known page.
 */

import { useId, useRef, type ReactElement } from "react";

export function Pager({
  itemCount,
  pageNumber,
  hasPrevious,
  nextCursor,
  busy,
  onPrevious,
  onNext,
  label = "Results",
}: {
  itemCount: number;
  pageNumber: number;
  hasPrevious: boolean;
  nextCursor?: string | null;
  busy?: boolean;
  onPrevious: () => void;
  onNext: (cursor: string) => void;
  label?: string;
}): ReactElement | null {
  const statusId = useId();
  const clickGuardRef = useRef(false);
  const verifiedNextCursor =
    typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : null;
  if (!hasPrevious && !verifiedNextCursor) return null;
  const safePageNumber =
    Number.isSafeInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
  const safeItemCount =
    Number.isSafeInteger(itemCount) && itemCount >= 0 ? itemCount : 0;
  const previousUnavailable = Boolean(busy) || !hasPrevious;
  const nextUnavailable = Boolean(busy) || verifiedNextCursor === null;
  const status = busy
    ? `Loading page ${safePageNumber.toLocaleString()} of ${label.toLowerCase()}.`
    : !hasPrevious
      ? `First page of ${label.toLowerCase()}; Previous is unavailable.`
      : verifiedNextCursor === null
        ? `Last page of ${label.toLowerCase()}; Next is unavailable.`
        : `Page ${safePageNumber.toLocaleString()} of ${label.toLowerCase()}.`;
  const requestPage = (
    direction: "previous" | "next",
    unavailable: boolean,
  ): void => {
    if (unavailable || clickGuardRef.current) return;
    clickGuardRef.current = true;
    try {
      if (direction === "previous") {
        onPrevious();
      } else if (verifiedNextCursor !== null) {
        onNext(verifiedNextCursor);
      }
    } finally {
      queueMicrotask(() => {
        clickGuardRef.current = false;
      });
    }
  };
  return (
    <div
      className="commerce-pager"
      role="navigation"
      aria-label={`${label} pagination`}
      aria-busy={busy || undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 8,
        fontSize: 12,
      }}
    >
      <span className="muted tabular">
        Page {safePageNumber.toLocaleString()} ·{" "}
        {safeItemCount.toLocaleString()} on this page
      </span>
      <span
        id={statusId}
        className="muted commerce-pager-status"
        role="status"
        aria-live="polite"
      >
        {status}
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="btn btn-sm"
        aria-label={`${label}: Previous page`}
        aria-disabled={previousUnavailable || undefined}
        aria-describedby={statusId}
        onClick={() => requestPage("previous", previousUnavailable)}
      >
        <span aria-hidden="true">←</span> Previous
      </button>
      <button
        type="button"
        className="btn btn-sm"
        aria-label={`${label}: Next page`}
        aria-disabled={nextUnavailable || undefined}
        aria-describedby={statusId}
        onClick={() => requestPage("next", nextUnavailable)}
      >
        Next <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}

/**
 * InlinePromoCard — horizontal "next step" card.
 *
 * Sits between a hero / table and nudges the user toward a related
 * next action without nagging. Optional dismissal stores a flag in
 * localStorage so the user never sees the same nudge twice.
 */

import { useEffect, useState, type ReactElement, type ReactNode } from "react";

interface InlinePromoCardProps {
  thumbnail?: ReactNode;
  /** When set, dismissal is persisted to localStorage. */
  dismissKey?: string;
  label?: string;
  title: string;
  body: string;
  cta: { label: string; onClick: () => void };
}

const LS_PREFIX = "postwave_promo_dismissed_";

export function InlinePromoCard({
  thumbnail,
  dismissKey,
  label,
  title,
  body,
  cta,
}: InlinePromoCardProps): ReactElement | null {
  const [dismissed, setDismissed] = useState<boolean>(false);

  useEffect(() => {
    if (!dismissKey) return;
    try {
      if (localStorage.getItem(LS_PREFIX + dismissKey) === "1") {
        setDismissed(true);
      }
    } catch {
      /* localStorage disabled — show the card regardless. */
    }
  }, [dismissKey]);

  if (dismissed) return null;

  function dismiss(): void {
    setDismissed(true);
    if (!dismissKey) return;
    try {
      localStorage.setItem(LS_PREFIX + dismissKey, "1");
    } catch {
      /* nothing */
    }
  }

  return (
    <div className="promo-card" style={{ position: "relative" }}>
      <div className="promo-card-thumb" aria-hidden="true">
        {thumbnail}
      </div>
      <div className="promo-card-text">
        {label ? <div className="promo-card-label">{label}</div> : null}
        <div className="promo-card-title">{title}</div>
        <div className="promo-card-body">{body}</div>
      </div>
      <button type="button" className="btn" onClick={cta.onClick}>
        {cta.label}
      </button>
      {dismissKey ? (
        <button
          type="button"
          className="promo-card-dismiss"
          onClick={dismiss}
          aria-label="Dismiss"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M2 2l6 6M8 2l-6 6" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

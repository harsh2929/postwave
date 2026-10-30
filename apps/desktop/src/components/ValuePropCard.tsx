/**
 * ValuePropCard — compact inline-education panel.
 *
 * Smaller than HeroEmptyState, more present than a tooltip. Sits at
 * the top of an in-tab section to explain an advanced feature with
 * an icon, headline, body, and CTA. Auto-themes to use accent on a
 * 4% accent-tinted surface (subtle enough not to dominate the page).
 */

import type { ReactElement, ReactNode } from "react";

interface Props {
  icon?: ReactNode;
  title: string;
  body: string;
  cta?: { label: string; onClick: () => void };
}

export function ValuePropCard({ icon, title, body, cta }: Props): ReactElement {
  return (
    <div className="value-prop-card">
      <div className="value-prop-card-icon" aria-hidden="true">
        {icon ?? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3l1.8 4.5L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.5z" />
          </svg>
        )}
      </div>
      <div className="value-prop-card-text">
        <div className="value-prop-card-title">{title}</div>
        <div className="value-prop-card-body">{body}</div>
      </div>
      {cta ? (
        <button type="button" className="btn" onClick={cta.onClick}>
          {cta.label}
        </button>
      ) : null}
    </div>
  );
}

/**
 * HeroEmptyState — outcome-framed empty state.
 *
 * Replaces deficit-framed "No X yet" panels with a pastel-tinted hero
 * that pitches the value of the feature. Show ONLY when the underlying
 * list is empty AND no search/filter is active — if the user has
 * narrowed results to zero, keep the existing .list-empty / .empty-state
 * pattern (they need filter feedback, not a marketing pitch).
 *
 * Tones map to the CSS hero-bg-* tints:
 *   blue    Campaigns / Sequences / Deliverability / Custom Domains / DMARC / Audit / Approvals / Compliance / Sending Settings
 *   mint    Subscribers / Tags / Lists / Suppressions
 *   blush   Forms / Track / Analytics / Send Time / Templates / Assets / SMS Inbox
 *   sand    Webhooks / Inbound Routes / MCP / API Playground / Webhook Simulator / Audit Sinks / Moosewave AI
 *   neutral Settings / Agency / SCIM / Referrals / Discounts / Gifts / Archive / Migrations
 */

import type { ReactElement, ReactNode } from "react";

export type HeroTone = "blue" | "mint" | "blush" | "sand" | "neutral";

interface HeroCta {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
}

interface HeroEmptyStateProps {
  tone?: HeroTone;
  eyebrow?: string;
  title: string;
  subtitle: string;
  primaryCta?: HeroCta;
  secondaryCta?: HeroCta;
  meta?: ReactNode;
  /**
   * URL or import-resolved path of the photographic illustration.
   * Pass `null` to render the panel without an image (taller text column).
   */
  imageSrc?: string | null;
  imageAlt?: string;
}

export function HeroEmptyState({
  tone = "neutral",
  eyebrow,
  title,
  subtitle,
  primaryCta,
  secondaryCta,
  meta,
  imageSrc,
  imageAlt = "",
}: HeroEmptyStateProps): ReactElement {
  return (
    <section className={`hero-empty tone-${tone}`} aria-label={title}>
      <div className="hero-empty-text">
        {eyebrow ? <span className="hero-empty-eyebrow">{eyebrow}</span> : null}
        <h2 className="hero-empty-title">{title}</h2>
        <p className="hero-empty-subtitle">{subtitle}</p>
        {(primaryCta || secondaryCta) && (
          <div className="hero-empty-actions">
            {primaryCta && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={primaryCta.onClick}
              >
                {primaryCta.icon}
                {primaryCta.label}
              </button>
            )}
            {secondaryCta && (
              <button
                type="button"
                className="btn"
                onClick={secondaryCta.onClick}
              >
                {secondaryCta.label}
              </button>
            )}
          </div>
        )}
        {meta ? <div className="hero-empty-meta">{meta}</div> : null}
      </div>
      {imageSrc ? (
        <div className="hero-empty-image" aria-hidden="true">
          <img src={imageSrc} alt={imageAlt} draggable={false} />
        </div>
      ) : null}
    </section>
  );
}

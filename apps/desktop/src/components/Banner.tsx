/**
 * Banner — a wide, page-top tonal callout, taller than <Notice> and
 * intended to host a longer headline + supporting paragraph + a
 * trailing CTA. Used at the top of pages and large card sections to
 * surface a current state (offline, degraded provider, warming up,
 * etc.).
 *
 * Differences from <Notice>:
 *   - Larger padding and font sizes — meant to dominate the top of
 *     a section, not slot inline next to body copy.
 *   - Supports an optional dismiss button via `onDismiss`.
 *   - Optional `icon` slot to mirror the look of InboxRealityBanner
 *     and friends without each one re-implementing the chrome.
 *
 * Domain `*Banner.tsx` owners keep their fetches and state machines, but safe
 * tonal shells compose this primitive so announcement, dismissal, theme, and
 * forced-colour behavior do not fork.
 */
import { type ReactElement, type ReactNode } from "react";

import {
  Notice,
  type NoticeAnnouncement,
  type NoticeTone,
} from "./Notice";
import type { PrimitiveLayoutStyle } from "./primitive-style-contract";

interface BannerBaseProps {
  tone?: NoticeTone;
  /** Optional leading icon (string emoji or React node). */
  icon?: ReactNode;
  /** Headline. Renders with the shared emphasized title treatment. */
  title?: ReactNode;
  /** Body content. */
  children?: ReactNode;
  /** Trailing action area — typically a primary CTA button. */
  action?: ReactNode;
  className?: string;
  style?: PrimitiveLayoutStyle;
  announcement?: NoticeAnnouncement;
  "data-testid"?: string;
}

type BannerDismissProps =
  | {
      /** When supplied, a close (×) button renders on the far right. */
      onDismiss: () => void;
      /** Contextual accessible name, e.g. “Dismiss domain verified banner”. */
      dismissLabel: string;
    }
  | {
      onDismiss?: undefined;
      dismissLabel?: never;
    };

export type BannerProps = BannerBaseProps & BannerDismissProps;

export function Banner({
  tone = "info",
  icon,
  title,
  children,
  action,
  onDismiss,
  dismissLabel,
  className,
  style,
  announcement = "auto",
  "data-testid": testId,
}: BannerProps): ReactElement {
  /* Compose on top of Notice for tone/border parity, then override
   * the size-related styles. This keeps the colour token mapping in
   * one place. */
  return (
    <Notice
      tone={tone}
      announcement={announcement}
      data-testid={testId}
      className={["pw-banner", className].filter(Boolean).join(" ")}
      style={{
        padding: "var(--pw-sp-3) var(--pw-sp-4)",
        fontSize: "var(--pw-text-body)",
        alignItems: "center",
        ...style,
      }}
      action={action != null || onDismiss ? (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--pw-sp-2)",
          }}
        >
          {action}
          {onDismiss ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm pw-banner-dismiss"
              aria-label={dismissLabel}
              onClick={onDismiss}
            >
              ×
            </button>
          ) : null}
        </div>
      ) : undefined}
      title={
        icon != null || title != null ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--pw-sp-2)",
              fontSize: "var(--pw-text-body)",
            }}
          >
            {icon != null ? (
              <span aria-hidden="true" style={{ display: "inline-flex" }}>
                {icon}
              </span>
            ) : null}
            {title}
          </span>
        ) : undefined
      }
    >
      {children}
    </Notice>
  );
}

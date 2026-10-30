/**
 * Notice — inline tonal callout (info / success / warning / danger).
 *
 * Replaces dozens of bespoke `<div style={{ background: ..., border:
 * "1px solid ...", borderRadius: ..., padding: ..., ... }}>` blocks
 * scattered across the dashboard pages. Pulls all colours from
 * --pw-info / --pw-success / --pw-warning / --pw-danger so the same
 * primitive themes correctly under dark and light data-themes.
 *
 * Why a JSX primitive over a CSS-only class:
 *   - Tonal variants need both background-tint and border-tint that
 *     are derived from a single semantic colour. Encoding that in
 *     plain CSS would multiply the variant count (4 classes); a
 *     React wrapper keeps the API to one prop.
 *   - The `title` slot renders bold/leading copy in a consistent
 *     size, which is what every existing inline notice was hand-
 *     writing differently. Centralising it kills visual drift.
 *
 * The component is purely presentational — no portals, no focus
 * management. For dismissable banners that pin to the top of a page,
 * use <Banner> instead.
 */
import { type ReactElement, type ReactNode } from "react";

import type { PrimitiveLayoutStyle } from "./primitive-style-contract";

export type NoticeTone = "info" | "success" | "warning" | "danger" | "neutral";

export type NoticeAnnouncement =
  | "auto"
  | "polite"
  | "assertive"
  | "off";

export interface NoticeProps {
  /** Tonal variant. Defaults to "info". */
  tone?: NoticeTone;
  /** Optional bolded leading line. Renders above `children`. */
  title?: ReactNode;
  /** Body content. */
  children?: ReactNode;
  /** Right-aligned action area (typically a small button). */
  action?: ReactNode;
  /** Extra className passthrough for one-off layout tweaks. */
  className?: string;
  /** Extra inline style passthrough for one-off layout tweaks. Avoid
   *  for colours / borders — use a different tone instead. */
  style?: PrimitiveLayoutStyle;
  /**
   * Announcement policy. `auto` uses assertive delivery only for danger,
   * polite delivery for success/warning, and a non-live note for info/neutral.
   * Static callouts can opt out; asynchronous information can opt in.
   */
  announcement?: NoticeAnnouncement;
  /** Test id passthrough. */
  "data-testid"?: string;
}

function announcementRole(
  tone: NoticeTone,
  announcement: NoticeAnnouncement,
): "alert" | "status" | "note" {
  if (announcement === "assertive") return "alert";
  if (announcement === "polite") return "status";
  if (announcement === "off") return "note";
  if (tone === "danger") return "alert";
  if (tone === "warning" || tone === "success") return "status";
  return "note";
}

/** Map a tone to the underlying CSS custom property name. The
 *  primitive uses `color-mix()` against the resolved colour so the
 *  variant survives theme changes without re-rendering. */
function toneVar(tone: NoticeTone): string {
  switch (tone) {
    case "success":
      return "var(--pw-success)";
    case "warning":
      return "var(--pw-warning)";
    case "danger":
      return "var(--pw-danger)";
    case "neutral":
      return "var(--pw-fg-subtle)";
    case "info":
    default:
      return "var(--pw-info)";
  }
}

export function Notice({
  tone = "info",
  title,
  children,
  action,
  className,
  style,
  announcement = "auto",
  "data-testid": testId,
}: NoticeProps): ReactElement {
  const c = toneVar(tone);
  const role = announcementRole(tone, announcement);
  return (
    <div
      className={["pw-notice", className].filter(Boolean).join(" ")}
      role={role}
      data-tone={tone}
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: action != null ? "center" : "flex-start",
        gap: "var(--pw-sp-3)",
        padding: "var(--pw-sp-2) var(--pw-sp-3)",
        background: `color-mix(in srgb, ${c} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} 30%, transparent)`,
        borderRadius: "var(--pw-radius-sm)",
        color: "var(--pw-fg)",
        fontSize: "var(--pw-text-sm)",
        lineHeight: "var(--pw-leading-snug)",
        ...style,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {title != null ? (
          <div
            style={{
              fontWeight: 600,
              marginBottom:
                children != null ? "calc(var(--pw-sp-1) / 2)" : 0,
            }}
          >
            {title}
          </div>
        ) : null}
        {children}
      </div>
      {action != null ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  );
}

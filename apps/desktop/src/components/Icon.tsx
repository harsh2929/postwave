import type { CSSProperties, ReactElement } from "react";

/**
 * Minimal stroke-icon set (Phase-2 design-system pass).
 *
 * Replaces the unicode glyphs (⋮⋮, ⚠, ▲/▼, ↗, ↑/↓) that were used as
 * iconography across the dashboard — the loudest "typed, not designed"
 * tell. Icons are 16-grid, 1.5-stroke, `currentColor`, so they inherit
 * text color (e.g. a delta arrow turns green/red from `.stat-delta`).
 *
 * Decorative by default (`aria-hidden`); every call site already carries
 * its own `aria-label`/`title` on the surrounding element.
 */
export type IconName =
  | "chevron-up"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "grip-vertical"
  | "alert-triangle"
  | "arrow-right"
  | "arrow-up-right"
  | "eye"
  | "eye-off"
  | "key"
  | "lock"
  | "mail"
  | "megaphone"
  | "users"
  | "shield-check"
  | "chart-bars"
  | "clock"
  | "git-branch"
  | "plus"
  | "minus"
  | "log-out"
  | "pencil"
  | "x";

const PATHS: Record<IconName, ReactElement> = {
  "chevron-up": <path d="M3.5 9.5 8 5l4.5 4.5" />,
  "chevron-down": <path d="M3.5 6.5 8 11l4.5-4.5" />,
  "chevron-left": <path d="M10 3.5 5.5 8l4.5 4.5" />,
  "chevron-right": <path d="M6 3.5 10.5 8 6 12.5" />,
  "alert-triangle": (
    <>
      <path d="M8 2.5 14.8 13.5H1.2z" />
      <path d="M8 6.5v3.4" />
      <path d="M8 12.4h.01" />
    </>
  ),
  "arrow-up-right": (
    <>
      <path d="M5 11 11 5" />
      <path d="M6 5h5v5" />
    </>
  ),
  "arrow-right": <path d="M2.5 8h11m-4-4 4 4-4 4" />,
  eye: (
    <>
      <path d="M1.8 8s2.2-3.6 6.2-3.6S14.2 8 14.2 8 12 11.6 8 11.6 1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  "eye-off": (
    <>
      <path d="m2.3 2.3 11.4 11.4M6.5 4.6A7 7 0 0 1 8 4.4c4 0 6.2 3.6 6.2 3.6a9.6 9.6 0 0 1-1.7 2.1M10 11.3a6.7 6.7 0 0 1-2 .3C4 11.6 1.8 8 1.8 8a10 10 0 0 1 1.8-2.2" />
    </>
  ),
  key: (
    <>
      <circle cx="5.5" cy="8" r="2.6" />
      <path d="M8.1 8H14m-2 0v1.8M10 8v1.8" />
    </>
  ),
  lock: (
    <>
      <rect x="2.8" y="6.5" width="10.4" height="7.2" rx="1.6" />
      <path d="M5.2 6.5V4.8a2.8 2.8 0 0 1 5.6 0v1.7M8 9.3v1.8" />
    </>
  ),
  "grip-vertical": (
    <g fill="currentColor" stroke="none">
      <circle cx="6.5" cy="4" r="1.1" />
      <circle cx="6.5" cy="8" r="1.1" />
      <circle cx="6.5" cy="12" r="1.1" />
      <circle cx="9.5" cy="4" r="1.1" />
      <circle cx="9.5" cy="8" r="1.1" />
      <circle cx="9.5" cy="12" r="1.1" />
    </g>
  ),
  mail: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2.5 4.5 8 8.5l5.5-4" />
    </>
  ),
  megaphone: (
    <>
      <path d="M2.2 6.2v3.6h2.6L11.8 13V3L4.8 6.2H2.2Z" />
      <path d="m4.3 9.8.8 3.2h2.2l-1-2.5" />
      <path d="M13.2 6.1a3.6 3.6 0 0 1 0 3.8" />
    </>
  ),
  users: (
    <>
      <circle cx="6.1" cy="5.6" r="2.2" />
      <path d="M2.4 13c.2-2.4 1.5-3.7 3.7-3.7s3.5 1.3 3.7 3.7" />
      <path d="M10 4a2 2 0 0 1 0 3.8M10.6 9.4c1.8.2 2.8 1.4 3 3.3" />
    </>
  ),
  "shield-check": (
    <>
      <path d="M8 2 12.8 4v3.7c0 3-1.9 5-4.8 6.3-2.9-1.3-4.8-3.3-4.8-6.3V4L8 2Z" />
      <path d="m5.8 8 1.4 1.4 3-3.2" />
    </>
  ),
  "chart-bars": (
    <>
      <path d="M2.5 13.5h11" />
      <rect x="3.1" y="8.1" width="2.1" height="3.4" rx=".5" />
      <rect x="7" y="5.7" width="2.1" height="5.8" rx=".5" />
      <rect x="10.9" y="2.7" width="2.1" height="8.8" rx=".5" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.7V8l2.3 1.5" />
    </>
  ),
  "git-branch": (
    <>
      <path d="M8 2.8v3.4" />
      <path d="M8 6.2 4.3 10.5M8 6.2l3.7 4.3" />
      <circle cx="4.3" cy="11.4" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="11.7" cy="11.4" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  minus: <path d="M3.5 8h9" />,
  "log-out": (
    <>
      <path d="M6 3.5H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" />
      <path d="M9.5 11 13 8 9.5 5" />
      <path d="M13 8H6.5" />
    </>
  ),
  pencil: (
    <>
      <path d="M10.5 3.2 12.8 5.5" />
      <path d="M11.3 2.4 4.8 8.9 3.8 12l3.1-1 6.5-6.5a1.5 1.5 0 0 0-2.1-2.1z" />
    </>
  ),
  x: <path d="M4 4l8 8M12 4l-8 8" />,
};

export function Icon({
  name,
  size = 14,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={className ? `pw-icon ${className}` : "pw-icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {PATHS[name]}
    </svg>
  );
}

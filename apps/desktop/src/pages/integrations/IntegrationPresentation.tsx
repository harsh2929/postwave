import type { ReactElement, SVGProps } from "react";

import type { IntegrationBadge } from "../../lib/api-client";

const iconProps: SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

export function IconRefresh(): ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M20 6v5h-5" />
      <path d="M4 18v-5h5" />
      <path d="M18 10a7 7 0 0 0-11.8-3.2L4 9" />
      <path d="M6 14a7 7 0 0 0 11.8 3.2L20 15" />
    </svg>
  );
}

export function IconPlug(): ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M9 7V3" />
      <path d="M15 7V3" />
      <path d="M7 7h10v4a5 5 0 0 1-10 0z" />
      <path d="M12 16v5" />
    </svg>
  );
}

export function IconArrow(): ReactElement {
  return (
    <svg {...iconProps}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export function statusTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "active" || normalized === "connected")
    return "var(--pw-success)";
  if (normalized === "planned") return "var(--pw-advisor)";
  if (normalized === "error") return "var(--pw-danger)";
  if (normalized === "paused") return "var(--pw-warning)";
  return "var(--pw-fg-muted)";
}

export function healthTone(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === "healthy") return "var(--pw-success)";
  if (normalized === "action_required") return "var(--pw-danger)";
  if (normalized === "needs_attention") return "var(--pw-warning)";
  if (normalized === "planned") return "var(--pw-advisor)";
  if (normalized === "ready_to_configure") return "var(--pw-info)";
  return statusTone(state);
}

export function maturityTone(maturity: string): string {
  switch (maturity) {
    case "verified_hybrid_ready":
    case "verified_native_ready":
    case "foundation_hybrid_ready":
      return "var(--pw-success)";
    case "foundation_cataloged":
    case "catalog_only":
      return "var(--pw-warning)";
    case "bridge_ready":
      return "var(--pw-info)";
    case "planned_only":
      return "var(--pw-advisor)";
    default:
      return "var(--pw-fg-muted)";
  }
}

export function badgeTone(badge: IntegrationBadge): string {
  switch (badge) {
    case "native":
      return "var(--pw-success)";
    case "partner":
    case "zapier":
      return "var(--pw-warning)";
    case "webhook":
      return "var(--pw-info)";
    case "api_sdk":
    case "planned":
      return "var(--pw-advisor)";
    case "migration_only":
      return "var(--pw-fg-muted)";
  }
}

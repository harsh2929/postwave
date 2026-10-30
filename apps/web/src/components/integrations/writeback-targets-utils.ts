// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from "@/lib/api";

const PROVIDER_LABELS: Record<string, string> = {
  shopify: "Shopify",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  pipedrive: "Pipedrive",
  woocommerce: "WooCommerce",
  "zoho-crm": "Zoho CRM",
  klaviyo: "Klaviyo",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export function statusClass(status: string): string {
  const s = status.toLowerCase();
  if (s === "active" || s === "connected" || s === "completed") {
    return "bg-success text-success-foreground";
  }
  if (s === "error" || s === "failed") {
    return "bg-destructive/15 text-destructive-emphasis";
  }
  if (s === "paused" || s === "partial") {
    return "bg-warning/15 text-warning-emphasis";
  }
  return "bg-muted-foreground/15 text-muted-foreground";
}

export function fmtDate(value?: string | null): string {
  if (!value) return "never";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Provider/GraphQL error strings can be very long; keep toasts readable.
export function clip(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export function errText(e: unknown, fallback: string): string {
  return clip(e instanceof Error ? e.message : fallback);
}

export function writebackErrorMessage(e: unknown): string {
  if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
    return "You need admin access to manage write-back.";
  }
  return errText(e, "Failed to load write-back");
}

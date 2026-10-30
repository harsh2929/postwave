/**
 * useSidebarCallout — feeds the SidebarCallout slot.
 *
 * Returns at most ONE callout: the most recent un-dismissed product
 * announcement (per-key localStorage dismissal flags).
 *
 * NOTE (audit §7): the former billing-failure / trial-expiry /
 * unverified-domain priority branches were removed — they read fields
 * that do not exist anywhere (`store.tenant`, `me.billing_failure_until`,
 * `me.trial_ends_at`, `tenant.unverified_domain_since`; the store's `Me`
 * is only {user, tenant: string, role}), so they were dead code that
 * could never fire. Reinstate them once the store exposes a tenant slice
 * carrying billing_failure_until / trial_ends_at /
 * unverified_domain_since (likely from a /tenant or billing endpoint).
 *
 * UI-only. No side effects in the API.
 */

import { useMemo } from "react";

import { setSection, useStore } from "../lib/store";
import type { SidebarCalloutData } from "../components/SidebarCallout";

/**
 * Static product announcements. Each entry is shown until the user
 * dismisses it (per-key localStorage flag). Ordered oldest → newest;
 * the most recent un-dismissed one wins.
 *
 * Sunset entries by deleting them; the dismissal flags become moot.
 */
const ANNOUNCEMENTS: SidebarCalloutData[] = [
  {
    kind: "promo",
    label: "What's new",
    title: "Audit Sinks — configure delivery to your evidence systems.",
    cta: { label: "See setup", onClick: () => setSection("auditSinks") },
    dismissable: true,
    dismissKey: "anc-audit-sinks-2026-05",
  },
  {
    kind: "promo",
    label: "What's new",
    title: "Control evidence workspace — track internal assessments.",
    cta: { label: "Open Compliance", onClick: () => setSection("compliance") },
    dismissable: true,
    dismissKey: "anc-compliance-2026-05",
  },
  {
    kind: "promo",
    label: "What's new",
    title: "Moosewave AI — draft, summarize, and segment with one prompt.",
    cta: { label: "Try it", onClick: () => setSection("ai") },
    dismissable: true,
    dismissKey: "anc-postwave-ai-2026-05",
  },
];

function readDismissed(key?: string): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(`postwave_sidebar_callout_dismissed_${key}`) === "1";
  } catch {
    return false;
  }
}

function pickAnnouncement(): SidebarCalloutData | null {
  /* Walk newest → oldest, return the first un-dismissed one. */
  for (let i = ANNOUNCEMENTS.length - 1; i >= 0; i--) {
    const a = ANNOUNCEMENTS[i];
    if (a && !readDismissed(a.dismissKey)) return a;
  }
  return null;
}

export function useSidebarCallout(): SidebarCalloutData | null {
  const store = useStore();
  return useMemo<SidebarCalloutData | null>(() => {
    // Re-pick on any store change so a dismissal (which re-renders the
    // sidebar) advances to the next un-dismissed announcement.
    void store;
    return pickAnnouncement();
  }, [store]);
}

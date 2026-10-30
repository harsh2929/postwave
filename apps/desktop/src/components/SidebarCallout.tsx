/**
 * SidebarCallout — single persistent surface anchored to the bottom of
 * the sidebar. Surfaces one priority-queue callout at a time (trial
 * expiry, billing failure, unverified domain, product announcement).
 *
 * Render decision lives in `hooks/useSidebarCallout.ts`. This component
 * is purely presentational so we can preview any kind of callout in
 * isolation without wiring real state.
 */

import { useState, type ReactElement, type ReactNode } from "react";

export interface SidebarCalloutData {
  kind: "info" | "warn" | "promo";
  icon?: ReactNode;
  /** Small uppercase eyebrow, e.g. "Time sensitive". */
  label?: string;
  title: string;
  cta: { label: string; onClick: () => void };
  /** When true, user can dismiss; pass `dismissKey` to persist. */
  dismissable?: boolean;
  dismissKey?: string;
}

interface Props {
  callout: SidebarCalloutData | null;
}

const LS_PREFIX = "postwave_sidebar_callout_dismissed_";

function readDismissed(key?: string): boolean {
  if (!key) return false;
  try {
    return localStorage.getItem(LS_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

export function SidebarCallout({ callout }: Props): ReactElement | null {
  // D15-shell-onboarding#7: track keys dismissed in THIS session and
  // derive `hidden` from the CURRENT callout's key on every render.
  // The previous `useState(() => readDismissed(callout?.dismissKey))`
  // captured the first callout's dismissal ONCE, so when the hook later
  // surfaced the next un-dismissed announcement this same (un-keyed)
  // instance stayed hidden and returned null — the next promo never
  // appeared until an app restart. Deriving per-callout resets that.
  //
  // (Advancing to the next announcement the instant a dismiss happens —
  //  rather than on the next store change — additionally needs
  //  useSidebarCallout.ts / Sidebar.tsx to re-pick, which live outside
  //  this component.)
  const [sessionDismissed, setSessionDismissed] = useState<Set<string>>(
    () => new Set(),
  );

  const dismissKey = callout?.dismissKey;
  const hidden =
    !!dismissKey &&
    (readDismissed(dismissKey) || sessionDismissed.has(dismissKey));

  if (!callout || hidden) return null;

  function dismiss(): void {
    if (!dismissKey) return;
    try {
      localStorage.setItem(LS_PREFIX + dismissKey, "1");
    } catch {
      /* nothing */
    }
    setSessionDismissed((prev) => {
      const next = new Set(prev);
      next.add(dismissKey);
      return next;
    });
  }

  return (
    <div
      className={`sidebar-callout kind-${callout.kind}`}
      style={{ position: "relative" }}
    >
      {(callout.label || callout.icon) && (
        <div className="sidebar-callout-eyebrow">
          {callout.icon}
          {callout.label}
        </div>
      )}
      <div className="sidebar-callout-title">{callout.title}</div>
      <button
        type="button"
        className="sidebar-callout-cta"
        onClick={callout.cta.onClick}
      >
        {callout.cta.label}
      </button>
      {callout.dismissable && (
        <button
          type="button"
          className="sidebar-callout-dismiss"
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
      )}
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  CONSENT_STORAGE_KEY,
  MAX_COOKIE_PREFS_BYTES,
  parseConsentRecord,
} from "@/lib/cookie-consent-record";
import {
  PUBLIC_CONSENT_GPC_ENFORCED_EVENT,
  PUBLIC_CONSENT_PENDING_STORAGE_KEY,
  PUBLIC_CONSENT_SYNC_STATE_EVENT,
  discardUnrecoverablePublicConsentDecisions,
  enqueuePublicConsentDecision,
  flushPendingPublicConsentDecisions,
  type PublicConsentChoice,
  type PublicConsentPrefs,
} from "@/lib/public-consent-sync";

export { createConsentDecisionId } from "@/lib/public-consent-sync";

// Marketing-brand button styles (pw-* tokens), so the persistent cookie banner
// speaks the warm-paper marketing palette rather than the dashboard's shadcn
// semantic tokens (MKTC-010 / MKTP-012).
const BTN_PRIMARY =
  "inline-flex min-h-11 items-center justify-center rounded-md bg-pw-ember-500 px-3.5 py-2 text-sm font-medium text-white shadow-[0_2px_0_0_#7A081B] transition-colors hover:bg-pw-ember-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2";
const BTN_OUTLINE =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-pw-surface px-3.5 py-2 text-sm font-medium text-pw-ink2 transition-colors hover:bg-pw-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500";
const CHECKBOX =
  "h-5 w-5 shrink-0 rounded border-pw-surface accent-pw-ember-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500";

type Choice = PublicConsentChoice;
type Prefs = PublicConsentPrefs;

// Key and byte cap come from the shared record module rather than being
// re-declared here: telemetry.ts reads the same entry, and the copies had
// already drifted apart in what they checked.
const STORAGE_KEY = CONSENT_STORAGE_KEY;
const VISITOR_KEY = "moosewave.visitor_id.v1";
const VISITOR_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const POLICY_VERSION = "v1";
export const COOKIE_PREFERENCES_EVENT = "moosewave:open-cookie-preferences";

// Public site key baked into the marketing bundle at build time. The API
// resolves tenant ownership from this key rather than trusting a caller-
// supplied tenant id in a compliance record.
// When unset (e.g. local dev) the banner skips the server write but
// still persists locally — the localStorage entry is the source of
// truth for the UI either way.
const CONSENT_SITE_KEY =
  (typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY) ||
  "";
const CONSENT_ENDPOINT =
  (typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_POSTWAVE_API_BASE_URL) ||
  "";

function readOrCreateVisitorId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(VISITOR_KEY);
    if (existing && VISITOR_ID_RE.test(existing)) return existing;
    const bytes = new Uint8Array(16);
    if (!window.crypto?.getRandomValues) return "";
    window.crypto.getRandomValues(bytes);
    const id = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    window.localStorage.setItem(VISITOR_KEY, id);
    // A quota/security failure or a racing write must not produce an identity
    // that was never durably associated with this browser.
    return window.localStorage.getItem(VISITOR_KEY) === id ? id : "";
  } catch {
    return "";
  }
}

export function postConsentToServer(choice: Choice, prefs: Prefs): boolean {
  if (typeof window === "undefined") return false;
  if (!CONSENT_SITE_KEY) return true; // local/dev site identity intentionally unwired
  const visitorId = readOrCreateVisitorId();
  if (
    !enqueuePublicConsentDecision({
      visitorId,
      choice,
      prefs,
      policyVersion: POLICY_VERSION,
      config: {
        siteKey: CONSENT_SITE_KEY,
        endpoint: CONSENT_ENDPOINT,
      },
    })
  ) {
    return false;
  }
  // The exact request envelope and its UUID key were durably written before
  // this call. Network loss, reload, 429, or 5xx retries retain that identity;
  // only a fully validated 202 removes it.
  void flushPendingPublicConsentDecisions({
    siteKey: CONSENT_SITE_KEY,
    endpoint: CONSENT_ENDPOINT,
  });
  return true;
}

function globalPrivacyControlEnabled(): boolean {
  if (typeof navigator === "undefined") return false;
  return Boolean(
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl,
  );
}

/**
 * Optional-consent checkbox state when the preferences panel opens: a stored
 * choice wins, and with nothing stored both boxes start unchecked.
 *
 * This read `existing?.analytics ?? !globalPrivacyControlEnabled()`, which
 * pre-ticked Analytics for anyone who opened the panel from the footer's
 * "Cookie preferences" button before making a choice — the banner is a bounded
 * card that deliberately clears the footer, so that is a reachable order of
 * operations. "Save preferences" is the primary button and takes focus when the
 * panel opens, so one keypress wrote analytics: true into the consent ledger as
 * a choice the visitor never made.
 *
 * The GPC term could not prevent it: when GPC is on, the mount effect has
 * already written a "gpc" record, so `existing` is non-null and the fallback
 * never runs. Its only reachable value was `true`. Marketing, in the same
 * expression, already defaulted to false — as did both boxes on the
 * first-visit path, which never touches this state at all.
 */
export function initialOptionalPrefs(existing: Prefs | null): {
  analytics: boolean;
  marketing: boolean;
} {
  return {
    analytics: existing?.analytics ?? false,
    marketing: existing?.marketing ?? false,
  };
}

function readPrefs(): Prefs | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    // Expiry lives in lib/cookie-consent-record so this reader and telemetry's
    // cannot disagree: a banner that re-prompts while telemetry still captures
    // against the stale entry would be worse than never expiring at all.
    const { prefs, oversize } = parseConsentRecord(raw, new Date());
    if (oversize) window.localStorage.removeItem(STORAGE_KEY);
    return prefs;
  } catch {
    return null;
  }
}

function gpcPrefs(): Prefs {
  return { essential: true, analytics: false, marketing: false };
}

function persistLocalPrefs(choice: Choice, prefs: Prefs): boolean {
  if (typeof window === "undefined") return false;
  try {
    const payload = JSON.stringify({
      choice,
      prefs,
      ts: new Date().toISOString(),
    });
    if (
      new TextEncoder().encode(payload).byteLength <= MAX_COOKIE_PREFS_BYTES
    ) {
      window.localStorage.setItem(STORAGE_KEY, payload);
      if (window.localStorage.getItem(STORAGE_KEY) !== payload) return false;
    } else {
      return false;
    }
  } catch {
    return false;
  }
  applyToPostHog(prefs);
  return true;
}

function writePrefs(choice: Choice, prefs: Prefs): boolean {
  const gpc = globalPrivacyControlEnabled();
  const effectiveChoice: Choice = gpc ? "gpc" : choice;
  const effectivePrefs = gpc ? gpcPrefs() : prefs;
  const persisted = persistLocalPrefs(effectiveChoice, effectivePrefs);
  if (!persisted) return false;
  // Mirror the choice to the server-side consent_events ledger so the
  // compliance audit trail captures visitor_id + IP + UA. Delivery remains
  // non-blocking, but uncertainty is held durably under the same replay key.
  return postConsentToServer(effectiveChoice, effectivePrefs);
}

function applyToPostHog(prefs: Prefs): void {
  if (typeof window === "undefined") return;
  const granted = prefs.analytics && !globalPrivacyControlEnabled();
  // PostHog may or may not be loaded; access defensively without using `any`.
  const w = window as unknown as {
    posthog?: {
      opt_in_capturing?: () => void;
      opt_out_capturing?: (options?: { clear_persistence?: boolean }) => void;
    };
  };
  if (!w.posthog) {
    // Not loaded is now the NORMAL state before a grant: telemetry.ts refuses
    // to call `posthog.init()` until consent exists, because initialising
    // writes a cookie and a localStorage entry, and ePrivacy Art. 5(3)
    // regulates that storage rather than the later transmission. So a grant
    // has to *start* PostHog, not just flip a switch on an already-running
    // one. Returning early here — the old behaviour — would mean an accepted
    // banner did nothing until the next navigation.
    if (granted) {
      void import("@/lib/telemetry").then((m) => m.init());
    }
    return;
  }
  if (granted) {
    w.posthog.opt_in_capturing?.();
  } else {
    // Withdrawal removes the store the grant created; opting out while leaving
    // the identity cookie behind keeps storing data with no lawful basis.
    w.posthog.opt_out_capturing?.({ clear_persistence: true });
  }
}

export function CookieBanner(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [syncProblem, setSyncProblem] = useState(false);
  const shouldFocusOnOpenRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const resumePendingSync = (): void => {
      if (!CONSENT_SITE_KEY) return;
      void flushPendingPublicConsentDecisions({
        siteKey: CONSENT_SITE_KEY,
        endpoint: CONSENT_ENDPOINT,
      });
    };
    const resumePendingSyncFromStorage = (event: StorageEvent): void => {
      if (event.key?.startsWith(PUBLIC_CONSENT_PENDING_STORAGE_KEY)) {
        resumePendingSync();
      }
    };
    const enforceServerGPC = (): void => {
      const prefs = gpcPrefs();
      const persisted = persistLocalPrefs("gpc", prefs);
      // The server-observed privacy signal is authoritative even if storage is
      // full or unavailable. Never leave telemetry opted in merely because the
      // durable local mirror could not be updated.
      applyToPostHog(prefs);
      setAnalytics(false);
      setMarketing(false);
      setSyncProblem(!persisted);
      setOpen(!persisted);
    };
    const observeSyncState = (event: Event): void => {
      const state = (event as CustomEvent<{ state?: string }>).detail?.state;
      if (
        state === "conflict" ||
        state === "failed" ||
        state === "queue_full" ||
        state === "storage_unavailable" ||
        state === "storage_corrupt" ||
        state === "configuration_mismatch"
      ) {
        setSyncProblem(true);
        setOpen(true);
      }
    };
    const openPrefs = (): void => {
      const initial = initialOptionalPrefs(readPrefs());
      setAnalytics(initial.analytics);
      setMarketing(initial.marketing);
      setCustomizing(true);
      shouldFocusOnOpenRef.current = true;
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setOpen(true);
    };
    window.addEventListener(COOKIE_PREFERENCES_EVENT, openPrefs);
    window.addEventListener("online", resumePendingSync);
    window.addEventListener("storage", resumePendingSyncFromStorage);
    window.addEventListener(
      PUBLIC_CONSENT_GPC_ENFORCED_EVENT,
      enforceServerGPC,
    );
    window.addEventListener(PUBLIC_CONSENT_SYNC_STATE_EVENT, observeSyncState);
    resumePendingSync();
    const existing = readPrefs();
    if (globalPrivacyControlEnabled()) {
      const mirrored = writePrefs("gpc", gpcPrefs());
      setOpen(!mirrored);
      setSyncProblem(!mirrored);
    } else if (!existing) {
      setOpen(true);
    } else {
      applyToPostHog(existing);
    }
    return () => {
      window.removeEventListener(COOKIE_PREFERENCES_EVENT, openPrefs);
      window.removeEventListener("online", resumePendingSync);
      window.removeEventListener("storage", resumePendingSyncFromStorage);
      window.removeEventListener(
        PUBLIC_CONSENT_GPC_ENFORCED_EVENT,
        enforceServerGPC,
      );
      window.removeEventListener(
        PUBLIC_CONSENT_SYNC_STATE_EVENT,
        observeSyncState,
      );
    };
  }, []);

  useEffect(() => {
    if (!open || !shouldFocusOnOpenRef.current) return;
    const handle = window.requestAnimationFrame(() => {
      saveButtonRef.current?.focus();
      shouldFocusOnOpenRef.current = false;
    });
    return () => window.cancelAnimationFrame(handle);
  }, [open, customizing]);

  if (!open) return null;

  const close = (): void => {
    setOpen(false);
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (target && document.contains(target)) {
      window.setTimeout(() => target.focus(), 0);
    }
  };

  const acceptAll = (): void => {
    const complete = writePrefs("accept", {
      essential: true,
      analytics: true,
      marketing: true,
    });
    setSyncProblem(!complete);
    if (complete) close();
  };
  const rejectOptional = (): void => {
    const complete = writePrefs("reject", gpcPrefs());
    setSyncProblem(!complete);
    if (complete) close();
  };
  const saveCustom = (): void => {
    const complete = writePrefs("custom", {
      essential: true,
      analytics,
      marketing,
    });
    setSyncProblem(!complete);
    if (complete) close();
  };
  const discardUnrecoverable = (): void => {
    discardUnrecoverablePublicConsentDecisions();
    setSyncProblem(false);
  };

  return (
    <section
      role="region"
      aria-labelledby="moosewave-cookie-title"
      // Bounded card anchored bottom-left so it doesn't span the footer as a
      // full-width bar and clears the bottom-right tour launcher (MKTN-016);
      // raised above the launcher on mobile.
      className="fixed bottom-20 left-4 z-50 max-h-[calc(100dvh-6rem)] w-[min(calc(100%_-_2rem),28rem)] overflow-y-auto overscroll-contain rounded-xl border border-pw-surface bg-pw-paper/95 shadow-lg backdrop-blur sm:bottom-4 sm:max-h-[calc(100dvh-2rem)]"
    >
      <div className="flex flex-col gap-3 px-5 py-4">
        <h2 id="moosewave-cookie-title" className="sr-only">
          Cookie preferences
        </h2>
        <div className="text-sm text-pw-muted-on-paper">
          We use essential cookies to keep Moosewave working (auth and
          security). Optional analytics cookies help us improve the product.
          {globalPrivacyControlEnabled()
            ? " Your browser's Global Privacy Control signal is active, so optional tracking starts off."
            : null}{" "}
          See our{" "}
          <Link
            href="/legal/cookies"
            className="text-pw-ember-700 underline underline-offset-4 hover:text-pw-ember-600"
          >
            Cookie Policy
          </Link>
          .
          {customizing ? (
            <div className="mt-3 flex flex-col gap-2 text-pw-ink2">
              <label className="flex min-h-11 items-center gap-2">
                <input type="checkbox" checked disabled className={CHECKBOX} />
                <span className="text-sm">
                  Essential (always on) — session, auth, CSRF, payment handoff
                </span>
              </label>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  checked={analytics}
                  onChange={(e) => setAnalytics(e.target.checked)}
                  className={CHECKBOX}
                />
                <span className="text-sm">
                  Analytics — PostHog product analytics (anonymized)
                </span>
              </label>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  checked={marketing}
                  onChange={(e) => setMarketing(e.target.checked)}
                  className={CHECKBOX}
                />
                <span className="text-sm">
                  Marketing — attribution and remarketing
                </span>
              </label>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {customizing ? (
            <button
              ref={saveButtonRef}
              type="button"
              onClick={saveCustom}
              className={BTN_PRIMARY}
            >
              Save preferences
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setCustomizing(true)}
                className={BTN_OUTLINE}
              >
                Customize
              </button>
              <button
                type="button"
                onClick={rejectOptional}
                className={BTN_OUTLINE}
              >
                Reject optional
              </button>
              <button type="button" onClick={acceptAll} className={BTN_PRIMARY}>
                Accept all
              </button>
            </>
          )}
        </div>
        {syncProblem ? (
          <div
            role="status"
            className="rounded-md border border-pw-ember-300 bg-pw-ember-50 p-3 text-sm text-pw-ink2"
          >
            <p>
              Your privacy choice is applied on this device, but its server
              receipt could not be safely queued. Keep this window open and try
              again, or explicitly discard unrecoverable local receipt attempts.
            </p>
            <button
              type="button"
              onClick={discardUnrecoverable}
              className="mt-2 inline-flex min-h-11 items-center text-left text-pw-ember-700 underline underline-offset-4 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
            >
              Discard unrecoverable receipt attempts
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

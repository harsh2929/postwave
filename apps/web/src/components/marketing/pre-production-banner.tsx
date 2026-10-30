// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

const DISMISS_KEY = "moosewave.preprod_banner.dismissed.v1";

/**
 * Persistent pre-production notice for the marketing surface.
 *
 * This is static boilerplate, not a live update, so it is a plain landmark
 * (`role="note"`) rather than an ARIA live region — announcing it on every
 * navigation would be wrong (MKTP-015).
 *
 * It is dismissible and the choice persists in localStorage (MKTC-015). To
 * stay hydration-safe the banner renders on the server and on the client's
 * first paint identically (visible); the stored dismissal is only applied in
 * an effect after mount, so no server/client attribute diverges.
 */
export function PreProductionBanner(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(DISMISS_KEY) === "1") {
        setDismissed(true);
      }
    } catch {
      // localStorage unavailable — keep the banner visible.
    }
  }, []);

  if (dismissed) return null;

  const dismiss = (): void => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Non-persistent dismissal is still better than none.
    }
  };

  return (
    <div
      role="note"
      aria-label="Pre-production qualification notice"
      // Reserve the full 44px dismiss target at every width so centered copy
      // can never wrap underneath it.
      className="relative border-b border-amber-300 bg-amber-50 px-6 py-2 pr-12 text-center text-xs text-amber-950"
    >
      <span className="hidden sm:inline">
        Pre-production qualification: checkout, legal terms, provider-backed
        capabilities, and service commitments remain unavailable until their
        release evidence is approved.{" "}
      </span>
      <span className="sm:hidden">
        Pre-production qualification in progress.{" "}
      </span>
      <Link
        href="/roadmap"
        className="font-medium underline underline-offset-2 hover:text-amber-900"
      >
        Review status
      </Link>
      .
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss pre-production notice"
        className="absolute right-0.5 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded text-amber-900 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      >
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// Cross-device continuity control. Web detail views (campaign, subscriber,
// sequence) get a small "Copy link" button that hands out the *universal*
// link on the active deployment host. That single URL doubles
// as the shareable web address AND the "open in app" affordance: via the
// AASA the web app serves, opening it on a device with the native
// desktop/mobile app routes straight into that entity — turning the latent
// route-map plumbing into real open-on-one-continue-on-another behaviour.
//
// Link shape is derived from the shared @postwave/route-map registry (the
// single source of truth) — we never hand-roll the slug/scheme here.
"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Link2 } from "lucide-react";
import { toast } from "sonner";

import { Button, type ButtonProps } from "@/components/ui/button";
import { copyToClipboard, isClipboardAvailable } from "@/lib/clipboard";
import { entityShareUrl } from "@/lib/entity-share-link";

export { entityShareUrl };

export interface CopyEntityLinkProps {
  /** route-map entity key: "campaign" | "subscriber" | "sequence" | … */
  entity: string;
  /** Resource id. */
  id: string;
  /** Button label (defaults to "Copy link"). */
  label?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}

type CopyStatus = "idle" | "copied" | "error";

/**
 * A reusable "Copy link" button. Copies the universal link for the entity to
 * the clipboard and flips to a confirmation state briefly. Renders nothing
 * when the entity/id can't produce a valid link (keeps callers terse — they
 * can pass an id straight from the route without guarding).
 *
 * Clipboard access is guarded the way the rest of the app does (see
 * settings/api + settings/webhooks): when the Clipboard API is unavailable
 * the button is rendered disabled with the URL exposed via `title` as a
 * manual-copy fallback, and a rejected write surfaces a visible failure
 * state (icon + label flip + toast) rather than failing silently.
 */
export function CopyEntityLink({
  entity,
  id,
  label = "Copy link",
  variant = "outline",
  size = "sm",
  className,
}: CopyEntityLinkProps): JSX.Element | null {
  const [status, setStatus] = useState<CopyStatus>("idle");
  // Resolved on the client so SSR doesn't mark the button disabled before the
  // Clipboard API is observable; defaults to available to avoid a flash.
  const [available, setAvailable] = useState(true);
  const [deploymentOrigin, setDeploymentOrigin] = useState<string>();
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAvailable(isClipboardAvailable());
    setDeploymentOrigin(window.location.origin);
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const url = entityShareUrl(entity, id, deploymentOrigin);
  if (!url) return null;

  const scheduleReset = (): void => {
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setStatus("idle");
      resetTimerRef.current = null;
    }, 1600);
  };

  const onCopy = async (): Promise<void> => {
    const result = await copyToClipboard(url);
    if (result === "copied") {
      setStatus("copied");
      scheduleReset();
      return;
    }
    // Both "unavailable" and "error" are real, user-visible failures here —
    // surface them instead of swallowing the rejected write.
    setStatus("error");
    toast.error(
      result === "unavailable"
        ? "Clipboard unavailable — copy the link manually."
        : "Couldn't copy the link. Try again.",
    );
    scheduleReset();
  };

  const failed = status === "error";

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      disabled={!available}
      onClick={() => void onCopy()}
      aria-live="polite"
      aria-label={
        available
          ? `Copy link to this ${entity}`
          : `Clipboard unavailable — copy this ${entity} link manually`
      }
      title={url}
    >
      {status === "copied" ? (
        <Check className="h-4 w-4" />
      ) : failed ? (
        <AlertTriangle className="h-4 w-4" />
      ) : (
        <Link2 className="h-4 w-4" />
      )}
      {status === "copied" ? "Copied" : failed ? "Copy failed" : label}
    </Button>
  );
}

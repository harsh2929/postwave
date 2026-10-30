// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// "Copy JWKS URL" for a Standard Webhooks audit sink (desktop parity:
// components/audit/AuditSinkEditorPrimitives.tsx SigningKeyPanel). The URL is
// built client-side from the public API origin; this control never fetches
// the JWKS. The endpoint is audit:read-gated and publishes HS256 verification
// material, so the browser only hands the address to whoever configures the
// receiver.

import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppOrigin } from "@/lib/use-app-origin";

/** Absolute JWKS address for one sink under the given API origin. */
export function sinkJwksUrl(sinkId: string, origin: string): string {
  const base = origin.trim().replace(/\/+$/, "");
  return `${base}/api/v1/audit-sinks/${encodeURIComponent(sinkId)}/.well-known/jwks.json`;
}

/**
 * The origin receivers should call: an explicitly configured public API origin
 * wins (split-origin deployments); otherwise the browser's own origin, which
 * serves /api/* through the app's proxy. Empty until mount (hydration-safe).
 */
function useJwksOrigin(): string {
  const appOrigin = useAppOrigin();
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim() ?? "";
  return configured || appOrigin;
}

export function SinkJwksCopyButton({
  sinkId,
  disabled = false,
}: {
  sinkId: string;
  disabled?: boolean;
}) {
  const origin = useJwksOrigin();
  const url = origin ? sinkJwksUrl(sinkId, origin) : null;

  async function copy(): Promise<void> {
    if (!url) return;
    const result = await copyToClipboard(url);
    if (result === "copied") toast.success("JWKS URL copied.");
    else
      toast.error(
        result === "unavailable"
          ? "Clipboard unavailable — copy the JWKS URL shown below manually."
          : "Could not copy the JWKS URL to the clipboard.",
      );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || !url}
        onClick={() => void copy()}
      >
        <Copy aria-hidden />
        Copy JWKS URL
      </Button>
      <p className="text-xs text-muted-foreground">
        Receivers verify signatures against{" "}
        <code className="break-all">
          {url ??
            `/api/v1/audit-sinks/${encodeURIComponent(sinkId)}/.well-known/jwks.json`}
        </code>
        . Revoked keys stay listed for a 30-minute grace window so in-flight
        verifications still resolve. The endpoint needs an audit:read
        credential; this screen copies the address and never fetches the key
        material.
      </p>
    </div>
  );
}

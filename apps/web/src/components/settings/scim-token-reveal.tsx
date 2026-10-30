// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Show-once reveal for a freshly minted SCIM provisioning token (desktop
// parity: pages/SCIM.tsx RevealMintedTokenModal + the "Close without storing
// this token?" confirm). Adds what the inline web reveal lacked:
//   - show/hide masking, for screen-sharing an IdP setup without leaking it;
//   - a secret copy that clears the clipboard after 60 s if it still holds
//     the token;
//   - an explicit acknowledgement before "Done", and a confirm that names
//     the consequence before the token is discarded unstored.
// The token lives only in the parent's state; nothing here persists it.

import { useState } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { MintedToken } from "@/lib/scim-api";
import { copySecretWithAutoClear } from "@/lib/secret-clipboard";

const MASK = "•";

export function maskToken(token: string): string {
  return MASK.repeat(Math.min(Array.from(token).length, 48));
}

export function ScimTokenReveal({
  minted,
  onDismiss,
}: {
  minted: MintedToken;
  /** Drops the plaintext from the parent's state. */
  onDismiss: () => void;
}) {
  const [shown, setShown] = useState(true);
  const [stored, setStored] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  async function copy(): Promise<void> {
    const result = await copySecretWithAutoClear(minted.token, {
      // Runs after the panel may already be closed; sonner is global.
      onClearOutcome: (outcome) => {
        if (outcome === "failed")
          toast.error(
            "Moosewave could not clear the SCIM token from the clipboard. Clear it manually.",
          );
      },
    });
    if (result.status === "copied") {
      const seconds = Math.round(result.clearAfterMs / 1000);
      const note = result.clearScheduled
        ? `Token copied. Moosewave will clear the clipboard in ${seconds} seconds if it still holds this token.`
        : "Token copied. This browser cannot read the clipboard back, so clear it yourself after pasting.";
      setCopyNote(note);
      toast.success("SCIM token copied.");
      return;
    }
    setCopyNote(null);
    toast.error(
      result.status === "unavailable"
        ? "Clipboard unavailable — select and copy the token manually."
        : "Could not copy the token to the clipboard.",
    );
  }

  return (
    <section
      aria-label="New SCIM token"
      className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm"
    >
      <p className="font-medium text-warning-emphasis">
        Copy this token now — it will not be shown again.
      </p>
      {minted.warning.trim() ? (
        <p className="mt-1 text-xs text-muted-foreground">{minted.warning}</p>
      ) : null}
      <div className="mt-2 flex items-start gap-2">
        <code
          data-testid="scim-token-value"
          aria-label={shown ? "SCIM token" : "SCIM token (hidden)"}
          className="block min-w-0 flex-1 break-all rounded bg-background p-2 text-xs"
        >
          {shown ? minted.token : maskToken(minted.token)}
        </code>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-pressed={!shown}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {shown ? "Hide" : "Show"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Configure your IdP to send this as{" "}
        <code>Authorization: Bearer …</code> on every SCIM request.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy()}
        >
          <Copy aria-hidden />
          Copy token
        </Button>
        <label className="flex cursor-pointer items-center gap-2 text-xs">
          <Checkbox
            checked={stored}
            onChange={(event) => setStored(event.target.checked)}
          />
          I&apos;ve stored it safely.
        </label>
      </div>
      {copyNote ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {copyNote}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!stored}
          onClick={onDismiss}
        >
          Done — I&apos;ve saved it
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => (stored ? onDismiss() : setConfirmClose(true))}
        >
          Close
        </Button>
      </div>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Close without storing this token?"
        description="The full SCIM token is shown once and cannot be recovered. You will need to revoke it and mint another."
        confirmLabel="Discard shown token"
        cancelLabel="Keep token open"
        onConfirm={onDismiss}
      />
    </section>
  );
}

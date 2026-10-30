// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Row action that copies a SCIM token's public prefix for IdP log searches
// (desktop parity: pages/SCIM.tsx tokens table "Copy"). The prefix is not a
// secret, so it is copied as-is with no clipboard clean-up.

import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

export function ScimTokenPrefixCopy({
  prefix,
  disabled = false,
}: {
  prefix: string;
  disabled?: boolean;
}) {
  async function copy(): Promise<void> {
    const result = await copyToClipboard(prefix);
    if (result === "copied") {
      toast.success(`Copied token prefix ${prefix}.`);
      return;
    }
    toast.error(
      result === "unavailable"
        ? "Clipboard unavailable — copy the prefix manually."
        : "Could not copy the token prefix to the clipboard.",
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled}
      aria-label={`Copy token prefix ${prefix} for IdP log searches`}
      onClick={() => void copy()}
    >
      <Copy aria-hidden />
      Copy prefix
    </Button>
  );
}

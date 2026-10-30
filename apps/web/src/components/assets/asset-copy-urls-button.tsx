// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { publicAssetURL, type Asset } from "@/lib/assets-api";
import { copyToClipboard, isClipboardAvailable } from "@/lib/clipboard";

/**
 * The public delivery URLs for a selection, all or nothing (desktop parity:
 * LibrarySelectionBar "Copy URLs"). An asset held in local authenticated
 * storage has no shareable URL; copying the rest would hand the operator a
 * list that silently omits files they selected, so the copy is refused and
 * the reason names how many are affected.
 */
export function selectedAssetURLs(assets: readonly Asset[]): {
  urls: string[];
  missing: number;
} {
  const urls: string[] = [];
  let missing = 0;
  for (const asset of assets) {
    const url = publicAssetURL(asset);
    if (url) urls.push(url);
    else missing += 1;
  }
  return { urls, missing };
}

/**
 * Bulk "Copy URLs" for the asset selection bar. Read-only: any role that can
 * select assets may copy their public URLs. Every outcome is surfaced — copied,
 * refused because some URLs are not public, clipboard unavailable, or the
 * browser rejecting the write.
 */
export function CopyAssetUrlsButton({
  assets,
  disabled = false,
}: {
  assets: readonly Asset[];
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const clipboardReady = isClipboardAvailable();
  const count = assets.length;

  async function copy() {
    if (busy || count === 0) return;
    const { urls, missing } = selectedAssetURLs(assets);
    if (missing > 0) {
      toast.error(
        `${missing} of the ${count} selected asset${count === 1 ? "" : "s"} ${missing === 1 ? "has" : "have"} no public URL, so nothing was copied.`,
        {
          description:
            "Assets in local authenticated storage cannot be shared by link. Deselect them, or download them instead.",
        },
      );
      return;
    }
    setBusy(true);
    try {
      const result = await copyToClipboard(urls.join("\n"));
      if (result === "copied") {
        toast.success(
          `${urls.length} asset URL${urls.length === 1 ? "" : "s"} copied`,
        );
      } else if (result === "unavailable") {
        toast.error(
          "Clipboard access is unavailable in this browser. Nothing was copied.",
        );
      } else {
        toast.error(
          "The browser refused the clipboard write. Nothing was copied.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled || busy || count === 0 || !clipboardReady}
      loading={busy}
      title={
        !clipboardReady
          ? "Clipboard access is unavailable in this browser. Open an asset to select its URL manually."
          : undefined
      }
      onClick={() => void copy()}
    >
      <Copy aria-hidden />
      Copy URLs
    </Button>
  );
}

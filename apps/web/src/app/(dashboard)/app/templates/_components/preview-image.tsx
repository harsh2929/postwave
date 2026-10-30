// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ImageIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A thumbnail/preview `<img>` that swaps to a graceful "Preview unavailable"
 * block when the source 404s or is blocked, instead of the browser's raw
 * broken-image glyph. Shared by the card, detail, and preview surfaces so the
 * fallback treatment is identical everywhere (TMPL-008).
 *
 * A plain `<img>` (not next/image) is intentional: the API returns immutable,
 * content-addressed previews from Moosewave's configured asset CDN. Trust
 * validation happens before this component receives the URL.
 */
export function PreviewImage({
  src,
  alt,
  className,
  wrapperClassName,
  width,
  height,
}: {
  src?: string;
  alt: string;
  className?: string;
  /** Applied to the fallback wrapper so it can match the img footprint. */
  wrapperClassName?: string;
  /**
   * Intrinsic pixel size of the asset. The API already reports `width`/`height`
   * for every hosted preview, and without them an `<img>` sized only by
   * `max-height`/`max-width` lays out at height 0 until the bytes arrive and
   * then jumps by hundreds of pixels — a large layout shift on the template
   * detail and capture surfaces. Passing both lets the UA reserve the box from
   * the aspect ratio (Tailwind's preflight already applies `height: auto`).
   * Callers inside a fixed-size container can keep omitting them.
   */
  width?: number;
  height?: number;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();

  if (!src || failedSrc === src) {
    const hasAccessibleName = Boolean(alt.trim());
    return (
      <div
        className={cn(
          "flex min-h-40 flex-col items-center justify-center gap-2 rounded border bg-muted/30 py-10 text-muted-foreground",
          wrapperClassName,
        )}
        role={hasAccessibleName ? "img" : undefined}
        aria-label={
          hasAccessibleName ? `${alt} (preview unavailable)` : undefined
        }
        aria-hidden={hasAccessibleName ? undefined : true}
      >
        <ImageIcon className="h-8 w-8" aria-hidden />
        <span className="text-xs">Preview unavailable</span>
      </div>
    );
  }

  // Only a COMPLETE pair is forwarded: a lone dimension gives the UA no ratio
  // to reserve space from and would just constrain one axis.
  const hasIntrinsicSize =
    typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height > 0;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      width={hasIntrinsicSize ? width : undefined}
      height={hasIntrinsicSize ? height : undefined}
      onError={() => setFailedSrc(src)}
      className={className}
    />
  );
}

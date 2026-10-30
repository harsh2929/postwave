// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from "react";

import { renderSmsPreview } from "./page-helpers";

/**
 * Phone-style preview of a composed SMS/MMS: merge tags render with sample
 * values and MMS media shows as an image, so operators see the real message
 * instead of literal {{tags}} or a bare URL (audit SMS-033).
 */
export function SmsPhonePreview({
  body,
  mediaUrl,
}: {
  body: string;
  mediaUrl?: string;
}) {
  const [loadedMedia, setLoadedMedia] = useState<string | null>(null);
  const [failedMedia, setFailedMedia] = useState<string | null>(null);
  const rendered = renderSmsPreview(body);
  const media = mediaUrl?.trim();
  const mayRenderMedia = Boolean(media && loadedMedia === media);
  const mediaFailed = Boolean(media && failedMedia === media);
  return (
    <div className="rounded-2xl border bg-muted/30 p-3">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Preview
      </div>
      <div className="max-w-[18rem] space-y-2 rounded-2xl rounded-bl-sm bg-primary px-3 py-2 text-sm text-primary-foreground shadow-sm">
        {media ? (
          mayRenderMedia && !mediaFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={media}
              alt="MMS media preview"
              className="max-h-40 w-full rounded-lg object-cover"
              referrerPolicy="no-referrer"
              onError={() => setFailedMedia(media)}
            />
          ) : mediaFailed ? (
            <div className="rounded-lg bg-background/20 px-2 py-3 text-center text-xs text-primary-foreground/80">
              Media could not be loaded. Verify the MMS URL is public.
            </div>
          ) : (
            <div className="space-y-2 rounded-lg bg-background/20 px-2 py-3 text-center text-xs text-primary-foreground/90">
              <p>
                External media is hidden. Loading it contacts the media host
                and can disclose your IP address and timing.
              </p>
              <button
                type="button"
                className="rounded-md border border-current px-2 py-1 font-medium"
                aria-label="Load external MMS media preview"
                onClick={() => {
                  setFailedMedia(null);
                  setLoadedMedia(media);
                }}
              >
                Load external media
              </button>
            </div>
          )
        ) : null}
        {rendered ? (
          <p className="whitespace-pre-wrap break-words">{rendered}</p>
        ) : (
          <p className="italic text-primary-foreground/70">
            Your message preview appears here.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * AssetThumb — renders an asset image across both storage backends.
 *
 * Encapsulates the auth-gated-blob handling (see lib/asset-display): on R2
 * it renders the public URL directly; on the filesystem backend it fetches
 * the auth-gated "/api/v1/assets/{id}/blob" with the Bearer key and renders
 * the resulting object URL. When there's nothing displayable (missing URL,
 * auth-fetch failure, or decode error) it renders `fallback` instead — so
 * every call site keeps its own "image unavailable" affordance.
 */

import { type ReactElement, type ReactNode, useState } from "react";

import { useAssetImageSrc } from "../../lib/asset-display";

interface Props {
  url: string | null | undefined;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
  draggable?: boolean;
  /** MIME supplied by the asset record. GIFs stay paused unless explicitly
   *  opted into animation, so user uploads never start moving unexpectedly. */
  mime?: string | null;
  allowAnimation?: boolean;
  /** Rendered only after a terminal failure or when no URL exists. */
  fallback?: ReactNode;
  /** Rendered while an authenticated image fetch is pending. */
  loadingFallback?: ReactNode;
}

function isGif(
  mime: string | null | undefined,
  url: string | null | undefined,
): boolean {
  if (mime?.split(";", 1)[0]?.trim().toLowerCase() === "image/gif") return true;
  return /\.gif(?:$|[?#])/i.test(url?.trim() ?? "");
}

export function AssetThumb({
  url,
  alt,
  className,
  loading,
  draggable,
  fallback = null,
  loadingFallback = null,
  mime,
  allowAnimation = false,
}: Props): ReactElement {
  const pausedGif = !allowAnimation && isGif(mime, url);
  const { src, status } = useAssetImageSrc(pausedGif ? null : url);
  const [decodeState, setDecodeState] = useState<{
    src: string | null;
    status: "loading" | "ready" | "error";
  }>({ src: null, status: "loading" });
  const decodedStatus =
    decodeState.src === src ? decodeState.status : "loading";
  const stateClassName = ["asset-thumb-state", className]
    .filter(Boolean)
    .join(" ");

  if (pausedGif) {
    return (
      <span
        className={`${stateClassName} is-paused`}
        data-asset-image-state="paused"
      >
        <span className="visually-hidden">
          {alt}. Animated GIF preview paused.
        </span>
        <span className="asset-thumb-paused-badge" aria-hidden="true">
          GIF · paused
        </span>
      </span>
    );
  }

  if (status === "loading") {
    return (
      <span
        className={`${stateClassName} is-loading`}
        aria-busy="true"
        data-asset-image-state="loading"
      >
        <span className="visually-hidden">Loading image: {alt}. </span>
        <span aria-hidden="true">{loadingFallback ?? "Loading…"}</span>
      </span>
    );
  }

  if (
    !src ||
    status === "empty" ||
    status === "error" ||
    decodedStatus === "error"
  ) {
    return (
      <span
        className={`${stateClassName} is-error`}
        data-asset-image-state="error"
      >
        <span className="visually-hidden">{alt}. Image unavailable. </span>
        <span aria-hidden="true">{fallback ?? "Image unavailable"}</span>
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      draggable={draggable}
      decoding="async"
      referrerPolicy="no-referrer"
      aria-busy={decodedStatus === "loading" ? "true" : undefined}
      data-asset-image-state={decodedStatus}
      onLoad={() => setDecodeState({ src, status: "ready" })}
      onError={() => setDecodeState({ src, status: "error" })}
    />
  );
}

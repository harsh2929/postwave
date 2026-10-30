/**
 * asset-display — resolve an Asset.url into something the desktop can
 * actually render / copy, across both storage backends.
 *
 * Two backends produce two URL shapes (apps/api/internal/assets/storage.go):
 *   - R2 (production): an ABSOLUTE, public URL — usable directly in an
 *     <img> and copyable as-is.
 *   - Filesystem (dev / self-hosted without R2): a RELATIVE, auth-gated
 *     path "/api/v1/assets/{id}/blob". A bare <img> can't render it —
 *     `new URL(relative)` throws in safeExternalAssetUrl (→ null → no
 *     thumbnail), and even absolutized the blob route requires
 *     ScopeReadCampaigns (handlers.go), which an <img> can't supply.
 *
 * `resolveAssetUrl` absolutizes the relative FS path against the configured
 * API host so Copy URL yields a real, host-qualified URL. `useAssetImageSrc`
 * additionally fetches the auth-gated FS blob with the Bearer key and hands
 * back an object URL, so thumbnails render on FS deployments too. On R2 the
 * hook is a pass-through — the public URL is used directly, unchanged.
 */

import { useEffect, useState } from "react";

import { getApiKey, getApiUrl } from "./api-client";
import { nativeAwareFetch } from "./native-api-fetch";
import { safeExternalAssetUrl } from "./safe-url";

/**
 * Turn a possibly-relative Asset.url into a validated absolute URL.
 * Absolute inputs (R2 public URLs) are validated as-is; relative
 * same-origin "/api/..." paths (FS backend blobs) are absolutized against
 * the API host first. Returns null for empty / unsafe inputs.
 */
export function resolveAssetUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Already absolute (R2 public URL, or any http(s) URL): validate directly.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return safeExternalAssetUrl(trimmed);
  }
  // Relative root-absolute path (FS backend blob). Absolutize against the
  // API origin, matching the rest of the client (`${getApiUrl()}/api/...`).
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    const base = getApiUrl().replace(/\/+$/, "");
    return safeExternalAssetUrl(base + trimmed);
  }
  return null;
}

/** True when the URL points at this API host's auth-gated assets blob
 *  route — the FS-backend case that needs an authenticated fetch. */
function isApiHostedBlob(url: string): boolean {
  try {
    const api = new URL(getApiUrl());
    const u = new URL(url);
    return (
      u.origin === api.origin &&
      /^\/api\/v1\/assets\/[^/]+\/blob$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

/** Bearer key normalized the same way the API client does (pw_ prefix). */
function bearerKey(): string | null {
  const v = (getApiKey() ?? "").trim();
  if (!v) return null;
  return v.startsWith("pw_") ? v : `pw_${v}`;
}

/**
 * Create a renderer-local preview URL through the asset display boundary.
 * Keeping creation and revocation together makes ownership reviewable and
 * prevents page components from leaking native object URLs.
 */
export function createLocalAssetPreviewUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === "function"
    ? URL.createObjectURL(blob)
    : null;
}

export function revokeLocalAssetPreviewUrl(url: string): void {
  if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
}

export interface AssetImageSrc {
  /** The value to put in <img src>. null while an auth-fetch is in flight
   *  or when there's nothing displayable. */
  src: string | null;
  /** True when the auth-fetch failed (403/404/network) — caller should
   *  render its "image unavailable" fallback. */
  failed: boolean;
  /** Truthful lifecycle for callers that distinguish an authenticated fetch
   *  from a terminal failure. `ready` means a usable src is available. */
  status: "empty" | "loading" | "ready" | "error";
}

interface AuthImageState {
  resolved: string | null;
  src: string | null;
  status: "empty" | "loading" | "ready" | "error";
}

/**
 * Resolve an Asset.url to a directly-usable <img> src.
 *
 *   - R2 / any public absolute URL → returned as-is (no fetch).
 *   - FS-backend auth-gated blob → fetched with the Bearer key + session
 *     cookie, exposed as a same-process object URL (revoked on cleanup).
 *
 * The R2 path is a pure pass-through, so production rendering is unchanged;
 * the auth-fetch only ever runs for the FS backend's own blob route.
 */
export function useAssetImageSrc(
  raw: string | null | undefined,
): AssetImageSrc {
  const resolved = resolveAssetUrl(raw);
  const needsAuth = resolved != null && isApiHostedBlob(resolved);
  const [authState, setAuthState] = useState<AuthImageState>({
    resolved: null,
    src: null,
    status: "empty",
  });

  useEffect(() => {
    if (!resolved || !needsAuth) {
      setAuthState({
        resolved,
        src: null,
        status: resolved ? "ready" : "empty",
      });
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    setAuthState({ resolved, src: null, status: "loading" });
    void (async () => {
      try {
        const headers: Record<string, string> = {};
        const key = bearerKey();
        if (key) headers.Authorization = `Bearer ${key}`;
        const res = await nativeAwareFetch(resolved, {
          method: "GET",
          headers,
          mode: "cors",
          credentials: "include",
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          setAuthState({ resolved, src: null, status: "error" });
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        created = createLocalAssetPreviewUrl(blob);
        if (!created) {
          setAuthState({ resolved, src: null, status: "error" });
          return;
        }
        setAuthState({ resolved, src: created, status: "ready" });
      } catch {
        if (!cancelled) {
          setAuthState({ resolved, src: null, status: "error" });
        }
      }
    })();
    return () => {
      cancelled = true;
      if (created) revokeLocalAssetPreviewUrl(created);
    };
  }, [resolved, needsAuth]);

  if (!resolved) return { src: null, failed: false, status: "empty" };
  if (!needsAuth) return { src: resolved, failed: false, status: "ready" };
  if (authState.resolved !== resolved) {
    return { src: null, failed: false, status: "loading" };
  }
  return {
    src: authState.src,
    failed: authState.status === "error",
    status: authState.status,
  };
}

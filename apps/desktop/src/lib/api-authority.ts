import { canonicalApiBaseUrl } from "./config";

type ApiAuthorityListener = (authority: string | null) => void;

let authority: string | null = null;
const listeners = new Set<ApiAuthorityListener>();

/**
 * Publish the canonical full API base synchronously at the transport owner.
 * Identity-bearing consumers use this to clear old authority before another
 * event/request can be attributed to it.
 */
export function observeApiAuthority(
  apiBaseUrl: string | null | undefined,
): string | null {
  const next = canonicalApiBaseUrl(apiBaseUrl);
  if (next === authority) return next;
  authority = next;
  for (const listener of [...listeners]) {
    try {
      listener(next);
    } catch {
      // One optional observer must not block API configuration changes.
    }
  }
  return next;
}

/**
 * Publish a credential boundary even when the canonical base URL is
 * unchanged. The temporary null authority synchronously invalidates every
 * identity-bearing observer before a native broker can commit a replacement
 * bearer, then restores the transport base for anonymous attribution.
 */
export function observeApiCredentialBoundary(
  apiBaseUrl: string | null | undefined,
): string | null {
  const next = canonicalApiBaseUrl(apiBaseUrl);
  if (authority !== null) {
    authority = null;
    for (const listener of [...listeners]) {
      try {
        listener(null);
      } catch {
        // One optional observer must not block credential replacement.
      }
    }
  }
  return observeApiAuthority(next);
}

export function readApiAuthority(): string | null {
  return authority;
}

export function subscribeApiAuthority(
  listener: ApiAuthorityListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetApiAuthorityForTests(): void {
  authority = null;
  listeners.clear();
}

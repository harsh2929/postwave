const LEGACY_STORAGE_PREFIX = "postwave.analytics.saved-views.v1";

export interface LegacySavedViewsCleanup {
  notice: string | null;
  failed: boolean;
}

/** Delete every ownership-ambiguous plaintext generation without reading it. */
export function purgeLegacySavedViews(): LegacySavedViewsCleanup {
  if (typeof window === "undefined") return { notice: null, failed: false };
  const keys = new Set<string>([LEGACY_STORAGE_PREFIX]);
  let found = false;
  let failed = false;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key &&
        (key === LEGACY_STORAGE_PREFIX ||
          key.startsWith(`${LEGACY_STORAGE_PREFIX}:`))
      ) {
        found = true;
        keys.add(key);
      }
    }
  } catch {
    failed = true;
  }
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      failed = true;
    }
  }
  return {
    failed,
    notice: failed
      ? "An ownership-ambiguous plaintext saved-view record could not be removed."
      : found
        ? "An ownership-ambiguous plaintext saved-view record was removed without importing it."
        : null,
  };
}

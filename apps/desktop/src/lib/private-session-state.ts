/**
 * Process-local cleanup registry for customer-bearing desktop state.
 *
 * Sensitive search/filter/entity state may live in memory for the current
 * signed-in process, but it must be erased at an identity boundary. Owners
 * register a synchronous reset here; the auth layer invokes the registry
 * before the signed-out shell can be shown to another operator.
 *
 * The storage sweep removes records written by older builds without reading
 * or adopting them. Current code must never use these prefixes for sensitive
 * plaintext again.
 */

type PrivateSessionReset = () => void;

const resets = new Map<string, PrivateSessionReset>();

const UNSAFE_STORAGE_PREFIXES = [
  "postwave.cmdk.recents.v1",
  "postwave.desktop.route.v1",
  "postwave.audit.filters.v1",
  "postwave.helpdesk-note-quarantine.v1",
  "postwave.helpdesk-note-quarantine.v2",
  "postwave.helpdesk-note-quarantine.v3",
] as const;

const RECOVERY_QUARANTINE_PREFIXES = new Set<string>([
  "postwave.helpdesk-note-quarantine.v2",
  "postwave.helpdesk-note-quarantine.v3",
]);

const UNSAFE_STORAGE_KEYS = [
  "pw.subscribers.recentSearches.v1",
  "postwave.suppressions.pending-list-filter.v1",
  "postwave.suppressions.pending-list-name.v1",
] as const;

const ORPHANED_SUPPRESSION_KEYS = [
  "postwave.suppressions.pending-list-filter.v1",
  "postwave.suppressions.pending-list-name.v1",
] as const;

export function registerPrivateSessionReset(
  owner: string,
  reset: PrivateSessionReset,
): () => void {
  resets.set(owner, reset);
  return () => {
    if (resets.get(owner) === reset) resets.delete(owner);
  };
}

function purgeStorage(
  storage: Storage | undefined,
  preserveInternalNoteQuarantine: boolean,
): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
    for (const key of keys) {
      if (
        UNSAFE_STORAGE_KEYS.includes(
          key as (typeof UNSAFE_STORAGE_KEYS)[number],
        ) ||
        UNSAFE_STORAGE_PREFIXES.some(
          (prefix) =>
            (!preserveInternalNoteQuarantine ||
              !RECOVERY_QUARANTINE_PREFIXES.has(prefix)) &&
            (key === prefix || key.startsWith(`${prefix}:`)),
        )
      ) {
        storage.removeItem(key);
      }
    }
    // Storage test doubles do not always implement key()/length. Removing the
    // exact historical keys remains useful and harmless in that environment.
    for (const key of UNSAFE_STORAGE_KEYS) storage.removeItem(key);
    for (const prefix of UNSAFE_STORAGE_PREFIXES) {
      if (
        !preserveInternalNoteQuarantine ||
        !RECOVERY_QUARANTINE_PREFIXES.has(prefix)
      ) {
        storage.removeItem(prefix);
      }
    }
  } catch {
    // Hardened webviews may block either storage enumeration or deletion.
    // In-memory owners have still been cleared below/above.
  }
}

/** Remove list handoff keys that never had a consumer in any released UI. */
export function purgeOrphanedSuppressionHandoffs(): void {
  if (typeof window === "undefined") return;
  try {
    for (const key of ORPHANED_SUPPRESSION_KEYS) {
      window.sessionStorage.removeItem(key);
      window.localStorage.removeItem(key);
    }
  } catch {
    // A later sign-out sweep will retry if browser storage is unavailable.
  }
}

/** Clear every loaded owner and ownership-ambiguous plaintext legacy key. */
export function purgePrivateSessionState(options?: {
  preserveInternalNoteQuarantine?: boolean;
}): void {
  for (const reset of [...resets.values()]) {
    try {
      reset();
    } catch {
      // One optional owner must not prevent the remaining privacy cleanup.
    }
  }
  if (typeof window === "undefined") return;
  try {
    purgeStorage(
      window.localStorage,
      options?.preserveInternalNoteQuarantine === true,
    );
  } catch {
    // Accessing the Storage object itself can throw in a hardened webview.
  }
  try {
    purgeStorage(
      window.sessionStorage,
      options?.preserveInternalNoteQuarantine === true,
    );
  } catch {
    // Accessing the Storage object itself can throw in a hardened webview.
  }
}

// desktop-router imports this module during shell boot, so stale handoffs are
// removed promptly rather than waiting for the operator to revisit Lists.
purgeOrphanedSuppressionHandoffs();

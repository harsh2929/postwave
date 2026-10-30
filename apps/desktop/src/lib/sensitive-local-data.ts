/**
 * Encrypted persistence boundary for customer-authored desktop-only data.
 *
 * The logical key contains an opaque user+tenant fingerprint, never either
 * raw identifier. Ownership-ambiguous legacy plaintext is never adopted by a
 * newly signed-in identity; known old keys are purged without reading values.
 */

import { desktopRouteIdentityScope } from "./desktop-router";
import { vaultDelete, vaultReadJSON, vaultSetJSON } from "./secure-vault";

const RECORD_VERSION = 1;
const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,47}$/u;
const IDENTITY_SCOPE_RE = /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/u;
const LEGACY_IDENTITY_SCOPE_RE = /^[a-f0-9]{16}$/u;
const VAULT_STORAGE_PREFIX = "postwave.desktop.vault.v1:";
const LEGACY_TENANT_SUFFIX_RE = /^[a-z][a-z0-9.-]{0,63}$/u;

interface SensitiveRecord<T> {
  version: typeof RECORD_VERSION;
  value: T;
}

export interface SanitizedLocalData<T> {
  value: T;
  altered: boolean;
}

export type SensitiveLocalValidator<T> = (
  candidate: unknown,
) => SanitizedLocalData<T> | null;

export interface SensitiveLocalLoad<T> {
  value: T;
  state: "ready" | "unavailable";
  warning: string | null;
  retryable: boolean;
}

interface SensitiveLocalOptions<T> {
  identityScope: string | null;
  namespace: string;
  fallback: T;
  validate: SensitiveLocalValidator<T>;
  unownedLegacyKeys?: readonly string[];
  unownedTenantLegacySuffixes?: readonly string[];
  purgeLegacy16HexScopes?: boolean;
}

export function sensitiveLocalIdentityScope(
  user: string | null | undefined,
  tenant: string | null | undefined,
): string | null {
  return desktopRouteIdentityScope(user, tenant);
}

export function sensitiveLocalVaultKey(
  namespace: string,
  identityScope: string,
): string {
  if (!NAMESPACE_RE.test(namespace) || !IDENTITY_SCOPE_RE.test(identityScope)) {
    throw new Error("Sensitive local-data scope is invalid.");
  }
  return `sensitive-local.v${RECORD_VERSION}.${namespace}.${identityScope}`;
}

/** Load only identity-owned ciphertext and purge ambiguous old plaintext. */
export async function loadSensitiveLocalData<T>(
  options: SensitiveLocalOptions<T>,
): Promise<SensitiveLocalLoad<T>> {
  const { identityScope, namespace, fallback, validate } = options;
  const legacyCleanup = purgeUnownedLegacyKeys(
    options.unownedLegacyKeys ?? [],
    options.unownedTenantLegacySuffixes ?? [],
    namespace,
    options.purgeLegacy16HexScopes === true,
  );
  if (!identityScope) {
    return {
      value: fallback,
      state: "unavailable",
      warning: withLegacyCleanupWarning(
        "Encrypted local data is unavailable until the signed-in workspace identity is resolved.",
        legacyCleanup,
      ),
      retryable: legacyCleanup.failed,
    };
  }
  const key = sensitiveLocalVaultKey(namespace, identityScope);
  const read = await vaultReadJSON<SensitiveRecord<unknown>>(key).catch(
    () => ({ status: "unavailable" }) as const,
  );
  if (read.status === "ready") {
    const sanitized =
      read.value?.version === RECORD_VERSION
        ? validate(read.value.value)
        : null;
    if (!sanitized) {
      safelyDeleteVaultKey(key);
      return {
        value: fallback,
        state: "ready",
        warning: withLegacyCleanupWarning(
          "The encrypted local record was malformed and has been discarded.",
          legacyCleanup,
        ),
        retryable: legacyCleanup.failed,
      };
    }
    if (sanitized.altered) {
      try {
        await vaultSetJSON(key, {
          version: RECORD_VERSION,
          value: sanitized.value,
        } satisfies SensitiveRecord<T>);
      } catch {
        return {
          value: sanitized.value,
          state: "unavailable",
          warning: withLegacyCleanupWarning(
            "Some invalid or oversized encrypted entries were omitted for this session, but the repaired record could not be saved. Retry encrypted storage.",
            legacyCleanup,
          ),
          retryable: true,
        };
      }
    }
    return {
      value: sanitized.value,
      state: "ready",
      warning: withLegacyCleanupWarning(
        sanitized.altered
          ? "Some invalid or oversized local entries were omitted and the encrypted record was repaired."
          : null,
        legacyCleanup,
      ),
      retryable: legacyCleanup.failed,
    };
  }

  if (read.status === "unavailable") {
    return {
      value: fallback,
      state: "unavailable",
      warning: withLegacyCleanupWarning(
        "Encrypted local data is temporarily unavailable. Existing ciphertext was left untouched; retry after OS keychain access recovers.",
        legacyCleanup,
      ),
      retryable: true,
    };
  }

  return {
    value: fallback,
    state: "ready",
    warning: withLegacyCleanupWarning(
      read.status === "corrupt"
        ? "The encrypted local record was unreadable and has been discarded."
        : null,
      legacyCleanup,
    ),
    retryable: legacyCleanup.failed,
  };
}

/** Validate and encrypt a complete replacement record. Never writes plaintext. */
export async function saveSensitiveLocalData<T>(
  options: Omit<
    SensitiveLocalOptions<T>,
    | "fallback"
    | "unownedLegacyKeys"
    | "unownedTenantLegacySuffixes"
    | "purgeLegacy16HexScopes"
  > & {
    value: T;
  },
): Promise<T> {
  const { identityScope, namespace, validate } = options;
  if (!identityScope) {
    throw new Error("Signed-in workspace identity is unavailable.");
  }
  const sanitized = validate(options.value);
  if (!sanitized)
    throw new Error("Sensitive local data is invalid or too large.");
  await vaultSetJSON(sensitiveLocalVaultKey(namespace, identityScope), {
    version: RECORD_VERSION,
    value: sanitized.value,
  } satisfies SensitiveRecord<T>);
  return sanitized.value;
}

interface LegacyCleanupResult {
  found: boolean;
  failed: boolean;
}

function purgeUnownedLegacyKeys(
  keys: readonly string[],
  tenantSuffixCandidates: readonly string[],
  namespace: string,
  purgeLegacy16HexScopes: boolean,
): LegacyCleanupResult {
  const targets = new Set(keys);
  const tenantSuffixes = new Set(
    tenantSuffixCandidates.filter((suffix) =>
      LEGACY_TENANT_SUFFIX_RE.test(suffix),
    ),
  );
  let found = false;
  let failed = tenantSuffixes.size !== tenantSuffixCandidates.length;
  if (
    targets.size === 0 &&
    tenantSuffixes.size === 0 &&
    !purgeLegacy16HexScopes
  ) {
    return { found, failed };
  }
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key &&
        (targets.has(key) ||
          matchesTenantLegacyKey(key, tenantSuffixes) ||
          matchesLegacyEncryptedScopeKey(
            key,
            namespace,
            purgeLegacy16HexScopes,
          ))
      ) {
        found = true;
        targets.add(key);
      }
    }
  } catch {
    failed = true;
  }
  for (const key of targets) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      failed = true;
    }
  }
  return { found, failed };
}

function matchesLegacyEncryptedScopeKey(
  key: string,
  namespace: string,
  enabled: boolean,
): boolean {
  if (!enabled || !NAMESPACE_RE.test(namespace)) return false;
  const prefix = `${VAULT_STORAGE_PREFIX}sensitive-local.v${RECORD_VERSION}.${namespace}.`;
  return key.startsWith(prefix)
    ? LEGACY_IDENTITY_SCOPE_RE.test(key.slice(prefix.length))
    : false;
}

function matchesTenantLegacyKey(
  key: string,
  suffixes: ReadonlySet<string>,
): boolean {
  if (!key.startsWith("pw:tenant:")) return false;
  for (const suffix of suffixes) {
    if (key.endsWith(`:${suffix}`)) return true;
  }
  return false;
}

function withLegacyCleanupWarning(
  primary: string | null,
  cleanup: LegacyCleanupResult,
): string | null {
  const cleanupWarning = cleanup.failed
    ? "An ownership-ambiguous local copy could not be removed from device storage."
    : cleanup.found
      ? "For account isolation, an ownership-ambiguous local copy was removed without importing or reading it."
      : null;
  return [primary, cleanupWarning].filter(Boolean).join(" ") || null;
}

function safelyDeleteVaultKey(key: string): void {
  try {
    vaultDelete(key);
  } catch {
    /* storage unavailable */
  }
}

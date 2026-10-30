/** Helpers for keeping desktop bearer credentials out of persistent renderer storage. */

import { opaqueVaultKey } from "./opaque-vault-key";

const KEYCHAIN_MAX_ATTEMPTS = 3;
export const STREAM_TOKEN_FALLBACK_LOG =
  "[postwave-api] stream token unavailable; falling back to legacy api_key URL auth";

export class SecureCredentialStorageError extends Error {
  constructor() {
    super(
      "Moosewave could not access the operating-system credential vault. The plaintext legacy credential was removed; unlock the vault and enter the API key again.",
    );
    this.name = "SecureCredentialStorageError";
  }
}

export async function retryCredentialOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= KEYCHAIN_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < KEYCHAIN_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 50));
      }
    }
  }
  throw lastError;
}

/**
 * Collision-resistant, non-credential identity proof for browser API-key
 * sessions. The credential is used only as WebCrypto input and is never
 * persisted by this helper.
 */
export function credentialIdentityHash(
  apiUrl: string,
  key: string,
): Promise<string | null> {
  return opaqueVaultKey(
    "api-credential",
    JSON.stringify([2, apiUrl.trim(), key.trim()]),
  );
}

export function allowLegacyStreamApiKeyFallback(base: string): boolean {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  } catch {
    return false;
  }
}

export function normalizeDesktopApiKey(
  key: string | null | undefined,
): string | null {
  const value = (key ?? "").trim();
  if (!value) return null;
  return value.startsWith("pw_") ? value : `pw_${value}`;
}

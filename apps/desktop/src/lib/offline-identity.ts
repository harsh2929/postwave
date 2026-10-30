import { opaqueVaultKey } from "./opaque-vault-key";

const MAX_IDENTITY_SOURCE_BYTES = 8 * 1024;
const OPAQUE_OFFLINE_IDENTITY_RE = /^offline-identity:sha256:[a-f0-9]{64}$/u;

/**
 * Turn an authenticated identity signal into the only identity representation
 * that offline persistence may retain. The source can contain account ids or a
 * credential-derived proof, but it is never returned or stored.
 */
export async function deriveOfflineIdentity(
  source: string,
): Promise<string | null> {
  if (
    !source ||
    source !== source.trim() ||
    new TextEncoder().encode(source).byteLength > MAX_IDENTITY_SOURCE_BYTES
  ) {
    return null;
  }
  return opaqueVaultKey("offline-identity", source);
}

export function isOpaqueOfflineIdentity(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_OFFLINE_IDENTITY_RE.test(value);
}

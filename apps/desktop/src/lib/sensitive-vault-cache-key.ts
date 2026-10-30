import { opaqueVaultKey } from "./opaque-vault-key";
import { vaultDelete } from "./secure-vault";

/**
 * Build an identity-bound sensitive GET cache key without exposing its logical
 * locator. The readable, collision-prone v1 key is deleted without adoption.
 */
export async function sensitiveVaultCacheKey(
  identity: string | null,
  path: string,
): Promise<string | null> {
  if (!identity) return null;
  try {
    vaultDelete(`sensitive:${identity}:${path}`);
  } catch {
    /* storage unavailable; the current request still proceeds uncached */
  }
  return opaqueVaultKey("sensitive-cache", JSON.stringify([identity, path]));
}

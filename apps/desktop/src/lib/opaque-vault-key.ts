/**
 * Derive a stable, non-reversible vault key for a sensitive logical locator.
 * The clear namespace supports coarse lifecycle ownership; identities, resource
 * ids, emails, query terms and paths exist only inside the SHA-256 input.
 */

const NAMESPACE_RE = /^[a-z][a-z0-9-]{0,31}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const MAX_LOGICAL_KEY_BYTES = 32 * 1024;

export async function opaqueVaultKey(
  namespace: string,
  logicalKey: string,
): Promise<string | null> {
  if (
    !NAMESPACE_RE.test(namespace) ||
    !logicalKey ||
    CONTROL_RE.test(logicalKey)
  ) {
    return null;
  }
  const encoded = new TextEncoder().encode(
    JSON.stringify([namespace, logicalKey]),
  );
  if (encoded.byteLength > MAX_LOGICAL_KEY_BYTES) return null;
  const cryptoProvider = globalThis.crypto;
  if (!cryptoProvider?.subtle) return null;
  try {
    const digest = new Uint8Array(
      await cryptoProvider.subtle.digest("SHA-256", encoded),
    );
    const fingerprint = Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${namespace}:sha256:${fingerprint}`;
  } catch {
    return null;
  }
}

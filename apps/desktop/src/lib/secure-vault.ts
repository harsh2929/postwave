import { isTauri, tauriApi } from "./tauri";

const ITEM_PREFIX = "postwave.desktop.vault.v1:";
const MAX_VAULT_PLAINTEXT_BYTES = 512 * 1024;
const MAX_VAULT_ENVELOPE_CHARS = 768 * 1024;
const MAX_VAULT_ITEM_KEY_CHARS = 160;
const VAULT_CONTROL_RE = /[\u0000-\u001f\u007f]/;
let inMemoryVaultKey: string | null = null;

/**
 * Privacy-wipe fence for asynchronous encryption and storage commits.
 *
 * Calling `vaultPurgeAll` closes the gate synchronously, before its first
 * await. Already-started writes remain registered until their last storage
 * commit, so purge can drain them before deleting ciphertext and the native
 * key. Their epoch check prevents an in-flight seal from committing once
 * sign-out has begun. The gate intentionally stays closed for the lifetime of
 * this renderer: full sign-out reloads the shell, and accepting another write
 * beforehand could recreate the signed-out user's key or private cache.
 */
let vaultWriteEpoch = 0;
let vaultWritesClosed = false;
const activeVaultWrites = new Set<Promise<unknown>>();
const VAULT_WRITES_CLOSED_MESSAGE =
  "Encrypted local vault writes are unavailable after sign-out has begun.";

type VaultWriteFence = () => void;

function runVaultWrite<T>(
  operation: (assertCurrent: VaultWriteFence) => Promise<T>,
): Promise<T> {
  if (vaultWritesClosed) {
    return Promise.reject(new Error(VAULT_WRITES_CLOSED_MESSAGE));
  }
  const epoch = vaultWriteEpoch;
  const assertCurrent = (): void => {
    if (vaultWritesClosed || epoch !== vaultWriteEpoch) {
      throw new Error(VAULT_WRITES_CLOSED_MESSAGE);
    }
  };
  const pending = (async (): Promise<T> => {
    assertCurrent();
    return operation(assertCurrent);
  })();
  activeVaultWrites.add(pending);
  void pending.then(
    () => activeVaultWrites.delete(pending),
    () => activeVaultWrites.delete(pending),
  );
  return pending;
}

export async function vaultSetJSON(key: string, value: unknown): Promise<void> {
  const itemKey = requireStorageKey(key);
  const serialized = JSON.stringify(value);
  const plaintext = new TextEncoder().encode(serialized);
  if (plaintext.byteLength > MAX_VAULT_PLAINTEXT_BYTES) {
    throw new Error("Encrypted local vault item is too large.");
  }
  return runVaultWrite(async (assertCurrent) => {
    const envelope = await encryptVaultString(serialized, plaintext);
    assertCurrent();
    window.localStorage.setItem(itemKey, envelope);
  });
}

export async function vaultGetJSON<T>(key: string): Promise<T | null> {
  const result = await vaultReadJSON<T>(key);
  return result.status === "ready" ? result.value : null;
}

/**
 * A read contract for callers that must distinguish an empty vault from a
 * temporarily unavailable OS keychain.  The legacy `vaultGetJSON` API keeps
 * its cache-miss semantics; sensitive authoring surfaces use this richer
 * result so they never replace unread ciphertext with an empty collection.
 */
export type VaultReadResult<T> =
  | { status: "ready"; value: T }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "corrupt" };

export interface VaultReadOptions {
  /**
   * Keep proven-corrupt ciphertext until the caller has durably recorded its
   * own quarantine evidence. Ordinary cache callers retain delete-on-corrupt
   * behavior; idempotency recovery owners use this to avoid a crash window in
   * which both the ciphertext and its quarantine marker are absent.
   */
  preserveCorrupt?: boolean;
}

export async function vaultReadJSON<T>(
  key: string,
  options: VaultReadOptions = {},
): Promise<VaultReadResult<T>> {
  const itemKey = storageKey(key);
  if (!itemKey) return { status: "missing" };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(itemKey);
  } catch {
    return { status: "unavailable" };
  }
  if (!raw) return { status: "missing" };
  if (raw.length > MAX_VAULT_ENVELOPE_CHARS) {
    removeCorruptStorageItem(itemKey, options);
    return { status: "corrupt" };
  }
  if (isTauri()) {
    let plaintext: string | null;
    try {
      plaintext = await tauriApi.openVaultString(raw);
    } catch {
      return { status: "unavailable" };
    }
    if (plaintext === null) {
      removeCorruptStorageItem(itemKey, options);
      return { status: "corrupt" };
    }
    try {
      return { status: "ready", value: JSON.parse(plaintext) as T };
    } catch {
      removeCorruptStorageItem(itemKey, options);
      return { status: "corrupt" };
    }
  }
  let envelope: { iv?: string; data?: string };
  try {
    envelope = JSON.parse(raw) as { iv?: string; data?: string };
  } catch {
    removeCorruptStorageItem(itemKey, options);
    return { status: "corrupt" };
  }
  if (!envelope.iv || !envelope.data) {
    removeCorruptStorageItem(itemKey, options);
    return { status: "corrupt" };
  }
  // Acquire the key OUTSIDE the deletion path: a transient keychain /
  // WebCrypto failure must not destroy the (possibly fine) ciphertext —
  // the next read may succeed once OS vault access recovers.
  let webCrypto: Crypto;
  let cryptoKey: CryptoKey;
  try {
    webCrypto = getWebCrypto();
    cryptoKey = await getVaultCryptoKey(webCrypto);
  } catch {
    return { status: "unavailable" };
  }
  try {
    const plain = await webCrypto.subtle.decrypt(
      { name: "AES-GCM", iv: asArrayBuffer(fromB64(envelope.iv)) },
      cryptoKey,
      asArrayBuffer(fromB64(envelope.data)),
    );
    if (plain.byteLength > MAX_VAULT_PLAINTEXT_BYTES) {
      removeCorruptStorageItem(itemKey, options);
      return { status: "corrupt" };
    }
    return {
      status: "ready",
      value: JSON.parse(new TextDecoder().decode(plain)) as T,
    };
  } catch {
    // A well-formed envelope that fails to decrypt/decode with a valid
    // key is corrupt (or foreign) ciphertext. Recovery owners retain it until
    // their separate quarantine evidence is durable.
    removeCorruptStorageItem(itemKey, options);
    return { status: "corrupt" };
  }
}

function removeCorruptStorageItem(
  itemKey: string,
  options: VaultReadOptions,
): void {
  if (!options.preserveCorrupt) removeStorageItem(itemKey);
}

export function vaultDelete(key: string): void {
  const itemKey = storageKey(key);
  if (itemKey && typeof window !== "undefined") {
    window.localStorage.removeItem(itemKey);
  }
}

/** Delete ciphertext items in one logical namespace without exposing a key. */
export function vaultDeletePrefix(prefix: string): void {
  const itemPrefix = storageKey(prefix);
  if (!itemPrefix || typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(itemPrefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Purge EVERY encrypted vault item and drop the encryption key — both the
 * in-memory copy and the OS-keychain `vault_key` secret. Called from
 * fullSignOut so the next account on this device cannot decrypt (or even
 * re-key into) the previous owner's sensitive offline cache (D02#4).
 * Deleting the secret alongside the ciphertext means any leftover envelope
 * that escapes the localStorage sweep (e.g. restored from a backup) is
 * cryptographically dead rather than merely re-keyable.
 */
export async function vaultPurgeAll(): Promise<void> {
  // Close the write gate before yielding. This makes even a same-tick save
  // deterministic and prevents any later renderer work from minting a new
  // native key while sign-out is still navigating away.
  vaultWritesClosed = true;
  vaultWriteEpoch += 1;
  await Promise.allSettled(Array.from(activeVaultWrites));
  try {
    const storage = window.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(ITEM_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
  inMemoryVaultKey = null;
  try {
    if (isTauri()) await tauriApi.purgeVaultKey();
  } catch {
    /* keychain unavailable — the ciphertext is already gone */
  }
  // A browser-mode key resolver cannot currently complete after the tracked
  // writes above, but clear again at the boundary so that invariant survives
  // future asynchronous key-provider changes.
  inMemoryVaultKey = null;
}

/**
 * Encrypt an arbitrary UTF-8 string with the local vault key, returning a
 * self-describing JSON envelope. This low-level helper shares the exact
 * AES-GCM key + envelope shape as vaultSetJSON. Callers that subsequently
 * persist the envelope asynchronously must use vaultCommitEncryptedString so
 * the commit remains inside the privacy-wipe fence.
 */
export async function vaultEncryptString(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  if (data.byteLength > MAX_VAULT_PLAINTEXT_BYTES) {
    throw new Error("Encrypted local vault item is too large.");
  }
  return runVaultWrite(async (assertCurrent) => {
    const envelope = await encryptVaultString(plaintext, data);
    assertCurrent();
    return envelope;
  });
}

/**
 * Encrypt and durably commit a string inside one purge-fenced write. Storage
 * adapters whose commit is itself asynchronous (currently the query-cache
 * IndexedDB persister) must use this instead of committing after
 * `vaultEncryptString` resolves.
 */
export async function vaultCommitEncryptedString(
  plaintext: string,
  commit: (envelope: string) => Promise<void>,
): Promise<void> {
  const data = new TextEncoder().encode(plaintext);
  if (data.byteLength > MAX_VAULT_PLAINTEXT_BYTES) {
    throw new Error("Encrypted local vault item is too large.");
  }
  return runVaultWrite(async (assertCurrent) => {
    const envelope = await encryptVaultString(plaintext, data);
    assertCurrent();
    await commit(envelope);
    assertCurrent();
  });
}

async function encryptVaultString(
  plaintext: string,
  data: Uint8Array,
): Promise<string> {
  if (isTauri()) {
    const envelope = await tauriApi.sealVaultString(plaintext);
    if (envelope.length > MAX_VAULT_ENVELOPE_CHARS) {
      throw new Error("Encrypted local vault envelope is too large.");
    }
    return envelope;
  }
  const webCrypto = getWebCrypto();
  const cryptoKey = await getVaultCryptoKey(webCrypto);
  const iv = webCrypto.getRandomValues(new Uint8Array(12));
  const cipher = await webCrypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv) },
    cryptoKey,
    asArrayBuffer(data),
  );
  const envelope = JSON.stringify({
    alg: "AES-GCM",
    iv: b64(iv),
    data: b64(new Uint8Array(cipher)),
    written_at: new Date().toISOString(),
  });
  if (envelope.length > MAX_VAULT_ENVELOPE_CHARS) {
    throw new Error("Encrypted local vault envelope is too large.");
  }
  return envelope;
}

/**
 * Inverse of {@link vaultEncryptString}. Returns null for anything that
 * isn't a valid envelope decryptable with the current key — including a
 * legacy PLAINTEXT cache written before D02#3 (it fails JSON/shape/decrypt
 * and is treated as a cache miss, so nothing plaintext is ever trusted).
 */
export async function vaultDecryptString(
  envelope: string,
): Promise<string | null> {
  if (envelope.length > MAX_VAULT_ENVELOPE_CHARS) return null;
  if (isTauri()) {
    try {
      return await tauriApi.openVaultString(envelope);
    } catch {
      return null;
    }
  }
  let parsed: { iv?: string; data?: string };
  try {
    parsed = JSON.parse(envelope) as { iv?: string; data?: string };
  } catch {
    return null;
  }
  if (!parsed.iv || !parsed.data) return null;
  let webCrypto: Crypto;
  let cryptoKey: CryptoKey;
  try {
    webCrypto = getWebCrypto();
    cryptoKey = await getVaultCryptoKey(webCrypto);
  } catch {
    return null;
  }
  try {
    const plain = await webCrypto.subtle.decrypt(
      { name: "AES-GCM", iv: asArrayBuffer(fromB64(parsed.iv)) },
      cryptoKey,
      asArrayBuffer(fromB64(parsed.data)),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function getWebCrypto(): Crypto {
  if (typeof window === "undefined" || !window.crypto?.subtle) {
    throw new Error("Encrypted local vault is unavailable in this webview.");
  }
  return window.crypto;
}

// Dedupe concurrent first-use key resolution — without this two
// concurrent vault calls can each mint a different key (same pattern as
// api-client's fetchStreamToken).
let inflightVaultSecret: Promise<string> | null = null;

async function getVaultCryptoKey(webCrypto: Crypto): Promise<CryptoKey> {
  const raw = await resolveVaultSecret(webCrypto);
  return webCrypto.subtle.importKey(
    "raw",
    asArrayBuffer(fromB64(raw)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

async function resolveVaultSecret(webCrypto: Crypto): Promise<string> {
  if (inMemoryVaultKey) return inMemoryVaultKey;
  if (inflightVaultSecret) return inflightVaultSecret;
  inflightVaultSecret = (async (): Promise<string> => {
    const secret = b64(webCrypto.getRandomValues(new Uint8Array(32)));
    inMemoryVaultKey = secret;
    return secret;
  })();
  try {
    return await inflightVaultSecret;
  } finally {
    inflightVaultSecret = null;
  }
}

function requireStorageKey(key: string): string {
  const itemKey = storageKey(key);
  if (!itemKey) throw new Error("Encrypted local vault key is invalid.");
  return itemKey;
}

function storageKey(key: string): string | null {
  const trimmed = String(key ?? "").trim();
  if (
    !trimmed ||
    trimmed.length > MAX_VAULT_ITEM_KEY_CHARS ||
    trimmed !== key ||
    VAULT_CONTROL_RE.test(trimmed)
  ) {
    return null;
  }
  return `${ITEM_PREFIX}${trimmed.replace(/[^a-zA-Z0-9_.:-]/g, "_")}`;
}

function removeStorageItem(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function b64(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out);
}

function fromB64(raw: string): Uint8Array {
  const decoded = atob(raw);
  const out = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) out[i] = decoded.charCodeAt(i);
  return out;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

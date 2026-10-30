import type { MigrationSource } from "./api/migrations";
import { getOfflineIdentity } from "./offline-store";
import { opaqueVaultKey } from "./opaque-vault-key";
import { isTauri, tauriApi } from "./tauri";

const LEGACY_LEDGER_PREFIX = "postwave.desktop.migration-upload.v1:";
const LEDGER_PREFIX = "postwave.desktop.migration-upload.v2:";
const MAX_LEDGER_BYTES = 8 * 1024;
const FINGERPRINT_CHUNK_BYTES = 2 * 1024 * 1024;
const LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOCAL_LEDGERS = 20;

export interface MigrationUploadLedger {
  version: 2;
  uploadId: string;
  uploadedBytes: number;
  updatedAt: string;
  expiresAt: string;
}

export interface MigrationUploadLedgerScope {
  identity: string;
  key: string;
  fileSize: number;
}

/**
 * Build a resume scope from the active opaque identity and the complete file
 * content. A rolling tree hash keeps memory bounded for large CSV exports.
 * Missing identity, file-read failures, or missing WebCrypto disable resume.
 */
export async function migrationUploadLedgerScope(
  source: MigrationSource,
  file: File,
): Promise<MigrationUploadLedgerScope | null> {
  await purgeAmbiguousMigrationLedger(source, file);
  const identity = getOfflineIdentity();
  if (!identity) return null;
  const contentFingerprint = await fingerprintFile(file);
  if (!contentFingerprint || identity !== getOfflineIdentity()) return null;
  const opaque = await opaqueVaultKey(
    "migration-upload",
    JSON.stringify([
      2,
      identity,
      source,
      contentFingerprint,
      file.size,
      file.lastModified,
    ]),
  );
  if (!opaque || identity !== getOfflineIdentity()) return null;
  return {
    identity,
    key: `${LEDGER_PREFIX}${opaque.slice("migration-upload:sha256:".length)}`,
    fileSize: file.size,
  };
}

export function migrationUploadScopeIsCurrent(
  scope: MigrationUploadLedgerScope | null,
): boolean {
  return scope === null || scope.identity === getOfflineIdentity();
}

export async function readMigrationUploadLedger(
  scope: MigrationUploadLedgerScope | null,
): Promise<MigrationUploadLedger | null> {
  if (!scope || !migrationUploadScopeIsCurrent(scope)) return null;
  if (isTauri()) {
    try {
      const raw = await tauriApi.readMigrationLedger(scope.key);
      const parsed = raw ? parseLedger(raw, scope.fileSize) : null;
      if (raw && !parsed) await tauriApi.clearMigrationLedger(scope.key);
      if (parsed) return parsed;
    } catch {
      /* use the equally scoped renderer fallback */
    }
  }
  try {
    const raw = window.localStorage.getItem(scope.key);
    const parsed = raw ? parseLedger(raw, scope.fileSize) : null;
    if (raw && !parsed) window.localStorage.removeItem(scope.key);
    return parsed;
  } catch {
    return null;
  }
}

export async function writeMigrationUploadLedger(
  scope: MigrationUploadLedgerScope | null,
  uploadId: string,
  uploadedBytes: number,
): Promise<void> {
  if (
    !scope ||
    !migrationUploadScopeIsCurrent(scope) ||
    !validUploadID(uploadId) ||
    !Number.isSafeInteger(uploadedBytes) ||
    uploadedBytes < 0 ||
    uploadedBytes > scope.fileSize
  ) {
    return;
  }
  const now = Date.now();
  const payload = JSON.stringify({
    version: 2,
    uploadId: uploadId.trim(),
    uploadedBytes,
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LEDGER_TTL_MS).toISOString(),
  } satisfies MigrationUploadLedger);
  if (byteLength(payload) > MAX_LEDGER_BYTES) return;
  if (isTauri()) {
    try {
      await tauriApi.writeMigrationLedger(scope.key, payload);
      try {
        window.localStorage.removeItem(scope.key);
      } catch {
        /* a stale fallback is still identity/content bound and expires */
      }
      return;
    } catch {
      /* preserve resume state in the scoped renderer fallback */
    }
  }
  try {
    window.localStorage.setItem(scope.key, payload);
  } catch {
    /* no durable resume; the upload itself may continue */
  }
}

export async function clearMigrationUploadLedger(
  scope: MigrationUploadLedgerScope | null,
): Promise<void> {
  if (!scope) return;
  if (isTauri()) {
    try {
      await tauriApi.clearMigrationLedger(scope.key);
    } catch {
      /* best effort; a future server reconciliation still fails closed */
    }
  }
  try {
    window.localStorage.removeItem(scope.key);
  } catch {
    /* storage unavailable */
  }
}

export function newMigrationUploadID(): string {
  try {
    const provider = globalThis.crypto;
    if (typeof provider?.randomUUID === "function")
      return provider.randomUUID();
    if (typeof provider?.getRandomValues === "function") {
      const bytes = provider.getRandomValues(new Uint8Array(16));
      return `upload-${hex(bytes)}`;
    }
  } catch {
    /* handled by the fixed failure below */
  }
  throw new Error(
    "Secure randomness is unavailable. The migration upload was not started.",
  );
}

export function safeMigrationUploadFilename(filename: string): string {
  const basename = (filename.split(/[\\/]/).pop() ?? "").trim() || "upload.csv";
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[?#&=]/g, "_")
    .replace(/\s+/g, " ");
  return cleaned.slice(0, 180) || "upload.csv";
}

async function fingerprintFile(file: File): Promise<string | null> {
  const provider = globalThis.crypto;
  if (!provider?.subtle) return null;
  try {
    let state = new Uint8Array(32);
    let chunkIndex = 0;
    for (
      let offset = 0;
      offset < file.size;
      offset += FINGERPRINT_CHUNK_BYTES
    ) {
      const chunk = await file
        .slice(offset, Math.min(offset + FINGERPRINT_CHUNK_BYTES, file.size))
        .arrayBuffer();
      const chunkHash = new Uint8Array(
        await provider.subtle.digest("SHA-256", chunk),
      );
      const frame = new Uint8Array(state.length + chunkHash.length + 8);
      frame.set(state);
      frame.set(chunkHash, state.length);
      new DataView(frame.buffer).setBigUint64(
        state.length + chunkHash.length,
        BigInt(chunkIndex),
      );
      state = new Uint8Array(await provider.subtle.digest("SHA-256", frame));
      chunkIndex += 1;
    }
    const finalFrame = new TextEncoder().encode(
      JSON.stringify([2, file.size, chunkIndex, hex(state)]),
    );
    return hex(
      new Uint8Array(await provider.subtle.digest("SHA-256", finalFrame)),
    );
  } catch {
    return null;
  }
}

async function purgeAmbiguousMigrationLedger(
  source: MigrationSource,
  file: File,
): Promise<void> {
  const legacyKey = `${LEGACY_LEDGER_PREFIX}${source}:${legacyFingerprint(file)}:${file.size}:${file.lastModified}`;
  try {
    const storage = window.localStorage;
    pruneLocalLedgers(storage);
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_LEDGER_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
  if (isTauri()) {
    try {
      await tauriApi.pruneMigrationLedgers();
      await tauriApi.clearMigrationLedger(legacyKey);
    } catch {
      /* the v1 record is never read or adopted */
    }
  }
}

function legacyFingerprint(file: File): string {
  let hash = 2166136261;
  const value = `${file.name}:${file.size}:${file.lastModified}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function parseLedger(
  raw: string,
  fileSize: number,
): MigrationUploadLedger | null {
  if (byteLength(raw) > MAX_LEDGER_BYTES) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MigrationUploadLedger>;
    if (
      parsed.version !== 2 ||
      typeof parsed.uploadId !== "string" ||
      !validUploadID(parsed.uploadId) ||
      !Number.isSafeInteger(parsed.uploadedBytes) ||
      (parsed.uploadedBytes ?? -1) < 0 ||
      (parsed.uploadedBytes ?? fileSize + 1) > fileSize ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.expiresAt !== "string"
    ) {
      return null;
    }
    const updatedAt = Date.parse(parsed.updatedAt);
    const expiresAt = Date.parse(parsed.expiresAt);
    const now = Date.now();
    if (
      !Number.isFinite(updatedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= now ||
      expiresAt > updatedAt + LEDGER_TTL_MS ||
      updatedAt > now + 5 * 60 * 1000
    ) {
      return null;
    }
    return {
      version: 2,
      uploadId: parsed.uploadId.trim(),
      uploadedBytes: parsed.uploadedBytes as number,
      updatedAt: new Date(updatedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  } catch {
    return null;
  }
}

function pruneLocalLedgers(storage: Storage): void {
  const valid: Array<{ key: string; updatedAt: number }> = [];
  const remove: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(LEDGER_PREFIX)) continue;
    const raw = storage.getItem(key);
    if (!raw || byteLength(raw) > MAX_LEDGER_BYTES) {
      remove.push(key);
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<MigrationUploadLedger>;
      const updatedAt = Date.parse(parsed.updatedAt ?? "");
      const expiresAt = Date.parse(parsed.expiresAt ?? "");
      if (
        parsed.version !== 2 ||
        !Number.isFinite(updatedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() ||
        expiresAt > updatedAt + LEDGER_TTL_MS
      ) {
        remove.push(key);
      } else {
        valid.push({ key, updatedAt });
      }
    } catch {
      remove.push(key);
    }
  }
  valid.sort((left, right) => right.updatedAt - left.updatedAt);
  remove.push(...valid.slice(MAX_LOCAL_LEDGERS).map(({ key }) => key));
  for (const key of remove) storage.removeItem(key);
}

function validUploadID(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value.trim());
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

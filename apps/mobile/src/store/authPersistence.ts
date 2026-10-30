/**
 * store/authPersistence.ts
 *
 * The write-ahead session transaction and the readers that recover it.
 * Extracted from store/auth.ts (AUTH#60).
 *
 * Why a journal at all: three keychain writes (stage, baseUrl, profile) cannot
 * be made atomic, and a process death between them would otherwise leave the
 * device holding an OLDER profile whose MFA projection contradicts the one /me
 * just returned. The stage row is written first and deleted last, so a crash at
 * any point leaves either the new profile or a recoverable copy of it —
 * never a stale authorization state that is treated as current.
 *
 * If even the journal cannot be written, we leave the fail-closed cleanup
 * marker instead: the next launch wipes rather than trusts.
 */
import { createAuthClient } from "@/api/auth";

import { LocalAuthPersistenceError } from "./authErrors";
import {
  SECURE_KEY_BASE,
  SECURE_KEY_CLEANUP_PENDING,
  SECURE_KEY_SESSION,
  SECURE_KEY_SESSION_STAGE,
  retryStorageOperation,
  secureDelete,
  secureSet,
} from "./authSecureStorage";
import {
  MAX_STORED_SESSION_BYTES,
  sanitizeSessionProfile,
  type SessionProfile,
} from "./authSessionProfile";
import { utf8ByteLength } from "../lib/utf8";

type SessionStage = {
  version: 1;
  baseUrl: string;
  session: SessionProfile;
};

export function parseStoredSession(
  sessionRaw: string | null,
): SessionProfile | null {
  if (!sessionRaw) return null;
  if (utf8ByteLength(sessionRaw) > MAX_STORED_SESSION_BYTES) return null;
  try {
    const j = JSON.parse(sessionRaw) as Partial<SessionProfile>;
    return sanitizeSessionProfile(j);
  } catch {
    /* corrupt blob */
  }
  return null;
}

export function parseStoredSessionStage(
  raw: string | null,
): SessionStage | null {
  if (!raw || utf8ByteLength(raw) > MAX_STORED_SESSION_BYTES * 2) return null;
  try {
    const value = JSON.parse(raw) as Partial<SessionStage>;
    if (value.version !== 1 || typeof value.baseUrl !== "string") return null;
    const session = sanitizeSessionProfile(value.session ?? {});
    if (!session) return null;
    const baseUrl = createAuthClient(value.baseUrl).baseUrl;
    return { version: 1, baseUrl, session };
  } catch {
    return null;
  }
}

export async function persistSessionTransaction(
  baseUrl: string,
  session: SessionProfile,
): Promise<void> {
  const normalizedBaseUrl = createAuthClient(baseUrl).baseUrl;
  const stage: SessionStage = {
    version: 1,
    baseUrl: normalizedBaseUrl,
    session,
  };
  try {
    // The stage is a write-ahead journal. A process death between writes can
    // recover this exact profile and must revalidate it with /me before online
    // access; it can never restore the older, contradictory MFA projection.
    await retryStorageOperation(() =>
      secureSet(SECURE_KEY_SESSION_STAGE, JSON.stringify(stage)),
    );
    await retryStorageOperation(() =>
      secureSet(SECURE_KEY_BASE, normalizedBaseUrl),
    );
    await retryStorageOperation(() =>
      secureSet(SECURE_KEY_SESSION, JSON.stringify(session)),
    );
    await retryStorageOperation(() => secureDelete(SECURE_KEY_SESSION_STAGE));
  } catch {
    // If even the journal could not be written, leave a fail-closed cleanup
    // marker so the next launch cannot accept an older cached authorization
    // state. Marker persistence is also retried and remains best effort only
    // when the platform keychain itself is unavailable.
    await retryStorageOperation(() =>
      secureSet(SECURE_KEY_CLEANUP_PENDING, "1"),
    ).catch(() => undefined);
    throw new LocalAuthPersistenceError();
  }
}

/**
 * Possession-bound pending state for native email authentication.
 *
 * The device stores the selected, normalized API origin beside a random
 * one-time state before requesting email. Return screens resolve this record
 * first and only then construct an API client. Consequently arbitrary
 * self-hosted HTTPS origins work when the device requested them, while no URL
 * query parameter can redirect a credential to another server.
 */
import * as SecureStore from "expo-secure-store";

import {
  AUTH_LINK_VERSION,
  safeAuthLinkState,
  type AuthLinkFlow,
} from "./authLinkContract";
import { validateApiBaseUrl } from "./config";

const SECURE_KEY_MAGIC_LINK_STATE = "postwave.auth_link.magic.v1";
const SECURE_KEY_RESET_LINK_STATE = "postwave.auth_link.reset.v1";
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export const MAGIC_LINK_STATE_TTL_MS = 5 * 60 * 1000;
export const PASSWORD_RESET_STATE_TTL_MS = 60 * 60 * 1000;
/**
 * OAuth runs at the identity provider's pace, not ours: an account picker, a
 * password, and frequently a second factor pushed to another device. Five
 * minutes — right for a link the user already has in their inbox — expires
 * mid-flow often enough to make the feature feel broken, and the failure is
 * indistinguishable from a rejected sign-in. The nonce is still single-use and
 * device-bound; only the window is longer.
 */
export const OAUTH_LINK_STATE_TTL_MS = 15 * 60 * 1000;
const AUTH_LINK_STATE_BYTES = 16;

export interface PendingAuthLinkState {
  version: typeof AUTH_LINK_VERSION;
  flow: AuthLinkFlow;
  audience: "mobile";
  state: string;
  email: string;
  baseUrl: string;
  expiresAt: number;
}

/**
 * The email of a pending record that was created before the account was known.
 * Empty rather than a sentinel word so it can never collide with a real,
 * normalized address.
 */
export const UNBOUND_AUTH_LINK_EMAIL = "";

export type PendingMagicLinkState = PendingAuthLinkState & { flow: "magic" };
export type PendingPasswordResetState = PendingAuthLinkState & {
  flow: "reset";
};

export type PendingAuthLinkFailure =
  | "missing"
  | "expired"
  | "state_mismatch"
  | "base_url_mismatch"
  | "storage_unavailable"
  | "cleanup_failed"
  | "corrupt";

export type PendingMagicLinkFailure = PendingAuthLinkFailure;
export type PendingPasswordResetFailure = PendingAuthLinkFailure;

export async function createPendingMagicLinkState(input: {
  email: string;
  baseUrl: string;
  now?: number;
}): Promise<PendingMagicLinkState> {
  return createPendingAuthLinkState("magic", input);
}

export async function createPendingPasswordResetState(input: {
  email: string;
  baseUrl: string;
  now?: number;
}): Promise<PendingPasswordResetState> {
  return createPendingAuthLinkState("reset", input);
}

/**
 * The OAuth variant of the magic pending state. Identical machinery — same
 * SecureStore key, same single-use nonce, same origin binding — with ONE
 * deliberate difference: no email.
 *
 * A magic link is requested FOR a known address, so the return path can insist
 * the account it signed in as is the account the device asked for. An OAuth
 * round-trip cannot: the user picks the Google account inside the browser,
 * minutes after this device committed its state. Recording a guessed address
 * would make every legitimate sign-in with a second Google account fail with
 * "this link doesn't match the account that requested it", so the record is
 * explicitly UNBOUND and `magicLinkEmailMatches` says so out loud.
 */
export async function createPendingOAuthLinkState(input: {
  baseUrl: string;
  now?: number;
}): Promise<PendingMagicLinkState> {
  return createPendingAuthLinkState("magic", {
    email: UNBOUND_AUTH_LINK_EMAIL,
    baseUrl: input.baseUrl,
    ...(input.now === undefined ? {} : { now: input.now }),
    ttlMs: OAUTH_LINK_STATE_TTL_MS,
  });
}

/**
 * Preferred return-path primitive: validates device state and returns its
 * locally bound origin. Callers must not select an API client before this
 * resolves successfully.
 */
export async function resolvePendingMagicLinkState(input: {
  state: string;
  now?: number;
}): Promise<
  | { ok: true; pending: PendingMagicLinkState }
  | { ok: false; reason: PendingMagicLinkFailure }
> {
  return resolvePendingAuthLinkState("magic", input);
}

export async function resolvePendingPasswordResetState(input: {
  state: string;
  now?: number;
}): Promise<
  | { ok: true; pending: PendingPasswordResetState }
  | { ok: false; reason: PendingPasswordResetFailure }
> {
  return resolvePendingAuthLinkState("reset", input);
}

/**
 * Compatibility wrapper for older focused tests/callers. New return screens
 * use resolvePendingMagicLinkState so origin selection cannot precede state
 * verification.
 */
export async function verifyPendingMagicLinkState(input: {
  state: string;
  baseUrl: string;
  now?: number;
}): Promise<
  | { ok: true; pending: PendingMagicLinkState }
  | { ok: false; reason: PendingMagicLinkFailure }
> {
  const resolved = await resolvePendingMagicLinkState(input);
  if (!resolved.ok) return resolved;
  const baseUrl = normalizeBoundBaseUrl(input.baseUrl);
  if (!baseUrl || resolved.pending.baseUrl !== baseUrl) {
    return { ok: false, reason: "base_url_mismatch" };
  }
  return resolved;
}

export async function clearPendingMagicLinkState(): Promise<void> {
  await clearPendingAuthLinkState("magic");
}

export async function clearPendingPasswordResetState(): Promise<void> {
  await clearPendingAuthLinkState("reset");
}

export async function clearPendingAuthLinkStates(): Promise<void> {
  const results = await Promise.allSettled([
    clearPendingMagicLinkState(),
    clearPendingPasswordResetState(),
  ]);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

/**
 * Does the account we just signed in as match the one this device asked for?
 *
 * An UNBOUND record (created by createPendingOAuthLinkState) answers yes for
 * any account, because there was no address to ask for. That is not a
 * weakening of the return path: the envelope is still rejected unless it
 * carries this device's single-use nonce AND the server's HMAC over it, so an
 * attacker cannot deliver a token minted for their own account to this phone.
 * The email equality check is a second, weaker fence that only exists for the
 * flow where the address is known in advance.
 */
export function magicLinkEmailMatches(
  pending: PendingMagicLinkState,
  email: string,
): boolean {
  if (pending.email === UNBOUND_AUTH_LINK_EMAIL) return true;
  return pending.email === normalizeEmail(email);
}

export { safeAuthLinkState as safeMagicLinkState };

async function createPendingAuthLinkState<TFlow extends AuthLinkFlow>(
  flow: TFlow,
  input: { email: string; baseUrl: string; now?: number; ttlMs?: number },
): Promise<PendingAuthLinkState & { flow: TFlow }> {
  const baseUrl = normalizeBoundBaseUrl(input.baseUrl);
  if (!baseUrl) throw new Error("API URL is invalid.");
  const now = input.now ?? Date.now();
  const defaultTtl =
    flow === "magic" ? MAGIC_LINK_STATE_TTL_MS : PASSWORD_RESET_STATE_TTL_MS;
  const pending: PendingAuthLinkState & { flow: TFlow } = {
    version: AUTH_LINK_VERSION,
    flow,
    audience: "mobile",
    state: generateAuthLinkState(),
    email: normalizeEmail(input.email),
    baseUrl,
    expiresAt: now + (input.ttlMs ?? defaultTtl),
  };
  await retrySecureStore(() =>
    SecureStore.setItemAsync(
      secureKey(flow),
      JSON.stringify(pending),
      SECURE_OPTIONS,
    ),
  );
  return pending;
}

async function resolvePendingAuthLinkState<TFlow extends AuthLinkFlow>(
  flow: TFlow,
  input: { state: string; now?: number },
): Promise<
  | { ok: true; pending: PendingAuthLinkState & { flow: TFlow } }
  | { ok: false; reason: PendingAuthLinkFailure }
> {
  let pending: PendingAuthLinkState | null;
  try {
    pending = await readPendingAuthLinkState(flow);
  } catch {
    return { ok: false, reason: "storage_unavailable" };
  }
  if (!pending) return { ok: false, reason: "missing" };
  if (pending.expiresAt <= (input.now ?? Date.now())) {
    try {
      await clearPendingAuthLinkState(flow);
    } catch {
      return { ok: false, reason: "cleanup_failed" };
    }
    return { ok: false, reason: "expired" };
  }
  if (!safeAuthLinkState(input.state) || pending.state !== input.state) {
    // A mismatched unsolicited link must not erase a still-valid request on
    // this device. The legitimate state remains usable until expiry.
    return { ok: false, reason: "state_mismatch" };
  }
  return {
    ok: true,
    pending: pending as PendingAuthLinkState & { flow: TFlow },
  };
}

async function readPendingAuthLinkState(
  flow: AuthLinkFlow,
): Promise<PendingAuthLinkState | null> {
  const raw = await retrySecureStore(() =>
    SecureStore.getItemAsync(secureKey(flow), SECURE_OPTIONS),
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingAuthLinkState>;
    const state = safeAuthLinkState(parsed.state);
    const baseUrl =
      typeof parsed.baseUrl === "string"
        ? normalizeBoundBaseUrl(parsed.baseUrl)
        : null;
    if (
      parsed.version !== AUTH_LINK_VERSION ||
      parsed.flow !== flow ||
      parsed.audience !== "mobile" ||
      !state ||
      typeof parsed.email !== "string" ||
      !baseUrl ||
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      await clearPendingAuthLinkState(flow);
      return null;
    }
    return {
      version: AUTH_LINK_VERSION,
      flow,
      audience: "mobile",
      state,
      email: normalizeEmail(parsed.email),
      baseUrl,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    await clearPendingAuthLinkState(flow);
    return null;
  }
}

async function clearPendingAuthLinkState(flow: AuthLinkFlow): Promise<void> {
  await retrySecureStore(() =>
    SecureStore.deleteItemAsync(secureKey(flow), SECURE_OPTIONS),
  );
}

async function retrySecureStore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}

function generateAuthLinkState(): string {
  const crypto = (
    globalThis as unknown as {
      crypto?: { getRandomValues: (array: Uint8Array) => Uint8Array };
    }
  ).crypto;
  if (!crypto?.getRandomValues) {
    throw new Error("Secure random source unavailable.");
  }
  const bytes = new Uint8Array(AUTH_LINK_STATE_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeBoundBaseUrl(baseUrl: string): string | null {
  const valid = validateApiBaseUrl(baseUrl);
  return valid.ok ? valid.url : null;
}

function secureKey(flow: AuthLinkFlow): string {
  return flow === "magic"
    ? SECURE_KEY_MAGIC_LINK_STATE
    : SECURE_KEY_RESET_LINK_STATE;
}

import type { AuthLinkFlow } from "./auth-link-contract";

const PENDING_AUTH_STATE_KEYS: Record<AuthLinkFlow, string> = {
  magic: "postwave_pending_magic_auth_state_v2",
  reset: "postwave_pending_reset_auth_state_v1",
};

// Magic also covers the OAuth round trip, whose provider interaction can take
// longer than the five-minute email token window. The token remains the
// backend-enforced expiry boundary.
export const MAGIC_AUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const RESET_AUTH_STATE_TTL_MS = 60 * 60 * 1000;

const STATE_BYTE_LENGTH = 24;
const MAX_PENDING_STATE_RECORD_BYTES = 1024;
const AUTH_STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export type AuthFlowStateFailureReason =
  | "missing_pending"
  | "missing_state"
  | "expired"
  | "mismatch"
  | "invalid_pending";

export type AuthFlowStateVerification =
  | { ok: true }
  | { ok: false; reason: AuthFlowStateFailureReason };

interface PendingAuthState {
  flow: AuthLinkFlow;
  state: string;
  createdAt: number;
}

const memoryPendingAuthState: Record<AuthLinkFlow, string | null> = {
  magic: null,
  reset: null,
};

/**
 * Create a native email-auth nonce before requesting the email. The record is
 * written to both browser stores so an OS cold-start can still prove that this
 * desktop initiated the flow. Link parameters can never create this record.
 */
export function beginAuthReturnFlow(
  flow: AuthLinkFlow,
  now = Date.now(),
): string {
  const state = randomAuthState();
  const raw = JSON.stringify({ flow, state, createdAt: now } satisfies PendingAuthState);
  memoryPendingAuthState[flow] = raw;
  for (const store of authStateStores()) {
    try {
      store.setItem(PENDING_AUTH_STATE_KEYS[flow], raw);
    } catch {
      /* best effort; the in-memory record remains available */
    }
  }
  return state;
}

export function beginMagicAuthReturnFlow(now = Date.now()): string {
  return beginAuthReturnFlow("magic", now);
}

export function beginPasswordResetReturnFlow(now = Date.now()): string {
  return beginAuthReturnFlow("reset", now);
}

/** OAuth /start receives this state-only redirect and the callback adds the
 * complete signed v1 envelope before handing control back to desktop. */
export function desktopMagicAuthReturnUrl(state: string): string {
  const url = new URL("moosewave://auth/magic");
  url.searchParams.set("state", state);
  return url.toString();
}

export function consumeAuthReturnState(
  flow: AuthLinkFlow,
  returnedState: string | undefined | null,
  now = Date.now(),
): AuthFlowStateVerification {
  const pending = readPendingAuthState(flow);
  if (!pending) return { ok: false, reason: "missing_pending" };
  if (
    pending.flow !== flow ||
    !Number.isFinite(pending.createdAt) ||
    !isAuthState(pending.state)
  ) {
    clearPendingAuthReturnState(flow);
    return { ok: false, reason: "invalid_pending" };
  }
  if (now - pending.createdAt > authStateTTL(flow)) {
    clearPendingAuthReturnState(flow);
    return { ok: false, reason: "expired" };
  }
  if (!returnedState || !isAuthState(returnedState)) {
    return { ok: false, reason: "missing_state" };
  }
  if (!constantTimeEqual(pending.state, returnedState)) {
    // An unsolicited mismatched link must not erase a legitimate request.
    return { ok: false, reason: "mismatch" };
  }
  clearPendingAuthReturnState(flow);
  return { ok: true };
}

export function consumeMagicAuthReturnState(
  returnedState: string | undefined | null,
  now = Date.now(),
): AuthFlowStateVerification {
  return consumeAuthReturnState("magic", returnedState, now);
}

export function consumePasswordResetReturnState(
  returnedState: string | undefined | null,
  now = Date.now(),
): AuthFlowStateVerification {
  return consumeAuthReturnState("reset", returnedState, now);
}

export function clearPendingAuthReturnState(flow: AuthLinkFlow): void {
  memoryPendingAuthState[flow] = null;
  for (const store of authStateStores()) {
    try {
      store.removeItem(PENDING_AUTH_STATE_KEYS[flow]);
    } catch {
      /* ignore */
    }
  }
}

export function clearPendingMagicAuthReturnState(): void {
  clearPendingAuthReturnState("magic");
}

export function clearPendingPasswordResetReturnState(): void {
  clearPendingAuthReturnState("reset");
}

function readPendingAuthState(flow: AuthLinkFlow): PendingAuthState | null {
  for (const raw of pendingAuthStateValues(flow)) {
    const parsed = parsePendingAuthState(raw, flow);
    if (parsed) return parsed;
  }
  return null;
}

function pendingAuthStateValues(flow: AuthLinkFlow): string[] {
  const values: string[] = [];
  const memory = memoryPendingAuthState[flow];
  if (memory) values.push(memory);
  for (const store of authStateStores()) {
    try {
      const raw = store.getItem(PENDING_AUTH_STATE_KEYS[flow]);
      if (raw) values.push(raw);
    } catch {
      /* ignore */
    }
  }
  return values;
}

function parsePendingAuthState(
  raw: string,
  flow: AuthLinkFlow,
): PendingAuthState | null {
  if (
    !raw ||
    new TextEncoder().encode(raw).byteLength > MAX_PENDING_STATE_RECORD_BYTES
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed.flow === flow &&
      typeof parsed.state === "string" &&
      isAuthState(parsed.state) &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return { flow, state: parsed.state, createdAt: parsed.createdAt };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function authStateTTL(flow: AuthLinkFlow): number {
  return flow === "magic"
    ? MAGIC_AUTH_STATE_TTL_MS
    : RESET_AUTH_STATE_TTL_MS;
}

function randomAuthState(): string {
  const bytes = new Uint8Array(STATE_BYTE_LENGTH);
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) {
    throw new Error("secure random source unavailable");
  }
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAuthState(value: string): boolean {
  return AUTH_STATE_RE.test(value);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function authStateStores(): Storage[] {
  if (typeof window === "undefined") return [];
  const stores: Storage[] = [];
  try {
    if (window.sessionStorage) stores.push(window.sessionStorage);
  } catch {
    /* ignore */
  }
  try {
    if (window.localStorage && window.localStorage !== window.sessionStorage) {
      stores.push(window.localStorage);
    }
  } catch {
    /* ignore */
  }
  return stores;
}

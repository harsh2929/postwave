// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Web client for the RFC 8628 device grant used by "sign in with another
 * device". The high-entropy device_code is deliberately returned only to the
 * mounted target component; callers must keep it in memory and clear it when
 * the flow ends. It must never be put in a URL, storage, analytics, or logs.
 */

import { CLI_DEVICE_APPROVE_PATH } from "@postwave/route-map";

import { ApiError, api } from "@/lib/api";

export const DEVICE_LOGIN_START_PATH = "/api/v1/auth/cli/device/start";
export const DEVICE_LOGIN_TOKEN_PATH = "/api/v1/auth/cli/device/token";
export const DEVICE_LOGIN_APPROVE_PATH = "/api/v1/auth/cli/device/approve";

const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MAX_DEVICE_CODE_CHARS = 1024;
const MAX_DISCLOSURE_CHARS = 160;
const MAX_SCOPES = 64;
const MAX_POLL_SECONDS = 60;
const MAX_NETWORK_POLL_SECONDS = 30;

export interface DeviceLoginStart {
  /** Secret possession credential. Keep in a ref/closure only. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
  remember: boolean;
}

export interface DeviceLoginSuccess {
  grant_kind: "session";
  session: true;
  confirmation_required: true;
  confirmation_expires_in: number;
  tenant_id?: string;
  email?: string;
  expires_in?: number;
}

export interface DeviceLoginConfirmation {
  grant_kind: "session";
  session: true;
  confirmed: true;
  confirmation_required: false;
}

export type DeviceGrantKind = "api_key" | "session";
export type DeviceGrantAction = "inspect" | "approve" | "deny";

export interface DeviceGrantDetails {
  grantKind: DeviceGrantKind;
  account: {
    email: string;
    workspaceName?: string;
    workspaceSlug?: string;
  };
  device: {
    label: string;
    type: string;
    os?: string;
    client?: string;
  };
  expiresIn: number;
  remember: boolean;
  scopes: string[];
  requiresMfa: boolean;
  /** Opaque inspect→decision binding; keep only in mounted component state. */
  consentToken?: string;
}

export type DevicePollDecision =
  | {
      kind: "retry";
      delaySeconds: number;
      status: "waiting" | "network";
      raiseInterval?: boolean;
    }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "error"; message: string };

export function normalizeDeviceUserCode(value: string): string {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  return normalized.length > 4
    ? `${normalized.slice(0, 4)}-${normalized.slice(4)}`
    : normalized;
}

export function isCompleteDeviceUserCode(value: string): boolean {
  return USER_CODE_RE.test(value);
}

export function parseDeviceLoginStart(
  payload: unknown,
  expectedOrigin: string,
  expectedRemember = false,
): DeviceLoginStart {
  const value = record(payload);
  const deviceCode = boundedString(value.device_code, MAX_DEVICE_CODE_CHARS);
  const rawUserCode = boundedString(value.user_code, 9);
  const userCode = rawUserCode?.toUpperCase() ?? "";
  const grantKind = value.grant_kind;
  const expiresIn = positiveInteger(value.expires_in, 1, 60 * 60);
  const interval = positiveInteger(value.interval, 1, MAX_POLL_SECONDS);

  if (
    !deviceCode ||
    !USER_CODE_RE.test(userCode) ||
    grantKind !== "session" ||
    expiresIn === null ||
    interval === null ||
    value.remember !== expectedRemember
  ) {
    throw new Error("The server returned an invalid device sign-in request.");
  }

  const verificationUri = safeVerificationUri(
    value.verification_uri,
    expectedOrigin,
    false,
    userCode,
  );
  const verificationUriComplete = safeVerificationUri(
    value.verification_uri_complete,
    expectedOrigin,
    true,
    userCode,
  );
  if (!verificationUri || !verificationUriComplete) {
    throw new Error("The server returned an unsafe device sign-in link.");
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn,
    interval,
    remember: expectedRemember,
  };
}

export async function startDeviceLogin(
  expectedOrigin: string,
  opts: { signal?: AbortSignal; remember?: boolean } = {},
): Promise<DeviceLoginStart> {
  const remember = opts.remember === true;
  const payload = await api.post<unknown>(
    DEVICE_LOGIN_START_PATH,
    {
      grant_kind: "session",
      // The API derives the device disclosure from the request/User-Agent.
      // Never let the target choose the identity shown to the approver.
      remember,
    },
    authGrantRequestOptions(opts.signal),
  );
  return parseDeviceLoginStart(payload, expectedOrigin, remember);
}

export async function pollDeviceLogin(
  deviceCode: string,
  opts: { signal?: AbortSignal } = {},
): Promise<DeviceLoginSuccess> {
  const payload = record(
    await api.post<unknown>(
      DEVICE_LOGIN_TOKEN_PATH,
      { device_code: deviceCode },
      authGrantRequestOptions(opts.signal),
    ),
  );
  if (payload.grant_kind !== "session" || payload.session !== true) {
    // Never accidentally surface or accept an API key if a deployment mixes
    // up the legacy CLI flow and the session flow.
    throw new Error("The server returned an invalid device sign-in response.");
  }
  if (
    payload.confirmation_required !== true ||
    positiveInteger(payload.confirmation_expires_in, 1, 10 * 60) === null
  ) {
    throw new Error("The server returned an invalid session confirmation lease.");
  }
  return payload as unknown as DeviceLoginSuccess;
}

export async function confirmDeviceLogin(
  deviceCode: string,
  opts: { signal?: AbortSignal } = {},
): Promise<DeviceLoginConfirmation> {
  const payload = record(
    await api.post<unknown>(
      DEVICE_LOGIN_TOKEN_PATH,
      { device_code: deviceCode, action: "confirm" },
      authGrantRequestOptions(opts.signal),
    ),
  );
  if (
    payload.grant_kind !== "session" ||
    payload.session !== true ||
    payload.confirmed !== true ||
    payload.confirmation_required !== false
  ) {
    throw new Error("The server returned an invalid session confirmation.");
  }
  return payload as unknown as DeviceLoginConfirmation;
}

export async function cancelDeviceLogin(deviceCode: string): Promise<void> {
  await api.post<unknown>(
    DEVICE_LOGIN_TOKEN_PATH,
    { device_code: deviceCode, action: "cancel" },
    {
      ...authGrantRequestOptions(),
      // Give page navigation a chance to deliver the best-effort revocation.
      // Expiry remains the server-side fallback if the browser is offline.
      keepalive: true,
    },
  );
}

export async function inspectDeviceGrant(
  userCode: string,
): Promise<DeviceGrantDetails> {
  const payload = await api.post<unknown>(
    DEVICE_LOGIN_APPROVE_PATH,
    {
      user_code: userCode,
      action: "inspect",
    },
    authGrantRequestOptions(),
  );
  const details = parseDeviceGrantDetails(payload);
  if (details.grantKind === "session" && !details.consentToken) {
    throw new Error("The server did not bind this review to your session.");
  }
  return details;
}

export async function decideDeviceGrant(
  userCode: string,
  action: "approve" | "deny",
  consentToken?: string,
): Promise<DeviceGrantDetails> {
  const payload = record(
    await api.post<unknown>(
      DEVICE_LOGIN_APPROVE_PATH,
      {
        user_code: userCode,
        action,
        ...(consentToken ? { consent_token: consentToken } : {}),
      },
      authGrantRequestOptions(),
    ),
  );
  if (payload.ok !== true) {
    throw new Error("The server returned an invalid device approval response.");
  }
  return parseDeviceGrantDetails(payload);
}

export function parseDeviceGrantDetails(payload: unknown): DeviceGrantDetails {
  const value = record(payload);
  const grantKind = value.grant_kind;
  if (grantKind !== "api_key" && grantKind !== "session") {
    throw new Error("The server returned an invalid device request.");
  }
  const rawDevice = record(value.device);
  const rawAccount = record(value.account);
  const expiresIn = positiveInteger(value.expires_in, 0, 60 * 60);
  if (expiresIn === null || typeof value.remember !== "boolean") {
    throw new Error("The server returned incomplete device request details.");
  }

  const label = disclosureString(rawDevice.device_label) ?? "Unknown device";
  const type = disclosureString(rawDevice.device_type) ?? "device";
  const os = disclosureString(rawDevice.device_os);
  const client = disclosureString(rawDevice.device_client);
  const email = disclosureString(rawAccount.email);
  const workspaceName = disclosureString(rawAccount.workspace_name);
  const workspaceSlug = disclosureString(rawAccount.workspace_slug);
  if (!email) {
    throw new Error(
      "The server returned incomplete approving account details.",
    );
  }
  const scopes = Array.isArray(value.scopes)
    ? value.scopes
        .slice(0, MAX_SCOPES)
        .map(disclosureString)
        .filter((scope): scope is string => Boolean(scope))
    : [];
  const consentToken = boundedString(value.consent_token, 2048);
  if (
    consentToken &&
    (consentToken.length < 32 || !/^[A-Za-z0-9_.-]+$/.test(consentToken))
  ) {
    throw new Error("The server returned an invalid consent binding.");
  }
  if (grantKind === "api_key" && scopes.length === 0) {
    throw new Error("The server returned incomplete API-key permissions.");
  }

  return {
    grantKind,
    account: {
      email,
      ...(workspaceName ? { workspaceName } : {}),
      ...(workspaceSlug ? { workspaceSlug } : {}),
    },
    device: {
      label,
      type,
      ...(os ? { os } : {}),
      ...(client ? { client } : {}),
    },
    expiresIn,
    remember: value.remember,
    scopes,
    requiresMfa: value.requires_mfa === true,
    ...(consentToken ? { consentToken } : {}),
  };
}

/** RFC 8628 status handling plus bounded transport backoff. */
export function devicePollDecision(
  error: unknown,
  intervalSeconds: number,
  consecutiveNetworkErrors: number,
): DevicePollDecision {
  const interval = Math.max(1, Math.min(MAX_POLL_SECONDS, intervalSeconds));
  if (error instanceof ApiError) {
    switch (error.code) {
      case "authorization_pending":
        return { kind: "retry", delaySeconds: interval, status: "waiting" };
      case "slow_down":
        return {
          kind: "retry",
          delaySeconds: Math.min(MAX_POLL_SECONDS, interval + 5),
          status: "waiting",
          raiseInterval: true,
        };
      case "access_denied":
        return { kind: "denied" };
      case "expired_token":
        return { kind: "expired" };
      default:
        if (error.status === 429) {
          return {
            kind: "retry",
            delaySeconds: Math.min(
              MAX_POLL_SECONDS,
              Math.max(
                interval,
                Math.ceil(error.retryAfterSeconds ?? interval),
              ),
            ),
            status: "network",
          };
        }
        if (
          error.status >= 500 ||
          error.kind === "network" ||
          error.kind === "offline" ||
          error.kind === "timeout"
        ) {
          return {
            kind: "retry",
            delaySeconds: networkBackoffSeconds(
              interval,
              consecutiveNetworkErrors,
            ),
            status: "network",
          };
        }
    }
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { kind: "error", message: "Device sign-in was cancelled." };
  }
  return {
    kind: "error",
    message:
      error instanceof Error && error.message
        ? error.message
        : "Could not complete device sign-in.",
  };
}

function networkBackoffSeconds(
  intervalSeconds: number,
  consecutiveErrors: number,
): number {
  const exponent = Math.min(4, Math.max(1, consecutiveErrors));
  return Math.min(
    MAX_NETWORK_POLL_SECONDS,
    Math.max(intervalSeconds, intervalSeconds * 2 ** exponent),
  );
}

function authGrantRequestOptions(signal?: AbortSignal) {
  return {
    signal,
    cache: "no-store" as const,
    requireOnline: true,
    // A lost response after the one-shot token exchange must not be replayed
    // automatically. The polling state machine owns every retry explicitly.
    maxAttempts: 1,
  };
}

function safeVerificationUri(
  raw: unknown,
  expectedOrigin: string,
  complete: boolean,
  expectedCode: string,
): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let expected: URL;
  let value: URL;
  try {
    expected = new URL(expectedOrigin);
    value = new URL(raw, expected);
  } catch {
    return null;
  }
  if (value.origin !== expected.origin || value.username || value.password) {
    return null;
  }
  const localDevelopment =
    expected.protocol === "http:" &&
    (expected.hostname === "localhost" ||
      expected.hostname === "127.0.0.1" ||
      expected.hostname === "[::1]");
  if (expected.protocol !== "https:" && !localDevelopment) return null;
  if (value.pathname !== CLI_DEVICE_APPROVE_PATH || value.hash) return null;

  const codes = value.searchParams.getAll("user_code");
  if (complete) {
    const keys = Array.from(value.searchParams.keys());
    if (
      codes.length !== 1 ||
      keys.length !== 1 ||
      keys[0] !== "user_code" ||
      codes[0]?.toUpperCase() !== expectedCode
    ) {
      return null;
    }
  } else if (codes.length !== 0 || value.search) {
    return null;
  }
  return value.toString();
}

function disclosureString(value: unknown): string | null {
  return boundedString(value, MAX_DISCLOSURE_CHARS);
}

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxChars ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function positiveInteger(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The server returned an invalid device sign-in response.");
  }
  return value as Record<string, unknown>;
}

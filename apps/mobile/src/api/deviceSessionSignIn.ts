/**
 * Target-side RFC 8628 session grant for native mobile sign-in.
 *
 * The high-entropy device code is a bearer credential. Callers must keep it
 * in memory only; it is never returned in a URL, rendered, logged, persisted,
 * or sent to analytics. The QR contains only the server's approval URL and
 * the short user code, both of which still require an authenticated approval.
 */
import { authRequest, type AuthApiError, type AuthResult } from "@/api/auth";
import { PUBLIC_APP_BASE_URL } from "@/lib/config";
import { utf8ByteLength } from "@/lib/utf8";

const START_PATH = "/api/v1/auth/cli/device/start";
const TOKEN_PATH = "/api/v1/auth/cli/device/token";
const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const MAX_DEVICE_CODE_BYTES = 1024;
const MAX_URL_BYTES = 4096;
const MAX_GRANT_SECONDS = 60 * 60;
const MAX_POLL_SECONDS = 60;
const MAX_CONFIRM_SECONDS = 10 * 60;
const MAX_SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_SHORT_SESSION_SECONDS = 12 * 60 * 60;

export interface DeviceSessionGrantStart {
  /** Bearer secret. Keep only in a closure/ref. */
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
  remember: boolean;
}

export interface DeviceSessionGrantSuccess {
  grant_kind: "session";
  session: true;
  confirmation_required: true;
  confirmation_expires_in: number;
  expires_in: number;
  remember: boolean;
}

export interface DeviceSessionGrantConfirmation {
  grant_kind: "session";
  session: true;
  confirmed: true;
  confirmation_required: false;
  expires_in: number;
  remember: boolean;
}

export type DeviceSessionPollDecision =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "network" }
  | { kind: "fatal"; message: string };

export async function startDeviceSessionGrant(
  baseUrl: string,
  remember: boolean,
  signal?: AbortSignal,
): Promise<AuthResult<DeviceSessionGrantStart>> {
  const result = await authRequest<unknown>(baseUrl, START_PATH, {
    method: "POST",
    body: JSON.stringify({ grant_kind: "session", remember }),
    ...(signal ? { signal } : {}),
  });
  if (result.error) return result;
  try {
    return {
      data: parseDeviceSessionGrantStart(result.data, remember, baseUrl),
    };
  } catch (error) {
    return {
      error: {
        code: "invalid_device_grant",
        kind: "parse",
        message:
          error instanceof Error
            ? error.message
            : "The server returned an invalid device sign-in request.",
      },
    };
  }
}

export async function pollDeviceSessionGrant(
  baseUrl: string,
  deviceCode: string,
  expectedRemember: boolean,
  signal?: AbortSignal,
): Promise<AuthResult<DeviceSessionGrantSuccess>> {
  const result = await authRequest<unknown>(baseUrl, TOKEN_PATH, {
    method: "POST",
    body: JSON.stringify({ device_code: deviceCode }),
    ...(signal ? { signal } : {}),
  });
  if (result.error) return result;
  const value = record(result.data);
  const maximumSessionSeconds = expectedRemember
    ? MAX_SESSION_SECONDS
    : MAX_SHORT_SESSION_SECONDS;
  if (
    value.grant_kind !== "session" ||
    value.session !== true ||
    value.confirmation_required !== true ||
    boundedPositiveInteger(
      value.confirmation_expires_in,
      MAX_CONFIRM_SECONDS,
    ) === null ||
    boundedPositiveInteger(value.expires_in, maximumSessionSeconds) === null ||
    value.remember !== expectedRemember
  ) {
    return {
      error: {
        code: "invalid_device_grant",
        kind: "parse",
        message: "The server returned an invalid device sign-in response.",
      },
    };
  }
  return { data: value as unknown as DeviceSessionGrantSuccess };
}

export async function confirmDeviceSessionGrant(
  baseUrl: string,
  deviceCode: string,
  expectedRemember: boolean,
  signal?: AbortSignal,
): Promise<AuthResult<DeviceSessionGrantConfirmation>> {
  const result = await authRequest<unknown>(baseUrl, TOKEN_PATH, {
    method: "POST",
    body: JSON.stringify({ device_code: deviceCode, action: "confirm" }),
    ...(signal ? { signal } : {}),
  });
  if (result.error) return result;
  const value = record(result.data);
  const maximumSessionSeconds = expectedRemember
    ? MAX_SESSION_SECONDS
    : MAX_SHORT_SESSION_SECONDS;
  if (
    value.grant_kind !== "session" ||
    value.session !== true ||
    value.confirmed !== true ||
    value.confirmation_required !== false ||
    boundedPositiveInteger(value.expires_in, maximumSessionSeconds) === null ||
    value.remember !== expectedRemember
  ) {
    return {
      error: {
        code: "invalid_device_grant",
        kind: "parse",
        message: "The server returned an invalid session confirmation.",
      },
    };
  }
  return {
    data: value as unknown as DeviceSessionGrantConfirmation,
  };
}

export async function cancelDeviceSessionGrant(
  baseUrl: string,
  deviceCode: string,
): Promise<void> {
  await authRequest<unknown>(baseUrl, TOKEN_PATH, {
    method: "POST",
    body: JSON.stringify({ device_code: deviceCode, action: "cancel" }),
  });
}

export function decideDeviceSessionPoll(
  error: AuthApiError,
): DeviceSessionPollDecision {
  switch (error.code) {
    case "authorization_pending":
      return { kind: "pending" };
    case "slow_down":
      return { kind: "slow_down" };
    case "access_denied":
      return { kind: "denied" };
    case "expired_token":
      return { kind: "expired" };
  }
  if (
    error.kind === "network" ||
    error.kind === "timeout" ||
    error.status === 429 ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return { kind: "network" };
  }
  return {
    kind: "fatal",
    message: error.message || "Could not complete device sign-in.",
  };
}

export function parseDeviceSessionGrantStart(
  payload: unknown,
  expectedRemember: boolean,
  expectedApiBaseUrl: string,
): DeviceSessionGrantStart {
  const value = record(payload);
  const deviceCode = boundedString(value.device_code, MAX_DEVICE_CODE_BYTES);
  const userCode = boundedString(value.user_code, 9)?.toUpperCase() ?? "";
  const expiresIn = boundedPositiveInteger(value.expires_in, MAX_GRANT_SECONDS);
  const interval = boundedPositiveInteger(value.interval, MAX_POLL_SECONDS);
  if (
    value.grant_kind !== "session" ||
    value.remember !== expectedRemember ||
    !deviceCode ||
    !USER_CODE_RE.test(userCode) ||
    expiresIn === null ||
    interval === null
  ) {
    throw new Error(
      "The server returned an incomplete device sign-in request.",
    );
  }
  let appUrl: URL;
  try {
    // Validate the configured API URL even though approval links are pinned to
    // the separately configured public app origin below.
    new URL(expectedApiBaseUrl);
    appUrl = new URL(PUBLIC_APP_BASE_URL);
  } catch {
    throw new Error("The configured Moosewave URL is invalid.");
  }
  if (!isOriginOnlyUrl(appUrl)) {
    throw new Error("The configured Moosewave URL is invalid.");
  }
  const allowHttp = appUrl.protocol === "http:";
  const verificationUri = safeVerificationUrl(
    value.verification_uri,
    appUrl.origin,
    allowHttp,
  );
  const verificationUriComplete = safeVerificationUrl(
    value.verification_uri_complete,
    appUrl.origin,
    allowHttp,
  );
  const completeKeys = verificationUriComplete
    ? Array.from(verificationUriComplete.searchParams.keys())
    : [];
  if (
    !verificationUri ||
    !verificationUriComplete ||
    verificationUri.pathname !== "/cli/auth" ||
    verificationUri.search !== "" ||
    verificationUriComplete.pathname !== "/cli/auth" ||
    completeKeys.length !== 1 ||
    completeKeys[0] !== "user_code" ||
    verificationUriComplete.searchParams.getAll("user_code").length !== 1 ||
    verificationUriComplete.searchParams.get("user_code") !== userCode ||
    containsDecodedSecret(verificationUri.toString(), deviceCode) ||
    containsDecodedSecret(verificationUriComplete.toString(), deviceCode)
  ) {
    throw new Error("The server returned an unsafe device approval link.");
  }
  return {
    deviceCode,
    userCode,
    verificationUri: verificationUri.toString(),
    verificationUriComplete: verificationUriComplete.toString(),
    expiresIn,
    interval,
    remember: expectedRemember,
  };
}

function isOriginOnlyUrl(url: URL): boolean {
  return (
    url.pathname === "/" &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || !value) return null;
  return utf8ByteLength(value) <= maxBytes ? value : null;
}

function boundedPositiveInteger(value: unknown, max: number): number | null {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    return null;
  }
  return value;
}

function safeVerificationUrl(
  value: unknown,
  expectedOrigin: string,
  allowHttp: boolean,
): URL | null {
  const raw = boundedString(value, MAX_URL_BYTES);
  if (!raw || raw.trim() !== raw || /[\u0000-\u001f\u007f]/.test(raw)) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) ||
      url.origin !== expectedOrigin ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function containsDecodedSecret(value: string, secret: string): boolean {
  let candidate = value;
  for (let pass = 0; pass < 4; pass += 1) {
    if (candidate.includes(secret)) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return true;
    }
  }
  return candidate.includes(secret);
}

/**
 * api/deviceApprove.ts — approve a CLI/desktop device-authorization grant from
 * the phone. The signed-in mobile app POSTs the scanned (or typed) user_code
 * to /api/v1/auth/cli/device/approve; the server binds the pending grant to
 * this session's tenant and the waiting CLI's poll receives its key.
 *
 * This used to go through the SDK transport, which threw away the server's
 * error `code` and returned one catch-all string. That mattered: the approve
 * handler's failure space includes `mfa_required` (an un-stepped-up
 * editor/admin — recoverable on device by stepping up) and `insufficient_role`
 * (not recoverable at all), and the old copy — "that code is invalid, expired,
 * or already used" — described neither. It now uses the same cookie-aware
 * transport as the rest of `/api/v1/auth/*`, so the code survives.
 *
 * It also returns the `scopes` the grant actually received. Those are derived
 * server-side from the approving principal's role, so echoing them back is the
 * only authoritative disclosure of what the user just handed out.
 */
import {
  approveDeviceGrant,
  type AuthDeviceApproveResponse,
  type AuthDeviceGrantAccount,
  type AuthDeviceGrantKind,
  type AuthDeviceIdentity,
} from "./authSessions";
import {
  deviceApproveErrorMessage,
  deviceApproveFailureKind,
  type DeviceApproveFailure,
} from "@/lib/authErrorCopy";
import { utf8ByteLength } from "@/lib/utf8";

export interface DeviceApproveResult {
  ok: boolean;
  /** Human copy for the failure — never a raw server string or status. */
  message?: string;
  /** Structured failure so the screen can offer the right recovery action. */
  failure?: DeviceApproveFailure;
  /** The scopes the server actually granted, echoed on success. */
  scopes?: string[];
  grantKind?: AuthDeviceGrantKind;
  device?: AuthDeviceIdentity;
  account?: AuthDeviceGrantAccount;
  expiresIn?: number;
  remember?: boolean;
  requiresMfa?: boolean;
  /** Opaque inspect→decision binding. Keep only in mounted UI memory. */
  consentToken?: string;
}

function successfulDeviceResult(
  data: AuthDeviceApproveResponse,
): DeviceApproveResult | null {
  const payload = (data && typeof data === "object" ? data : {}) as {
    grant_kind?: unknown;
    device?: unknown;
    account?: unknown;
    expires_in?: unknown;
    remember?: unknown;
    requires_mfa?: unknown;
    scopes?: unknown;
    consent_token?: unknown;
  };
  const grantKind =
    payload.grant_kind === "session" || payload.grant_kind === "api_key"
      ? payload.grant_kind
      : null;
  const scopes = parseScopes(payload.scopes);
  const account = parseGrantAccount(payload.account);
  const device = parseDeviceIdentity(payload.device);
  const expiresIn = boundedPositiveInteger(payload.expires_in, 60 * 60);
  const consentToken =
    payload.consent_token === undefined
      ? undefined
      : boundedConsentToken(payload.consent_token);
  if (
    !grantKind ||
    !device ||
    !account ||
    expiresIn === null ||
    typeof payload.remember !== "boolean" ||
    scopes === null ||
    consentToken === null ||
    (payload.requires_mfa !== undefined &&
      typeof payload.requires_mfa !== "boolean")
  ) {
    return null;
  }
  return {
    ok: true,
    grantKind,
    device,
    account,
    expiresIn,
    remember: payload.remember,
    ...(scopes ? { scopes } : {}),
    ...(typeof payload.requires_mfa === "boolean"
      ? { requiresMfa: payload.requires_mfa }
      : {}),
    ...(consentToken !== undefined ? { consentToken } : {}),
  };
}

const DEVICE_TYPES = new Set<AuthDeviceIdentity["device_type"]>([
  "desktop",
  "mobile",
  "tablet",
  "cli",
  "bot",
  "unknown",
]);

function parseDeviceIdentity(value: unknown): AuthDeviceIdentity | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const label = boundedDisclosure(row.device_label);
  const type = boundedDisclosure(row.device_type);
  if (
    !label ||
    !type ||
    !DEVICE_TYPES.has(type as AuthDeviceIdentity["device_type"])
  ) {
    return null;
  }
  const os = boundedDisclosure(row.device_os);
  const client = boundedDisclosure(row.device_client);
  return {
    device_label: label,
    device_type: type as AuthDeviceIdentity["device_type"],
    ...(os ? { device_os: os } : {}),
    ...(client ? { device_client: client } : {}),
  };
}

function parseGrantAccount(value: unknown): AuthDeviceGrantAccount | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const email = boundedDisclosure(row.email);
  if (!email) return null;
  const workspaceName = boundedDisclosure(row.workspace_name);
  const workspaceSlug = boundedDisclosure(row.workspace_slug);
  return {
    email,
    ...(workspaceName ? { workspace_name: workspaceName } : {}),
    ...(workspaceSlug ? { workspace_slug: workspaceSlug } : {}),
  };
}

function boundedDisclosure(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > 320 ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function parseScopes(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64) return null;
  const scopes: string[] = [];
  for (const scope of value) {
    const parsed = boundedDisclosure(scope);
    if (!parsed || parsed.length > 160) return null;
    scopes.push(parsed);
  }
  return scopes;
}

function boundedPositiveInteger(value: unknown, max: number): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= max
    ? value
    : null;
}

function boundedConsentToken(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8ByteLength(value) > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
}

async function submitDeviceDecision(
  baseUrl: string,
  userCode: string,
  action: "inspect" | "approve" | "deny",
  consentToken?: string,
): Promise<DeviceApproveResult> {
  const res = await approveDeviceGrant(baseUrl, userCode, action, consentToken);
  if (res.error) {
    const failure = deviceApproveFailureKind(res.error);
    return {
      ok: false,
      failure,
      message: deviceApproveErrorMessage(failure),
    };
  }
  const result = successfulDeviceResult(res.data);
  if (!result || (action !== "inspect" && res.data.ok !== true)) {
    return {
      ok: false,
      failure: "unknown",
      message:
        "Moosewave returned incomplete device details. Do not approve this request; restart it on the other device.",
    };
  }
  if (
    action === "inspect" &&
    result.grantKind === "session" &&
    !result.consentToken
  ) {
    return {
      ok: false,
      failure: "unknown",
      message:
        "Moosewave could not bind this review to your current account. Do not approve it; inspect the request again.",
    };
  }
  if (
    action === "inspect" &&
    result.grantKind === "api_key" &&
    !result.scopes
  ) {
    return {
      ok: false,
      failure: "unknown",
      message:
        "Moosewave returned incomplete permission details. Do not approve this request; inspect it again.",
    };
  }
  return result;
}

/** Load authoritative request details before rendering a consent button. */
export function inspectDevice(
  baseUrl: string,
  userCode: string,
): Promise<DeviceApproveResult> {
  return submitDeviceDecision(baseUrl, userCode, "inspect");
}

/** Explicitly refuse a pending request so the waiting device stops polling. */
export function denyDevice(
  baseUrl: string,
  userCode: string,
  consentToken?: string,
): Promise<DeviceApproveResult> {
  return submitDeviceDecision(baseUrl, userCode, "deny", consentToken);
}

/** Approve the pending device grant identified by `userCode` (XXXX-XXXX). */
export async function approveDevice(
  baseUrl: string,
  userCode: string,
  consentToken?: string,
): Promise<DeviceApproveResult> {
  return submitDeviceDecision(baseUrl, userCode, "approve", consentToken);
}

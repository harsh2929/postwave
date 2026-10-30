/**
 * Strict signed-v1 email-auth contract for the native desktop return path.
 *
 * The backend HMAC binds token, version, flow, audience, and state. Desktop
 * accepts only native (`mobile`) audience links with a locally pending state;
 * legacy token-only and browser-audience links are deliberately rejected.
 */

export const AUTH_LINK_VERSION = 1 as const;
export const AUTH_LINK_NATIVE_AUDIENCE = "mobile" as const;

const MAX_AUTH_DEEP_LINK_URL_BYTES = 8 * 1024;
const MAX_AUTH_TOKEN_CHARS = 2048;
const MAX_AUTH_STATE_CHARS = 256;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const AUTH_STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const AUTH_QUERY_FIELDS = new Set([
  "token",
  "v",
  "flow",
  "aud",
  "state",
  "sig",
]);

export type AuthLinkFlow = "magic" | "reset";
export type AuthLinkContractFailure =
  | "invalid_link"
  | "unsupported_version"
  | "wrong_device"
  | "wrong_flow"
  | "invalid_signature";

export type DesktopAuthLinkInspection =
  | { kind: "not_auth_link" }
  | {
      kind: "invalid";
      reason: AuthLinkContractFailure;
      flow: AuthLinkFlow | null;
    }
  | { kind: "valid"; proof: DesktopAuthLinkProof };

export interface DesktopAuthLinkProof {
  token: string;
  link_version: typeof AUTH_LINK_VERSION;
  link_flow: AuthLinkFlow;
  link_audience: typeof AUTH_LINK_NATIVE_AUDIENCE;
  state: string;
  link_signature: string;
}

export interface DesktopAuthLinkStart {
  link_version: typeof AUTH_LINK_VERSION;
  link_audience: typeof AUTH_LINK_NATIVE_AUDIENCE;
  state: string;
}

export function desktopAuthLinkStart(state: string): DesktopAuthLinkStart {
  const safeState = safeBounded(state, MAX_AUTH_STATE_CHARS);
  if (!safeState || !AUTH_STATE_RE.test(safeState)) {
    throw new Error("native auth-link state is invalid");
  }
  return {
    link_version: AUTH_LINK_VERSION,
    link_audience: AUTH_LINK_NATIVE_AUDIENCE,
    state: safeState,
  };
}

/** Parse only exact custom-scheme/native handoff shapes. */
export function parseDesktopAuthLink(
  rawUrl: string,
): DesktopAuthLinkProof | null {
  const inspection = inspectDesktopAuthLink(rawUrl);
  return inspection.kind === "valid" ? inspection.proof : null;
}

/**
 * Parse the native return without collapsing auth-shaped failures into a
 * generic non-route. The reason is safe for user recovery UI and never
 * includes the token, signature, state, or raw URL.
 */
export function inspectDesktopAuthLink(
  rawUrl: string,
): DesktopAuthLinkInspection {
  if (
    !rawUrl ||
    new TextEncoder().encode(rawUrl).byteLength > MAX_AUTH_DEEP_LINK_URL_BYTES
  ) {
    return { kind: "not_auth_link" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl.startsWith("moosewave://auth")
      ? { kind: "invalid", reason: "invalid_link", flow: null }
      : { kind: "not_auth_link" };
  }
  if (parsed.protocol !== "postwave:" || parsed.hostname !== "auth") {
    return { kind: "not_auth_link" };
  }
  const expectedFlow = authFlowFromUrl(parsed);
  const flowHint = expectedFlow;
  if (parsed.username || parsed.password || parsed.hash || parsed.port) {
    return { kind: "invalid", reason: "invalid_link", flow: flowHint };
  }
  if (
    !expectedFlow ||
    Array.from(parsed.searchParams.keys()).some(
      (field) => !AUTH_QUERY_FIELDS.has(field),
    )
  ) {
    return { kind: "invalid", reason: "invalid_link", flow: flowHint };
  }

  const token = safeBounded(
    single(parsed.searchParams, "token"),
    MAX_AUTH_TOKEN_CHARS,
  );
  const version = single(parsed.searchParams, "v");
  const flow = single(parsed.searchParams, "flow");
  const audience = single(parsed.searchParams, "aud");
  const state = safeBounded(
    single(parsed.searchParams, "state"),
    MAX_AUTH_STATE_CHARS,
  );
  const signature = single(parsed.searchParams, "sig");
  if (version !== String(AUTH_LINK_VERSION)) {
    return {
      kind: "invalid",
      reason: version ? "unsupported_version" : "invalid_link",
      flow: expectedFlow,
    };
  }
  if (flow !== expectedFlow) {
    return { kind: "invalid", reason: "wrong_flow", flow: expectedFlow };
  }
  if (audience !== AUTH_LINK_NATIVE_AUDIENCE) {
    return {
      kind: "invalid",
      reason: audience ? "wrong_device" : "invalid_link",
      flow: expectedFlow,
    };
  }
  if (!signature || !SIGNATURE_RE.test(signature)) {
    return {
      kind: "invalid",
      reason: signature ? "invalid_signature" : "invalid_link",
      flow: expectedFlow,
    };
  }
  if (
    !token ||
    !BASE64URL_RE.test(token) ||
    !state ||
    !AUTH_STATE_RE.test(state)
  ) {
    return { kind: "invalid", reason: "invalid_link", flow: expectedFlow };
  }
  return {
    kind: "valid",
    proof: {
      token,
      link_version: AUTH_LINK_VERSION,
      link_flow: expectedFlow,
      link_audience: AUTH_LINK_NATIVE_AUDIENCE,
      state,
      link_signature: signature,
    },
  };
}

function authFlowFromUrl(parsed: URL): AuthLinkFlow | null {
  if (parsed.protocol !== "postwave:" || parsed.hostname !== "auth") {
    return null;
  }
  const path = parsed.pathname;
  if (path === "/magic" || path === "/magic-link") {
    return "magic";
  }
  if (path === "/reset" || path === "/reset-password") {
    return "reset";
  }
  return null;
}

function safeBounded(value: string | null, maxChars: number): string | null {
  if (
    !value ||
    value.length > maxChars ||
    value.trim() !== value ||
    CONTROL_RE.test(value)
  ) {
    return null;
  }
  return value;
}

function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

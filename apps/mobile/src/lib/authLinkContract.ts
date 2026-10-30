/**
 * Versioned email-auth link contract shared by magic-link and password-reset
 * screens.
 *
 * v1 query envelope:
 *   token=<one-time credential>
 *   v=1
 *   flow=magic|reset
 *   aud=mobile|web
 *   state=<device nonce>       (required only for aud=mobile)
 *   sig=<server HMAC>
 *
 * The API signature binds every field. Native code additionally resolves the
 * mobile state from SecureStore before it chooses an API origin. No link field
 * can select an API base URL.
 */
import { PUBLIC_APP_BASE_URL } from "./config";

export const AUTH_LINK_VERSION = 1 as const;
export const AUTH_LINK_TOKEN_MAX_CHARS = 2048;
export const AUTH_LINK_STATE_MAX_CHARS = 256;

export type AuthLinkFlow = "magic" | "reset";
export type AuthLinkAudience = "mobile" | "web";

export interface AuthLinkProof {
  token: string;
  version: typeof AUTH_LINK_VERSION;
  flow: AuthLinkFlow;
  audience: AuthLinkAudience;
  state?: string;
  signature: string;
}

export interface MobileAuthLinkStart {
  link_version: typeof AUTH_LINK_VERSION;
  link_audience: "mobile";
  state: string;
}

export interface AuthLinkProofBody {
  link_version: typeof AUTH_LINK_VERSION;
  link_flow: AuthLinkFlow;
  link_audience: AuthLinkAudience;
  state?: string;
  link_signature: string;
}

export type AuthLinkConsumeBody = AuthLinkProofBody & { token: string };

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;

export function mobileAuthLinkStart(state: string): MobileAuthLinkStart {
  const safeState = safeAuthLinkState(state);
  if (!safeState) {
    throw new Error("Mobile auth-link state is invalid.");
  }
  return {
    link_version: AUTH_LINK_VERSION,
    link_audience: "mobile",
    state: safeState,
  };
}

export function parseAuthLinkProof(
  params: URLSearchParams,
  expectedFlow?: AuthLinkFlow,
): AuthLinkProof | null {
  if (params.getAll("base_url").length > 0) return null;
  const token = safeToken(singleParam(params, "token"));
  const version = singleParam(params, "v");
  const flow = singleParam(params, "flow");
  const audience = singleParam(params, "aud");
  const rawState = singleParam(params, "state");
  const signature = singleParam(params, "sig");

  if (
    !token ||
    version !== String(AUTH_LINK_VERSION) ||
    (flow !== "magic" && flow !== "reset") ||
    (expectedFlow != null && flow !== expectedFlow) ||
    (audience !== "mobile" && audience !== "web") ||
    !signature ||
    !SIGNATURE_RE.test(signature)
  ) {
    return null;
  }

  if (audience === "mobile") {
    const state = safeAuthLinkState(rawState);
    if (!state) return null;
    return {
      token,
      version: AUTH_LINK_VERSION,
      flow,
      audience,
      state,
      signature,
    };
  }
  // Browser links are deliberately not device-bound. A state on a web
  // envelope is ambiguous and must not be silently ignored.
  if (rawState != null) return null;
  return {
    token,
    version: AUTH_LINK_VERSION,
    flow,
    audience,
    signature,
  };
}

export function authLinkProofBody(proof: AuthLinkProof): AuthLinkProofBody {
  return {
    link_version: proof.version,
    link_flow: proof.flow,
    link_audience: proof.audience,
    ...(proof.state ? { state: proof.state } : {}),
    link_signature: proof.signature,
  };
}

export function authLinkConsumeBody(
  proof: AuthLinkProof,
): AuthLinkConsumeBody {
  return { token: proof.token, ...authLinkProofBody(proof) };
}

export function authLinkRouteParams(
  proof: AuthLinkProof,
): Record<string, string> {
  return {
    token: proof.token,
    link_version: String(proof.version),
    link_flow: proof.flow,
    link_audience: proof.audience,
    ...(proof.state ? { state: proof.state } : {}),
    link_signature: proof.signature,
  };
}

export function authLinkProofFromRouteParams(input: {
  token?: string | undefined;
  link_version?: string | undefined;
  link_flow?: string | undefined;
  link_audience?: string | undefined;
  state?: string | undefined;
  link_signature?: string | undefined;
}): AuthLinkProof | null {
  const params = new URLSearchParams();
  for (const [key, value] of [
    ["token", input.token],
    ["v", input.link_version],
    ["flow", input.link_flow],
    ["aud", input.link_audience],
    ["state", input.state],
    ["sig", input.link_signature],
  ] as const) {
    if (typeof value === "string") params.set(key, value);
  }
  return parseAuthLinkProof(params);
}

/**
 * Browser fallback uses a route intentionally excluded from AASA/Android
 * intent filters, preventing an app↔browser loop. The origin is build-owned;
 * no URL/origin supplied by the email is accepted here.
 */
export function browserAuthFallbackUrl(
  proof: AuthLinkProof,
  publicBaseUrl = PUBLIC_APP_BASE_URL,
): string {
  const url = new URL(
    proof.flow === "magic"
      ? "/browser-auth/magic"
      : "/browser-auth/reset",
    publicBaseUrl,
  );
  url.searchParams.set("token", proof.token);
  url.searchParams.set("v", String(proof.version));
  url.searchParams.set("flow", proof.flow);
  url.searchParams.set("aud", proof.audience);
  if (proof.state) url.searchParams.set("state", proof.state);
  url.searchParams.set("sig", proof.signature);
  return url.toString();
}

export function safeAuthLinkState(
  value: string | null | undefined,
): string | null {
  if (
    !value ||
    value.length > AUTH_LINK_STATE_MAX_CHARS ||
    value.trim() !== value ||
    CONTROL_RE.test(value)
  ) {
    return null;
  }
  return value;
}

function safeToken(value: string | null): string | null {
  if (
    !value ||
    value.length > AUTH_LINK_TOKEN_MAX_CHARS ||
    value.trim() !== value ||
    CONTROL_RE.test(value)
  ) {
    return null;
  }
  return value;
}

function singleParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browser half of the signed v1 email-auth link contract. Web pages consume
 * only audience=web; a mobile link opened without the installed app renders a
 * visible recovery path instead of weakening native device possession.
 */
export const AUTH_LINK_VERSION = 1 as const;

export type AuthLinkFlow = "magic" | "reset";
export type AuthLinkAudience = "mobile" | "web";

export interface AuthLinkProof {
  token: string;
  link_version: typeof AUTH_LINK_VERSION;
  link_flow: AuthLinkFlow;
  link_audience: AuthLinkAudience;
  state?: string;
  link_signature: string;
}

export const WEB_AUTH_LINK_START = Object.freeze({
  link_version: AUTH_LINK_VERSION,
  link_audience: "web" as const,
});

type SearchParamsLike = {
  getAll(name: string): string[];
};

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_CHARS = 2048;
const MAX_STATE_CHARS = 256;

export function parseAuthLinkProof(
  params: SearchParamsLike,
  expectedFlow: AuthLinkFlow,
): AuthLinkProof | null {
  if (params.getAll("base_url").length > 0) return null;
  const token = single(params, "token");
  const version = single(params, "v");
  const flow = single(params, "flow");
  const audience = single(params, "aud");
  const state = single(params, "state");
  const signature = single(params, "sig");
  if (
    !safeBounded(token, MAX_TOKEN_CHARS) ||
    version !== String(AUTH_LINK_VERSION) ||
    flow !== expectedFlow ||
    (audience !== "web" && audience !== "mobile") ||
    !signature ||
    !SIGNATURE_RE.test(signature)
  ) {
    return null;
  }
  if (audience === "mobile") {
    if (!safeBounded(state, MAX_STATE_CHARS)) return null;
  } else if (state != null) {
    return null;
  }
  return {
    token,
    link_version: AUTH_LINK_VERSION,
    link_flow: expectedFlow,
    link_audience: audience,
    ...(state ? { state } : {}),
    link_signature: signature,
  };
}

export function hasAnyAuthLinkCredential(params: SearchParamsLike): boolean {
  return ["token", "v", "flow", "aud", "state", "sig"].some(
    (name) => params.getAll(name).length > 0,
  );
}

/**
 * Convert a native-audience HTTPS landing link into the custom-scheme handoff
 * used when a desktop browser cannot open the universal/app link directly.
 * Every signed field is preserved and no origin is carried across.
 */
export function nativeAuthHandoffUrl(proof: AuthLinkProof): string | null {
  if (proof.link_audience !== "mobile" || !proof.state) return null;
  const url = new URL(`moosewave://auth/${proof.link_flow}`);
  url.searchParams.set("token", proof.token);
  url.searchParams.set("v", String(proof.link_version));
  url.searchParams.set("flow", proof.link_flow);
  url.searchParams.set("aud", proof.link_audience);
  url.searchParams.set("state", proof.state);
  url.searchParams.set("sig", proof.link_signature);
  return url.toString();
}

function safeBounded(
  value: string | null,
  maxChars: number,
): value is string {
  return Boolean(
    value &&
      value.length <= maxChars &&
      value.trim() === value &&
      !CONTROL_RE.test(value),
  );
}

function single(params: SearchParamsLike, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

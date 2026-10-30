const SIG = "A".repeat(43);
const MOBILE = "v=1&aud=mobile&state=device-state&sig=" + SIG;
const WEB = "v=1&aud=web&sig=" + SIG;

/**
 * Query-only bare-path fixtures mirror production email links. These are used
 * by the live validator and unit tests so wildcard-only AASA regressions can
 * no longer pass.
 */
export const POSITIVE_AUTH_APP_LINK_FIXTURES = Object.freeze([
  {
    name: "bare generic auth",
    url: "/auth?token=fixture&flow=magic&" + MOBILE,
  },
  {
    name: "bare magic link",
    url: "/magic-link?token=fixture&flow=magic&" + MOBILE,
  },
  {
    name: "bare password reset",
    url: "/reset-password?token=fixture&flow=reset&" + MOBILE,
  },
  {
    name: "browser magic interception fallback",
    url: "/magic-link?token=fixture&flow=magic&" + WEB,
  },
  {
    name: "browser reset interception fallback",
    url: "/reset-password?token=fixture&flow=reset&" + WEB,
  },
]);

export const NEGATIVE_AUTH_APP_LINK_FIXTURES = Object.freeze([
  {
    name: "unclaimed magic browser handoff",
    url: "/browser-auth/magic?token=fixture&flow=magic&" + WEB,
  },
  {
    name: "unclaimed reset browser handoff",
    url: "/browser-auth/reset?token=fixture&flow=reset&" + WEB,
  },
  {
    name: "nested magic path rejected by strict parser",
    url: "/magic-link/extra?token=fixture&flow=magic&" + MOBILE,
  },
]);

export function advertisedPathMatchesUrl(pattern, rawUrl) {
  const pathname = new URL(rawUrl, "https://app.moosewave.com").pathname;
  if (pattern.endsWith("*")) {
    return pathname.startsWith(pattern.slice(0, -1));
  }
  return pathname === pattern;
}

export function associationClaimsUrl(advertisedPaths, rawUrl) {
  return [...advertisedPaths].some((pattern) =>
    advertisedPathMatchesUrl(pattern, rawUrl),
  );
}

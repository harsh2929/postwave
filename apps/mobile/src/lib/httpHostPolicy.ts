/**
 * lib/httpHostPolicy.ts — the ONE answer to "may this host be reached over
 * plain http?".
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────
 * This rule used to be written out by hand in three places, each carrying a
 * comment instructing the next reader to keep it in lockstep with the others:
 * `lib/config.ts` (the sign-in form's validator), `api/url.ts` (every request
 * URL) and `@postwave/sdk`'s client. Comments do not keep anything in
 * lockstep. When the loopback-only rule was relaxed to permit a LAN address
 * for on-device development, two copies were updated and `api/url.ts` was not.
 *
 * The result was not a clean refusal. `api/url.ts` throws SYNCHRONOUSLY from
 * `createAuthClient`, and the sign-in path invoked it as `void submitPassword`,
 * so the rejection was swallowed and the button never came back: the app sat
 * on a spinner forever with no message, on a URL the form itself had just
 * accepted. Two copies agreeing and one disagreeing is strictly worse than one
 * copy being wrong.
 *
 * So there is now exactly one copy, and it is import-free and unit-tested. The
 * SDK keeps its own predicate because it is a published library that cannot
 * import app code — but it takes an explicit opt-in flag rather than inferring
 * the policy, so it cannot silently diverge either.
 */

/** Loopback, in every spelling a URL can produce. Always permitted. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]"
  );
}

/**
 * RFC1918 private IPv4, IPv4 link-local, and IPv6 unique-local/link-local.
 *
 * IP literals ONLY — a hostname could resolve anywhere, so accepting names
 * here would reopen exactly the hole this policy closes.
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m) {
    // 172.16.0.0/12 — 172.15.x and 172.32.x are PUBLIC address space, and an
    // off-by-one here puts credentials on the open internet in cleartext.
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h);
}

/**
 * May this build reach `hostname` over plain http?
 *
 * `buildProfile` is a PARAMETER, never an ambient constant: a predicate that
 * ignored the profile it was handed would let a production-profile check pass
 * on a developer machine — a leak hidden behind a test that looked green.
 *
 * The cost of the private-network allowance is real and worth stating: on a
 * LAN host, credentials cross the network in cleartext. That is acceptable for
 * a developer build on a developer's own network and nowhere else, which is
 * why production is loopback-only.
 */
export function httpHostAllowed(
  hostname: string,
  buildProfile: string,
): boolean {
  if (isLoopbackHost(hostname)) return true;
  // ALLOW-LIST, not deny-list. `buildProfile !== "production"` let an UNSET
  // profile — which lib/config falls back to "development" — and the
  // `preview` profile handed to testers reach a private-network API over
  // plain http. Only a build that says it is development gets that; every
  // real launch sets EXPO_PUBLIC_BUILD_PROFILE (.env, eas.json), so nothing
  // legitimate is lost, and the same shape lib/devAutoSignIn already uses.
  return buildProfile === "development" && isPrivateNetworkHost(hostname);
}

// SPDX-License-Identifier: AGPL-3.0-only
//
// Bounded per-instance budget for /og, the public social-card renderer.
//
// Every distinct query string is a full satori text layout plus a resvg raster
// at 1200x630, and `output: "standalone"` (next.config.mjs) means that work
// happens inside the same Node process that serves marketing, forms,
// preferences and archive pages. Unmetered, a few hundred concurrent requests
// with random titles saturate the render workers and stall the whole public
// tier. This is the same shape of defence /api/mjml already applies to its
// compile endpoint, minus the credential — /og is unauthenticated by design.

export const RENDER_WINDOW_MS = 60_000;
/** Per-peer allowance. One page needs one image; crawlers refetch a handful. */
export const RENDER_REQUESTS_PER_PEER = 60;
/**
 * Instance-wide ceiling. The peer budget alone is not enough: attribution
 * comes from a proxy header, so a caller that can vary or omit it would
 * otherwise mint a fresh bucket per request. This is the number that actually
 * bounds render CPU on one replica.
 */
export const RENDER_REQUESTS_PER_INSTANCE = 600;
const MAX_RENDER_KEYS = 10_000;

type RenderWindow = { startedAt: number; requests: number };
const renderWindows = new Map<string, RenderWindow>();
let instanceWindow: RenderWindow = { startedAt: 0, requests: 0 };

/**
 * The peer a request actually came from. X-Forwarded-For is read from the
 * RIGHT, matching apps/api/internal/middleware/client_ip.go: a client can
 * prepend anything it likes before the request reaches a proxy, so only the
 * rightmost (proxy-appended) hop is meaningful. Requests with no trustworthy
 * attribution share ONE bucket rather than each getting a free one — the
 * instance ceiling is what keeps that honest.
 */
export function ogPeerKey(headers: Pick<Headers, "get">): string {
  const forwarded = headers.get("x-forwarded-for") ?? "";
  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const candidate = hops.at(-1) ?? headers.get("x-real-ip")?.trim() ?? "";
  if (
    !candidate ||
    candidate.length > 64 ||
    !/^[0-9a-f:.]+$/i.test(candidate)
  ) {
    return "peer:unattributed";
  }
  return `peer:${candidate}`;
}

/** Seconds the caller must wait, or null when the render may proceed. */
export function consumeOgRenderAllowance(
  key: string,
  now = Date.now(),
): number | null {
  const retryAfter = (startedAt: number): number =>
    Math.max(1, Math.ceil((startedAt + RENDER_WINDOW_MS - now) / 1_000));

  if (now - instanceWindow.startedAt >= RENDER_WINDOW_MS) {
    instanceWindow = { startedAt: now, requests: 0 };
  }
  if (instanceWindow.requests >= RENDER_REQUESTS_PER_INSTANCE) {
    return retryAfter(instanceWindow.startedAt);
  }

  const current = renderWindows.get(key);
  if (current && now - current.startedAt < RENDER_WINDOW_MS) {
    if (current.requests >= RENDER_REQUESTS_PER_PEER) {
      return retryAfter(current.startedAt);
    }
    current.requests += 1;
    instanceWindow.requests += 1;
    return null;
  }
  if (current) renderWindows.delete(key);

  if (renderWindows.size >= MAX_RENDER_KEYS) {
    for (const [existing, window] of renderWindows) {
      if (now - window.startedAt >= RENDER_WINDOW_MS) {
        renderWindows.delete(existing);
      }
    }
  }
  while (renderWindows.size >= MAX_RENDER_KEYS) {
    const oldest = renderWindows.keys().next().value as string | undefined;
    if (!oldest) break;
    renderWindows.delete(oldest);
  }
  renderWindows.set(key, { startedAt: now, requests: 1 });
  instanceWindow.requests += 1;
  return null;
}

/** Test seam: forget every window so one suite cannot starve the next. */
export function resetOgRenderBudget(): void {
  renderWindows.clear();
  instanceWindow = { startedAt: 0, requests: 0 };
}

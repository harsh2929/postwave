/**
 * settings-gates — pure derivation helpers behind the Settings /
 * Sending Settings / Send Time surfaces.
 *
 * Extracted from the page components so the gating logic is
 * unit-testable in the node-env vitest suite (no DOM, no React) — see
 * src/__tests__/settings-gates.test.ts. Everything in here must stay
 * side-effect free: no fetches, no storage access, no globals.
 */

import type {
  SampleDataStatus,
  SendingSettings,
  SlackAvailability,
} from "./api-client";

/* ---------- sample data (Settings → Sample data) ------------------ */

/** Badge state for the sample-data section. `unknown` is the honest
 *  fallback when the status probe failed — never fabricate "Empty". */
export type SampleBadge = "checking" | "unknown" | "seeded" | "empty";

export function deriveSampleBadge(
  loading: boolean,
  error: string | null,
  status: SampleDataStatus | null,
): SampleBadge {
  if (loading) return "checking";
  if (error || !status) return "unknown";
  return status.seeded ? "seeded" : "empty";
}

/** Known seeder count keys, in display order. Unknown keys (a newer
 *  server seeding more entity types) are appended alphabetically so
 *  they're still surfaced instead of silently dropped. */
const SAMPLE_COUNT_ORDER = [
  "subscribers",
  "lists",
  "segments",
  "campaigns",
  "sequences",
] as const;

/** "Subscribers: 50 · Lists: 1 · …" or null when there's nothing to show. */
export function formatSampleCounts(
  counts: Record<string, number> | undefined,
): string | null {
  if (!counts) return null;
  const keys = Object.keys(counts);
  if (keys.length === 0) return null;
  const known = SAMPLE_COUNT_ORDER.filter((k) => k in counts);
  const rest = keys.filter(
    (k) => !(SAMPLE_COUNT_ORDER as readonly string[]).includes(k),
  );
  rest.sort();
  return [...known, ...rest]
    .map((k) => `${k.charAt(0).toUpperCase()}${k.slice(1)}: ${counts[k]}`)
    .join(" · ");
}

/* ---------- Slack connect gate (Settings → Slack) ------------------ */

export type SlackGate =
  /** Server has no Slack OAuth credentials — connecting is impossible. */
  | { kind: "not_configured" }
  /** OAuth start needs a cookie session and this is an API-key-only
   *  desktop session — connecting would dead-end on the auth gate. */
  | { kind: "needs_session" }
  | { kind: "ok" };

/**
 * Decide whether the "Connect Slack" CTA is actionable.
 *
 * `availability === null` means the probe failed (network, older
 * server without the endpoint): fall back to the conservative pre-probe
 * behaviour and require a cookie session, since the OAuth start route
 * historically rejected API-key-only sessions.
 */
export function deriveSlackGate(
  availability: SlackAvailability | null,
  sessionAuth: boolean,
): SlackGate {
  if (availability?.configured === false) return { kind: "not_configured" };
  const requiresSession = availability ? availability.requires_session : true;
  if (requiresSession && !sessionAuth) return { kind: "needs_session" };
  return { kind: "ok" };
}

/* ---------- IP pool (Sending Settings → Sending identity) ---------- */

export type IpPoolView =
  | { kind: "known"; name: string; dedicated: boolean }
  | /** Field absent from the sending-settings response — older API
     *  build that doesn't report pool assignment. Honest "Unknown",
     *  never a fabricated "Shared". */
    { kind: "unknown" };

export function describeIpPool(
  pool: SendingSettings["ip_pool"],
): IpPoolView {
  if (!pool || !pool.name) return { kind: "unknown" };
  return { kind: "known", name: pool.name, dedicated: pool.dedicated === true };
}

/* ---------- send-time optimization (Send Time) --------------------- */

/**
 * Parse the legacy device-local STO preference ("pw.sendtime.optEnabled").
 * The workspace endpoint is now the source of truth; the old value is
 * only a migration hint that seeds the switch position while the GET is
 * in flight. Unset → true (the old default was "on").
 */
export function parseLegacyStoHint(raw: string | null): boolean {
  if (raw == null) return true;
  return raw === "1" || raw === "true";
}

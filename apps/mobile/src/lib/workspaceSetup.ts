/**
 * lib/workspaceSetup.ts — what the Slack-workspace and sample-data cards say.
 *
 * Pure and import-free, so every one of these sentences is exercised in the
 * node vitest environment rather than only through a rendered screen.
 *
 * THE RULE THAT DROVE THIS FILE: absence is not zero. A workspace connection
 * row that came back without a channel name has NO default channel — it does
 * not have a channel called "". A sample-data marker written before the
 * counts field existed reports its total as an em-dash, not as 0, because
 * "0 subscribers seeded" and "we don't know how many" are different claims and
 * only one of them is safe to act on.
 */

/** The one dash the whole app uses for a measurement it does not have. */
export const NO_VALUE = "—";

export type SlackConnectionSummary = {
  connected: boolean;
  /** Workspace name, falling back to the team id, else null. */
  workspace: string | null;
  /** "#general"-style channel label, or null when none was recorded. */
  channel: string | null;
  /** ISO timestamp the connection was first made, or null. */
  connectedAt: string | null;
};

export function slackConnectionSummary(
  raw:
    | {
        connected?: boolean;
        slack_team_id?: string;
        slack_team_name?: string;
        default_channel_id?: string;
        default_channel_name?: string;
        created_at?: string;
      }
    | null
    | undefined,
): SlackConnectionSummary {
  const connected = Boolean(raw?.connected);
  if (!connected) {
    return { connected: false, workspace: null, channel: null, connectedAt: null };
  }
  const name = trimmed(raw?.slack_team_name);
  const team = trimmed(raw?.slack_team_id);
  const channelName = trimmed(raw?.default_channel_name);
  const channelId = trimmed(raw?.default_channel_id);
  const channel = channelName
    ? channelName.startsWith("#")
      ? channelName
      : `#${channelName}`
    : channelId;
  return {
    connected: true,
    workspace: name ?? team ?? null,
    channel: channel ?? null,
    // Go's `omitempty` on a time.Time never omits the zero value, so a row
    // with no real timestamp arrives as year 1. Treat that as unknown.
    connectedAt: usableTimestamp(raw?.created_at),
  };
}

/**
 * What the connect line is allowed to promise.
 *
 * `unconfigured` is a hard stop everywhere, phone or not — the deployment has
 * no SLACK_CLIENT_ID and the start route answers 503. `browser_only` is the
 * normal case: the OAuth install must be completed in a browser session, so
 * the honest mobile affordance is a link out, never an in-app Connect button.
 */
export type SlackConnectAvailability =
  | "connected"
  | "unconfigured"
  | "browser_only"
  | "unknown";

export function slackConnectAvailability(input: {
  connected: boolean;
  availability: { configured?: boolean } | null | undefined;
  availabilityFailed: boolean;
}): SlackConnectAvailability {
  if (input.connected) return "connected";
  // A failed probe must not be reported as "not configured" — that would tell
  // an operator their deployment lacks a Slack app when the read simply did
  // not land.
  if (input.availabilityFailed || !input.availability) return "unknown";
  return input.availability.configured ? "browser_only" : "unconfigured";
}

export function slackConnectMessage(state: SlackConnectAvailability): string {
  switch (state) {
    case "connected":
      return "The approval bot can post to this workspace.";
    case "unconfigured":
      return "This Moosewave deployment has no Slack app configured, so no workspace can be connected — on any device.";
    case "browser_only":
      return "Connecting a workspace is a Slack install grant: it has to be completed in a signed-in browser, so finish it on the web admin.";
    default:
      return "Couldn't check whether Slack is available on this deployment.";
  }
}

export type SampleDataSummary = {
  seeded: boolean;
  /** Total rows the marker recorded, or null when it recorded none. */
  total: number | null;
  /** Non-zero rows, largest first — what the card actually lists. */
  breakdown: { label: string; count: number }[];
  seededAt: string | null;
};

const SAMPLE_DATA_LABELS: readonly [
  keyof NonNullable<SampleDataSummaryInput["counts"]>,
  string,
][] = [
  ["subscribers", "Subscribers"],
  ["lists", "Lists"],
  ["segments", "Segments"],
  ["campaigns", "Campaigns"],
  ["sequences", "Sequences"],
];

interface SampleDataSummaryInput {
  seeded?: boolean;
  seeded_at?: string;
  counts?: {
    subscribers?: number;
    lists?: number;
    segments?: number;
    campaigns?: number;
    sequences?: number;
  };
}

export function sampleDataSummary(
  raw: SampleDataSummaryInput | null | undefined,
): SampleDataSummary {
  const seeded = Boolean(raw?.seeded);
  const counts = raw?.counts;
  const breakdown = counts
    ? SAMPLE_DATA_LABELS.map(([key, label]) => ({
        label,
        count: countOf(counts[key]),
      })).filter((entry) => entry.count > 0)
    : [];
  return {
    seeded,
    // No counts object at all means the marker predates the field. That is
    // unknown, not empty — reporting 0 would claim the seed created nothing.
    total: counts
      ? SAMPLE_DATA_LABELS.reduce((sum, [key]) => sum + countOf(counts[key]), 0)
      : null,
    breakdown: breakdown.sort((a, b) => b.count - a.count),
    seededAt: usableTimestamp(raw?.seeded_at),
  };
}

/**
 * The seeder is idempotent server-side (re-running returns the cached counts
 * without inserting duplicates), so the button is about intent, not safety:
 * it is offered only when the workspace is NOT already seeded, and the remove
 * counterpart only when it is.
 */
export function sampleDataAction(
  summary: SampleDataSummary,
): "seed" | "remove" {
  return summary.seeded ? "remove" : "seed";
}

function trimmed(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  return v || undefined;
}

function countOf(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** Rejects empty strings and Go's zero time, both of which mean "unknown". */
function usableTimestamp(value: string | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw || raw.startsWith("0001-01-01")) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? raw : null;
}

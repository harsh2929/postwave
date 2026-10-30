/**
 * lib/governanceOfflineStates.ts — what a governance surface says when the
 * device cannot reach the server (GOVERNANCE#33).
 *
 * ── THE BUG THIS CLOSES ────────────────────────────────────────────────────
 * The app is offline-first everywhere else, and governance is the cluster you
 * are most likely to consult AWAY from connectivity — on a train, in a taxi,
 * mid-incident. Four of the six governance screens already answer honestly:
 * Approvals through `approvalGateNotice`, SCIM and Audit sinks through
 * `QueryStates`' offline rung, Audit through its vault snapshot. Two did not:
 *
 *   - MIGRATIONS rendered "No migration jobs — start migrations from desktop;
 *     their progress will appear here." An operator offline was therefore told
 *     that the import they started an hour ago does not exist.
 *   - AGENCY rendered NOTHING AT ALL. Its query is gated on `gate.enabled`, so
 *     offline it is neither loading nor errored and `data` is undefined — every
 *     branch in the screen was false and the ScrollView came out blank.
 *
 * Both are the same category of lie: ABSENCE IS NOT ZERO. A disabled query has
 * not learned that there are no jobs; it has not asked.
 *
 * ── WHY A SHARED MODULE RATHER THAN TWO GOOD PARAGRAPHS ────────────────────
 * Exactly the argument `governanceEmptyStates` makes for first-run copy, and
 * for the same six screens: the failure mode is DRIFT. One screen says
 * "You're offline", the next "Reconnect", the third stays blank. This module is
 * the offline half of that same contract, shaped identically — `{ title,
 * description }` is what `<EmptyState>`, `<ErrorState message>` and
 * `QueryStates`' `empty` prop already take, so adopting it is a substitution
 * rather than a refactor — plus a `staleMessage` for the screens that DO hold
 * cached rows and only need a banner above them.
 *
 * ── ORDER OF THE TWO BRANCHES ──────────────────────────────────────────────
 * No workspace is reported before no connectivity, because it is the one the
 * reader can actually do something about, and because a screen that says
 * "you're offline" to someone who is merely signed out sends them to check
 * their wifi. Same ordering rule `approvalActionGate` follows.
 *
 * Import-free of react-native/expo (only `lib/i18n`, itself import-free), so
 * every rule above is unit-tested under node. Copy lives in the catalogue.
 */
import { msg, type SimpleMessageKey } from "@/lib/i18n";

/**
 * Catalogue keys per surface, written out rather than assembled from the
 * surface name — a template-built key would need a cast to `SimpleMessageKey`,
 * and that cast throws away the whole safety property of this seam (a missing
 * entry must be a compile error, not a key rendering itself on screen).
 */
const KEYS = {
  migrationJobs: {
    title: "governance.offline.migrationJobs.title",
    body: "governance.offline.migrationJobs.body",
    stale: "governance.offline.migrationJobs.stale",
  },
  migrationSources: {
    title: "governance.offline.migrationSources.title",
    body: "governance.offline.migrationSources.body",
    stale: "governance.offline.migrationSources.stale",
  },
  agency: {
    title: "governance.offline.agency.title",
    body: "governance.offline.agency.body",
    stale: "governance.offline.agency.stale",
  },
} as const satisfies Record<
  string,
  { title: SimpleMessageKey; body: SimpleMessageKey; stale: SimpleMessageKey }
>;

/** The governance surfaces with shared offline copy. */
export type GovernanceOfflineSurface = keyof typeof KEYS;

export const GOVERNANCE_OFFLINE_SURFACES = Object.keys(
  KEYS,
) as GovernanceOfflineSurface[];

export interface GovernanceOfflineCopy {
  title: string;
  description: string;
  /** Shown above rows we still hold, instead of replacing them. */
  staleMessage: string;
}

export interface GovernanceOfflineInput {
  /** `useOnlineQueryGate().enabled` — online services are usable. */
  gateEnabled: boolean;
  /** A tenant is resolved. False means signed out / mid-bootstrap. */
  hasTenant: boolean;
  surface: GovernanceOfflineSurface;
}

const NO_WORKSPACE_KEYS = {
  title: "governance.offline.noWorkspace.title",
  body: "governance.offline.noWorkspace.body",
  stale: "governance.offline.noWorkspace.stale",
} as const satisfies {
  title: SimpleMessageKey;
  body: SimpleMessageKey;
  stale: SimpleMessageKey;
};

/**
 * The offline notice for a governance surface, or null when the surface may
 * fetch normally.
 *
 * Returns null whenever the gate is open — INCLUDING while a request is in
 * flight or has failed. An online failure is an error and must keep reading as
 * one; conflating "the server said no" with "you are offline" is the mirror of
 * the bug this module exists to fix.
 */
export function governanceOfflineNotice(
  input: GovernanceOfflineInput,
): GovernanceOfflineCopy | null {
  if (input.gateEnabled) return null;
  if (!input.hasTenant) {
    return {
      title: msg(NO_WORKSPACE_KEYS.title),
      description: msg(NO_WORKSPACE_KEYS.body),
      staleMessage: msg(NO_WORKSPACE_KEYS.stale),
    };
  }
  const keys = KEYS[input.surface];
  return {
    title: msg(keys.title),
    description: msg(keys.body),
    staleMessage: msg(keys.stale),
  };
}

/**
 * `{ title, description }` only — the shape `<EmptyState>` and `QueryStates`'
 * `empty` prop take, so a call site does not have to drop `staleMessage` by
 * hand and cannot accidentally render the stale sentence as a blocking one.
 */
export function governanceOfflineEmptyCopy(
  notice: GovernanceOfflineCopy,
): { title: string; description: string } {
  return { title: notice.title, description: notice.description };
}

/**
 * Should a headline metric render as a measurement, or as an em-dash?
 *
 * Offline is a MISSING measurement, never a zero: "Running 0 / Failed 0" read
 * off a query that never ran is a confident, false claim about a live import.
 * Cached rows are the one exception — if we are still showing job cards, the
 * counts derived from those same cards are true of what is on screen.
 */
export function governanceMetricsUnavailable(input: {
  failed: boolean;
  offline: boolean;
  cachedRowCount: number;
}): boolean {
  if (input.cachedRowCount > 0) return false;
  return input.failed || input.offline;
}

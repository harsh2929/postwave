/**
 * lib/inboundRouteVerdict.ts — the judgements the inbound-routing monitor
 * makes, and the disclosures that keep each one honest.
 *
 * Split from `lib/inboundRoutes` (which owns the shapes) so the parsing and the
 * opinions are separately readable and separately testable. Every function here
 * maps to one of the five server facts documented at the top of that module.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */
import type {
  InboundActionRun,
  InboundRoute,
  InboundRouteMatch,
} from "@/lib/inboundRoutes";

export interface RoutingPosture {
  total: number;
  enabled: number;
  disabled: number;
  /** Enabled rules that have never matched anything. */
  enabledNeverMatched: number;
  /** Rules that are switched off but still carry a match history. */
  disabledWithHistory: number;
}

export function routingPosture(
  routes: readonly InboundRoute[],
): RoutingPosture {
  const enabled = routes.filter((route) => route.enabled);
  const disabled = routes.filter((route) => !route.enabled);
  return {
    total: routes.length,
    enabled: enabled.length,
    disabled: disabled.length,
    enabledNeverMatched: enabled.filter((route) => route.matchCount === 0).length,
    disabledWithHistory: disabled.filter((route) => route.matchCount > 0).length,
  };
}

export type RoutingTone = "ok" | "warn" | "idle";

export interface RoutingVerdict {
  tone: RoutingTone;
  headline: string;
  detail: string;
}

/**
 * The posture sentence for the whole rule set.
 *
 * IT DELIBERATELY NEVER SAYS "MAIL IS ROUTING FINE". There is no global match
 * feed on this API — matches are only reachable one rule at a time (see fact 1
 * in lib/inboundRoutes) — so any claim about the workspace as a whole would be
 * an extrapolation from a list of CONFIGURATION rows. What this verdict states
 * is exactly what the rule list can support: how many rules exist, how many are
 * switched on, and how many of the switched-on ones have never fired.
 */
export function routingVerdict(
  routes: readonly InboundRoute[] | null,
): RoutingVerdict {
  if (routes === null) {
    return {
      tone: "idle",
      headline: "No reading yet",
      detail: "The rule list has not been read.",
    };
  }
  const posture = routingPosture(routes);
  if (posture.total === 0) {
    return {
      tone: "idle",
      headline: "No routing rules",
      detail:
        "Nothing is configured to act on inbound mail. Rules are authored on the web admin.",
    };
  }
  if (posture.enabled === 0) {
    return {
      tone: "warn",
      headline: `All ${posture.total} rules are switched off`,
      detail:
        "No inbound mail is being acted on at all — matching skips disabled rules entirely, however much history they show.",
    };
  }
  if (posture.enabledNeverMatched > 0) {
    return {
      tone: "warn",
      headline: `${posture.enabledNeverMatched} of ${posture.enabled} live rules have never matched`,
      detail:
        "A rule that has never fired is either waiting for its first message or has a pattern nothing reaches. This is a statement about the rules, not about whether today's mail routed.",
    };
  }
  return {
    tone: "ok",
    headline: `${posture.enabled} live rules have all matched at least once`,
    detail:
      "Every enabled rule has fired before. Open a rule to see whether its recent matches actually ran their actions — that is the only place this API can answer it.",
  };
}

/**
 * The sentence a rule's match list needs beside it.
 *
 * `match_count` is lifetime and the list is the newest 50, so the two disagree
 * routinely and each disagreement means something different.
 */
export function matchWindowNotice(
  route: InboundRoute,
  matches: readonly InboundRouteMatch[],
  pageSize: number,
): string {
  if (route.matchCount === 0) {
    return "This rule has never matched a message.";
  }
  if (matches.length === 0) {
    return `This rule has matched ${route.matchCount} times, but no match rows remain — the history is pruned on a retention schedule while the counter is not.`;
  }
  if (matches.length >= pageSize && route.matchCount > matches.length) {
    return `Showing the newest ${matches.length} of ${route.matchCount} lifetime matches.`;
  }
  return `${matches.length} recent ${matches.length === 1 ? "match" : "matches"} of ${route.matchCount} lifetime.`;
}

/** Loud, because a disabled rule with history is the most misleading row here. */
export function disabledNotice(route: InboundRoute): string | null {
  if (route.enabled) return null;
  if (route.matchCount > 0) {
    return "This rule is switched off. Matching skips it entirely, so everything below is history from before it was disabled — none of it is current behaviour.";
  }
  return "This rule is switched off, so it matches nothing.";
}

export interface RunOutcome {
  failed: number;
  skipped: number;
  succeeded: number;
  unknown: number;
  retried: number;
}

export function runOutcome(runs: readonly InboundActionRun[]): RunOutcome {
  return {
    failed: runs.filter((run) => run.status === "failed").length,
    skipped: runs.filter((run) => run.status === "skipped").length,
    succeeded: runs.filter((run) => run.status === "succeeded").length,
    unknown: runs.filter((run) => run.status === "unknown").length,
    // `attempts` counts the total tries, so anything above 1 means the action
    // was retried — including when it eventually succeeded, which is exactly
    // the flaky-upstream signal a green row would otherwise hide.
    retried: runs.filter((run) => run.attempts > 1).length,
  };
}

/**
 * What an EMPTY run list means. It has two causes and this does not pick one.
 *
 * Returns null when there are runs to render.
 */
export function emptyRunsNotice(
  route: InboundRoute,
  runs: readonly InboundActionRun[],
): string | null {
  if (runs.length > 0) return null;
  if (route.actions.length === 0) {
    return "This rule has no actions, so a match records the message and does nothing else. There is nothing to have failed.";
  }
  return `This rule has ${route.actions.length} ${route.actions.length === 1 ? "action" : "actions"}, but no run rows are recorded against this match. Either the match predates action logging, or its runs have been pruned — this API cannot tell the two apart.`;
}

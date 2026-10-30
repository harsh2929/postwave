/**
 * lib/inboundRouteToggle.ts — the payload and the copy for switching one
 * inbound routing rule off (or back on) from a phone.
 *
 * WHY THE PAYLOAD ECHOES FIELDS IT DOES NOT CHANGE. The server's PATCH
 * (apps/api/internal/inbound_email/routes.go:530-591) is only partially
 * PATCH-shaped:
 *
 *   - `enabled` / `stop_on_match` are pointers → omitted means preserved. Good.
 *   - `name` / `match_recipient` go through COALESCE(NULLIF($n,'')) → an empty
 *     string is preserved. Also good.
 *   - `match_subject_prefix` ($8) and `match_from_domain` ($9) are RAW
 *     ASSIGNMENTS of non-pointer strings: omit them from the JSON and Go's
 *     zero value "" is WRITTEN, silently deleting the rule's matchers.
 *   - `priority` ($4) is a non-pointer int guarded by `BETWEEN 0 AND 10000` —
 *     and 0 is in that range, so an omitted priority RESETS the rule to 0.
 *
 * Desktop's toggle sends a bare `{enabled}` and therefore has exactly this bug
 * (apps/desktop/src/pages/inbound-routes/useInboundRoutesController.ts:398).
 * The mobile toggle must not inherit it: a 2am "switch it off" that also wipes
 * the matchers and the priority turns tomorrow's re-enable into a different
 * rule. This is the raw-$n PATCH-preserve class of defect — echo back exactly
 * the fields the SQL would otherwise zero (retry fields are pointers and safe
 * to omit).
 *
 * `actions` IS one of those fields, non-obviously. The handler marshals the
 * omitted Go slice with `json.Marshal(nil)` → the four-character string
 * "null" → `'null'::jsonb`, which is a jsonb VALUE, not SQL NULL — so the
 * `$10::jsonb IS NULL` preserve arm never fires and the ELSE arm writes JSON
 * null over the rule's actions. An omitting toggle therefore strips every
 * action from the rule it switches. The payload echoes `rawActions` — the
 * wire-verbatim array, NOT the normalized one, which drops each action's
 * `extra` map (see lib/inboundRoutes.ts). A non-empty echo replaces the
 * column with identical content; an empty echo takes the server's
 * empty-array-preserve arm. Either way nothing is lost.
 *
 * Import-free of react-native so the node vitest environment can prove the
 * echo is present — the assertion that keeps this from regressing to
 * desktop's payload.
 */
import type { InboundRoute } from "@/lib/inboundRoutes";

/** Exactly what the PATCH must carry: the change, plus the preserve echo. */
export interface InboundRouteTogglePayload {
  enabled: boolean;
  priority: number;
  match_subject_prefix: string;
  match_from_domain: string;
  /** Wire-verbatim echo — see the header for why omission wipes the column. */
  actions: readonly unknown[];
}

export function inboundRouteTogglePayload(
  route: InboundRoute,
  enabled: boolean,
): InboundRouteTogglePayload {
  return {
    enabled,
    priority: route.priority,
    match_subject_prefix: route.matchSubjectPrefix,
    match_from_domain: route.matchFromDomain,
    actions: route.rawActions,
  };
}

/**
 * Thrown instead of queueing the write. A routing-rule toggle must never
 * replay from an offline outbox: a queued "switch on" landing hours later
 * would re-arm a rule somebody has since decided to keep off, against a
 * configuration that has moved on.
 */
export class InboundRouteOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor() {
    super(
      "Routing rules can only be switched while connected. Reconnect and try again.",
    );
    this.name = "InboundRouteOfflineError";
  }
}

/** The confirm copy for switching a LIVE rule off. */
export function disableConfirmCopy(route: InboundRoute): {
  title: string;
  message: string;
  consequence: string;
} {
  const name = route.name || "This rule";
  return {
    title: "Switch this rule off?",
    message: `${name} stops matching inbound mail the moment it is off. Every match it has already made is kept.`,
    consequence:
      "Mail this rule would have routed is handled by later rules, or not at all.",
  };
}

/** The toast/a11y verb pair for the current state. */
export function toggleVerb(enabled: boolean): {
  label: string;
  accessibilityLabel: string;
  successToast: string;
  failureToast: string;
} {
  return enabled
    ? {
        label: "Switch off this rule",
        accessibilityLabel: "Switch this routing rule off",
        successToast: "Rule switched off.",
        failureToast: "Couldn't switch the rule off.",
      }
    : {
        label: "Switch this rule on",
        accessibilityLabel: "Switch this routing rule on",
        successToast: "Rule switched on.",
        failureToast: "Couldn't switch the rule on.",
      };
}

/**
 * sequenceTrigger — read-only presentation of a sequence's ENTRY condition
 * and its success criterion.
 *
 * Why this exists: the mobile canvas used to render every step of a journey
 * and omit the node that decides who enters it. That is an incomplete read —
 * an operator could see all five emails and still not know whether the
 * sequence fires on list join, on a segment match, or on a custom event.
 *
 * Ported from apps/desktop/src/components/sequence/trigger-config.ts so the
 * two clients describe the same stored value with the same words. Pure module
 * (no react-native import) so it is unit-testable in the node environment.
 */
import type {
  SequenceGoalWire,
  SequenceTriggerWire,
} from "@/api/sequences";

export interface TriggerSummary {
  label: string;
  detail: string | null;
  /**
   * True when the stored trigger is missing a field it needs to be complete.
   * Mobile does not offer to fix it (authoring is desktop-only) but must not
   * present a half-configured trigger as a finished one.
   */
  incomplete: boolean;
  /**
   * False when the RESPONSE carried no `trigger` field at all — which is not
   * the same as "no trigger is configured". The Voice service does not persist
   * the field yet (the desktop round-trips it client-side, see
   * apps/desktop/src/lib/api/campaign-sequence-operations.ts:392), so an
   * absent field says nothing about tenant state and must not be reported as
   * "nothing enrolls into this journey".
   */
  known: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Present a stored entry trigger.
 *
 *   undefined → the field was not in the payload; we know nothing.
 *   null      → the field was present and empty; no trigger is configured.
 */
export function triggerSummary(
  trigger: SequenceTriggerWire | null | undefined,
): TriggerSummary {
  if (trigger === undefined) {
    return {
      label: "Entry trigger not reported",
      detail:
        "This gateway doesn't return a sequence's entry condition, so we can't say what starts this journey. Open it on desktop to see or set it.",
      incomplete: false,
      known: false,
    };
  }
  if (!trigger || typeof trigger !== "object") {
    return {
      label: "No entry trigger",
      detail: "Nothing enrolls into this journey until a trigger is set.",
      incomplete: true,
      known: true,
    };
  }
  switch (trigger.kind) {
    case "list_subscribe": {
      const listID =
        trigger.list_id === undefined || trigger.list_id === null
          ? ""
          : String(trigger.list_id).trim();
      return {
        label: "When subscriber joins list",
        detail: listID ? `List #${listID}` : "No list picked yet",
        incomplete: listID === "",
        known: true,
      };
    }
    case "segment_match": {
      const segment = text(trigger.segment_id);
      return {
        label: "When subscriber matches segment",
        detail: segment ? `Segment ${segment.slice(0, 8)}…` : "No segment picked yet",
        incomplete: segment === "",
        known: true,
      };
    }
    case "custom_event": {
      const event = text(trigger.event_name);
      return {
        label: "On custom event",
        detail: event ? `Event "${event}"` : "No event name set yet",
        incomplete: event === "",
        known: true,
      };
    }
    case "schedule": {
      const runAt = text(trigger.run_at);
      if (runAt) {
        return {
          label: "On schedule",
          detail: `Runs once at ${runAt}`,
          incomplete: false,
          known: true,
        };
      }
      const cron = text(trigger.cron);
      if (cron) {
        return {
          label: "On schedule",
          detail: `Cron: ${cron}`,
          incomplete: false,
          known: true,
        };
      }
      return {
        label: "On schedule",
        detail: "No date or cron set yet",
        incomplete: true,
        known: true,
      };
    }
    case "tag_added":
    case "tag_removed": {
      const tag = text(trigger.tag_name);
      const label =
        trigger.kind === "tag_added" ? "When tag is added" : "When tag is removed";
      return {
        label,
        detail: tag ? `Tag "${tag}"` : "No tag name set yet",
        incomplete: tag === "",
        known: true,
      };
    }
    default: {
      // An unknown kind is reported as unknown. Guessing a label here is how
      // a client ends up confidently describing the wrong entry condition.
      const kind = text(trigger.kind);
      return {
        label: "Unrecognised trigger",
        detail: kind
          ? `This build does not know the "${kind}" trigger. Open on desktop.`
          : "This build does not recognise the stored trigger.",
        incomplete: true,
        known: true,
      };
    }
  }
}

export interface GoalSummary {
  label: string;
  detail: string;
}

/**
 * Present the sequence goal. The caveat copy mirrors the desktop's
 * sequence-settings so both clients are honest in identical words: goals are
 * STORED, and only open/click are derivable in-repo today.
 */
export function goalSummary(
  goal: SequenceGoalWire | null | undefined,
): GoalSummary | null {
  if (!goal || typeof goal !== "object") return null;
  const exitNote = goal.exit_on_goal
    ? " Exit-on-goal is requested; the send loop lives outside this build, so further sends are not actually stopped here."
    : "";
  switch (goal.kind) {
    case "open":
      return {
        label: "Goal · opened any email",
        detail: `Met when the subscriber opens any email in this sequence.${exitNote}`,
      };
    case "click":
      return {
        label: "Goal · clicked any link",
        detail: `Met when the subscriber clicks any link in this sequence.${exitNote}`,
      };
    case "conversion":
      return {
        label: "Goal · conversion",
        detail: `Stored, but never evaluated in this build — no conversion event source is wired.${exitNote}`,
      };
    default:
      return {
        label: "Goal · unrecognised",
        detail: "This build does not recognise the stored goal kind.",
      };
  }
}

/** Present the stuck-participant threshold. 0/absent means detection is off. */
export function stuckThresholdSummary(days: number | undefined): string {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 1) {
    return "Stuck detection off";
  }
  const whole = Math.floor(days);
  return `Stuck after ${whole} ${whole === 1 ? "day" : "days"}`;
}

/**
 * Trigger configuration helpers — shared between SequenceTriggerCard
 * (rendering) and SequenceTriggerEditor (the picker). Kept separate
 * because both surfaces need the same labels / icons / summary logic
 * and we don't want either to import the other.
 */
import { type SequenceTrigger } from "../../lib/api-client";

/** Discriminator for the four entry-condition shapes. */
export type SequenceTriggerKind = SequenceTrigger["kind"];

interface TriggerKindMeta {
  kind: SequenceTriggerKind;
  /** Human-readable name shown in the picker. */
  label: string;
  /** Short one-liner under the label in the picker. */
  description: string;
  /** SVG path for the kind's icon (24x24 viewBox). */
  iconPath: string;
}

export const TRIGGER_KINDS: readonly TriggerKindMeta[] = [
  {
    kind: "list_subscribe",
    label: "When subscriber joins list",
    description: "Fires whenever a subscriber is added to the picked list.",
    // Inbox / list silhouette.
    iconPath:
      "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
  },
  {
    kind: "segment_match",
    label: "When subscriber matches segment",
    description:
      "Re-runs the segment on schedule and triggers for new matches.",
    // Filter / funnel.
    iconPath: "M22 3H2l8 9.46V19l4 2v-8.54L22 3z",
  },
  {
    kind: "custom_event",
    label: "On custom event",
    description: "Fires when your app emits a named event for the subscriber.",
    // Bolt / event signal.
    iconPath: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  },
  {
    kind: "schedule",
    label: "On schedule",
    description:
      "Runs at a specific time — one-shot or recurring cron expression.",
    // Calendar.
    iconPath:
      "M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zM16 2v4M8 2v4M3 10h18",
  },
  {
    kind: "tag_added",
    label: "When tag is added",
    description:
      "Fires after a tag is applied to a subscriber (eventually consistent).",
    // Tag.
    iconPath:
      "M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM7 7h.01",
  },
  {
    kind: "tag_removed",
    label: "When tag is removed",
    description:
      "Fires after a tag is stripped from a subscriber (eventually consistent).",
    // Tag with slash.
    iconPath: "M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82zM4 4l16 16",
  },
];

interface TriggerSummary {
  /** Headline shown on the card. */
  label: string;
  /** Sub-line under the headline — names the picked list / event / etc. */
  detail: string | null;
}

/**
 * Render-ready summary of a trigger's current state. Used by the
 * canvas card to show "When subscriber joins list · Welcome (id 4)"
 * without each call site re-implementing the kind→label switch.
 */
export function triggerSummary(
  trigger: SequenceTrigger | null,
): TriggerSummary {
  if (!trigger) {
    return {
      label: "No entry trigger",
      detail: null,
    };
  }
  switch (trigger.kind) {
    case "list_subscribe":
      return {
        label: "When subscriber joins list",
        detail:
          trigger.list_id != null && String(trigger.list_id).length > 0
            ? `List #${trigger.list_id}`
            : "Pick a list to finish setup",
      };
    case "segment_match":
      return {
        label: "When subscriber matches segment",
        detail: trigger.segment_id
          ? `Segment ${trigger.segment_id.slice(0, 8)}…`
          : "Pick a segment to finish setup",
      };
    case "custom_event":
      return {
        label: "On custom event",
        detail: trigger.event_name
          ? `Event "${trigger.event_name}"`
          : "Name the event to finish setup",
      };
    case "schedule":
      if (trigger.run_at) return { label: "On schedule", detail: `Runs once at ${trigger.run_at}` };
      if (trigger.cron) return { label: "On schedule", detail: `Cron: ${trigger.cron}` };
      return { label: "On schedule", detail: "Pick a date/time to finish setup" };
    case "tag_added":
      return {
        label: "When tag is added",
        detail: trigger.tag_name
          ? `Tag "${trigger.tag_name}"`
          : "Pick a tag name to finish setup",
      };
    case "tag_removed":
      return {
        label: "When tag is removed",
        detail: trigger.tag_name
          ? `Tag "${trigger.tag_name}"`
          : "Pick a tag name to finish setup",
      };
  }
}

/**
 * Validate a trigger draft before persisting. Returns null if OK, or
 * a short user-facing reason why it's not ready. Mirrors the
 * canPersistStep gate that prevents drag/drop from PATCHing half-
 * configured nodes.
 */
export function validateTrigger(trigger: SequenceTrigger): string | null {
  switch (trigger.kind) {
    case "list_subscribe":
      return trigger.list_id != null && String(trigger.list_id).length > 0
        ? null
        : "Pick a list before saving.";
    case "segment_match":
      return trigger.segment_id ? null : "Pick a segment before saving.";
    case "custom_event":
      return (trigger.event_name ?? "").trim().length > 0
        ? null
        : "Enter an event name before saving.";
    case "schedule":
      return (trigger.cron ?? "").trim().length > 0 ||
        (trigger.run_at ?? "").trim().length > 0
        ? null
        : "Pick a date/time or cron expression before saving.";
    case "tag_added":
    case "tag_removed":
      return (trigger.tag_name ?? "").trim().length > 0
        ? null
        : "Enter a tag name before saving.";
  }
}

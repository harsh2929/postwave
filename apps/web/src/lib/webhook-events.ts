// SPDX-License-Identifier: AGPL-3.0-only
//
// Human metadata + grouping for the outbound webhook event catalog. Keeps the
// create-webhook picker (SETA-037) readable: every event gets a one-line
// description, events group by their `prefix.*` namespace so a "Select all in
// group" is possible, and a filter narrows a 20-item list to what the user
// wants. Pure + dependency-free so it's unit-tested in node.

import { ALL_WEBHOOK_EVENTS, type WebhookEvent } from "@/lib/webhooks-api";

/** One-line, subscriber-facing explanation of what each event delivers. */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  "subscriber.created": "A subscriber was added to the workspace.",
  "subscriber.updated": "A subscriber's details or custom fields changed.",
  "subscriber.confirmed": "A subscriber confirmed via double opt-in.",
  "subscriber.unsubscribed": "A subscriber opted out of all mail.",
  "subscriber.bounced": "Mail to a subscriber hard-bounced.",
  "subscriber.complained": "A subscriber marked a message as spam.",
  "subscriber.deleted": "A subscriber record was deleted.",
  "subscriber.merged": "Two subscriber records were merged into one.",
  "subscriber.status_changed": "A subscriber's status changed.",
  "subscriber.consent_changed": "A subscriber's consent or topic opt-in changed.",
  "campaign.sent": "A campaign finished sending.",
  "campaign.opens.digest": "Periodic digest of campaign opens.",
  "campaign.clicks.digest": "Periodic digest of campaign clicks.",
  "automation.completed": "An automation or sequence run completed.",
  "migration.completed": "An import/migration finished successfully.",
  "migration.failed": "An import/migration failed.",
  "form.submitted": "A hosted form was submitted.",
  "form.confirmed": "A form submission was confirmed.",
  "sequence.generated": "An AI sequence draft was generated.",
  "sequence.participants.stuck":
    "Participants have been idling in a sequence past its stuck threshold.",
  "approval.requested": "An item was submitted for approval.",
};

/** The `prefix` of `prefix.rest` — the namespace an event groups under. */
export function webhookEventPrefix(event: string): string {
  const dot = event.indexOf(".");
  return dot === -1 ? event : event.slice(0, dot);
}

export interface WebhookEventGroup {
  prefix: string;
  events: WebhookEvent[];
}

/**
 * Group events by their `prefix.*` namespace, preserving first-seen order both
 * for the groups and the events within them.
 */
export function groupWebhookEvents(
  events: readonly WebhookEvent[] = ALL_WEBHOOK_EVENTS,
): WebhookEventGroup[] {
  const groups: WebhookEventGroup[] = [];
  const byPrefix = new Map<string, WebhookEventGroup>();
  for (const event of events) {
    const prefix = webhookEventPrefix(event);
    let group = byPrefix.get(prefix);
    if (!group) {
      group = { prefix, events: [] };
      byPrefix.set(prefix, group);
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups;
}

/**
 * Filter events by a free-text query, matching the event name OR its
 * description (case-insensitive). An empty/whitespace query returns all.
 */
export function filterWebhookEvents(
  query: string,
  events: readonly WebhookEvent[] = ALL_WEBHOOK_EVENTS,
): WebhookEvent[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...events];
  return events.filter((event) => {
    const desc = WEBHOOK_EVENT_DESCRIPTIONS[event] ?? "";
    return (
      event.toLowerCase().includes(q) || desc.toLowerCase().includes(q)
    );
  });
}

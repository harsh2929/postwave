import { isValidEventTopicFilter } from "@postwave/query-contract";

export const DEFAULT_EVENT_BUS_TOPICS = [
  "campaign.*",
  "subscriber.*",
  // The bell reads the server feed and re-syncs on this family
  // (lib/notification-feed-sync.ts). Declaring the subscription in
  // cache-invalidator.ts is not enough: the negotiated `?topics=` CSV is built
  // from THIS list, so a family absent here is never sent by the server.
  "notification.*",
  "approval.*",
  "audit.*",
  // list.* / sequence.* are negotiated so the shared bus can drive
  // event-bus cache invalidation (lib/cache-invalidator.ts) for those
  // families too. They carry no chatty/high-volume firehose, so adding
  // them to the default negotiation is cheap. If the backend does not yet
  // emit a family over the bus, nothing fires for it — no harm.
  "list.*",
  "sequence.*",
  "presence.*",
  "cursor.*",
  "selection.*",
];

export const CONCRETE_EVENT_BUS_TOPICS = [
  "presence.update",
  "campaign.created",
  "campaign.updated",
  "campaign.sent",
  "subscriber.added",
  "subscriber.removed",
  // SUB-096 — live open/click counter on the subscriber slideover.
  "subscriber.engagement_updated",
  "approval.requested",
  "approval.decided",
  "audit.created",
  // list.* / sequence.* concrete topics so the native EventSource attaches
  // exact-name listeners for them (named SSE events do NOT fall through to
  // onmessage). These drive event-bus cache invalidation
  // (lib/cache-invalidator.ts) for the lists + sequence/campaign caches.
  "list.create",
  "list.update",
  "list.delete",
  "sequence.generated",
  "cursor.move",
  "selection.move",
  // D03-tauri-shell#1 — the backend publishes these NAMED subscriber.* /
  // approval.* events over SSE, but a native EventSource only fires
  // addEventListener(name) for an EXACT name match (there is no onmessage
  // fallthrough for named events). Without an exact-name listener the
  // subscriber.* / approval.* WILDCARD subscribers (cache-invalidator,
  // CampaignActivityFeed) never see them, so a subscriber unsubscribing /
  // complaining / changing lifecycle stage — or an approval expiring /
  // escalating — silently missed live cache invalidation. All strings below
  // are verified bus-published (listmonk_events emitBus, lifecycle handlers,
  // approvals sweep + escalation). subscriber.bounced previously only worked
  // by accident via the OS-notifier's concrete subscription; listing it here
  // makes it explicit (attach is idempotent — deduped by topic name).
  "subscriber.opened",
  "subscriber.clicked",
  "subscriber.delivered",
  "subscriber.bounced",
  "subscriber.complained",
  "subscriber.unsubscribed",
  "subscriber.lifecycle_stage_changed",
  // EventSource delivers a NAMED event only to an exact-name listener, so a
  // concrete entry is required in addition to the wildcard above.
  "notification.created",
  "approval.expired",
  "approval.escalated",
];

const MAX_EVENT_BUS_TOPICS = 50;
const MAX_EVENT_BUS_TOPICS_CSV_CHARS = 1024;
// The topic grammar is NOT re-declared here — it lives in
// @postwave/query-contract (`isValidEventTopicFilter`, mirroring the gateway's
// streamTopicRE). The local copy that used to sit here omitted `_`, so this
// very file's `subscriber.lifecycle_stage_changed` entry (above) was silently
// discarded by the loop below before the CSV was built: desktop declared a
// subscription it never actually made, and nothing failed.

export function normalizeEventBusTopics(topics: string[]): string {
  const out: string[] = [];
  for (const raw of topics) {
    if (out.length >= MAX_EVENT_BUS_TOPICS) break;
    const topic = String(raw ?? "").trim();
    if (!topic || !isValidEventTopicFilter(topic)) continue;
    if (!out.includes(topic)) out.push(topic);
  }
  const csv = (out.length > 0 ? out : DEFAULT_EVENT_BUS_TOPICS).join(",");
  if (csv.length > MAX_EVENT_BUS_TOPICS_CSV_CHARS) {
    return DEFAULT_EVENT_BUS_TOPICS.join(",");
  }
  return csv;
}

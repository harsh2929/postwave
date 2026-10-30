/**
 * api/topics.ts — a subscriber's PREFERENCE CENTRE, on the phone.
 *
 *   GET  /api/v1/subscribers/{email}/topics                        read floor
 *   POST /api/v1/subscribers/{email}/topics/{topicId}/subscribe    write floor
 *   POST /api/v1/subscribers/{email}/topics/{topicId}/unsubscribe  write floor
 *
 * (apps/api/internal/server/engagement_preferences_webhooks.go:41,43,44 —
 * the read is ScopeReadSubscribers / viewer, the two writes are
 * ScopeWriteSubscribers / editor.)
 *
 * WHY THIS EXISTS AT ALL. Mobile's coverage table declared preference-centre
 * topics as covered — folded into the Settings screen — and no topic endpoint
 * was reachable anywhere in the app: no client, no hook, no card. That is the
 * one shape of gap worse than silence, because the table's whole purpose is to
 * be believed. The per-subscriber state is also the half that belongs on a
 * phone: it is a fact about a PERSON, which is where mobile already puts the
 * consent receipt and the suppression hold.
 *
 * NOT the topic CATALOG. Creating, renaming and deleting topics
 * (/api/v1/topics) sits behind ScopeAdmin and is workspace configuration —
 * desktop keeps it, exactly like the team roster does.
 *
 * The route keys on the EMAIL, not the subscriber id (the server lower-cases
 * it and matches citext), which is the same contract apps/web uses.
 *
 * Imports only ./request, so this module's request shaping is unit-testable
 * under node — see topics.test.ts.
 */
import { rawRequest, type AIApiResult } from "./request";

/**
 * One topic with this subscriber's state already applied.
 *
 * Flattened from the server's `{topic: {...}, optedIn}` envelope: every render
 * site wants one row, and leaving the nesting in place means every consumer
 * re-derives `row.topic.name ?? row.topic.slug` for itself.
 */
export interface SubscriberTopic {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** This subscriber's CURRENT state — already the default when never toggled. */
  optedIn: boolean;
  /** What a subscriber who never touched the preference centre gets. */
  defaultOptIn: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Defensive parse. A mis-shaped payload here would render a nameless row with
 * a switch on it — and flipping that switch would post to a topic id the
 * server never sent.
 */
export function normalizeSubscriberTopics(raw: unknown): SubscriberTopic[] {
  // The handler writes the slice directly (writeJSON of []SubscriberTopicView),
  // but tolerate an `items` envelope: a future paging change would otherwise
  // empty this card silently rather than loudly.
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { items?: unknown } | null)?.items)
      ? ((raw as { items: unknown[] }).items)
      : [];
  const out: SubscriberTopic[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const view = entry as { topic?: unknown; optedIn?: unknown };
    const topic = (view.topic ?? entry) as Record<string, unknown>;
    const id = str(topic.id);
    if (!id) continue;
    const slug = str(topic.slug);
    out.push({
      id,
      slug,
      // A topic with no name is addressed by its slug rather than by nothing;
      // "" would render a switch with no subject.
      name: str(topic.name) || slug || id,
      description: str(topic.description),
      optedIn: view.optedIn === true,
      defaultOptIn: topic.defaultOptIn === true,
    });
  }
  return out;
}

/** Built once so the queue, the test and the call site agree on the path. */
export function subscriberTopicsPath(email: string): string {
  return `/api/v1/subscribers/${encodeURIComponent(email)}/topics`;
}

export function subscriberTopicTogglePath(
  email: string,
  topicId: string,
  optedIn: boolean,
): string {
  return `${subscriberTopicsPath(email)}/${encodeURIComponent(topicId)}/${
    optedIn ? "subscribe" : "unsubscribe"
  }`;
}

export async function listSubscriberTopics(
  email: string,
): Promise<AIApiResult<SubscriberTopic[]>> {
  const res = await rawRequest<unknown>("GET", subscriberTopicsPath(email));
  if (res.error) return { data: null, error: res.error };
  return { data: normalizeSubscriberTopics(res.data), error: null };
}

/**
 * Set ONE topic, via the server's per-topic routes rather than the whole-array
 * PUT. The PUT replaces the submitted set, so sending a stale array — which is
 * what a phone holds after any other device changed a preference — would
 * silently revert topics the operator never touched.
 */
export async function setSubscriberTopic(
  email: string,
  topicId: string,
  optedIn: boolean,
): Promise<AIApiResult<{ ok?: boolean }>> {
  return rawRequest<{ ok?: boolean }>(
    "POST",
    subscriberTopicTogglePath(email, topicId, optedIn),
    {},
  );
}

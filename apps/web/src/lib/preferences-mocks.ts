// SPDX-License-Identifier: AGPL-3.0-only
//
// In-memory mock store for the preferences-api wrappers. Keeps the dashboard
// usable when the gateway is unreachable. State persists for the lifetime of
// the dev server process.

import type {
  CreateTopicInput,
  PreferenceLookupResponse,
  SubscriberTopicView,
  Topic,
  TopicOptIn,
  UpdateTopicInput,
} from "./preferences-api";

const NOW = () => new Date().toISOString();

const TOPICS: Topic[] = [
  {
    id: "tp_product",
    tenantId: "tenant_demo",
    slug: "product-updates",
    name: "Product updates",
    description: "Major releases, roadmap changes, breaking changes.",
    defaultOptIn: true,
    displayOrder: 0,
    createdAt: "2026-02-01T10:00:00Z",
    updatedAt: "2026-04-01T10:00:00Z",
  },
  {
    id: "tp_weekly",
    tenantId: "tenant_demo",
    slug: "weekly-digest",
    name: "Weekly digest",
    description: "A short Friday recap of what we shipped.",
    defaultOptIn: true,
    displayOrder: 1,
    createdAt: "2026-02-01T10:00:00Z",
    updatedAt: "2026-03-15T10:00:00Z",
  },
  {
    id: "tp_offers",
    tenantId: "tenant_demo",
    slug: "promotions",
    name: "Promotions & offers",
    description: "Occasional discount codes and bundle launches.",
    defaultOptIn: false,
    displayOrder: 2,
    createdAt: "2026-02-01T10:00:00Z",
    updatedAt: "2026-02-01T10:00:00Z",
  },
];

const SUBSCRIBER_TOPICS = new Map<string, Map<string, boolean>>();

function key(email: string): string {
  return email.toLowerCase();
}

export function mockListTopics(): Topic[] {
  return [...TOPICS].sort((a, b) => a.displayOrder - b.displayOrder);
}

export function mockCreateTopic(input: CreateTopicInput): Topic {
  const t: Topic = {
    id: `tp_${Date.now()}`,
    tenantId: "tenant_demo",
    slug: input.slug,
    name: input.name,
    description: input.description,
    defaultOptIn: input.defaultOptIn,
    displayOrder: input.displayOrder,
    createdAt: NOW(),
    updatedAt: NOW(),
  };
  TOPICS.push(t);
  return t;
}

export function mockUpdateTopic(id: string, patch: UpdateTopicInput): Topic {
  const idx = TOPICS.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error("not_found");
  const cur = TOPICS[idx];
  TOPICS[idx] = {
    ...cur,
    slug: patch.slug ?? cur.slug,
    name: patch.name ?? cur.name,
    description: patch.description ?? cur.description,
    defaultOptIn: patch.defaultOptIn ?? cur.defaultOptIn,
    displayOrder: patch.displayOrder ?? cur.displayOrder,
    updatedAt: NOW(),
  };
  return TOPICS[idx];
}

export function mockDeleteTopic(id: string): void {
  const idx = TOPICS.findIndex((t) => t.id === id);
  if (idx >= 0) TOPICS.splice(idx, 1);
}

export function mockListSubscriberTopics(email: string): SubscriberTopicView[] {
  const map = SUBSCRIBER_TOPICS.get(key(email));
  return mockListTopics().map((t) => ({
    topic: t,
    optedIn: map?.get(t.id) ?? t.defaultOptIn,
  }));
}

export function mockSetSubscriberTopics(
  email: string,
  items: TopicOptIn[],
): void {
  let map = SUBSCRIBER_TOPICS.get(key(email));
  if (!map) {
    map = new Map();
    SUBSCRIBER_TOPICS.set(key(email), map);
  }
  for (const it of items) {
    map.set(it.topicId, it.optedIn);
  }
}

export function mockPublicLookup(token: string): PreferenceLookupResponse {
  // Prefixes let the public browser matrix exercise privacy and empty states
  // without weakening the production token contract.
  const email = mockEmailFromToken(token);
  return {
    email,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    topics: token.startsWith("empty_")
      ? []
      : mockListSubscriberTopics(email).map(({ topic, optedIn }) => ({
          topic: {
            id: topic.id,
            slug: topic.slug,
            name: topic.name,
            description: topic.description,
            defaultOptIn: topic.defaultOptIn,
            displayOrder: topic.displayOrder,
          },
          optedIn,
        })),
    frequencyPreference: "default",
    gpc: token.startsWith("gpc_"),
    customization: {
      logo_url: "",
      primary_color: "#5B6CFF",
      footer_text: "You're receiving this because you subscribed.",
      show_postwave_badge: true,
    },
  };
}

export function mockPublicUpdate(token: string, items: TopicOptIn[]): void {
  const email = mockEmailFromToken(token);
  mockSetSubscriberTopics(email, items);
}

function mockEmailFromToken(token: string): string {
  for (const prefix of ["tok_", "gpc_", "empty_"]) {
    if (token.startsWith(prefix) && token.length > prefix.length) {
      return token.slice(prefix.length);
    }
  }
  return "demo@example.com";
}

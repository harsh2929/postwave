// SPDX-License-Identifier: AGPL-3.0-only
//
// In-memory subscriber fixtures. Loaded only when NEXT_PUBLIC_USE_MOCKS=1 so
// production subscriber API wrappers do not carry demo PII-shaped state.

import type {
  CreateSubscriberInput,
  Subscriber,
  SubscriberPage,
} from "./subscribers-api";

let mockSubscribers: Subscriber[] = [
  {
    id: "sub_demo_1",
    email: "maya@example.com",
    status: "enabled",
    consent_timestamp: "2026-04-15T12:00:00Z",
    consent_source: "import",
    custom_fields: { name: "Maya", plan: "founder" },
    tags: ["newsletter", "paid"],
    source_id: "demo-1",
    source_platform: "csv",
    created_at: "2026-04-15T12:00:00Z",
    updated_at: "2026-05-01T09:00:00Z",
  },
  {
    id: "sub_demo_2",
    email: "rio@example.com",
    status: "unconfirmed",
    consent_timestamp: null,
    consent_source: "double_optin",
    custom_fields: { name: "Rio" },
    tags: ["launch"],
    source_id: "demo-2",
    source_platform: "csv",
    created_at: "2026-04-28T16:20:00Z",
    updated_at: "2026-04-28T16:20:00Z",
  },
];

export function mockListSubscribers(page = 1, perPage = 50): SubscriberPage {
  return paginate(mockSubscribers, page, perPage);
}

export function mockSearchSubscribers(
  q: string,
  page = 1,
  perPage = 50,
): SubscriberPage {
  const needle = q.toLowerCase();
  return paginate(
    mockSubscribers.filter((subscriber) =>
      [
        subscriber.email,
        subscriber.status,
        subscriber.consent_source,
        subscriber.tags.join(" "),
        JSON.stringify(subscriber.custom_fields),
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    ),
    page,
    perPage,
  );
}

export function mockCreateSubscriber(
  input: CreateSubscriberInput,
): Subscriber {
  const now = new Date().toISOString();
  const subscriber: Subscriber = {
    id: `sub_demo_${mockSubscribers.length + 1}`,
    email: input.email,
    status: input.status ?? "enabled",
    consent_timestamp: input.consent_timestamp ?? now,
    consent_source: input.consent_source ?? "api",
    custom_fields: input.custom_fields ?? {},
    tags: input.tags ?? [],
    source_id: input.source_id,
    source_platform: input.source_platform,
    created_at: now,
    updated_at: now,
  };
  mockSubscribers = [
    subscriber,
    ...mockSubscribers.filter((s) => s.email !== subscriber.email),
  ];
  return subscriber;
}

export function mockSuppressSubscriber(id: string): void {
  mockSubscribers = mockSubscribers.map((subscriber) =>
    subscriber.id === id || subscriber.email === id
      ? { ...subscriber, status: "blocklisted" }
      : subscriber,
  );
}

export function mockUnsuppressSubscriber(id: string): Subscriber {
  let updated: Subscriber | undefined;
  mockSubscribers = mockSubscribers.map((subscriber) => {
    if (subscriber.id === id || subscriber.email === id) {
      updated = { ...subscriber, status: "enabled" };
      return updated;
    }
    return subscriber;
  });
  if (!updated) throw new Error("Subscriber not found.");
  return updated;
}

export function mockDeleteSubscriber(id: string): void {
  mockSubscribers = mockSubscribers.filter(
    (subscriber) => subscriber.id !== id && subscriber.email !== id,
  );
}

function paginate(
  items: Subscriber[],
  page: number,
  perPage: number,
): SubscriberPage {
  const start = (Math.max(1, page) - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    total: items.length,
    page,
    per_page: perPage,
  };
}

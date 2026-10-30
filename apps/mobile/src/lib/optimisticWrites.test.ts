import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  conversationReadTriad,
  membershipAddTriad,
  outboundWebhookEndpointsKey,
  smsConversationsKey,
  webhookActiveTriad,
  type SubscriberListMembership,
} from "./optimisticWrites";
import type { SmsConversationsPage } from "./smsConversation";
import { subscriberListsKey } from "./subscriberQueryKeys";

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
}

/** Let cancelQueries + onMutate settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const boom = async (): Promise<never> => {
  throw new Error("request failed");
};

/**
 * A mutationFn that stays in flight until `fail()` is called, so a test can
 * observe the projection BEFORE the rollback runs. A `boom` that throws
 * immediately would be rolled back within the same microtask queue.
 */
function pendingFailure() {
  let fail!: () => void;
  const promise = new Promise<never>((_resolve, reject) => {
    fail = () => reject(new Error("request failed"));
  });
  // Handled by the mutation machinery; keep node from flagging it early.
  void promise.catch(() => undefined);
  return { mutationFn: () => promise, fail };
}

/* ---- outbound webhooks: pause / resume ---- */

interface WebhookRow {
  id: string;
  active: boolean;
  url: string;
  consecutive_failures: number;
}

function webhookRows(): WebhookRow[] {
  return [
    { id: "w1", active: true, url: "https://a", consecutive_failures: 0 },
    { id: "w2", active: true, url: "https://b", consecutive_failures: 3 },
  ];
}

describe("webhookActiveTriad", () => {
  it("addresses the key the endpoint query actually uses", () => {
    // A projection aimed at the wrong key fails SILENTLY, so pin the shape.
    expect(outboundWebhookEndpointsKey("t1")).toEqual([
      "outbound-webhooks",
      "t1",
    ]);
    expect(outboundWebhookEndpointsKey(null)).toEqual([
      "outbound-webhooks",
      null,
    ]);
  });

  it("flips only the addressed endpoint, and holds when the PATCH succeeds", async () => {
    const qc = client();
    qc.setQueryData(outboundWebhookEndpointsKey("t1"), webhookRows());

    const observer = new MutationObserver(qc, {
      mutationFn: async () => undefined,
      ...webhookActiveTriad<WebhookRow>(qc, "t1"),
    });
    await observer.mutate({ id: "w2", active: false });

    const rows = qc.getQueryData<WebhookRow[]>(
      outboundWebhookEndpointsKey("t1"),
    );
    expect(rows?.[0]?.active).toBe(true);
    expect(rows?.[1]?.active).toBe(false);
    // The circuit-breaker counter is server-computed and must not be touched.
    expect(rows?.[1]?.consecutive_failures).toBe(3);
  });

  it("ROLLS BACK the switch when the PATCH fails", async () => {
    const qc = client();
    const before = webhookRows();
    qc.setQueryData(outboundWebhookEndpointsKey("t1"), before);

    const pending = pendingFailure();
    const observer = new MutationObserver(qc, {
      mutationFn: pending.mutationFn,
      ...webhookActiveTriad<WebhookRow>(qc, "t1"),
    });

    // Catch synchronously: the projection is asserted mid-flight, so the
    // rejection must already have a handler when the event loop turns.
    const settled = observer
      .mutate({ id: "w1", active: false })
      .catch((err: unknown) => err);
    await flush();
    // The switch has already moved while the PATCH is still open.
    expect(
      qc.getQueryData<WebhookRow[]>(outboundWebhookEndpointsKey("t1"))?.[0]
        ?.active,
    ).toBe(false);

    pending.fail();
    expect(await settled).toBeInstanceOf(Error);
    expect(qc.getQueryData(outboundWebhookEndpointsKey("t1"))).toEqual(before);
  });

  it("leaves an unloaded endpoint list alone rather than inventing one", async () => {
    const qc = client();
    const observer = new MutationObserver(qc, {
      mutationFn: async () => undefined,
      ...webhookActiveTriad<WebhookRow>(qc, "t1"),
    });
    await observer.mutate({ id: "w1", active: false });
    expect(qc.getQueryData(outboundWebhookEndpointsKey("t1"))).toBeUndefined();
  });
});

/* ---- SMS inbox: mark read ---- */

function page(unread: number): SmsConversationsPage {
  return {
    tenantId: "11111111-1111-4111-8111-111111111111",
    // The page now carries the identity of the query that produced it, so a
    // response for one filter can never be applied to another's view.
    query: { filter: "all", sort: "recent", status: "active" },
    conversations: [
      {
        phoneE164: "+15552340000",
        identityAmbiguous: false,
        lastMessagePreview: "hi",
        lastMessageAt: "2026-07-01T00:00:00Z",
        lastDirection: "inbound",
        messageCount: 4,
        unreadCount: unread,
        ...(unread > 0 ? { oldestUnreadAt: "2026-07-01T00:00:00Z" } : {}),
      },
      {
        phoneE164: "+15559999999",
        identityAmbiguous: false,
        lastMessagePreview: "yo",
        lastMessageAt: "2026-07-01T00:00:00Z",
        lastDirection: "inbound",
        messageCount: 1,
        unreadCount: 1,
        oldestUnreadAt: "2026-07-01T00:00:00Z",
      },
    ],
    snapshotAt: "2026-07-01T00:00:00Z",
    unreadTotal: unread > 0 ? 2 : 1,
    unknownTotal: 2,
    totalConversations: 2,
    activeTotal: 2,
    snoozedTotal: 0,
    archivedTotal: 0,
  };
}

describe("conversationReadTriad", () => {
  it("keys on the conversation-list PREFIX so every filter tab is corrected", async () => {
    expect(smsConversationsKey("t1")).toEqual(["sms-conversations", "t1"]);

    const qc = client();
    qc.setQueryData(["sms-conversations", "t1", "all"], page(2));
    qc.setQueryData(["sms-conversations", "t1", "unread"], page(2));

    const observer = new MutationObserver(qc, {
      mutationFn: async () => undefined,
      ...conversationReadTriad(qc, "t1"),
    });
    await observer.mutate("+15552340000");

    for (const filter of ["all", "unread"]) {
      const data = qc.getQueryData<SmsConversationsPage>([
        "sms-conversations",
        "t1",
        filter,
      ]);
      expect(data?.conversations[0]?.unreadCount).toBe(0);
      // The other thread's pip is untouched. unreadTotal counts unread
      // CONVERSATIONS, so clearing two messages still decrements it by one.
      expect(data?.conversations[1]?.unreadCount).toBe(1);
      expect(data?.unreadTotal).toBe(1);
    }
  });

  it("ROLLS BACK the pip when mark-read fails", async () => {
    const qc = client();
    const before = page(2);
    qc.setQueryData(["sms-conversations", "t1", "all"], before);

    const observer = new MutationObserver(qc, {
      mutationFn: boom,
      ...conversationReadTriad(qc, "t1"),
    });

    await expect(observer.mutate("+15552340000")).rejects.toThrow(
      "request failed",
    );
    expect(qc.getQueryData(["sms-conversations", "t1", "all"])).toEqual(before);
  });

  it("re-opening an already-read thread cannot double-decrement the total", async () => {
    const qc = client();
    qc.setQueryData(["sms-conversations", "t1", "all"], page(2));
    const observer = new MutationObserver(qc, {
      mutationFn: async () => undefined,
      ...conversationReadTriad(qc, "t1"),
    });

    await observer.mutate("+15552340000");
    await observer.mutate("+15552340000");

    expect(
      qc.getQueryData<SmsConversationsPage>(["sms-conversations", "t1", "all"])
        ?.unreadTotal,
    ).toBe(1);
  });
});

/* ---- subscriber list membership: add ---- */

describe("membershipAddTriad", () => {
  const rows = (): SubscriberListMembership[] => [
    { id: "10", name: "Newsletter" },
  ];

  it("appends the chosen list, named from the cached catalogue", async () => {
    const qc = client();
    qc.setQueryData(subscriberListsKey("t1", "s1"), rows());

    const observer = new MutationObserver(qc, {
      mutationFn: async () => undefined,
      ...membershipAddTriad(qc, "t1", (id) =>
        id === "20" ? "VIP customers" : id,
      ),
    });
    await observer.mutate({ id: "s1", listId: 20 });

    expect(qc.getQueryData(subscriberListsKey("t1", "s1"))).toEqual([
      { id: "10", name: "Newsletter" },
      { id: "20", name: "VIP customers" },
    ]);
  });

  it("is idempotent — re-adding an existing membership renders no duplicate", async () => {
    const qc = client();
    qc.setQueryData(subscriberListsKey("t1", "s1"), rows());
    const observer = new MutationObserver(qc, {
      mutationFn: async () => undefined,
      ...membershipAddTriad(qc, "t1", () => "Newsletter"),
    });

    await observer.mutate({ id: "s1", listId: "10" });

    expect(qc.getQueryData(subscriberListsKey("t1", "s1"))).toEqual(rows());
  });

  it("ROLLS BACK the appended row when the POST fails", async () => {
    const qc = client();
    qc.setQueryData(subscriberListsKey("t1", "s1"), rows());
    const pending = pendingFailure();
    const observer = new MutationObserver(qc, {
      mutationFn: pending.mutationFn,
      ...membershipAddTriad(qc, "t1", () => "VIP customers"),
    });

    const settled = observer
      .mutate({ id: "s1", listId: "20" })
      .catch((err: unknown) => err);
    await flush();
    // The chip is on screen while the POST is still open.
    expect(
      qc.getQueryData<SubscriberListMembership[]>(
        subscriberListsKey("t1", "s1"),
      ),
    ).toHaveLength(2);

    pending.fail();
    expect(await settled).toBeInstanceOf(Error);
    expect(qc.getQueryData(subscriberListsKey("t1", "s1"))).toEqual(rows());
  });

  it("projects the subscriber the write names, not some other row", async () => {
    const qc = client();
    qc.setQueryData(subscriberListsKey("t1", "s1"), rows());
    qc.setQueryData(subscriberListsKey("t1", "s2"), rows());

    const observer = new MutationObserver(qc, {
      mutationFn: async () => undefined,
      ...membershipAddTriad(qc, "t1", () => "VIP customers"),
    });
    await observer.mutate({ id: "s2", listId: "20" });

    expect(qc.getQueryData(subscriberListsKey("t1", "s1"))).toEqual(rows());
    expect(
      qc.getQueryData<SubscriberListMembership[]>(
        subscriberListsKey("t1", "s2"),
      ),
    ).toHaveLength(2);
  });
});

// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const access = vi.hoisted(() => ({ canAdmin: true }));
const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => access.canAdmin,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: toastMocks.error,
    success: toastMocks.success,
    info: vi.fn(),
  },
}));

vi.mock("../../components/webhooks/TriggersPanel", () => ({
  TriggersPanel: ({
    webhookId,
    sampleBody,
  }: {
    webhookId: string;
    sampleBody: string;
  }) => (
    <section aria-label="Inbound triggers">
      Triggers for {webhookId}
      <output aria-label="Trigger preview sample">{sampleBody}</output>
    </section>
  ),
}));

vi.mock("../../components/webhooks/WebhookHealthCard", () => ({
  WebhookHealthCard: ({ webhookId }: { webhookId: string }) => (
    <section aria-label="Webhook health">Health for {webhookId}</section>
  ),
}));

import { InboundWebhookDetailSlideover } from "../../components/InboundWebhookDetailSlideover";
import { OutboundWebhookDeliveriesSlideover } from "../../components/OutboundWebhookDeliveriesSlideover";
import * as apiClient from "../../lib/api-client";
import {
  api,
  type InboundWebhookEndpoint,
  type InboundWebhookEvent,
  type OutboundWebhook,
  type OutboundWebhookDelivery,
} from "../../lib/api-client";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  access.canAdmin = true;
  toastMocks.error.mockReset();
  toastMocks.success.mockReset();
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender: (next) => act(() => root?.render(next)),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => (element as HTMLElement | null)?.click());
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function buttonWithin(owner: Element, label: string): HTMLButtonElement {
  const match = Array.from(
    owner.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button in owner: ${label}`);
  return match;
}

function dispatchEscape(init: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
        ...init,
      }),
    );
  });
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

function endpoint(
  id = "inbound-1",
  name = "CRM product events",
): InboundWebhookEndpoint {
  return {
    id,
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: `${id}-slug`,
    name,
    enabled: true,
    createdAt: "2026-07-16T08:00:00.000Z",
  };
}

function inboundEvent(
  id: number,
  body = '{"type":"customer.created"}',
): InboundWebhookEvent {
  return {
    id,
    endpoint_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    headers: { "content-type": "application/json" },
    body,
    signature_valid: true,
    received_at: "2026-07-16T09:00:00.000Z",
  };
}

function subscription(
  id = "outbound-1",
  url = "https://receiver.example.test/webhooks",
): OutboundWebhook {
  return {
    id,
    tenant_id: "tenant-1",
    url,
    events: ["subscriber.added"],
    active: true,
    created_at: "2026-07-16T08:00:00.000Z",
    updated_at: "2026-07-16T08:00:00.000Z",
    config_version: 1,
    consecutive_failures: 1,
    signing_algorithm: "hmac_sha256",
    auth_config_status: "ready",
    url_status: "ready",
    delivery_policy_status: "ready",
  };
}

function delivery(
  id: string | number = 41,
  error = "receiver returned unavailable",
): OutboundWebhookDelivery {
  return {
    id: String(id),
    webhook_id: "outbound-1",
    event_type: "subscriber.added",
    attempt_count: 3,
    status: "exhausted",
    last_status_code: 503,
    last_error: error,
    created_at: "2026-07-16T09:00:00.000Z",
  };
}

describe("inbound webhook detail slideover", () => {
  it("fails closed for viewers before requesting retained inbound history", async () => {
    access.canAdmin = false;
    const history = vi
      .spyOn(api, "listInboundWebhookEvents")
      .mockRejectedValue(new Error("viewer history request escaped"));
    const replay = vi
      .spyOn(api, "replayInboundEvent")
      .mockRejectedValue(new Error("viewer replay request escaped"));
    const onClose = vi.fn();

    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={onClose}
        onRotate={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await flush();

    expect(document.body.textContent).toContain("Admin access required");
    expect(document.body.textContent).toContain(
      "No webhook history was requested",
    );
    expect(history).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Recent events");
    click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]'),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the decoded canonical signature states", async () => {
    vi.spyOn(api, "listInboundWebhookEvents").mockResolvedValue({
      data: {
        items: [
          {
            ...inboundEvent(1, '{"state":"verified"}'),
          },
          {
            ...inboundEvent(2, '{"state":"invalid"}'),
            signature_valid: false,
          },
        ],
        next_cursor: "",
      },
    });
    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={vi.fn()}
        onRotate={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await flush();

    expect(
      document.querySelectorAll(
        '[aria-label="Signature verification: Verified"]',
      ),
    ).toHaveLength(1);
    expect(
      document.querySelectorAll(
        '[aria-label="Signature verification: Invalid signature"]',
      ),
    ).toHaveLength(1);
    const invalidReplay = document.querySelector<HTMLButtonElement>(
      '[aria-label="Replay unavailable: invalid signature"]',
    );
    expect(invalidReplay?.disabled).toBe(true);
    expect(invalidReplay?.title).toContain(
      "failed signature verification cannot be replayed",
    );
    expect(
      document.querySelectorAll('button[aria-label="Replay event"]'),
    ).toHaveLength(1);
    expect(document.body.textContent).toContain("Processed payload");
    expect(document.body.textContent).toContain(
      "v2:<timestampByteLen>:<timestamp>:<eventIdByteLen>:<eventId>:<rawBody>",
    );
    expect(document.body.textContent).toContain(
      "Legacy raw-hex v1 is a compatibility opt-in only",
    );
    expect(document.body.textContent).not.toContain('timestamp + "." + raw');
  });

  it("seeds trigger preview from the newest verified event and masks invalid payloads until reveal", async () => {
    vi.spyOn(api, "listInboundWebhookEvents").mockResolvedValue({
      data: {
        items: [
          {
            ...inboundEvent(11, '{"untrusted":"must-stay-hidden"}'),
            signature_valid: false,
          },
          inboundEvent(12, '{"trusted":"preview-seed"}'),
        ],
        next_cursor: "",
      },
    });

    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={vi.fn()}
        onRotate={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await flush();

    expect(
      document.querySelector<HTMLOutputElement>(
        'output[aria-label="Trigger preview sample"]',
      )?.textContent,
    ).toBe('{"trusted":"preview-seed"}');
    expect(document.body.textContent).not.toContain("must-stay-hidden");
    const reveal = button("Reveal invalid payload");
    expect(reveal.getAttribute("aria-expanded")).toBe("false");

    click(reveal);
    expect(document.body.textContent).toContain("must-stay-hidden");
    expect(button("Hide invalid payload").getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("loads every retained-event cursor page with explicit retry and end states", async () => {
    const olderRequest =
      deferred<Awaited<ReturnType<typeof api.listInboundWebhookEvents>>>();
    const list = vi
      .spyOn(api, "listInboundWebhookEvents")
      .mockResolvedValueOnce({
        data: {
          items: [inboundEvent(101, '{"page":1}')],
          next_cursor: "older-event-page",
        },
      })
      .mockReturnValueOnce(olderRequest.promise)
      .mockResolvedValueOnce({
        data: {
          items: [inboundEvent(102, '{"page":2}')],
          next_cursor: "",
        },
      });
    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={vi.fn()}
        onRotate={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain(
      "Older retained events are available",
    );
    expect(list).toHaveBeenNthCalledWith(1, "inbound-1", { limit: 20 });

    click(button("Load older events"));
    const loadingMoreButton = button("Loading older events…");
    expect(loadingMoreButton.disabled).toBe(true);
    expect(
      loadingMoreButton.closest("section")?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(list).toHaveBeenNthCalledWith(2, "inbound-1", {
      cursor: "older-event-page",
      limit: 20,
    });

    await act(async () => {
      olderRequest.resolve({
        error: { message: "retention cursor unavailable" },
      });
      await Promise.resolve();
    });
    await flush();
    expect(document.body.textContent).toContain(
      "Couldn't load older events: retention cursor unavailable",
    );
    expect(document.body.textContent).toContain('{"page":1}');

    click(button("Retry loading older events"));
    await flush();
    expect(list).toHaveBeenNthCalledWith(3, "inbound-1", {
      cursor: "older-event-page",
      limit: 20,
    });
    expect(document.body.textContent).toContain('{"page":2}');
    expect(document.body.textContent).toContain(
      "All 2 available retained events are loaded",
    );
  });

  it("retains verified events when refresh fails contract validation", async () => {
    vi.spyOn(api, "listInboundWebhookEvents")
      .mockResolvedValueOnce({
        data: {
          items: [inboundEvent(111, '{"verified":"snapshot"}')],
          next_cursor: "",
        },
      })
      .mockResolvedValueOnce({
        error: {
          kind: "parse",
          code: "inbound_webhook_contract",
          message: "The event envelope was malformed.",
        },
      });
    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={vi.fn()}
        onRotate={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain('{"verified":"snapshot"}');

    click(button("Refresh events"));
    await flush();

    expect(document.body.textContent).toContain(
      "Previously verified events remain visible and may be stale.",
    );
    expect(document.body.textContent).toContain('{"verified":"snapshot"}');
    expect(document.body.textContent).not.toContain("No events received yet");
  });

  it("rejects duplicate IDs on the first retained-event page", async () => {
    vi.spyOn(api, "listInboundWebhookEvents").mockResolvedValue({
      data: {
        items: [
          inboundEvent(120, '{"duplicate":"first"}'),
          inboundEvent(120, '{"duplicate":"second"}'),
        ],
        next_cursor: "unsafe-next-page",
      },
    });
    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={vi.fn()}
        onRotate={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await flush();

    expect(document.querySelectorAll(".wh-inbound-event-row")).toHaveLength(0);
    expect(document.body.textContent).toContain("duplicate events in one page");
    expect(document.body.textContent).not.toContain('"duplicate":"first"');
    expect(document.body.textContent).not.toContain('"duplicate":"second"');
    expect(document.body.textContent).not.toContain("Load older events");
  });

  it("rejects a duplicate later page without partially appending it", async () => {
    const list = vi
      .spyOn(api, "listInboundWebhookEvents")
      .mockResolvedValueOnce({
        data: {
          items: [inboundEvent(121, '{"page":"first"}')],
          next_cursor: "event-cursor-a",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            inboundEvent(121, '{"page":"duplicate"}'),
            inboundEvent(122, '{"page":"older"}'),
          ],
          next_cursor: "",
        },
      });
    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={vi.fn()}
        onRotate={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await flush();

    click(button("Load older events"));
    await flush();

    expect(list).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll(".wh-inbound-event-row")).toHaveLength(1);
    expect(document.body.textContent).toContain(
      "event that was already loaded",
    );
    expect(document.body.textContent).not.toContain('{"page":"duplicate"}');
    expect(document.body.textContent).not.toContain('{"page":"older"}');
    expect(document.body.textContent).toContain(
      "History completeness is unknown",
    );
    expect(document.body.textContent).not.toContain(
      "All 1 available retained event is loaded",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) =>
          candidate.textContent?.trim() === "Load older events" ||
          candidate.textContent?.trim() === "Retry loading older events",
      ),
    ).toBe(false);
  });

  it("stops an A-to-B-to-A retained-event cursor cycle without appending the cycle page", async () => {
    const list = vi
      .spyOn(api, "listInboundWebhookEvents")
      .mockResolvedValueOnce({
        data: {
          items: [inboundEvent(131, '{"cycle":"first"}')],
          next_cursor: "event-cursor-a",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [inboundEvent(132, '{"cycle":"second"}')],
          next_cursor: "event-cursor-b",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [inboundEvent(133, '{"cycle":"must-not-append"}')],
          next_cursor: "event-cursor-a",
        },
      });
    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={vi.fn()}
        onRotate={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await flush();

    click(button("Load older events"));
    await flush();
    click(button("Load older events"));
    await flush();

    expect(list).toHaveBeenCalledTimes(3);
    expect(document.querySelectorAll(".wh-inbound-event-row")).toHaveLength(2);
    expect(document.body.textContent).toContain(
      "repeated an event-history cursor",
    );
    expect(document.body.textContent).not.toContain("must-not-append");
    expect(document.body.textContent).toContain('"cycle":"first"');
    expect(document.body.textContent).toContain('"cycle":"second"');
    expect(document.body.textContent).toContain(
      "History completeness is unknown",
    );
  });

  it("renders honest named data state and a cancel-first real-action replay", async () => {
    vi.spyOn(api, "listInboundWebhookEvents").mockResolvedValue({
      data: { items: [inboundEvent(201)], next_cursor: "" },
    });
    vi.spyOn(api, "replayInboundEvent")
      .mockRejectedValueOnce(new Error("trigger service unavailable"))
      .mockResolvedValueOnce({
        data: {
          ok: true,
          queued: true,
          replay_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          matches: [
            {
              trigger_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
              name: "Welcome sequence",
              subscriber_email: "reader@example.test",
              action_type: "add_to_sequence",
              action_target_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              queued: true,
              executed: false,
            },
          ],
        },
      });
    const onClose = vi.fn();
    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={onClose}
        onRotate={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );
    await flush();

    const slideover = document.querySelector<HTMLElement>(
      'aside[role="dialog"]',
    )!;
    expect(
      document.getElementById(slideover.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("CRM product events");
    expect(
      document.getElementById(slideover.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("Created");
    expect(slideover.textContent).toContain("customer.created");
    expect(document.activeElement?.textContent?.trim()).toBe("Copy URL");
    expect(
      seriousViolations(
        await axe.run(slideover, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);

    click(button("Replay event"));
    const replayDialog = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    )!;
    expect(replayDialog.textContent).toContain("Workers execute them later");
    expect(replayDialog.textContent).toContain("stored processed payload");
    expect((document.activeElement as HTMLElement).textContent?.trim()).toBe(
      "Cancel",
    );
    act(() => {
      const confirm = buttonWithin(replayDialog, "Replay event");
      confirm.click();
      confirm.click();
    });
    expect(api.replayInboundEvent).toHaveBeenCalledTimes(1);
    await flush();
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("trigger service unavailable"),
    );
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(slideover.hasAttribute("aria-busy")).toBe(false);

    click(
      buttonWithin(
        document.querySelector<HTMLElement>('[role="alertdialog"]')!,
        "Replay event",
      ),
    );
    await flush();
    expect(api.replayInboundEvent).toHaveBeenCalledTimes(2);
    const firstReplayOptions = vi.mocked(api.replayInboundEvent).mock
      .calls[0]?.[2];
    const retryReplayOptions = vi.mocked(api.replayInboundEvent).mock
      .calls[1]?.[2];
    expect(firstReplayOptions?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(retryReplayOptions?.idempotencyKey).toBe(
      firstReplayOptions?.idempotencyKey,
    );
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(slideover.inert).toBe(false);
    expect(toastMocks.success).toHaveBeenCalledWith(
      expect.stringContaining("awaiting execution"),
    );
    expect(toastMocks.success).not.toHaveBeenCalledWith(
      expect.stringContaining("fired"),
    );
  });

  it("locks every dismissal path during delete and cleans up after success", async () => {
    vi.spyOn(api, "listInboundWebhookEvents").mockResolvedValue({
      data: { items: [], next_cursor: "" },
    });
    const deletion =
      deferred<Awaited<ReturnType<typeof api.deleteInboundWebhook>>>();
    vi.spyOn(api, "deleteInboundWebhook").mockReturnValue(deletion.promise);
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    render(
      <InboundWebhookDetailSlideover
        endpoint={endpoint()}
        onClose={onClose}
        onRotate={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    await flush();
    click(button("Delete endpoint"));
    expect((document.activeElement as HTMLElement).textContent?.trim()).toBe(
      "Cancel",
    );
    const deleteDialog = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    )!;
    expect(deleteDialog.textContent).toContain("signing secrets are shredded");
    expect(deleteDialog.textContent).toContain("governed retention");
    act(() => {
      const confirm = buttonWithin(deleteDialog, "Delete endpoint");
      confirm.click();
      confirm.click();
    });
    expect(api.deleteInboundWebhook).toHaveBeenCalledTimes(1);
    const slideover = document.querySelector<HTMLElement>(
      'aside[role="dialog"]',
    )!;
    expect(slideover.getAttribute("aria-busy")).toBe("true");
    expect(
      document.querySelector<HTMLButtonElement>(".slideover-close")?.disabled,
    ).toBe(true);
    dispatchEscape();
    const backdrop = document.querySelector<HTMLElement>(".slideover-overlay")!;
    act(() => {
      backdrop.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    await act(async () => {
      deletion.resolve({ data: { ok: true } });
      await Promise.resolve();
    });
    await flush();
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("contains thrown loads, retries, and ignores a stale endpoint response", async () => {
    const first =
      deferred<Awaited<ReturnType<typeof api.listInboundWebhookEvents>>>();
    vi.spyOn(api, "listInboundWebhookEvents")
      .mockRejectedValueOnce(new Error("history gateway unavailable"))
      .mockResolvedValueOnce({
        data: { items: [inboundEvent(301)], next_cursor: "" },
      })
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        data: {
          items: [inboundEvent(302, "endpoint-b-body")],
          next_cursor: "",
        },
      });
    const props = {
      onClose: vi.fn(),
      onRotate: vi.fn(),
      onDeleted: vi.fn(),
    };
    const rendered = render(
      <InboundWebhookDetailSlideover endpoint={endpoint()} {...props} />,
    );
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "history gateway unavailable",
    );
    click(button("Retry loading events"));
    await flush();
    expect(document.body.textContent).toContain("customer.created");

    rendered.rerender(
      <InboundWebhookDetailSlideover
        endpoint={endpoint("inbound-a", "Endpoint A")}
        {...props}
      />,
    );
    expect(document.body.textContent).not.toContain("customer.created");
    expect(document.body.textContent).toContain("Loading recent events");
    rendered.rerender(
      <InboundWebhookDetailSlideover
        endpoint={endpoint("inbound-b", "Endpoint B")}
        {...props}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain("endpoint-b-body");
    await act(async () => {
      first.resolve({
        data: {
          items: [inboundEvent(303, "stale-a-body")],
          next_cursor: "",
        },
      });
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("stale-a-body");
  });
});

describe("outbound webhook deliveries slideover", () => {
  it("fails closed for viewers before requesting outbound delivery history", async () => {
    access.canAdmin = false;
    const history = vi
      .spyOn(apiClient, "listOutboundWebhookDeliveries")
      .mockRejectedValue(new Error("viewer delivery request escaped"));
    const replay = vi
      .spyOn(apiClient, "replayOutboundWebhookDelivery")
      .mockRejectedValue(new Error("viewer replay request escaped"));
    const onClose = vi.fn();

    render(
      <OutboundWebhookDeliveriesSlideover
        subscription={subscription()}
        onClose={onClose}
        onRetried={vi.fn()}
      />,
    );
    await flush();

    expect(document.body.textContent).toContain("Admin access required");
    expect(document.body.textContent).toContain(
      "No delivery history was requested",
    );
    expect(history).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("receiver.example.test");
    click(
      document.querySelector<HTMLButtonElement>('button[aria-label="Close"]'),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate delivery IDs on the first page", async () => {
    vi.spyOn(apiClient, "listOutboundWebhookDeliveries").mockResolvedValue({
      data: {
        deliveries: [
          delivery("duplicate-delivery", "first result"),
          delivery("duplicate-delivery", "second result"),
        ],
        next_cursor: "unsafe-next-page",
      },
    });

    render(
      <OutboundWebhookDeliveriesSlideover
        subscription={subscription()}
        onClose={vi.fn()}
        onRetried={vi.fn()}
      />,
    );
    await flush();

    expect(document.body.textContent).toContain(
      "duplicate deliveries in one page",
    );
    expect(document.querySelectorAll(".wh-delivery-row")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("first result");
    expect(document.body.textContent).not.toContain("second result");
  });

  it("stops an A-to-B-to-A delivery cursor cycle without appending the cycle page", async () => {
    const list = vi
      .spyOn(apiClient, "listOutboundWebhookDeliveries")
      .mockResolvedValueOnce({
        data: {
          deliveries: [delivery("delivery-1", "first result")],
          next_cursor: "delivery-cursor-a",
        },
      })
      .mockResolvedValueOnce({
        data: {
          deliveries: [delivery("delivery-2", "second result")],
          next_cursor: "delivery-cursor-b",
        },
      })
      .mockResolvedValueOnce({
        data: {
          deliveries: [delivery("delivery-3", "must-not-append")],
          next_cursor: "delivery-cursor-a",
        },
      });

    render(
      <OutboundWebhookDeliveriesSlideover
        subscription={subscription()}
        onClose={vi.fn()}
        onRetried={vi.fn()}
      />,
    );
    await flush();

    click(button("Load older deliveries"));
    await flush();
    click(button("Load older deliveries"));
    await flush();

    expect(list).toHaveBeenCalledTimes(3);
    expect(document.querySelectorAll(".wh-delivery-row")).toHaveLength(2);
    expect(document.body.textContent).toContain(
      "repeated a delivery-history cursor",
    );
    expect(document.body.textContent).not.toContain("must-not-append");
    expect(document.body.textContent).toContain("first result");
    expect(document.body.textContent).toContain("second result");
    expect(document.body.textContent).toContain(
      "History completeness is unknown",
    );
    expect(document.body.textContent).not.toContain(
      "All available deliveries are loaded",
    );
  });

  it("recovers load state, keeps nested verification topmost, and passes axe", async () => {
    vi.spyOn(apiClient, "listOutboundWebhookDeliveries")
      .mockRejectedValueOnce(new Error("delivery history unavailable"))
      .mockResolvedValue({
        data: { deliveries: [delivery()], next_cursor: "" },
      });
    render(
      <OutboundWebhookDeliveriesSlideover
        subscription={subscription()}
        onClose={vi.fn()}
        onRetried={vi.fn()}
      />,
    );
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "delivery history unavailable",
    );
    click(button("Retry loading deliveries"));
    await flush();
    const slideover = document.querySelector<HTMLElement>(
      'aside[role="dialog"]',
    )!;
    expect(
      document.getElementById(slideover.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Recent deliveries");
    expect(slideover.textContent).toContain("receiver returned unavailable");
    expect(document.querySelectorAll("[title]").length).toBe(0);
    expect(
      seriousViolations(
        await axe.run(slideover, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);

    click(button("Show verification snippet"));
    expect(
      document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
    ).toHaveLength(2);
    dispatchEscape({ isComposing: true });
    dispatchEscape({ keyCode: 229 });
    expect(document.body.textContent).toContain("Verify webhook signature");
    dispatchEscape();
    await flush();
    expect(document.body.textContent).not.toContain("Verify webhook signature");
    expect(document.querySelector('aside[role="dialog"]')).not.toBeNull();
  });

  it("gives retry one same-tick owner, locks dismissal, and recovers from throws", async () => {
    vi.spyOn(apiClient, "listOutboundWebhookDeliveries").mockResolvedValue({
      data: { deliveries: [delivery()], next_cursor: "" },
    });
    const retryRequest =
      deferred<
        Awaited<ReturnType<typeof apiClient.replayOutboundWebhookDelivery>>
      >();
    vi.spyOn(apiClient, "replayOutboundWebhookDelivery")
      .mockReturnValueOnce(retryRequest.promise)
      .mockResolvedValueOnce({
        data: {
          delivery_id: "delivery-replay-2",
          replayed_from: "41",
          status: "pending",
          replayed_at: "2026-07-16T10:00:00.000Z",
        },
      });
    const onClose = vi.fn();
    const onRetried = vi.fn();
    render(
      <OutboundWebhookDeliveriesSlideover
        subscription={subscription()}
        onClose={onClose}
        onRetried={onRetried}
      />,
    );
    await flush();
    click(button("Replay"));
    const retry = button("Replay delivery");
    act(() => {
      retry.click();
      retry.click();
    });
    expect(apiClient.replayOutboundWebhookDelivery).toHaveBeenCalledTimes(1);
    const slideover = document.querySelector<HTMLElement>(
      'aside[role="dialog"]',
    )!;
    expect(slideover.getAttribute("aria-busy")).toBe("true");
    dispatchEscape();
    act(() => {
      document
        .querySelector<HTMLElement>(".slideover-overlay")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      retryRequest.reject(new Error("outbox connection failed"));
      await Promise.resolve();
    });
    await flush();
    expect(toastMocks.error).toHaveBeenCalledWith(
      expect.stringContaining("outbox connection failed"),
    );
    expect(slideover.hasAttribute("aria-busy")).toBe(false);
    expect(button("Replay delivery").disabled).toBe(false);

    click(button("Replay delivery"));
    await flush();
    expect(apiClient.replayOutboundWebhookDelivery).toHaveBeenCalledTimes(2);
    const firstReplayOptions = vi.mocked(
      apiClient.replayOutboundWebhookDelivery,
    ).mock.calls[0]?.[1];
    const secondReplayOptions = vi.mocked(
      apiClient.replayOutboundWebhookDelivery,
    ).mock.calls[1]?.[1];
    expect(firstReplayOptions?.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(secondReplayOptions?.idempotencyKey).toBe(
      firstReplayOptions?.idempotencyKey,
    );
    expect(onRetried).toHaveBeenCalledTimes(1);
  });

  it("retains verified rows when replay-triggered refresh fails and explains replay identity", async () => {
    vi.spyOn(apiClient, "listOutboundWebhookDeliveries")
      .mockResolvedValueOnce({
        data: {
          deliveries: [delivery("verified-delivery", "verified outcome")],
          next_cursor: "",
        },
      })
      .mockRejectedValueOnce(new Error("refresh transport unavailable"));
    vi.spyOn(apiClient, "replayOutboundWebhookDelivery").mockResolvedValue({
      data: {
        delivery_id: "new-delivery-id",
        replayed_from: "verified-delivery",
        status: "pending",
        replayed_at: "2026-07-16T10:00:00.000Z",
      },
    });

    render(
      <OutboundWebhookDeliveriesSlideover
        subscription={subscription()}
        onClose={vi.fn()}
        onRetried={vi.fn()}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain("verified outcome");

    click(button("Replay"));
    const replayDialog = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    )!;
    expect(replayDialog.textContent).toContain("new delivery ID");
    expect(replayDialog.textContent).toContain("same event identity metadata");
    expect(replayDialog.textContent).toContain(
      "signature authenticates the body only",
    );
    expect(replayDialog.textContent).toContain(
      "only an identity retained inside that signed body",
    );
    expect(replayDialog.textContent).toContain("side effects may repeat");
    expect(replayDialog.textContent).not.toContain("deduplicates delivery IDs");
    click(buttonWithin(replayDialog, "Replay delivery"));
    await flush();

    expect(document.body.textContent).toContain("verified outcome");
    expect(document.body.textContent).toContain(
      "Previously verified deliveries remain visible and may be stale",
    );
  });

  it("ignores late delivery data after the selected subscription changes", async () => {
    const first =
      deferred<
        Awaited<ReturnType<typeof apiClient.listOutboundWebhookDeliveries>>
      >();
    vi.spyOn(apiClient, "listOutboundWebhookDeliveries")
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        data: {
          deliveries: [delivery(52, "current-subscription-error")],
          next_cursor: "",
        },
      });
    const props = { onClose: vi.fn(), onRetried: vi.fn() };
    const rendered = render(
      <OutboundWebhookDeliveriesSlideover
        subscription={subscription("outbound-a", "https://a.example.test")}
        {...props}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain("Loading delivery history");
    rendered.rerender(
      <OutboundWebhookDeliveriesSlideover
        subscription={subscription("outbound-b", "https://b.example.test")}
        {...props}
      />,
    );
    expect(document.body.textContent).not.toContain("stale-subscription-error");
    expect(document.body.textContent).toContain("Loading delivery history");
    await flush();
    expect(document.body.textContent).toContain("current-subscription-error");
    await act(async () => {
      first.resolve({
        data: {
          deliveries: [delivery(51, "stale-subscription-error")],
          next_cursor: "",
        },
      });
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("stale-subscription-error");
  });

  it("loads older delivery pages with the exact server cursor", async () => {
    const olderRequest =
      deferred<
        Awaited<ReturnType<typeof apiClient.listOutboundWebhookDeliveries>>
      >();
    const list = vi
      .spyOn(apiClient, "listOutboundWebhookDeliveries")
      .mockResolvedValueOnce({
        data: {
          deliveries: [delivery("newest", "newest-result")],
          next_cursor: "opaque-older-page",
        },
      })
      .mockReturnValueOnce(olderRequest.promise);

    render(
      <OutboundWebhookDeliveriesSlideover
        subscription={subscription()}
        onClose={vi.fn()}
        onRetried={vi.fn()}
      />,
    );
    await flush();
    expect(document.body.textContent).toContain("newest-result");

    click(button("Load older deliveries"));
    const loadingMoreButton = button("Loading older…");
    expect(
      loadingMoreButton.closest("section")?.getAttribute("aria-busy"),
    ).toBe("true");

    expect(list).toHaveBeenNthCalledWith(
      2,
      "outbound-1",
      50,
      expect.objectContaining({ cursor: "opaque-older-page" }),
    );
    await act(async () => {
      olderRequest.resolve({
        data: {
          deliveries: [delivery("older", "older-result")],
          next_cursor: "",
        },
      });
      await Promise.resolve();
    });
    await flush();
    expect(document.body.textContent).toContain("older-result");
    expect(document.body.textContent).toContain(
      "All available deliveries are loaded.",
    );
  });
});

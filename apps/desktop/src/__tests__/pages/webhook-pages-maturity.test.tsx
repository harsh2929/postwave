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

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  listInbound: vi.fn(),
  createInbound: vi.fn(),
  rotateInbound: vi.fn(),
  updateInbound: vi.fn(),
  previewInbound: vi.fn(),
  listOutbound: vi.fn(),
  testOutbound: vi.fn(),
  rotateOutbound: vi.fn(),
  setEnvironment: vi.fn(),
  reEnable: vi.fn(),
  disable: vi.fn(),
  remove: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  receiverCreated: null as null | Record<string, unknown>,
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => "https://api.postwave.test",
  OUTBOUND_WEBHOOK_EVENTS: [
    "campaign.sent",
    "subscriber.added",
    "subscriber.removed",
    "subscriber.unsubscribed",
    "approval.requested",
    "approval.decided",
    "audit.created",
    "bounce.received",
    "list.subscriber.added",
  ],
  OUTBOUND_WEBHOOK_SIGNING_ALGORITHMS: ["hmac_sha256", "ecdsa_p256", "ed25519"],
  listOutboundWebhooks: mocks.listOutbound,
  testOutboundWebhook: mocks.testOutbound,
  reEnableOutboundWebhook: mocks.reEnable,
  deleteOutboundWebhook: mocks.remove,
  rotateOutboundWebhookSigningMaterial: mocks.rotateOutbound,
  updateInboundWebhookEndpoint: mocks.updateInbound,
  previewInboundWebhookTransform: mocks.previewInbound,
  api: {
    listInboundWebhooks: mocks.listInbound,
    createInboundWebhook: mocks.createInbound,
    rotateInboundWebhook: mocks.rotateInbound,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

vi.mock("../../components/InboundWebhookDetailSlideover", () => ({
  InboundWebhookDetailSlideover: () => <div>Inbound details</div>,
}));

vi.mock("../../components/OutboundWebhookDeliveriesSlideover", () => ({
  OutboundWebhookDeliveriesSlideover: () => <div>Outbound deliveries</div>,
}));

vi.mock("../../components/webhooks/WebhookHealthCard", () => ({
  WebhookHealthCard: () => <div>Health available</div>,
}));

vi.mock("../../components/webhooks/WebhookOnboardingGallery", () => ({
  WebhookOnboardingGallery: () => <div>Webhook onboarding</div>,
}));

vi.mock("../../components/webhooks/OutboundWebhookEditDialog", () => ({
  OutboundWebhookEditDialog: () => null,
}));

vi.mock("../../components/webhooks/ReceiverPresetDialog", () => ({
  RECEIVER_PRESETS: {
    "Your own server": { name: "Your own server" },
  },
  ReceiverPresetDialog: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated: (created: Record<string, unknown>) => void;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() => {
          if (mocks.receiverCreated) onCreated(mocks.receiverCreated);
        }}
      >
        Complete mock destination creation
      </button>
    ) : null,
}));

vi.mock("../../lib/heroAssets", () => ({
  HERO: {
    inboundWebhooks: "inbound.png",
    outboundWebhooks: "outbound.png",
  },
}));

import { InboundWebhooks } from "../../pages/InboundWebhooks";
import { OutboundWebhooks } from "../../pages/OutboundWebhooks";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.listInbound.mockResolvedValue({
    data: { items: [inboundEndpoint()], next_cursor: "" },
  });
  mocks.receiverCreated = null;
  mocks.listOutbound.mockResolvedValue({
    data: { webhooks: [outboundWebhook()], next_cursor: "" },
  });
  mocks.createInbound.mockResolvedValue({
    data: {
      endpoint: inboundEndpoint(),
      secret: "inbound-secret-once",
    },
  });
  mocks.rotateInbound.mockResolvedValue({
    data: {
      endpoint: inboundEndpoint(),
      secret: "rotated-secret-once",
    },
  });
  mocks.updateInbound.mockImplementation(
    async (_id: string, patch: Record<string, unknown>) => ({
      data: { ...inboundEndpoint(), ...patch },
    }),
  );
  mocks.previewInbound.mockResolvedValue({
    data: { body: { email: "ada@example.com" } },
  });
  mocks.testOutbound.mockResolvedValue({
    data: {
      webhook_id: "outbound-1",
      status_code: 202,
      signed: true,
      signature: "t=1,v1=safe",
      response: "accepted",
      filtered: false,
    },
  });
  mocks.rotateOutbound.mockResolvedValue({
    data: createdWebhookMaterial("hmac_sha256"),
  });
  mocks.setEnvironment.mockResolvedValue({ data: {} });
  mocks.reEnable.mockResolvedValue({ data: {} });
  mocks.disable.mockResolvedValue({ data: {} });
  mocks.remove.mockResolvedValue({
    data: { ok: true, deleted: true, deactivated: false },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  resetLifecycleCoordinatorForTests();
});

function inboundEndpoint() {
  return {
    id: "inbound-1",
    tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "stripe-events-abc123",
    name: "Stripe checkout",
    enabled: true,
    createdAt: "2026-07-16T08:00:00.000Z",
  };
}

function outboundWebhook(
  id = "outbound-1",
  url = "https://hooks.example.com/postwave",
) {
  return {
    id,
    tenant_id: "tenant-1",
    url,
    description: "Customer receiver",
    events: ["subscriber.added"],
    active: true,
    created_at: "2026-07-16T08:00:00.000Z",
    updated_at: "2026-07-16T08:00:00.000Z",
    last_succeeded_at: "2026-07-16T08:30:00.000Z",
    consecutive_failures: 0,
    signing_algorithm: "hmac_sha256",
    auth_config_status: "ready",
    url_status: "ready",
    delivery_policy_status: "ready",
  };
}

function createdWebhookMaterial(
  algorithm: "hmac_sha256" | "ecdsa_p256",
): Record<string, unknown> {
  return {
    webhook: {
      ...outboundWebhook(),
      signing_algorithm: algorithm,
      ...(algorithm === "ecdsa_p256"
        ? { signing_public_key: "PUBLIC KEY FOR RECEIVER" }
        : {}),
    },
    ...(algorithm === "hmac_sha256"
      ? { signing_secret: "owhsec_shown_once" }
      : { public_key_pem: "PUBLIC KEY FOR RECEIVER" }),
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (caught) {
      failure = caught;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw failure;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setTextarea(input: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("webhook page maturity", () => {
  it("keeps inbound creation discoverable, single-flight, and one-time-secret explicit", async () => {
    render(<InboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Stripe checkout");
      expect(document.body.textContent).toContain(
        "https://api.postwave.test/api/public/inbound/stripe-events-abc123",
      );
    });
    expect(document.querySelector("[title]")).toBeNull();

    act(() => button("New endpoint").click());
    const create = button("Create endpoint");
    expect(create.disabled).toBe(false);
    expect(create.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Enter a label before creating the endpoint",
    );
    const label = document.querySelector<HTMLInputElement>("#iwh-label");
    if (!label) throw new Error("Missing inbound label input");
    setInput(label, "Billing events");
    const enabledCreate = button("Create endpoint");
    act(() => {
      enabledCreate.click();
      enabledCreate.click();
    });
    await waitFor(() => {
      expect(mocks.createInbound).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("inbound-secret-once");
    });
    expect(mocks.createInbound).toHaveBeenCalledWith(
      { label: "Billing events" },
      { idempotencyKey: expect.any(String) },
    );
    expect(document.body.textContent).toContain(
      "encrypted at rest and write-only in operator surfaces",
    );
    expect(document.body.textContent).not.toContain("We hash it at rest");
    expect(
      button("I've stored it securely").getAttribute("aria-disabled"),
    ).toBe("true");
    expect(document.body.textContent).toContain("cannot be shown again");
    expect(document.body.textContent).toContain(
      "v2:<timestampByteLen>:<timestamp>:<eventIdByteLen>:<eventId>:<rawBody>",
    );
    expect(document.body.textContent).toContain(
      "Legacy raw-hex v1 is an explicit compatibility opt-in only",
    );
  });

  it("explains the exact bounded grace period before rotating an inbound secret", async () => {
    render(<InboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Stripe checkout");
    });

    act(() => button("Rotate").click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "new secret becomes primary immediately",
    );
    expect(dialog?.textContent).toContain(
      "previous secret remains accepted for a bounded 24-hour grace period",
    );
    expect(dialog?.textContent).toContain(
      "after which the old secret is rejected",
    );
    expect(dialog?.textContent).not.toContain(
      "will fail until they're updated",
    );
  });

  it("reuses one rotation identity after an ambiguous inbound response loss", async () => {
    mocks.rotateInbound
      .mockReset()
      .mockResolvedValueOnce({
        error: {
          kind: "network",
          code: "network_error",
          message: "The response was lost.",
        },
      })
      .mockResolvedValueOnce({
        data: {
          endpoint: inboundEndpoint(),
          secret: "rotated-secret-once",
        },
      });
    render(<InboundWebhooks />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Stripe checkout"),
    );

    act(() => button("Rotate").click());
    act(() => button("Rotate secret").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("The response was lost."),
    );
    const firstKey = mocks.rotateInbound.mock.calls[0]?.[1]?.idempotencyKey;
    expect(firstKey).toEqual(expect.any(String));

    act(() => button("Rotate secret").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("rotated-secret-once"),
    );
    expect(mocks.rotateInbound.mock.calls[1]?.[1]?.idempotencyKey).toBe(
      firstKey,
    );
  });

  it("loads every inbound endpoint cursor page with visible loading, retry, and end states", async () => {
    let resolveMore!: (value: { error: { message: string } }) => void;
    const inFlight = new Promise<{ error: { message: string } }>((resolve) => {
      resolveMore = resolve;
    });
    mocks.listInbound
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          items: [inboundEndpoint()],
          next_cursor: "endpoint-page-2",
        },
      })
      .mockReturnValueOnce(inFlight)
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              ...inboundEndpoint(),
              id: "inbound-2",
              slug: "billing-events-def456",
              name: "Billing lifecycle",
            },
          ],
          next_cursor: "",
        },
      });

    render(<InboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Stripe checkout");
      expect(document.body.textContent).toContain(
        "More endpoint records are available",
      );
    });
    expect(mocks.listInbound).toHaveBeenNthCalledWith(1, { limit: 50 });

    act(() => button("Load more endpoints").click());
    expect(button("Loading more endpoints…").disabled).toBe(true);
    expect(mocks.listInbound).toHaveBeenNthCalledWith(2, {
      cursor: "endpoint-page-2",
      limit: 50,
    });

    await act(async () => {
      resolveMore({ error: { message: "cursor gateway unavailable" } });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Couldn't load more endpoints: cursor gateway unavailable",
      );
    });

    act(() => button("Retry loading more").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Billing lifecycle");
      expect(document.body.textContent).toContain(
        "All available endpoint records are loaded",
      );
    });
    expect(mocks.listInbound).toHaveBeenNthCalledWith(3, {
      cursor: "endpoint-page-2",
      limit: 50,
    });
  });

  it("rejects duplicate inbound endpoint rows on the first page", async () => {
    mocks.listInbound.mockReset().mockResolvedValueOnce({
      data: {
        items: [inboundEndpoint(), inboundEndpoint()],
        next_cursor: "",
      },
    });

    render(<InboundWebhooks />);

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "repeated an inbound endpoint inside the first page",
      ),
    );
    expect(document.body.textContent).not.toContain("2 endpoints");
  });

  it("stops inbound endpoint pagination atomically on an A-to-B-to-A cursor cycle", async () => {
    mocks.listInbound
      .mockReset()
      .mockResolvedValueOnce({
        data: { items: [inboundEndpoint()], next_cursor: "page-a" },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              ...inboundEndpoint(),
              id: "inbound-2",
              slug: "billing-events-def456",
              name: "Billing lifecycle",
            },
          ],
          next_cursor: "page-b",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              ...inboundEndpoint(),
              id: "inbound-3",
              slug: "support-events-ghi789",
              name: "Support lifecycle",
            },
          ],
          next_cursor: "page-a",
        },
      });

    render(<InboundWebhooks />);
    await waitFor(() => expect(button("Load more endpoints")).toBeTruthy());
    act(() => button("Load more endpoints").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Billing lifecycle"),
    );
    act(() => button("Load more endpoints").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "repeated an inbound-endpoint pagination cursor",
      ),
    );

    expect(document.body.textContent).toContain("Stripe checkout");
    expect(document.body.textContent).toContain("Billing lifecycle");
    expect(document.body.textContent).not.toContain("Support lifecycle");
    expect(document.body.textContent).toContain("completeness is unknown");
  });

  it("debounces inbound search into the server query contract", async () => {
    render(<InboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Stripe checkout");
    });
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search label or slug…"]',
    );
    if (!search) throw new Error("Missing inbound endpoint search");

    setInput(search, "stripe");
    expect(document.body.textContent).toContain("Searching server");
    expect(mocks.listInbound).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 275));
    });
    await waitFor(() => {
      expect(mocks.listInbound).toHaveBeenLastCalledWith({
        limit: 50,
        query: "stripe",
      });
    });
    expect(document.body.textContent).toContain(
      "matching endpoint loaded from the server",
    );
    expect(document.body.textContent).not.toContain(
      "Search currently covers the loaded records",
    );
  });

  it("retains the last verified inbound catalog when refresh fails", async () => {
    mocks.listInbound
      .mockReset()
      .mockResolvedValueOnce({
        data: { items: [inboundEndpoint()], next_cursor: "" },
      })
      .mockResolvedValueOnce({
        error: {
          kind: "parse",
          code: "inbound_webhook_contract",
          message: "The endpoint envelope was malformed.",
        },
      });
    render(<InboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Stripe checkout");
    });

    act(() => button("Refresh").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Previously loaded endpoint data remains visible and may be stale.",
      );
    });

    expect(document.body.textContent).toContain("Stripe checkout");
    expect(document.body.textContent).not.toContain(
      "Couldn't load inbound endpoints",
    );
  });

  it("does not present an inbound contract failure as an empty catalog", async () => {
    mocks.listInbound.mockResolvedValueOnce({
      error: {
        kind: "parse",
        code: "inbound_webhook_contract",
        message:
          "Moosewave returned malformed inbound webhook data. No malformed rows were discarded or treated as empty.",
      },
    });
    render(<InboundWebhooks />);

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "No malformed rows were discarded or treated as empty.",
      );
    });

    expect(document.body.textContent).toContain(
      "Couldn't load inbound endpoints",
    );
    expect(document.body.textContent).not.toContain(
      "Listen for what your other tools are saying.",
    );
    expect(document.body.textContent).not.toContain("0 loaded endpoints");
  });

  it("administers inbound endpoint identity, jq preview, and reversible availability", async () => {
    render(<InboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Stripe checkout");
    });

    act(() => button("Edit").click());
    const name = document.querySelector<HTMLInputElement>(
      "#inbound-endpoint-name",
    );
    const transform = document.querySelector<HTMLTextAreaElement>(
      "#inbound-transform-jq",
    );
    if (!name || !transform) throw new Error("Missing endpoint editor fields");
    setInput(name, "Billing lifecycle");
    setTextarea(transform, "{ email: .customer.email }");

    act(() => button("Run server preview").click());
    await waitFor(() => {
      expect(mocks.previewInbound).toHaveBeenCalledWith({
        transform_jq: "{ email: .customer.email }",
        body: expect.objectContaining({ source: "billing" }),
      });
      expect(document.body.textContent).toContain("ada@example.com");
    });

    const accessibility = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      accessibility.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    act(() => button("Save endpoint").click());
    await waitFor(() => {
      expect(mocks.updateInbound).toHaveBeenCalledWith("inbound-1", {
        name: "Billing lifecycle",
        transform_jq: "{ email: .customer.email }",
      });
    });

    act(() => button("Disable").click());
    expect(document.body.textContent).toContain("Disable this endpoint?");
    act(() => button("Disable endpoint").click());
    await waitFor(() => {
      expect(mocks.updateInbound).toHaveBeenLastCalledWith("inbound-1", {
        enabled: false,
      });
    });
  });

  it("confirms a live outbound test, serializes it, and stays axe-clean", async () => {
    mocks.testOutbound.mockResolvedValueOnce({
      data: {
        webhook_id: "outbound-1",
        status_code: 202,
        signed: true,
        signature: "t=1,v1=safe",
        response:
          "accepted https://receiver.test/callback?token=client-test-secret&trace=visible",
        filtered: false,
      },
    });
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://hooks.example.com/postwave",
      );
    });
    expect(button("New destination").disabled).toBe(false);
    expect(document.querySelector("table")).not.toBeNull();
    expect(
      Array.from(document.querySelectorAll("th")).map((cell) =>
        cell.textContent?.trim(),
      ),
    ).toEqual(
      expect.arrayContaining([
        "Destination",
        "State",
        "Delivery activity",
        "Events and signing",
      ]),
    );
    const test = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Send a synthetic test delivery"]',
    );
    if (!test) throw new Error("Missing outbound test action");
    act(() => test.click());
    expect(mocks.testOutbound).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Send a live test delivery?");
    const confirm = button("Send test");
    act(() => {
      confirm.click();
      confirm.click();
    });
    await waitFor(() => {
      expect(mocks.testOutbound).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("REDACTED");
    });
    expect(document.body.textContent).not.toContain("client-test-secret");
    expect(document.querySelector("[title]")).toBeNull();

    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("explains filtered tests without claiming a receiver request occurred", async () => {
    mocks.testOutbound.mockResolvedValueOnce({
      data: {
        webhook_id: "outbound-1",
        status_code: 204,
        signed: false,
        signature: "",
        response: "",
        filtered: true,
      },
    });
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://hooks.example.com/postwave",
      );
    });
    const test = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Send a synthetic test delivery"]',
    );
    if (!test) throw new Error("Missing outbound test action");
    act(() => test.click());
    act(() => button("Send test").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain("Filtered before delivery");
      expect(document.body.textContent).toContain(
        "No network request was made",
      );
    });
    expect(document.body.textContent).not.toContain(
      "Receiver returned HTTP 204",
    );
  });

  it("loads canonical outbound pages only when requested and forwards opaque cursors", async () => {
    mocks.listOutbound
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          webhooks: [outboundWebhook("outbound-1", "https://one.example/hook")],
          next_cursor: "opaque-page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          webhooks: [outboundWebhook("outbound-2", "https://two.example/hook")],
          next_cursor: "",
        },
      });

    render(<OutboundWebhooks />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("https://one.example/hook");
      expect(document.body.textContent).toContain(
        "More destination records are available from the server",
      );
    });
    expect(document.body.textContent).not.toContain("https://two.example/hook");
    expect(mocks.listOutbound).toHaveBeenCalledTimes(1);
    expect(mocks.listOutbound).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ limit: 50 }),
    );

    act(() => button("Load more destinations").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("https://two.example/hook");
      expect(document.body.textContent).toContain(
        "All available destination records are loaded",
      );
    });
    expect(mocks.listOutbound).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "opaque-page-2", limit: 50 }),
    );
  });

  it("debounces outbound search into the server query without locally filtering the response", async () => {
    mocks.listOutbound
      .mockReset()
      .mockResolvedValueOnce({
        data: { webhooks: [outboundWebhook()], next_cursor: "" },
      })
      .mockResolvedValueOnce({
        data: {
          webhooks: [
            outboundWebhook(
              "server-match",
              "https://server-ranked.example/hook",
            ),
          ],
          next_cursor: "",
        },
      });
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://hooks.example.com/postwave",
      );
    });
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search destination or event…"]',
    );
    if (!search) throw new Error("Missing outbound destination search");

    setInput(search, "needle-not-present-in-returned-row");
    expect(document.body.textContent).toContain("Searching server");
    expect(mocks.listOutbound).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 275));
    });

    await waitFor(() => {
      expect(mocks.listOutbound).toHaveBeenLastCalledWith(
        expect.objectContaining({
          limit: 50,
          query: "needle-not-present-in-returned-row",
        }),
      );
      expect(document.body.textContent).toContain(
        "https://server-ranked.example/hook",
      );
    });
    expect(document.body.textContent).toContain(
      "1 matching destination loaded",
    );
    expect(document.body.textContent).not.toContain("1 of 1 destinations");
  });

  it("ignores a stale outbound query response after a newer debounced query owns the screen", async () => {
    const stale = deferred<{
      data: {
        webhooks: ReturnType<typeof outboundWebhook>[];
        next_cursor: string;
      };
    }>();
    const latest = deferred<{
      data: {
        webhooks: ReturnType<typeof outboundWebhook>[];
        next_cursor: string;
      };
    }>();
    mocks.listOutbound
      .mockReset()
      .mockImplementation((options: { query?: string }) => {
        if (options.query === "first") return stale.promise;
        if (options.query === "second") return latest.promise;
        return Promise.resolve({
          data: { webhooks: [outboundWebhook()], next_cursor: "" },
        });
      });
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://hooks.example.com/postwave",
      );
    });
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search destination or event…"]',
    );
    if (!search) throw new Error("Missing outbound destination search");

    setInput(search, "first");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 275));
    });
    await waitFor(() => {
      expect(mocks.listOutbound).toHaveBeenCalledTimes(2);
    });
    const staleSignal = (
      mocks.listOutbound.mock.calls[1]?.[0] as { signal?: AbortSignal }
    ).signal;
    expect(staleSignal?.aborted).toBe(false);

    setInput(search, "second");
    expect(staleSignal?.aborted).toBe(true);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 275));
    });
    await waitFor(() => {
      expect(mocks.listOutbound).toHaveBeenCalledTimes(3);
    });

    await act(async () => {
      latest.resolve({
        data: {
          webhooks: [outboundWebhook("latest", "https://latest.example/hook")],
          next_cursor: "",
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://latest.example/hook",
      );
    });

    await act(async () => {
      stale.resolve({
        data: {
          webhooks: [outboundWebhook("stale", "https://stale.example/hook")],
          next_cursor: "",
        },
      });
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("https://latest.example/hook");
    expect(document.body.textContent).not.toContain(
      "https://stale.example/hook",
    );
  });

  it("restarts the current outbound scope when a pending query is cleared before debounce", async () => {
    const abandoned = deferred<{
      data: {
        webhooks: ReturnType<typeof outboundWebhook>[];
        next_cursor: string;
      };
    }>();
    mocks.listOutbound
      .mockReset()
      .mockReturnValueOnce(abandoned.promise)
      .mockResolvedValueOnce({
        data: {
          webhooks: [
            outboundWebhook("recovered", "https://recovered.example/hook"),
          ],
          next_cursor: "",
        },
      });
    render(<OutboundWebhooks />);
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search destination or event…"]',
    );
    if (!search) throw new Error("Missing outbound destination search");
    const initialSignal = (
      mocks.listOutbound.mock.calls[0]?.[0] as { signal?: AbortSignal }
    ).signal;

    setInput(search, "temporary query");
    expect(initialSignal?.aborted).toBe(true);
    setInput(search, "");

    await waitFor(() => {
      expect(mocks.listOutbound).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain(
        "https://recovered.example/hook",
      );
    });
    await act(async () => {
      abandoned.resolve({
        data: {
          webhooks: [
            outboundWebhook("abandoned", "https://abandoned.example/hook"),
          ],
          next_cursor: "",
        },
      });
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain(
      "https://abandoned.example/hook",
    );
  });

  it.each([
    {
      name: "duplicate destination",
      page: {
        webhooks: [outboundWebhook("outbound-1", "https://one.example/hook")],
        next_cursor: "opaque-page-3",
      },
      error: "repeated a destination across cursor pages",
    },
    {
      name: "repeated cursor",
      page: {
        webhooks: [outboundWebhook("outbound-2", "https://two.example/hook")],
        next_cursor: "opaque-page-2",
      },
      error: "repeated an outbound-webhook pagination cursor",
    },
  ])("stops outbound pagination on a $name", async ({ page, error }) => {
    mocks.listOutbound
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          webhooks: [outboundWebhook("outbound-1", "https://one.example/hook")],
          next_cursor: "opaque-page-2",
        },
      })
      .mockResolvedValueOnce({ data: page });
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("https://one.example/hook");
    });

    act(() => button("Load more destinations").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(error);
      expect(document.body.textContent).toContain("pagination stopped safely");
    });
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) =>
          candidate.textContent?.trim() === "Load more destinations",
      ),
    ).toBe(false);
    expect(
      document.querySelectorAll(
        'input[aria-label="Select https://one.example/hook"]',
      ),
    ).toHaveLength(1);
    expect(document.body.textContent).not.toContain("https://two.example/hook");
  });

  it("clears outbound selection when the server query changes and scopes bulk copy to loaded rows", async () => {
    mocks.listOutbound
      .mockReset()
      .mockResolvedValueOnce({
        data: {
          webhooks: [
            outboundWebhook("outbound-1", "https://one.example/hook"),
            outboundWebhook("outbound-2", "https://two.example/hook"),
          ],
          next_cursor: "base-page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          webhooks: [
            outboundWebhook("billing-1", "https://billing.example/hook"),
          ],
          next_cursor: "billing-page-2",
        },
      });
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("https://one.example/hook");
    });
    const selectAll = document.querySelector<HTMLInputElement>(
      'input[aria-label="Select all loaded webhooks in this query"]',
    );
    if (!selectAll) throw new Error("Missing select-all checkbox");
    act(() => selectAll.click());
    expect(document.body.textContent).toContain("2 selected");

    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search destination or event…"]',
    );
    if (!search) throw new Error("Missing outbound destination search");
    setInput(search, "billing");
    expect(document.body.textContent).not.toContain("2 selected");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 275));
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://billing.example/hook",
      );
    });

    const querySelectAll = document.querySelector<HTMLInputElement>(
      'input[aria-label="Select all loaded webhooks in this query"]',
    );
    if (!querySelectAll) throw new Error("Missing query select-all checkbox");
    act(() => querySelectAll.click());
    act(() => button("Pause all").click());
    expect(document.body.textContent).toContain(
      "among the rows loaded for the current server query",
    );
    expect(document.body.textContent).toContain(
      "Unloaded cursor pages are not selected",
    );
  });

  it("retains but does not display verified rows from a different failed query scope", async () => {
    mocks.listOutbound
      .mockReset()
      .mockResolvedValueOnce({
        data: { webhooks: [outboundWebhook()], next_cursor: "" },
      })
      .mockResolvedValueOnce({
        error: { message: "search gateway unavailable" },
      });
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://hooks.example.com/postwave",
      );
    });
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search destination or event…"]',
    );
    if (!search) throw new Error("Missing outbound destination search");
    setInput(search, "billing");
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 275));
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("search gateway unavailable");
      expect(document.body.textContent).toContain(
        "different server query are retained but are not shown",
      );
    });
    expect(document.body.textContent).not.toContain(
      "https://hooks.example.com/postwave",
    );
    expect(document.body.textContent).not.toContain("No destinations match");
  });

  it.each([
    {
      algorithm: "hmac_sha256" as const,
      materialLabel: "Shared signing secret",
      oneTimeValue: "owhsec_shown_once",
    },
  ])(
    "protects shown-once $algorithm material until secure storage is confirmed",
    async ({ algorithm, materialLabel, oneTimeValue }) => {
      mocks.receiverCreated = createdWebhookMaterial(algorithm);
      render(<OutboundWebhooks />);
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "https://hooks.example.com/postwave",
        );
      });

      act(() => button("New destination").click());
      act(() => button("Complete mock destination creation").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain(materialLabel);
        expect(document.body.textContent).toContain(oneTimeValue);
      });
      await expect(inspectLifecycle(quitIntent)).resolves.toEqual([
        expect.objectContaining({
          label: "Outbound webhook signing material",
          level: "blocking",
        }),
      ]);
      expect(document.body.textContent).toContain(
        "It is not a usable delivery destination.",
      );
      expect(button("Copy display address")).toBeTruthy();
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) => candidate.textContent?.trim() === "Copy URL",
        ),
      ).toBe(false);

      const resolve = button("I've stored it securely");
      expect(resolve.disabled).toBe(true);
      const storageLabel = Array.from(document.querySelectorAll("label")).find(
        (label) => label.textContent?.includes("I stored the"),
      );
      const stored = storageLabel?.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      if (!stored) throw new Error("Missing secure-storage confirmation");
      act(() => stored.click());
      expect(button("I've stored it securely").disabled).toBe(false);
      act(() => button("I've stored it securely").click());

      expect(document.body.textContent).not.toContain(oneTimeValue);
    },
  );

  it("reuses one canonical rotation identity after an ambiguous response loss", async () => {
    mocks.rotateOutbound
      .mockReset()
      .mockResolvedValueOnce({
        error: {
          kind: "network",
          code: "network_error",
          message: "The rotation response was lost.",
        },
      })
      .mockResolvedValueOnce({
        data: createdWebhookMaterial("hmac_sha256"),
      });
    render(<OutboundWebhooks />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "https://hooks.example.com/postwave",
      ),
    );

    act(() => button("Rotate key").click());
    const confirmRotation = (): HTMLButtonElement => {
      const matches = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).filter((candidate) => candidate.textContent?.trim() === "Rotate key");
      const match = matches.at(-1);
      if (!match) throw new Error("Missing rotation confirmation");
      return match;
    };
    act(() => confirmRotation().click());
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining("rotation response was lost"),
      ),
    );
    const firstKey = mocks.rotateOutbound.mock.calls[0]?.[2]?.idempotencyKey;
    expect(firstKey).toEqual(expect.any(String));

    act(() => confirmRotation().click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("owhsec_shown_once"),
    );
    expect(mocks.rotateOutbound.mock.calls[1]?.[2]?.idempotencyKey).toBe(
      firstKey,
    );
  });

  it("presents only the distributable public key for asymmetric signing", async () => {
    mocks.receiverCreated = createdWebhookMaterial("ecdsa_p256");
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://hooks.example.com/postwave",
      );
    });

    act(() => button("New destination").click());
    act(() => button("Complete mock destination creation").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Public verification key");
      expect(document.body.textContent).toContain("PUBLIC KEY FOR RECEIVER");
    });

    expect(document.body.textContent).toContain(
      "private signing key server-side",
    );
    expect(document.body.textContent).not.toContain("Signing private key");
    expect(document.body.textContent).not.toContain("PRIVATE KEY SHOWN ONCE");
    expect(button("Copy public key")).toBeTruthy();
    expect(button("Done").disabled).toBe(false);
    expect(
      Array.from(document.querySelectorAll("label")).some((label) =>
        label.textContent?.includes("I stored the"),
      ),
    ).toBe(false);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);

    act(() => button("Done").click());
    expect(document.body.textContent).not.toContain("PUBLIC KEY FOR RECEIVER");
  });

  it("blocks malformed canonical data without presenting a false empty state", async () => {
    mocks.listOutbound.mockResolvedValueOnce({
      error: {
        kind: "parse",
        code: "outbound_webhook_contract",
        message: "The list envelope was malformed.",
      },
    });

    render(<OutboundWebhooks />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Contract error:");
      expect(document.body.textContent).toContain(
        "The list envelope was malformed.",
      );
    });
    expect(button("New destination").disabled).toBe(false);
    expect(document.body.textContent).not.toContain(
      "No outbound webhooks match",
    );
  });

  it("retains failed bulk deletions selected for a safe retry", async () => {
    mocks.listOutbound.mockResolvedValue({
      data: {
        webhooks: [
          outboundWebhook("outbound-1", "https://one.example/hook"),
          outboundWebhook("outbound-2", "https://two.example/hook"),
        ],
        next_cursor: "",
      },
    });
    mocks.remove
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error("receiver connection dropped"));
    render(<OutboundWebhooks />);
    await waitFor(() =>
      expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(
        3,
      ),
    );
    const selectAll = document.querySelector<HTMLInputElement>(
      'input[aria-label="Select all loaded webhooks in this query"]',
    );
    if (!selectAll) throw new Error("Missing select-all checkbox");
    act(() => selectAll.click());
    act(() => button("Delete all").click());
    const confirmation = document.querySelector<HTMLInputElement>(
      'input[placeholder="DELETE"]',
    );
    if (!confirmation) throw new Error("Missing typed delete confirmation");
    setInput(confirmation, "DELETE");
    const deleteDialog = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    const confirmDelete = Array.from(
      deleteDialog?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).find((candidate) => candidate.textContent?.trim() === "Delete");
    if (!confirmDelete) throw new Error("Missing bulk delete confirmation");
    act(() => confirmDelete.click());

    await waitFor(() => {
      expect(mocks.remove).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain(
        "1 failed and remain selected for retry",
      );
    });
    expect(mocks.remove).toHaveBeenNthCalledWith(1, "outbound-1", {
      soft: false,
    });
    expect(mocks.remove).toHaveBeenNthCalledWith(2, "outbound-2", {
      soft: false,
    });
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Select https://two.example/hook"]',
      )?.checked,
    ).toBe(true);
  });

  it("uses the server soft-delete contract for an explicitly confirmed pause", async () => {
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://hooks.example.com/postwave",
      );
    });

    act(() => button("Pause").click());
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Pause this destination?");
    act(() => button("Pause destination").click());

    await waitFor(() => {
      expect(mocks.remove).toHaveBeenCalledWith("outbound-1", { soft: true });
    });
  });

  it("retains last-known outbound data when a background refresh fails", async () => {
    mocks.listOutbound
      .mockReset()
      .mockResolvedValueOnce({
        data: { webhooks: [outboundWebhook()], next_cursor: "stale-page-2" },
      })
      .mockResolvedValueOnce({
        error: { message: "gateway unavailable" },
      });
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "https://hooks.example.com/postwave",
      );
    });
    act(() => button("Refresh").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Previously loaded destinations remain visible and may be stale",
      );
      expect(document.body.textContent).toContain(
        "Refresh must succeed before additional cursor pages can be loaded",
      );
    });
    expect(document.body.textContent).toContain(
      "https://hooks.example.com/postwave",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) =>
          candidate.textContent?.trim() === "Load more destinations",
      ),
    ).toBe(false);
  });

  it("redacts credential-bearing URL details from the outbound list", async () => {
    mocks.listOutbound.mockResolvedValue({
      data: {
        webhooks: [
          outboundWebhook(
            "outbound-sensitive",
            "https://hooks.example.com/postwave?token=client-facing-secret&trace=request-123",
          ),
        ],
        next_cursor: "",
      },
    });
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("request-123");
    });
    expect(document.body.textContent).toContain("REDACTED");
    expect(document.body.textContent).not.toContain("client-facing-secret");
  });

  it("fails closed before loading outbound data for non-admins", async () => {
    mocks.canAdmin = false;
    render(<OutboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Workspace admin access is required",
      );
    });
    expect(mocks.listOutbound).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Webhook onboarding");
    expect(
      document.querySelector('button[aria-label^="Send a synthetic test"]'),
    ).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("fails closed before loading inbound endpoint data for non-admins", async () => {
    mocks.canAdmin = false;
    mocks.listInbound.mockResolvedValue({ data: { items: [] } });
    render(<InboundWebhooks />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Workspace admin access is required",
      );
    });
    expect(mocks.listInbound).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Webhook onboarding");
    expect(document.body.textContent).not.toContain("New endpoint");
  });
});

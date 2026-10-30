// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// /app/developer-reference/webhook-simulator — the fire, the receipt check,
// and every recovery control, driven through the real page against a routed
// fetch stub. Assertions are on CONSEQUENCES: the request each verb sends
// (method, path, headers, exact body), what the page renders afterwards, and
// what the tab's recovery checkpoint holds.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WHOAMI } from "./_harness";

const mocks = vi.hoisted(() => ({ whoami: vi.fn() }));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => createElement("a", { href, ...rest }, children),
}));

import WebhookSimulatorPage from "@/app/(dashboard)/app/developer-reference/webhook-simulator/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WEBHOOK = "7f3c2e10-1b2a-4c3d-8e4f-5a6b7c8d9e0f";
const CHECKPOINT_KEY = `postwave:webhook-playground-fire-recovery:v1:${WHOAMI.tenant_id}:${WHOAMI.user_id}`;
const SAMPLE = { campaign_id: "cmp_1", subject: "Hello" };
const SAMPLE_TEXT = JSON.stringify(SAMPLE, null, 2);
const RATE_SENTENCE =
  "per-tenant rate limit exceeded; retry after the Retry-After window";

const TARGET = {
  id: WEBHOOK,
  url: "https://hooks.example.test/…",
  description: "Order handler",
  events: ["campaign.sent"],
  active: true,
  config_version: 3,
  signing_algorithm: "hmac_sha256",
  url_status: "ready",
  auth_config_status: "ready",
  delivery_policy_status: "ready",
};

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: string | undefined;
}

type Responder = (call: Call) => Response | Promise<Response>;

let calls: Call[] = [];
let fireResponder: Responder;
let receiptResponder: Responder;
let root: Root | null = null;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function receiptFor(call: Call, overrides: Record<string, unknown> = {}) {
  const fireId = (JSON.parse(call.body ?? "{}") as { fire_id: string }).fire_id;
  return {
    fire_id: fireId,
    event_id: `evt-${fireId}`,
    delivery_id: `playground-${fireId}`,
    url: "https://hooks.example.test/…",
    method: "POST",
    headers: { "Content-Type": "application/json", "Moosewave-Test": "true" },
    body: { type: "campaign.sent", data: SAMPLE },
    signature: "sha256=abc",
    requested_at: "2026-09-12T10:00:00Z",
    status_code: 202,
    response_body: "accepted by handler",
    latency_ms: 41,
    outcome: "receiver_responded",
    ambiguous: false,
    response_body_truncated: false,
    ...overrides,
  };
}

function serverReceipt(fireId: string, state: string, outcome = "") {
  return {
    fire_id: fireId,
    webhook_id: WEBHOOK,
    event_type: "campaign.sent",
    delivery_id: `playground-${fireId}`,
    state,
    outcome,
    receiver_status_code: state === "completed" ? 202 : null,
    response_body_truncated: false,
    created_at: "2026-09-12T10:00:00Z",
    completed_at: null,
  };
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://postwave.test");
      const call: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname + url.search,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      calls.push(call);
      if (url.pathname === "/api/v1/outbound-webhooks/playground/events") {
        return json(200, {
          events: [
            { event_type: "campaign.sent", sample_payload: SAMPLE },
            {
              event_type: "subscriber.added",
              sample_payload: { email: "a@example.com" },
            },
          ],
        });
      }
      if (url.pathname === "/api/v1/outbound-webhooks") {
        return json(200, { webhooks: [TARGET], next_cursor: "" });
      }
      if (url.pathname.endsWith("/playground/fire")) return fireResponder(call);
      if (url.pathname.startsWith("/api/v1/outbound-webhooks/playground/fires/")) {
        return receiptResponder(call);
      }
      return json(404, { error: { code: "not_found", message: "" } });
    }),
  );
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (cause) {
      last = cause;
      await act(flush);
    }
  }
  throw last;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function maybeButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

function firePosts(): Call[] {
  return calls.filter(
    (call) => call.method === "POST" && call.path.endsWith("/playground/fire"),
  );
}

async function render(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(WebhookSimulatorPage),
      ),
    );
  });
  await waitFor(() => {
    expect(button("Fire event").getAttribute("aria-disabled")).toBeNull();
  });
}

/** Fire event → confirm, returning the confirm dialog's text. */
async function fireAndConfirm(): Promise<string> {
  await click(button("Fire event"));
  await waitFor(() => {
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
  const dialogText =
    document.querySelector('[role="dialog"]')?.textContent ?? "";
  await click(button("Send this one logical fire"));
  return dialogText;
}

beforeEach(() => {
  calls = [];
  window.sessionStorage.clear();
  mocks.whoami.mockResolvedValue(WHOAMI);
  fireResponder = (call) => json(200, receiptFor(call));
  receiptResponder = () =>
    json(404, { error: { code: "not_found", message: "fire receipt not found" } });
  installFetch();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// Whole-page flows on a shared machine: the 5s default measured CPU contention
// (a first test paying module warm-up took 5.5s), not the behaviour.
const FLOW_TIMEOUT = { timeout: 20_000 };

describe("webhook simulator — fire (platform-123)", FLOW_TIMEOUT, () => {
  it("confirms the consequence, checkpoints first, then sends one exact signed-fire request", async () => {
    let checkpointAtSend: unknown = null;
    fireResponder = (call) => {
      checkpointAtSend = JSON.parse(
        window.sessionStorage.getItem(CHECKPOINT_KEY) ?? "null",
      );
      return json(200, receiptFor(call));
    };
    await render();

    const dialogText = await fireAndConfirm();
    expect(dialogText).toContain(
      "one real signed POST for campaign.sent to Order handler",
    );
    expect(dialogText).toContain("side effects");

    await waitFor(() => expect(text()).toContain("accepted by handler"));
    const [post] = firePosts();
    expect(firePosts()).toHaveLength(1);
    expect(post.path).toBe(`/api/v1/outbound-webhooks/${WEBHOOK}/playground/fire`);
    const sent = JSON.parse(post.body ?? "{}") as Record<string, unknown>;
    const fireId = String(sent.fire_id);
    expect(post.headers.get("Idempotency-Key")).toBe(
      `webhook-playground:${fireId}`,
    );
    expect(post.headers.get("Content-Type")).toBe("application/json");
    expect(post.body).toBe(
      `{"fire_id":"${fireId}","event_type":"campaign.sent","expected_webhook_config_version":3,"payload":${SAMPLE_TEXT}}`,
    );
    // The checkpoint existed BEFORE the request left, naming this identity…
    expect(checkpointAtSend).toMatchObject({
      snapshot: { fireId, webhookId: WEBHOOK, payloadJSON: SAMPLE_TEXT },
    });
    // …and a provably-resolved fire releases it.
    expect(window.sessionStorage.getItem(CHECKPOINT_KEY)).toBeNull();
    expect(text()).toContain("Response to campaign.sent sent to Order handler.");
    expect(text()).not.toContain("awaiting reconciliation");
  });

  it("renders the rate limit's own sentence and releases the fence (a 429 is not a dispatch)", async () => {
    fireResponder = () =>
      json(
        429,
        { error: { code: "tenant_rate_limited", message: RATE_SENTENCE } },
        { "retry-after": "30" },
      );
    await render();

    await fireAndConfirm();

    await waitFor(() => expect(text()).toContain(RATE_SENTENCE));
    expect(firePosts()).toHaveLength(1);
    expect(text()).toContain("Test delivery failed");
    expect(text()).not.toContain("awaiting reconciliation");
    expect(window.sessionStorage.getItem(CHECKPOINT_KEY)).toBeNull();
    // Not blocked: a new logical fire is permitted again.
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBeNull(),
    );
  });

  it("withholds the simulator from a non-admin and makes no destination or fire request", async () => {
    mocks.whoami.mockResolvedValue({
      ...WHOAMI,
      role: "editor",
      effective_role: "editor",
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(WebhookSimulatorPage),
        ),
      );
    });
    await waitFor(() =>
      expect(text()).toContain("Workspace owner or admin access is required"),
    );
    expect(maybeButton("Fire event")).toBeUndefined();
    expect(
      calls.some((call) => call.path.startsWith("/api/v1/outbound-webhooks")),
    ).toBe(false);
  });
});

describe(
  "webhook simulator — check server receipt (platform-124) and recovery (platform-125)",
  FLOW_TIMEOUT,
  () => {
  async function fireAmbiguously(): Promise<{ fireId: string; body: string }> {
    fireResponder = () =>
      json(502, { error: { code: "bad_gateway", message: "upstream reset" } });
    await render();
    await fireAndConfirm();
    await waitFor(() =>
      expect(text()).toContain("This logical fire is awaiting reconciliation."),
    );
    const [post] = firePosts();
    const body = post.body ?? "";
    return { fireId: String((JSON.parse(body) as { fire_id: string }).fire_id), body };
  }

  it("fences an ambiguous fire, blocks a new identity, and checks the receipt for THAT fire", async () => {
    const { fireId } = await fireAmbiguously();

    // The checkpoint survives and a new identity is blocked, with the reason.
    expect(
      JSON.parse(window.sessionStorage.getItem(CHECKPOINT_KEY) ?? "null"),
    ).toMatchObject({ snapshot: { fireId } });
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
    expect(text()).toContain(
      "Resolve the previous logical fire before creating another.",
    );
    await click(button("Fire event"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    receiptResponder = () => json(200, serverReceipt(fireId, "pending"));
    await click(button("Check server receipt"));

    await waitFor(() =>
      expect(text()).toContain("still waiting to record a terminal receiver outcome"),
    );
    const lookups = calls.filter((call) => call.path.includes("/playground/fires/"));
    expect(lookups).toEqual([
      expect.objectContaining({
        method: "GET",
        path: `/api/v1/outbound-webhooks/playground/fires/${fireId}`,
      }),
    ]);
    expect(firePosts()).toHaveLength(1);
  });

  it("restores a retained response with the SAME identity and byte-identical body, then releases the fence", async () => {
    const { fireId, body } = await fireAmbiguously();
    receiptResponder = () =>
      json(200, serverReceipt(fireId, "completed", "receiver_responded"));
    await click(button("Check server receipt"));
    await waitFor(() => expect(maybeButton("Restore retained response")).toBeDefined());

    fireResponder = (call) => json(200, receiptFor(call), { "Idempotency-Replayed": "true" });
    await click(button("Restore retained response"));

    await waitFor(() => expect(text()).toContain("accepted by handler"));
    const posts = firePosts();
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toBe(body);
    expect(posts[1].headers.get("Idempotency-Key")).toBe(
      `webhook-playground:${fireId}`,
    );
    expect(window.sessionStorage.getItem(CHECKPOINT_KEY)).toBeNull();
    expect(text()).not.toContain("awaiting reconciliation");
  });

  it("offers only 'Continue this same fire' when no receipt is registered, and it re-sends the same identity", async () => {
    const { fireId, body } = await fireAmbiguously();
    await click(button("Check server receipt"));
    await waitFor(() => expect(maybeButton("Continue this same fire")).toBeDefined());
    expect(text()).toContain("No durable receipt is registered yet.");

    fireResponder = (call) => json(200, receiptFor(call));
    await click(button("Continue this same fire"));

    await waitFor(() => expect(text()).toContain("accepted by handler"));
    const posts = firePosts();
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toBe(body);
    expect(posts[1].headers.get("Idempotency-Key")).toBe(
      `webhook-playground:${fireId}`,
    );
  });

  it("keeps the fence when a recovery retry is refused before dispatch", async () => {
    const { fireId } = await fireAmbiguously();
    await click(button("Check server receipt"));
    await waitFor(() => expect(maybeButton("Continue this same fire")).toBeDefined());

    fireResponder = () =>
      json(429, { error: { code: "tenant_rate_limited", message: RATE_SENTENCE } });
    await click(button("Continue this same fire"));

    await waitFor(() =>
      expect(text()).toContain("The server refused this retry before dispatch"),
    );
    expect(text()).toContain(RATE_SENTENCE);
    expect(
      JSON.parse(window.sessionStorage.getItem(CHECKPOINT_KEY) ?? "null"),
    ).toMatchObject({ snapshot: { fireId } });
  });

  it("allows a new logical fire only after the operator acknowledges an ambiguous receipt", async () => {
    const { fireId } = await fireAmbiguously();
    receiptResponder = () =>
      json(200, serverReceipt(fireId, "ambiguous", "transport_ambiguous"));
    await click(button("Check server receipt"));
    await waitFor(() =>
      expect(text()).toContain("Receiver outcome needs human verification."),
    );

    const release = button("Allow a new logical fire");
    expect(release.disabled).toBe(true);
    await click(release);
    expect(window.sessionStorage.getItem(CHECKPOINT_KEY)).not.toBeNull();

    const ack = document.querySelector<HTMLInputElement>(
      '[aria-label="Fire reconciliation"] input[type="checkbox"]',
    );
    if (!ack) throw new Error("acknowledgement checkbox missing");
    await click(ack);
    await waitFor(() => expect(button("Allow a new logical fire").disabled).toBe(false));
    const requestsBefore = calls.length;
    await click(button("Allow a new logical fire"));

    await waitFor(() => expect(text()).not.toContain("needs human verification"));
    expect(window.sessionStorage.getItem(CHECKPOINT_KEY)).toBeNull();
    // Releasing is local: it contacts neither the receiver nor the server.
    expect(calls.length).toBe(requestsBefore);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBeNull(),
    );
  });

  it("clears only the local checkpoint for an identity whose receipt expired", async () => {
    const { fireId } = await fireAmbiguously();
    receiptResponder = () => json(200, serverReceipt(fireId, "receipt_expired"));
    await click(button("Check server receipt"));
    await waitFor(() => expect(text()).toContain("Private receipt details have expired."));

    const requestsBefore = calls.length;
    await click(button("Clear local recovery checkpoint"));

    await waitFor(() => expect(text()).not.toContain("Private receipt details have expired."));
    expect(window.sessionStorage.getItem(CHECKPOINT_KEY)).toBeNull();
    expect(calls.length).toBe(requestsBefore);
    expect(firePosts()).toHaveLength(1);
  });

  it("restores a checkpoint left by an earlier visit and fences it before anything else", async () => {
    const fireId = "0190f5c2-7b1a-7c3d-8e4f-5a6b7c8d9e0f";
    const payloadJSON = '{"order_id":"ord_9"}';
    window.sessionStorage.setItem(
      CHECKPOINT_KEY,
      JSON.stringify({
        version: 1,
        scope: `${WHOAMI.tenant_id}:${WHOAMI.user_id}`,
        snapshot: {
          fireId,
          idempotencyKey: `webhook-playground:${fireId}`,
          webhookId: WEBHOOK,
          expectedWebhookConfigVersion: 2,
          eventType: "campaign.sent",
          payloadJSON,
        },
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(QueryClientProvider, { client }, createElement(WebhookSimulatorPage)),
      );
    });
    await waitFor(() => expect(text()).toContain(fireId));
    expect(text()).toContain("A fire started earlier in this tab");
    // The fence renders before the catalog resolves; wait for the form too.
    await waitFor(() => expect(maybeButton("Fire event")).toBeDefined());
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
    expect(text()).toContain(
      "Resolve the previous logical fire before creating another.",
    );

    receiptResponder = () =>
      json(200, serverReceipt(fireId, "completed", "receiver_responded"));
    await click(button("Check server receipt"));
    await waitFor(() => expect(maybeButton("Restore retained response")).toBeDefined());
    fireResponder = (call) => json(200, receiptFor(call));
    await click(button("Restore retained response"));

    await waitFor(() => expect(text()).toContain("accepted by handler"));
    expect(firePosts()[0].body).toBe(
      `{"fire_id":"${fireId}","event_type":"campaign.sent","expected_webhook_config_version":2,"payload":${payloadJSON}}`,
    );
    expect(firePosts()[0].headers.get("Idempotency-Key")).toBe(
      `webhook-playground:${fireId}`,
    );
    expect(window.sessionStorage.getItem(CHECKPOINT_KEY)).toBeNull();
  });

  it("blocks firing while recovery cannot be proven, and 'Retry recovery check' re-reads it", async () => {
    const realDescriptor = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    const real = window.sessionStorage;
    let blocked = true;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        if (blocked) throw new DOMException("blocked", "SecurityError");
        return real;
      },
    });
    try {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      const host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      await act(async () => {
        root?.render(
          createElement(QueryClientProvider, { client }, createElement(WebhookSimulatorPage)),
        );
      });
      await waitFor(() => expect(text()).toContain("Fire recovery is not ready."));
      await waitFor(() => expect(maybeButton("Fire event")).toBeDefined());
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
      expect(text()).toContain("Browser session storage is unavailable.");

      blocked = false;
      await click(button("Retry recovery check"));

      await waitFor(() => expect(text()).not.toContain("Fire recovery is not ready."));
      await waitFor(() =>
        expect(button("Fire event").getAttribute("aria-disabled")).toBeNull(),
      );
      expect(firePosts()).toHaveLength(0);
    } finally {
      if (realDescriptor) {
        Object.defineProperty(window, "sessionStorage", realDescriptor);
      } else {
        delete (window as { sessionStorage?: Storage }).sessionStorage;
      }
    }
  });
});

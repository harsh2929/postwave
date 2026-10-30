// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// /app/routing/outbound-webhooks → Deliveries panel (platform-117…121).
//
// The page is mounted through its real `page.tsx` default export (next/dynamic
// is stubbed to actually run the page's loader), so the row action is proven
// reachable the way a user reaches it. `@/lib/api` is mocked at the transport:
// every assertion is on the literal method + path + query/body + live options,
// on the confirm's copy, or on what the panel renders back.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

import { importBeforeTests, waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  writeText: vi.fn(async (_text: string) => undefined),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.apiGet,
      post: mocks.apiPost,
      patch: mocks.apiPatch,
      delete: mocks.apiDelete,
    },
  };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));

// Run the page's own dynamic() loader, so a page.tsx that stops loading the
// Deliveries wiring makes the row action disappear from this test.
vi.mock("next/dynamic", async () => {
  const React = await import("react");
  return {
    default: (
      loader: () => Promise<React.ComponentType<Record<string, unknown>>>,
    ) => {
      const Lazy = React.lazy(async () => ({ default: await loader() }));
      return function DynamicStub(props: Record<string, unknown>) {
        return React.createElement(
          React.Suspense,
          { fallback: null },
          React.createElement(Lazy, props),
        );
      };
    },
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/* ---------- fixtures: the shapes internal/outbound_webhooks answers with --- */

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "qa@postwave.test",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "QA",
  workspace_slug: "qa",
};
const VIEWER = {
  ...OWNER,
  role: "viewer" as const,
  effective_role: "viewer" as const,
};

const LIST_PATH = "/api/v1/outbound-webhooks";
const WH_1 = {
  id: "wh_1",
  url: "https://hooks.zapier.com/hooks/catch",
  events: ["campaign.sent"],
  active: true,
  signing_algorithm: "hmac_sha256",
  consecutive_failures: 1,
};
const WH_2 = {
  id: "wh_2",
  url: "https://n8n.example.com/webhook/paused",
  events: ["campaign.sent"],
  active: false,
  signing_algorithm: "ed25519",
  signing_public_key: "-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----",
};

const DELIVERIES_1 = `${LIST_PATH}/wh_1/deliveries`;
const DELIVERIES_2 = `${LIST_PATH}/wh_2/deliveries`;
const HEALTH_1 = `${LIST_PATH}/wh_1/health`;
const HEALTH_2 = `${LIST_PATH}/wh_2/health`;

const D_EXHAUSTED = {
  id: "0191a000-0000-7000-8000-000000000001",
  webhook_id: "wh_1",
  event_type: "campaign.sent",
  attempt_count: 8,
  status: "exhausted",
  last_status_code: 500,
  last_error: "receiver returned 500",
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
};
const D_PENDING = {
  id: "0191a000-0000-7000-8000-000000000002",
  webhook_id: "wh_1",
  event_type: "subscriber.added",
  attempt_count: 1,
  status: "pending",
  next_attempt_at: new Date(Date.now() + 60 * 1000).toISOString(),
  created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
};
const D_OLDER = {
  id: "0191a000-0000-7000-8000-000000000003",
  webhook_id: "wh_1",
  event_type: "email.bounced",
  attempt_count: 1,
  status: "delivered",
  last_status_code: 200,
  created_at: "2026-08-01T10:00:00Z",
  delivered_at: "2026-08-01T10:00:01Z",
};
const D_PAUSED = {
  id: "0191a000-0000-7000-8000-000000000004",
  webhook_id: "wh_2",
  event_type: "campaign.sent",
  attempt_count: 3,
  status: "exhausted",
  created_at: "2026-08-01T10:00:00Z",
};
const REPLAYED_ID = "0191a000-0000-7000-8000-0000000000ff";

const HEALTH = {
  deliveries_total: 10,
  deliveries_succeeded: 9,
  deliveries_failed: 1,
  deliveries_pending: 0,
  deliveries_skipped: 2,
  latency_p50_ms: 120,
  latency_p99_ms: 900,
  status_breakdown: { "200": 9, "500": 1 },
  top_errors: [
    { status_code: 500, message: "upstream exploded", count: 1 },
  ],
  consecutive_failures: 1,
  auto_disabled: false,
};
const EMPTY_HEALTH = {
  ...HEALTH,
  deliveries_total: 0,
  deliveries_succeeded: 0,
  deliveries_failed: 0,
  deliveries_skipped: 0,
  status_breakdown: {},
  top_errors: [],
  consecutive_failures: 0,
};

type GetOptions = { query?: Record<string, unknown> } & Record<
  string,
  unknown
>;

function stubTransport(): void {
  mocks.apiGet.mockImplementation((path: string, opts?: GetOptions) => {
    if (path === LIST_PATH) {
      return Promise.resolve({ webhooks: [WH_1, WH_2], next_cursor: "" });
    }
    if (path === DELIVERIES_1) {
      return Promise.resolve(
        opts?.query?.cursor === "cur_2"
          ? { deliveries: [D_OLDER], next_cursor: "" }
          : { deliveries: [D_EXHAUSTED, D_PENDING], next_cursor: "cur_2" },
      );
    }
    if (path === DELIVERIES_2) {
      return Promise.resolve({ deliveries: [D_PAUSED], next_cursor: "" });
    }
    if (path === HEALTH_1) return Promise.resolve(HEALTH);
    if (path === HEALTH_2) return Promise.resolve(EMPTY_HEALTH);
    return Promise.reject(new Error(`Unexpected GET ${path}`));
  });
  mocks.apiPost.mockImplementation((path: string) => {
    if (path === `${LIST_PATH}/deliveries/${D_EXHAUSTED.id}/replay`) {
      return Promise.resolve({
        delivery_id: REPLAYED_ID,
        replayed_from: D_EXHAUSTED.id,
        status: "pending",
        replayed_at: "2026-09-12T10:00:00Z",
      });
    }
    return Promise.reject(new Error(`Unexpected POST ${path}`));
  });
}

/* ---------- harness ---------- */

async function render(ui: ReactNode): Promise<Root> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function text(): string {
  return document.body.textContent ?? "";
}

function dialogContaining(needle: string): HTMLElement {
  const el = [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"]'),
  ].find((d) => d.textContent?.includes(needle));
  if (!el) throw new Error(`No open dialog containing "${needle}"`);
  return el;
}

/** The innermost open dialog whose title is exactly `title`. */
function dialogTitled(title: string): HTMLElement {
  const el = [
    ...document.querySelectorAll<HTMLElement>('[role="dialog"]'),
  ].find((d) => d.querySelector("h2")?.textContent === title);
  if (!el) throw new Error(`No open dialog titled "${title}"`);
  return el;
}

function buttonByText(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const el = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`Missing button "${label}"`);
  return el;
}

function buttonByLabel(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const el = scope.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`Missing button labelled "${label}"`);
  return el;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
}

function getCalls(path: string): Array<[string, GetOptions]> {
  return mocks.apiGet.mock.calls.filter(([p]) => p === path) as Array<
    [string, GetOptions]
  >;
}

function postCalls(path: string): Array<[string, unknown, unknown]> {
  return mocks.apiPost.mock.calls.filter(([p]) => p === path) as Array<
    [string, unknown, unknown]
  >;
}

const REPLAY_PATH = `${LIST_PATH}/deliveries/${D_EXHAUSTED.id}/replay`;

async function mountPage(): Promise<Root> {
  // Warm the module graph so the page's lazy loader resolves inside the
  // polling window on a cold first test. This does not stand in for the
  // loader: the page still has to import the Deliveries wiring itself.
  await import("@/app/(dashboard)/app/routing/outbound-webhooks/outbound-webhook-deliveries");
  const { default: OutboundWebhooksPage } =
    await import("@/app/(dashboard)/app/routing/outbound-webhooks/page");
  const root = await render(createElement(OutboundWebhooksPage));
  await waitFor(() => expect(text()).toContain(WH_1.url));
  return root;
}

async function openDeliveries(url: string): Promise<HTMLElement> {
  await click(buttonByLabel(`Deliveries for ${url}`));
  await waitFor(() => dialogTitled("Recent deliveries"));
  return dialogTitled("Recent deliveries");
}

function unmount(root: Root): void {
  act(() => root.unmount());
}

// The modules these tests import are cold work for vitest's transform
// pipeline; pay them before any test's 5 s clock starts.
importBeforeTests(
  () => import("@/app/(dashboard)/app/routing/outbound-webhooks/page"),
  () => import("@/app/(dashboard)/app/routing/outbound-webhooks/outbound-webhook-deliveries"),
);

beforeEach(() => {
  // "Load older" is refused while the app is not known to be online.
  setOnlineStatusForTest("online");
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  stubTransport();
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("/app/routing/outbound-webhooks → Deliveries", () => {
  it("platform-117: the row's Deliveries action reads this destination's history and renders server states", async () => {
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_1.url);
      await waitFor(() =>
        expect(panel.textContent).toContain("Retries exhausted"),
      );

      expect(getCalls(DELIVERIES_1)).toHaveLength(1);
      expect(getCalls(DELIVERIES_1)[0]![1]).toEqual(
        expect.objectContaining({
          requireOnline: true,
          maxAttempts: 1,
          cache: "no-store",
          signal: expect.any(AbortSignal),
          query: { limit: 50, cursor: undefined },
        }),
      );
      // The OTHER entity's route is never touched.
      expect(
        mocks.apiGet.mock.calls.some(([p]) =>
          String(p).startsWith("/api/v1/webhooks/"),
        ),
      ).toBe(false);

      expect(panel.textContent).toContain(D_EXHAUSTED.id);
      expect(panel.textContent).toContain("receiver returned 500");
      expect(panel.textContent).toContain("HTTP 500");
      // A pending row is the server's to retry, not the operator's.
      expect(panel.textContent).toContain("Queued by server");
      expect(
        panel.querySelector(`button[aria-label="Replay delivery ${D_PENDING.id}"]`),
      ).toBeNull();
      expect(panel.textContent).toContain(
        "1 terminal failure in the loaded trailing 24-hour window.",
      );
    } finally {
      unmount(root);
    }
  });

  it("platform-119: Load older sends the server's cursor and appends the older page", async () => {
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_1.url);
      await waitFor(() => expect(panel.textContent).toContain(D_PENDING.id));
      expect(panel.textContent).not.toContain(D_OLDER.id);

      await click(buttonByText("Load older deliveries", panel));
      await waitFor(() => expect(getCalls(DELIVERIES_1)).toHaveLength(2));
      expect(getCalls(DELIVERIES_1)[1]![1]).toEqual(
        expect.objectContaining({ query: { limit: 50, cursor: "cur_2" } }),
      );
      await waitFor(() => expect(panel.textContent).toContain(D_OLDER.id));
      // Appended, not replaced.
      expect(panel.textContent).toContain(D_EXHAUSTED.id);
      expect(panel.textContent).toContain("3 deliveries loaded newest first.");
      expect(panel.textContent).toContain("All available deliveries are loaded.");
      expect(() => buttonByText("Load older deliveries", panel)).toThrow();
    } finally {
      unmount(root);
    }
  });

  it("platform-118: Replay names the consequence, re-checks authority, and posts with an Idempotency-Key", async () => {
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_1.url);
      await waitFor(() => expect(panel.textContent).toContain(D_EXHAUSTED.id));
      const deliveryReadsBefore = getCalls(DELIVERIES_1).length;

      await click(buttonByLabel(`Replay delivery ${D_EXHAUSTED.id}`, panel));
      const confirm = dialogTitled("Replay this live delivery?");
      expect(confirm.textContent).toContain(
        `This queues campaign.sent to ${WH_1.url} with a new delivery ID`,
      );
      expect(confirm.textContent).toContain("Otherwise side effects may repeat.");
      expect(confirm.textContent).toContain(
        `Original delivery: ${D_EXHAUSTED.id}`,
      );
      expect(postCalls(REPLAY_PATH)).toHaveLength(0);

      await click(buttonByText("Replay delivery", confirm));
      await waitFor(() => expect(postCalls(REPLAY_PATH)).toHaveLength(1));
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      const [, body, opts] = postCalls(REPLAY_PATH)[0]!;
      expect(body).toBeUndefined();
      expect(opts).toEqual(
        expect.objectContaining({
          requireOnline: true,
          maxAttempts: 1,
          cache: "no-store",
          idempotencyKey: expect.stringMatching(/\S/),
        }),
      );

      await waitFor(() =>
        expect(text()).toContain(`Replay queued as delivery ${REPLAYED_ID}`),
      );
      expect(mocks.toast.success).toHaveBeenCalledWith(
        `Delivery ${REPLAYED_ID} queued.`,
      );
      // The history is re-read so the new pending row can appear.
      await waitFor(() =>
        expect(getCalls(DELIVERIES_1).length).toBeGreaterThan(
          deliveryReadsBefore,
        ),
      );
    } finally {
      unmount(root);
    }
  });

  it("platform-118: a retry after a failed replay reuses the same Idempotency-Key and renders the server's sentence", async () => {
    const { ApiError } = await import("@/lib/api");
    let attempt = 0;
    mocks.apiPost.mockImplementation((path: string) => {
      if (path !== REPLAY_PATH) {
        return Promise.reject(new Error(`Unexpected POST ${path}`));
      }
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(
          new ApiError(
            "wait for the current delivery attempt to finish before replaying",
            409,
            undefined,
            { code: "delivery_in_progress" },
          ),
        );
      }
      return Promise.resolve({
        delivery_id: REPLAYED_ID,
        replayed_from: D_EXHAUSTED.id,
        status: "pending",
        replayed_at: "2026-09-12T10:00:00Z",
      });
    });
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_1.url);
      await waitFor(() => expect(panel.textContent).toContain(D_EXHAUSTED.id));
      await click(buttonByLabel(`Replay delivery ${D_EXHAUSTED.id}`, panel));
      const confirm = dialogTitled("Replay this live delivery?");

      await click(buttonByText("Replay delivery", confirm));
      await waitFor(() =>
        expect(confirm.textContent).toContain(
          "wait for the current delivery attempt to finish before replaying",
        ),
      );
      expect(text()).not.toContain("Replay queued as delivery");

      await click(buttonByText("Replay delivery", confirm));
      await waitFor(() => expect(postCalls(REPLAY_PATH)).toHaveLength(2));
      const firstKey = (postCalls(REPLAY_PATH)[0]![2] as {
        idempotencyKey: string;
      }).idempotencyKey;
      const secondKey = (postCalls(REPLAY_PATH)[1]![2] as {
        idempotencyKey: string;
      }).idempotencyKey;
      expect(firstKey).toMatch(/\S/);
      expect(secondKey).toBe(firstKey);
      await waitFor(() =>
        expect(text()).toContain(`Replay queued as delivery ${REPLAYED_ID}`),
      );
    } finally {
      unmount(root);
    }
  });

  it("platform-118: a receipt for a different delivery is not reported as queued", async () => {
    mocks.apiPost.mockImplementation(() =>
      Promise.resolve({
        delivery_id: REPLAYED_ID,
        replayed_from: D_OLDER.id,
        status: "pending",
        replayed_at: "2026-09-12T10:00:00Z",
      }),
    );
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_1.url);
      await waitFor(() => expect(panel.textContent).toContain(D_EXHAUSTED.id));
      await click(buttonByLabel(`Replay delivery ${D_EXHAUSTED.id}`, panel));
      const confirm = dialogTitled("Replay this live delivery?");
      await click(buttonByText("Replay delivery", confirm));
      await waitFor(() =>
        expect(confirm.textContent).toContain(
          "did not return a verifiable receipt",
        ),
      );
      expect(text()).not.toContain("Replay queued as delivery");
      expect(mocks.toast.success).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("platform-118: a downgraded fresh identity sends no replay", async () => {
    mocks.whoamiFresh.mockResolvedValue(VIEWER);
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_1.url);
      await waitFor(() => expect(panel.textContent).toContain(D_EXHAUSTED.id));
      await click(buttonByLabel(`Replay delivery ${D_EXHAUSTED.id}`, panel));
      const confirm = dialogTitled("Replay this live delivery?");
      await click(buttonByText("Replay delivery", confirm));
      await waitFor(() =>
        expect(confirm.textContent).toContain(
          "Your outbound-webhook admin authority changed",
        ),
      );
      expect(postCalls(REPLAY_PATH)).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });

  it("platform-118: replay is withheld with the reason on a paused destination", async () => {
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_2.url);
      await waitFor(() => expect(panel.textContent).toContain(D_PAUSED.id));
      const replay = buttonByLabel(`Replay delivery ${D_PAUSED.id}`, panel);
      expect(replay.disabled).toBe(true);
      const reasonId = replay.getAttribute("aria-describedby");
      expect(reasonId).toBeTruthy();
      expect(document.getElementById(reasonId!)?.textContent).toContain(
        "Resume this destination before replaying deliveries.",
      );
      expect(mocks.apiPost).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("platform-117: the panel itself asks the server for nothing when the caller is not an admin", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    const { OutboundWebhookDeliveriesPanel } =
      await import("@/app/(dashboard)/app/routing/outbound-webhooks/outbound-webhook-deliveries");
    const root = await render(
      createElement(OutboundWebhookDeliveriesPanel, {
        webhook: WH_1,
        onClose: () => undefined,
      }),
    );
    try {
      await waitFor(() =>
        expect(text()).toContain("Administrator access required"),
      );
      expect(text()).toContain("No delivery history was requested.");
      expect(mocks.apiGet).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("platform-120: the health card reads /health and renders the trailing 24-hour aggregate", async () => {
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_1.url);
      await waitFor(() =>
        expect(panel.textContent).toContain("Health · trailing 24 hours"),
      );
      expect(getCalls(HEALTH_1)).toHaveLength(1);
      expect(getCalls(HEALTH_1)[0]![1]).toEqual(
        expect.objectContaining({
          requireOnline: true,
          maxAttempts: 1,
          signal: expect.any(AbortSignal),
        }),
      );
      const health = panel.querySelector(
        'section[aria-label="Destination health, trailing 24 hours"]',
      )!;
      expect(health.textContent).toContain("90.0%");
      expect(health.textContent).toContain("9 of 10 completed");
      expect(health.textContent).toContain("Watch");
      expect(health.textContent).toContain("p50 120ms");
      expect(health.textContent).toContain("p99 900ms");
      expect(health.textContent).toContain("upstream exploded");
      expect(health.textContent).toContain("Cancelled2");
    } finally {
      unmount(root);
    }
  });

  it("platform-120: a zero-delivery window says so instead of rendering 0%", async () => {
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_2.url);
      await waitFor(() =>
        expect(panel.textContent).toContain(
          "No webhook deliveries were recorded in the trailing 24 hours.",
        ),
      );
      expect(panel.textContent).not.toContain("0.0%");
    } finally {
      unmount(root);
    }
  });

  it("platform-120: a failed health read renders the failure and Retry re-reads it", async () => {
    let healthReads = 0;
    const base = mocks.apiGet.getMockImplementation()!;
    mocks.apiGet.mockImplementation((path: string, opts?: GetOptions) => {
      if (path === HEALTH_1) {
        healthReads += 1;
        return healthReads === 1
          ? Promise.reject(new Error("health store unavailable"))
          : Promise.resolve(HEALTH);
      }
      return base(path, opts);
    });
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_1.url);
      await waitFor(() =>
        expect(panel.textContent).toContain(
          "Couldn't load webhook health: health store unavailable",
        ),
      );
      expect(panel.textContent).not.toContain("0.0%");
      await click(buttonByText("Retry health", panel));
      await waitFor(() => expect(getCalls(HEALTH_1)).toHaveLength(2));
      await waitFor(() => expect(panel.textContent).toContain("90.0%"));
    } finally {
      unmount(root);
    }
  });

  it("platform-121: the verification snippet copies the algorithm's verifier for the chosen language", async () => {
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_1.url);
      await click(buttonByText("Show verification snippet", panel));
      const dialog = dialogTitled("Verify webhook signature");
      expect(dialog.textContent).toContain(
        "Verify X-Postwave-Signature using HMAC-SHA256",
      );

      await click(buttonByText("Copy snippet", dialog));
      await waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(1));
      const node = mocks.writeText.mock.calls[0]![0];
      expect(node).toContain("crypto.createHmac('sha256', secret)");
      expect(node).toContain("p.startsWith('v1=')");
      await waitFor(() =>
        expect(dialog.textContent).toContain(
          "Node.js verification snippet copied to the clipboard.",
        ),
      );

      const pythonTab = [
        ...dialog.querySelectorAll<HTMLElement>('[role="tab"]'),
      ].find((tab) => tab.textContent === "Python")!;
      await click(pythonTab);
      await waitFor(() =>
        expect(pythonTab.getAttribute("aria-selected")).toBe("true"),
      );
      await click(buttonByText("Copy snippet", dialog));
      await waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(2));
      const python = mocks.writeText.mock.calls[1]![0];
      expect(python).toContain("def verify_postwave(");
      expect(python).toContain("hashlib.sha256");
      expect(python).not.toContain("whsec_");
    } finally {
      unmount(root);
    }
  });

  it("platform-121: an ed25519 destination gets the v3 public-key verifier, and a rejected write says so", async () => {
    mocks.writeText.mockRejectedValueOnce(new Error("denied"));
    const root = await mountPage();
    try {
      const panel = await openDeliveries(WH_2.url);
      await click(buttonByText("Show verification snippet", panel));
      const dialog = dialogContaining("Verify X-Postwave-Signature using Ed25519");

      await click(buttonByText("Copy snippet", dialog));
      await waitFor(() =>
        expect(dialog.textContent).toContain(
          "The clipboard write was rejected.",
        ),
      );
      await click(buttonByText("Copy snippet", dialog));
      await waitFor(() => expect(mocks.writeText).toHaveBeenCalledTimes(2));
      const snippet = mocks.writeText.mock.calls[1]![0];
      expect(snippet).toContain("p.startsWith('v3=')");
      expect(snippet).toContain("crypto.verify(null, payload, publicKeyPem");
    } finally {
      unmount(root);
    }
  });
});

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

import type { OutboundWebhook } from "../../lib/api-client";
import type { FireResponse } from "../../components/webhook-simulator/ResponseInspector";

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  listWebhooks: vi.fn(),
  listEvents: vi.fn(),
  fire: vi.fn(),
  getFire: vi.fn(),
  recoveryLoad: vi.fn(),
  recoveryPrepare: vi.fn(),
  recoverySettle: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  getApiUrl: () => "https://api.example.com",
  listOutboundWebhooks: mocks.listWebhooks,
  api: {
    listWebhookPlaygroundEvents: mocks.listEvents,
    fireWebhookPlayground: mocks.fire,
    getWebhookPlaygroundFire: mocks.getFire,
  },
}));

vi.mock("../../lib/webhook-playground-fire-recovery", () => ({
  createWebhookPlaygroundFireRecoveryAuthority: () => ({
    apiBaseUrl: "https://api.example.com",
    apiIdentityGeneration: 0,
    credentialSource: "session",
    principal: "22222222-2222-4222-8222-222222222222",
    scope: `v1-session-${"a".repeat(64)}`,
    tenant: "33333333-3333-4333-8333-333333333333",
  }),
  webhookPlaygroundFireRecovery: {
    load: mocks.recoveryLoad,
    prepare: mocks.recoveryPrepare,
    settle: mocks.recoverySettle,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("../../components/webhook-simulator/ResponseInspector", () => ({
  ResponseInspector: ({ response }: { response: FireResponse }) => (
    <div data-testid="response-status">status {response.status_code}</div>
  ),
  sanitizeInspectableUrl: (url: string) => ({ url, redactedCount: 0 }),
}));

vi.mock("../../components/webhook-simulator/SavedPayloadsPanel", () => ({
  SavedPayloadsPanel: () => <div>Saved payloads</div>,
}));

vi.mock("../../components/webhook-simulator/RecentFiresPanel", () => ({
  RecentFiresPanel: ({ fires }: { fires: Array<{ filtered: boolean }> }) => (
    <div>
      Recent fires: {fires.length} · Filtered:{" "}
      {fires.filter((fire) => fire.filtered).length}
    </div>
  ),
}));

vi.mock("../../components/webhooks/VerificationSnippetDialog", () => ({
  VerificationSnippetDialog: ({
    open,
    signingAlgorithm,
  }: {
    open: boolean;
    signingAlgorithm: string;
  }) =>
    open ? (
      <div data-testid="verification-algorithm">{signingAlgorithm}</div>
    ) : null,
}));

vi.mock("../../lib/heroAssets", () => ({
  HERO: { webhookSimulator: "hero.png" },
}));

vi.mock("../../lib/store", () => ({
  setSection: vi.fn(),
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => ({
    credentialFingerprint: null,
    credentialSource: "session",
    user: "22222222-2222-4222-8222-222222222222",
    tenant: "33333333-3333-4333-8333-333333333333",
    webhookPlaygroundRecoveryScope: "a".repeat(64),
  }),
}));

import { WebhookSimulator } from "../../pages/WebhookSimulator";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const WEBHOOK_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_WEBHOOK_ID = "44444444-4444-4444-8444-444444444444";

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function") mock.mockReset();
  }
  mocks.listEvents.mockResolvedValue({
    data: {
      events: [
        {
          event_type: "subscriber.added",
          sample_payload: { email: "reader@example.com" },
        },
      ],
    },
  });
  mocks.fire.mockResolvedValue({ data: fireResponse() });
  mocks.recoveryLoad.mockResolvedValue({ status: "clear" });
  mocks.recoveryPrepare.mockImplementation(async (_authority, snapshot) => ({
    status: "ready",
    snapshot,
  }));
  mocks.recoverySettle.mockResolvedValue({ status: "cleared" });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function webhook(
  environment: "production" | "staging" | "development" = "staging",
): OutboundWebhook {
  return {
    id: WEBHOOK_ID,
    tenant_id: "tenant-1",
    url: "https://hooks.example.com/postwave",
    description: "Primary handler",
    events: ["subscriber.added"],
    active: true,
    created_at: "2026-07-15T08:00:00.000Z",
    updated_at: "2026-07-15T08:00:00.000Z",
    config_version: 1,
    consecutive_failures: 0,
    signing_algorithm: "hmac_sha256",
    auth_config_status: "ready",
    url_status: "ready",
    delivery_policy_status: "ready",
    environment,
  };
}

function fireResponse(): FireResponse {
  const fireId = "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6d";
  return {
    fire_id: fireId,
    event_id: "11111111-1111-5111-8111-111111111111",
    delivery_id: `playground-${fireId}`,
    url: "https://hooks.example.com/postwave",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { email: "reader@example.com" },
    signature: "sha256=abc",
    requested_at: "2026-07-15T08:00:00.000Z",
    status_code: 202,
    response_body: "accepted",
    latency_ms: 25,
    outcome: "receiver_responded",
    ambiguous: false,
    response_body_truncated: false,
  };
}

async function confirmLiveFire(): Promise<void> {
  await act(async () => {
    button("Fire event").click();
    await Promise.resolve();
  });
  await act(async () => {
    button("Send this one logical fire").click();
    await Promise.resolve();
  });
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function setPayload(value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Payload JSON"]',
  );
  if (!textarea) throw new Error("Missing payload editor");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function selectEvent(value: string): void {
  const selects = Array.from(
    document.querySelectorAll<HTMLSelectElement>("select"),
  );
  const eventSelect = selects.find((select) =>
    Array.from(select.options).some((option) => option.value === value),
  );
  if (!eventSelect) throw new Error(`Missing event option: ${value}`);
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(eventSelect, value);
    eventSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("WebhookSimulator", () => {
  it("fails closed for non-admins without loading protected catalogs", () => {
    mocks.canAdmin = false;

    render(<WebhookSimulator />);

    expect(document.body.textContent).toContain(
      "Workspace admin access is required",
    );
    expect(document.body.textContent).toContain(
      "No simulator catalog or destination data was loaded",
    );
    expect(mocks.listWebhooks).not.toHaveBeenCalled();
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });

  it("warns that retained inspection receipts require synthetic data", () => {
    render(<WebhookSimulator />);

    expect(document.body.textContent).toContain("Use synthetic data only");
    expect(document.body.textContent).toContain(
      "envelope-encrypted private receipt",
    );
    expect(document.body.textContent).toContain("newest 100 matches");
    expect(document.body.textContent).toContain("no alias expansion");
    expect(document.body.textContent).toContain(
      "public erasure remains coverage-gated and unavailable",
    );
    expect(document.body.textContent).toContain(
      "name, phone, or ID without that email is not discoverable",
    );
    expect(document.body.textContent).toContain(
      "access-bundle copies are outside this receipt lifecycle",
    );
    expect(document.body.textContent).toContain(
      "payload-free fire identity remains to prevent redispatch",
    );
  });

  it("confirms and fires a validated payload at every real destination", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    act(() => button("Fire event").click());
    expect(mocks.fire).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Send a real signed webhook request?",
    );
    await act(async () => {
      button("Send this one logical fire").click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mocks.fire).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("status 202");
      expect(document.body.textContent).toContain("Recent fires: 1");
    });
    const [id, body, options] = mocks.fire.mock.calls[0] ?? [];
    expect(id).toBe(WEBHOOK_ID);
    expect(body).toMatchObject({
      fire_id: expect.any(String),
      event_type: "subscriber.added",
      expected_webhook_config_version: 1,
      payloadJSON: expect.stringContaining('"email": "reader@example.com"'),
    });
    expect(options).toMatchObject({
      idempotencyKey: `webhook-playground:${body.fire_id}`,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.recoveryPrepare).toHaveBeenCalledTimes(1);
    expect(mocks.recoverySettle).toHaveBeenCalledTimes(1);
    expect(mocks.recoveryPrepare.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.fire.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.fire.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recoverySettle.mock.invocationCallOrder[0] ?? 0,
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("refuses dispatch when the exact encrypted checkpoint cannot be prepared", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.recoveryPrepare.mockResolvedValueOnce({
      status: "held",
      reason: "vault-unavailable",
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "encrypted local vault is unavailable",
      ),
    );
    expect(mocks.fire).not.toHaveBeenCalled();
    expect(mocks.recoverySettle).not.toHaveBeenCalled();
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
  });

  it("blocks all new fires when recovery inventory belongs to a foreign identity scope", async () => {
    mocks.recoveryLoad.mockResolvedValueOnce({
      status: "held",
      reason: "foreign-checkpoint",
    });
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });

    render(<WebhookSimulator />);

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "exists outside the current API scope",
      ),
    );
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
    expect(mocks.recoveryPrepare).not.toHaveBeenCalled();
    expect(mocks.fire).not.toHaveBeenCalled();
  });

  it("does not dispatch after an unmount while checkpoint preparation is pending", async () => {
    const preparing = deferred<{
      status: "ready";
      snapshot: {
        fireId: string;
        idempotencyKey: string;
        webhookId: string;
        expectedWebhookConfigVersion: number;
        eventType: string;
        payloadJSON: string;
      };
    }>();
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.recoveryPrepare.mockReturnValueOnce(preparing.promise);
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() => expect(mocks.recoveryPrepare).toHaveBeenCalledTimes(1));
    const preparedSnapshot = mocks.recoveryPrepare.mock.calls[0]?.[1];
    if (!preparedSnapshot) throw new Error("missing prepared snapshot");
    act(() => {
      root?.unmount();
      root = null;
    });
    await act(async () => {
      preparing.resolve({ status: "ready", snapshot: preparedSnapshot });
      await preparing.promise;
      await Promise.resolve();
    });

    expect(mocks.fire).not.toHaveBeenCalled();
    expect(mocks.recoverySettle).not.toHaveBeenCalled();
  });

  it("ignores a delayed encrypted checkpoint load after unmount", async () => {
    const loading = deferred<unknown>();
    let resultReads = 0;
    const lateResult = {};
    Object.defineProperty(lateResult, "status", {
      get: () => {
        resultReads += 1;
        throw new Error("unmounted recovery result was consumed");
      },
    });
    mocks.recoveryLoad.mockReturnValueOnce(loading.promise);

    render(<WebhookSimulator />);
    await waitFor(() => expect(mocks.recoveryLoad).toHaveBeenCalledTimes(1));
    act(() => {
      root?.unmount();
      root = null;
    });
    await act(async () => {
      loading.resolve(lateResult);
      await loading.promise;
      await Promise.resolve();
    });

    expect(resultReads).toBe(0);
    expect(mocks.fire).not.toHaveBeenCalled();
  });

  it("restores a crash checkpoint and reuses its exact request identity", async () => {
    const recoveredFireID = "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6e";
    const recoveredSnapshot = {
      fireId: recoveredFireID,
      idempotencyKey: `webhook-playground:${recoveredFireID}`,
      webhookId: WEBHOOK_ID,
      expectedWebhookConfigVersion: 1,
      eventType: "subscriber.added",
      payloadJSON: '{\n  "large": 9007199254740993\n}',
    };
    mocks.recoveryLoad.mockResolvedValueOnce({
      status: "ready",
      snapshot: recoveredSnapshot,
    });
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.getFire.mockResolvedValueOnce({
      data: {
        fire_id: recoveredFireID,
        webhook_id: WEBHOOK_ID,
        event_type: "subscriber.added",
        delivery_id: `playground-${recoveredFireID}`,
        state: "completed",
        outcome: "receiver_responded",
        receiver_status_code: 202,
        response_body_truncated: false,
        created_at: "2026-07-15T08:00:00.000Z",
        completed_at: "2026-07-15T08:00:01.000Z",
      },
    });
    mocks.fire.mockResolvedValueOnce({
      data: { ...fireResponse(), fire_id: recoveredFireID },
    });

    render(<WebhookSimulator />);
    await waitFor(() => expect(button("Check server receipt")).toBeTruthy());
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Payload JSON"]',
      )?.value,
    ).toBe(recoveredSnapshot.payloadJSON);
    expect(document.body.textContent).toContain(
      "restored this exact fire identity",
    );

    await act(async () => {
      button("Check server receipt").click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(button("Restore retained response")).toBeTruthy(),
    );
    await act(async () => {
      button("Restore retained response").click();
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(1));

    expect(mocks.recoveryPrepare).not.toHaveBeenCalled();
    expect(mocks.fire).toHaveBeenCalledWith(
      WEBHOOK_ID,
      {
        fire_id: recoveredFireID,
        event_type: recoveredSnapshot.eventType,
        expected_webhook_config_version: 1,
        payloadJSON: recoveredSnapshot.payloadJSON,
      },
      expect.objectContaining({
        idempotencyKey: recoveredSnapshot.idempotencyKey,
      }),
    );
    expect(mocks.recoverySettle).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: `v1-session-${"a".repeat(64)}`,
      }),
      recoveredSnapshot,
    );
  });

  it("keeps a recovered checkpoint fenced when its retry is rate-limited", async () => {
    const recoveredFireID = "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6e";
    const recoveredSnapshot = {
      fireId: recoveredFireID,
      idempotencyKey: `webhook-playground:${recoveredFireID}`,
      webhookId: WEBHOOK_ID,
      expectedWebhookConfigVersion: 1,
      eventType: "subscriber.added",
      payloadJSON: '{"email":"reader@example.com"}',
    };
    mocks.recoveryLoad.mockResolvedValueOnce({
      status: "ready",
      snapshot: recoveredSnapshot,
    });
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.getFire.mockResolvedValueOnce({
      data: {
        fire_id: recoveredFireID,
        webhook_id: WEBHOOK_ID,
        event_type: recoveredSnapshot.eventType,
        delivery_id: `playground-${recoveredFireID}`,
        state: "completed",
        outcome: "receiver_responded",
        receiver_status_code: 202,
        response_body_truncated: false,
        created_at: "2026-07-15T08:00:00.000Z",
        completed_at: "2026-07-15T08:00:01.000Z",
      },
    });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 429,
        code: "rate_limited",
        message: "Retry later.",
      },
    });

    render(<WebhookSimulator />);
    await waitFor(() => expect(button("Check server receipt")).toBeTruthy());
    await act(async () => {
      button("Check server receipt").click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(button("Restore retained response")).toBeTruthy(),
    );
    await act(async () => {
      button("Restore retained response").click();
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(1));

    expect(mocks.recoveryPrepare).not.toHaveBeenCalled();
    expect(mocks.recoverySettle).not.toHaveBeenCalled();
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
  });

  it("clears a recovered checkpoint after the exact expired-identity tombstone", async () => {
    const recoveredFireID = "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6e";
    const recoveredSnapshot = {
      fireId: recoveredFireID,
      idempotencyKey: `webhook-playground:${recoveredFireID}`,
      webhookId: WEBHOOK_ID,
      expectedWebhookConfigVersion: 1,
      eventType: "subscriber.added",
      payloadJSON: '{"email":"reader@example.com"}',
    };
    mocks.recoveryLoad.mockResolvedValueOnce({
      status: "ready",
      snapshot: recoveredSnapshot,
    });
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.getFire.mockResolvedValueOnce({
      data: {
        fire_id: recoveredFireID,
        webhook_id: WEBHOOK_ID,
        event_type: recoveredSnapshot.eventType,
        delivery_id: `playground-${recoveredFireID}`,
        state: "completed",
        outcome: "receiver_responded",
        receiver_status_code: 202,
        response_body_truncated: false,
        created_at: "2026-07-15T08:00:00.000Z",
        completed_at: "2026-07-15T08:00:01.000Z",
      },
    });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 410,
        code: "playground_fire_receipt_expired",
        message: "This fire identity remains consumed.",
        details: {
          fire_id: recoveredFireID,
          state: "receipt_expired",
        },
      },
    });

    render(<WebhookSimulator />);
    await waitFor(() => expect(button("Check server receipt")).toBeTruthy());
    await act(async () => {
      button("Check server receipt").click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(button("Restore retained response")).toBeTruthy(),
    );
    await act(async () => {
      button("Restore retained response").click();
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.recoverySettle).toHaveBeenCalledTimes(1));
    expect(mocks.recoveryPrepare).not.toHaveBeenCalled();
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("false");
  });

  it("keeps the local fence when an expiry tombstone names another fire", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 410,
        code: "playground_fire_receipt_expired",
        message: "This fire identity remains consumed.",
        details: {
          fire_id: "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6e",
          state: "receipt_expired",
        },
      },
    });

    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
    await confirmLiveFire();

    await waitFor(() =>
      expect(document.body.textContent).toContain("unknown receiver outcome"),
    );
    expect(mocks.recoverySettle).not.toHaveBeenCalled();
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
  });

  it("clears a newly prepared checkpoint after a trustworthy initial 429 refusal", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 429,
        code: "rate_limited",
        message: "Retry later.",
      },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();

    await waitFor(() => expect(mocks.recoverySettle).toHaveBeenCalledTimes(1));
    expect(mocks.recoveryPrepare).toHaveBeenCalledTimes(1);
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("false");
  });

  it("keeps a resolved fire fenced until encrypted checkpoint cleanup succeeds", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.recoverySettle
      .mockResolvedValueOnce({
        status: "held",
        reason: "vault-unavailable",
      })
      .mockResolvedValueOnce({ status: "cleared" });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() => expect(button("Retry encrypted cleanup")).toBeTruthy());
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
    expect(mocks.fire).toHaveBeenCalledTimes(1);

    await act(async () => {
      button("Retry encrypted cleanup").click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
    expect(mocks.fire).toHaveBeenCalledTimes(1);
    expect(mocks.recoverySettle).toHaveBeenCalledTimes(2);
  });

  it("retains the immutable payload snapshot through live confirmation", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("production")] },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    act(() => button("Fire event").click());
    expect(mocks.fire).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Send a real signed webhook request?",
    );
    setPayload('{"changedAfterConfirmation":true}');
    await act(async () => {
      button("Send this one logical fire").click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mocks.fire).toHaveBeenCalledWith(
        WEBHOOK_ID,
        expect.objectContaining({
          fire_id: expect.any(String),
          event_type: "subscriber.added",
          expected_webhook_config_version: 1,
          payloadJSON: expect.stringContaining('"email": "reader@example.com"'),
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringMatching(/^webhook-playground:/u),
        }),
      );
    });
  });

  it("rejects invalid JSON and labels placeholder catalog samples honestly", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.listEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_type: "order.created",
            sample_payload: {
              note: "no sample payload registered for order.created",
            },
          },
        ],
      },
    });
    render(<WebhookSimulator />);
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "the pre-filled body is a placeholder",
      );
    });
    setPayload("{");
    act(() => button("Fire event").click());

    expect(mocks.fire).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Payload isn't valid JSON"),
    );
  });

  it("rejects escaped-equivalent duplicate payload members before review", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    setPayload('{"name": 1, "\\u006eame": 2}');
    act(() => button("Fire event").click());

    expect(mocks.fire).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("duplicate object member names"),
    );
  });

  it("rejects payload complexity before opening the live-send review", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
    let nested: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 25; depth += 1) {
      nested = { child: nested };
    }
    setPayload(JSON.stringify(nested));
    act(() => button("Fire event").click());

    expect(mocks.fire).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Payload exceeds simulator limits"),
    );
    expect(document.body.textContent).toContain("JSON depth or node limit");
  });

  it("keeps an empty payload unavailable with a visible reason", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
    setPayload("");

    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Enter a JSON object in the payload editor before firing",
    );
    act(() => button("Fire event").click());
    expect(mocks.fire).not.toHaveBeenCalled();
  });

  it("pages webhook targets without preloading the whole workspace", async () => {
    const second = {
      ...webhook("staging"),
      id: SECOND_WEBHOOK_ID,
      description: "Secondary handler",
      url: "https://hooks.example.com/secondary",
    };
    mocks.listWebhooks
      .mockResolvedValueOnce({
        data: { webhooks: [webhook("staging")], next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({
        data: { webhooks: [second], next_cursor: "" },
      });

    render(<WebhookSimulator />);
    await waitFor(() => expect(button("Load more targets")).toBeTruthy());
    act(() => button("Load more targets").click());
    await waitFor(() => {
      const options = Array.from(
        document.querySelectorAll<HTMLSelectElement>("select"),
      )[0]?.options;
      expect(options).toHaveLength(2);
      expect(document.body.textContent).toContain("Secondary handler");
    });

    expect(mocks.listWebhooks).toHaveBeenNthCalledWith(1, { limit: 200 });
    expect(mocks.listWebhooks).toHaveBeenNthCalledWith(2, {
      limit: 200,
      cursor: "page-2",
    });
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Load more targets",
      ),
    ).toBe(false);
  });

  it("blocks paused or unready targets before any live request", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: {
        webhooks: [{ ...webhook("staging"), active: false }],
        next_cursor: "",
      },
    });

    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Resume this paused webhook before firing",
      ),
    );

    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
    act(() => button("Fire event").click());
    expect(mocks.fire).not.toHaveBeenCalled();
  });

  it("uses the selected asymmetric signer in copy and verifier help", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: {
        webhooks: [
          {
            ...webhook("staging"),
            signing_algorithm: "ecdsa_p256",
            signing_public_key: "PUBLIC KEY",
          },
        ],
        next_cursor: "",
      },
    });

    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "one real ECDSA P-256-signed POST",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "one real HMAC-SHA256-signed POST",
    );
    act(() => button("Verify signature →").click());
    expect(
      document.querySelector('[data-testid="verification-algorithm"]')
        ?.textContent,
    ).toBe("ecdsa_p256");
  });

  it("locks live fire when a retained catalog fails to refresh", async () => {
    mocks.listWebhooks
      .mockResolvedValueOnce({
        data: { webhooks: [webhook("staging")], next_cursor: "" },
      })
      .mockRejectedValueOnce(new Error("refresh unavailable"));

    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
    act(() => button("Refresh catalog").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("refresh unavailable"),
    );

    expect(document.body.textContent).toContain("Primary handler");
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Refresh the simulator catalog successfully before firing",
    );
    act(() => button("Fire event").click());
    expect(mocks.fire).not.toHaveBeenCalled();
  });

  it("locks target and payload controls while a fire is in flight", async () => {
    const firing = deferred<{ data: FireResponse }>();
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockReturnValueOnce(firing.promise);
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Payload JSON"]',
      )?.disabled,
    ).toBe(true);
    expect(
      Array.from(document.querySelectorAll<HTMLSelectElement>("select")).every(
        (select) => select.disabled,
      ),
    ).toBe(true);

    firing.resolve({ data: fireResponse() });
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
  });

  it("owns a synchronous transport ambiguity and forbids a new-identity retry", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockImplementationOnce(() => {
      throw new Error("transport unavailable");
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    act(() => button("Fire event").click());
    const confirmButton = button("Send this one logical fire");
    await act(async () => {
      confirmButton.click();
      confirmButton.click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mocks.fire).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("transport unavailable");
      expect(button("Check server receipt")).toBeTruthy();
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
      expect(document.body.textContent).not.toContain("Retry fire");
    });
  });

  it("does not misclassify a local configuration refusal as receiver ambiguity", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "invalid_config",
        code: "identity_transition",
        message: "The local API identity changed before the request was sent.",
      },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The local API identity changed before the request was sent",
      ),
    );

    expect(document.body.textContent).not.toContain("Check server receipt");
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("false");
  });

  it("restores a completed receipt with the exact same logical fire identity", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire
      .mockResolvedValueOnce({
        error: {
          kind: "timeout",
          code: "request_timeout",
          message: "The desktop timed out after dispatch may have started.",
        },
      })
      .mockResolvedValueOnce({ data: fireResponse() });
    mocks.getFire.mockImplementationOnce(async (fireId: string) => ({
      data: {
        fire_id: fireId,
        webhook_id: "11111111-1111-4111-8111-111111111111",
        event_type: "subscriber.added",
        delivery_id: `playground-${fireId}`,
        state: "completed",
        outcome: "receiver_responded",
        receiver_status_code: 202,
        response_body_truncated: false,
        created_at: "2026-07-15T08:00:00.000Z",
        completed_at: "2026-07-15T08:00:01.000Z",
      },
    }));
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() => expect(button("Check server receipt")).toBeTruthy());
    const firstCall = mocks.fire.mock.calls[0];
    await act(async () => {
      button("Check server receipt").click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(button("Restore retained response")).toBeTruthy(),
    );
    await act(async () => {
      button("Restore retained response").click();
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.fire).toHaveBeenCalledTimes(2));

    expect(mocks.getFire).toHaveBeenCalledWith(firstCall?.[1].fire_id, {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.fire.mock.calls[1]?.[0]).toBe(firstCall?.[0]);
    expect(mocks.fire.mock.calls[1]?.[1]).toEqual(firstCall?.[1]);
    expect(mocks.fire.mock.calls[1]?.[2].idempotencyKey).toBe(
      firstCall?.[2].idempotencyKey,
    );
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("false");
    expect(document.body.textContent).toContain("status 202");
  });

  it("makes cancellation explicit and moves the retained fire into reconciliation", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockImplementationOnce(
      async (_id: string, _body: unknown, options: { signal: AbortSignal }) =>
        await new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                error: {
                  kind: "network",
                  code: "aborted",
                  message: "Stopped waiting for the API response.",
                },
              }),
            { once: true },
          );
        }),
    );
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    expect(button("Stop waiting & reconcile")).toBeTruthy();
    await act(async () => {
      button("Stop waiting & reconcile").click();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(button("Check server receipt")).toBeTruthy();
      expect(document.body.textContent).toContain(
        "cancellation cannot recall a receiver request",
      );
    });
    expect(mocks.fire).toHaveBeenCalledTimes(1);
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
  });

  it("stops a receipt lookup without downgrading or releasing its fire fence", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "timeout",
        code: "request_timeout",
        message: "The original response was not received.",
      },
    });
    mocks.getFire.mockImplementationOnce(
      async (_fireId: string, options: { signal: AbortSignal }) =>
        await new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                error: {
                  kind: "network",
                  code: "aborted",
                  message: "Request was cancelled.",
                },
              }),
            { once: true },
          );
        }),
    );
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() => expect(button("Check server receipt")).toBeTruthy());
    act(() => button("Check server receipt").click());
    await waitFor(() => expect(button("Stop receipt check")).toBeTruthy());
    await act(async () => {
      button("Stop receipt check").click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(button("Check server receipt")).toBeTruthy();
      expect(document.body.textContent).toContain(
        "existing reconciliation fence remains in place",
      );
    });
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
    expect(mocks.getFire).toHaveBeenCalledTimes(1);
  });

  it("keeps a pending receipt fenced without offering ambiguity acknowledgment", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "timeout",
        code: "request_timeout",
        message: "The original response was not received.",
      },
    });
    mocks.getFire.mockImplementationOnce(async (fireId: string) => ({
      data: {
        fire_id: fireId,
        webhook_id: "11111111-1111-4111-8111-111111111111",
        event_type: "subscriber.added",
        delivery_id: `playground-${fireId}`,
        state: "pending",
        outcome: "pending",
        receiver_status_code: 0,
        response_body_truncated: false,
        created_at: "2026-07-15T08:00:00.000Z",
      },
    }));
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() => expect(button("Check server receipt")).toBeTruthy());
    await act(async () => {
      button("Check server receipt").click();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The server reserved this fire and is still waiting",
      ),
    );
    expect(document.body.textContent).toContain(
      "Resolve the previous logical fire before creating another.",
    );
    expect(document.body.textContent).not.toContain("I checked the receiver");
    expect(document.body.textContent).not.toContain("Allow a new logical fire");
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
  });

  it("cleans up an expired private receipt without redispatching", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "timeout",
        code: "request_timeout",
        message: "The original response was not received.",
      },
    });
    mocks.getFire.mockImplementationOnce(async (fireId: string) => ({
      data: {
        fire_id: fireId,
        webhook_id: WEBHOOK_ID,
        event_type: "subscriber.added",
        delivery_id: `playground-${fireId}`,
        state: "receipt_expired",
        outcome: "receiver_responded",
        receiver_status_code: 202,
        response_body_truncated: false,
        created_at: "2026-07-15T08:00:00.000Z",
        completed_at: "2026-07-15T08:00:01.000Z",
      },
    }));
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() => expect(button("Check server receipt")).toBeTruthy());
    await act(async () => {
      button("Check server receipt").click();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(button("Clear local recovery checkpoint")).toBeTruthy(),
    );
    expect(document.body.textContent).toContain(
      "permanently fences this fire identity from redispatch",
    );
    expect(mocks.fire).toHaveBeenCalledTimes(1);
    await act(async () => {
      button("Clear local recovery checkpoint").click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
    expect(mocks.recoverySettle).toHaveBeenCalledTimes(1);
    expect(mocks.fire).toHaveBeenCalledTimes(1);
  });

  it("keeps recovery fenced when the receipt identity mismatches", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "timeout",
        code: "request_timeout",
        message: "The original response was not received.",
      },
    });
    mocks.getFire.mockImplementationOnce(async (fireId: string) => ({
      data: {
        fire_id: fireId,
        webhook_id: WEBHOOK_ID,
        event_type: "order.created",
        delivery_id: `playground-${fireId}`,
        state: "completed",
        outcome: "receiver_responded",
        receiver_status_code: 202,
        response_body_truncated: false,
        created_at: "2026-07-15T08:00:00.000Z",
        completed_at: "2026-07-15T08:00:01.000Z",
      },
    }));
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() => expect(button("Check server receipt")).toBeTruthy());
    await act(async () => {
      button("Check server receipt").click();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "server receipt identity did not match",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "Restore retained response",
    );
    expect(document.body.textContent).not.toContain(
      "Clear local recovery checkpoint",
    );
    expect(button("Fire event").getAttribute("aria-disabled")).toBe("true");
    expect(mocks.recoverySettle).not.toHaveBeenCalled();
  });

  it("requires human acknowledgment for a durable transport-ambiguous outcome", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockResolvedValueOnce({
      data: {
        ...fireResponse(),
        status_code: 0,
        response_body: "",
        error: "receiver connection ended without a status",
        outcome: "transport_ambiguous",
        ambiguous: true,
      },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() =>
      expect(button("Allow a new logical fire").disabled).toBe(true),
    );
    const acknowledgment = document.querySelector<HTMLInputElement>(
      '.wh-simulator-ambiguity-ack input[type="checkbox"]',
    );
    expect(acknowledgment).toBeTruthy();
    act(() => acknowledgment?.click());
    expect(button("Allow a new logical fire").disabled).toBe(false);
    await act(async () => {
      button("Allow a new logical fire").click();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
    expect(document.body.textContent).not.toContain("Retry fire");
  });

  it("requires a catalog refresh after the server rejects a stale target revision", async () => {
    mocks.listWebhooks
      .mockResolvedValueOnce({
        data: { webhooks: [webhook("staging")], next_cursor: "" },
      })
      .mockResolvedValueOnce({
        data: {
          webhooks: [
            {
              ...webhook("staging"),
              updated_at: "2026-07-15T08:05:00.000Z",
              config_version: 2,
            },
          ],
          next_cursor: "",
        },
      });
    mocks.fire.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 409,
        code: "webhook_changed",
        message: "Destination changed.",
      },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "The destination changed since this catalog snapshot",
      );
      expect(button("Refresh target")).toBeTruthy();
    });
    act(() => button("Refresh target").click());
    await waitFor(() => {
      expect(mocks.listWebhooks).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).not.toContain("Refresh target");
    });
    expect(mocks.fire).toHaveBeenCalledTimes(1);
  });

  it("records filtered evaluations as filtered rather than ordinary 204 fires", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.fire.mockResolvedValueOnce({
      data: {
        ...fireResponse(),
        status_code: 204,
        headers: {},
        signature: "",
        response_body: "",
        filtered: true,
        outcome: "filtered",
      },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );

    await confirmLiveFire();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Filtered: 1"),
    );
  });

  it("preserves an edited payload until replacement is explicitly confirmed", async () => {
    mocks.listWebhooks.mockResolvedValueOnce({
      data: { webhooks: [webhook("staging")] },
    });
    mocks.listEvents.mockResolvedValueOnce({
      data: {
        events: [
          {
            event_type: "subscriber.added",
            sample_payload: { email: "reader@example.com" },
          },
          {
            event_type: "campaign.sent",
            sample_payload: { campaign_id: "campaign-2" },
          },
        ],
      },
    });
    render(<WebhookSimulator />);
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
    setPayload('{"custom":true}');
    selectEvent("campaign.sent");

    expect(document.body.textContent).toContain("Replace the edited payload?");
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Payload JSON"]',
      )?.value,
    ).toBe('{"custom":true}');
    await act(async () => {
      button("Replace payload").click();
      await Promise.resolve();
    });
    expect(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Payload JSON"]',
      )?.value,
    ).toContain('"campaign_id": "campaign-2"');
  });

  it("recovers from a synchronous catalog failure and is axe-clean", async () => {
    mocks.listWebhooks
      .mockImplementationOnce(() => {
        throw new Error("catalog transport failed");
      })
      .mockResolvedValueOnce({ data: { webhooks: [webhook("staging")] } });
    render(<WebhookSimulator />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("catalog transport failed");
    });
    act(() => button("Retry").click());
    await waitFor(() =>
      expect(button("Fire event").getAttribute("aria-disabled")).toBe("false"),
    );
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
});

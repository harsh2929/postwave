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
  sendProductEvent: vi.fn(),
  createSequence: vi.fn(),
  createAutomationJourney: vi.fn(),
  listConversions: vi.fn(),
  listConversionKeys: vi.fn(),
  createConversionKey: vi.fn(),
  revokeConversionKey: vi.fn(),
  listIngestSecrets: vi.fn(),
  issueIngestSecret: vi.fn(),
  revokeIngestSecret: vi.fn(),
  writeClipboardText: vi.fn(),
  listSubscribers: vi.fn(),
  listProductEvents: vi.fn(),
  getProductEventCatalog: vi.fn(),
  getProductEventStats: vi.fn(),
  productEventStreamUrlAuthed: vi.fn(),
  productEventsCsvUrlAuthed: vi.fn(),
  setSection: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      sendProductEvent: mocks.sendProductEvent,
      createSequence: mocks.createSequence,
      createAutomationJourney: mocks.createAutomationJourney,
      listSubscribers: mocks.listSubscribers,
      listProductEvents: mocks.listProductEvents,
      getProductEventCatalog: mocks.getProductEventCatalog,
      getProductEventStats: mocks.getProductEventStats,
      productEventStreamUrlAuthed: mocks.productEventStreamUrlAuthed,
      productEventsCsvUrlAuthed: mocks.productEventsCsvUrlAuthed,
    },
    conversionsApi: {
      list: mocks.listConversions,
      listKeys: mocks.listConversionKeys,
      createKey: mocks.createConversionKey,
      revokeKey: mocks.revokeConversionKey,
      listIngestSecrets: mocks.listIngestSecrets,
      issueIngestSecret: mocks.issueIngestSecret,
      revokeIngestSecret: mocks.revokeIngestSecret,
    },
  };
});

vi.mock("../../lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/store")>()),
  setSection: mocks.setSection,
  useCanAdmin: () => true,
  useCanWrite: () => true,
}));

vi.mock("../../lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/clipboard")>()),
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: vi.fn(),
  },
}));

import { TrackEventSlideover } from "../../components/TrackEventSlideover";
import { ConversionsSection } from "../../components/track/ConversionsSection";
import { EventComposer } from "../../components/track/EventComposer";
import { Track } from "../../pages/Track";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, EventListener>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, payload: unknown): void {
    this.listeners.get(type)?.({
      data: JSON.stringify(payload),
    } as MessageEvent);
  }
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendProductEvent.mockResolvedValue({ data: { id: 101 } });
  mocks.createSequence.mockResolvedValue({ data: { id: "sequence-101" } });
  mocks.createAutomationJourney.mockResolvedValue({
    data: { id: "automation-101" },
  });
  mocks.listConversions.mockResolvedValue({
    data: [
      {
        id: 501,
        tenant_id: "tenant-complete-id",
        subscriber_email: "customer@example.com",
        event_name: "purchase",
        amount_cents: 4900,
        currency: "USD",
        campaign_id: "campaign-complete-id",
        attributed_via: "last_touch",
        properties: { sku: "PW-501" },
        occurred_at: "2026-07-16T05:15:30.000Z",
      },
    ],
  });
  mocks.listConversionKeys.mockResolvedValue({
    data: [
      {
        id: "key-complete-id",
        tenant_id: "tenant-complete-id",
        label: "checkout backend",
        prefix: "pwck_safe",
        created_at: "2026-07-15T05:15:30.000Z",
      },
    ],
  });
  mocks.createConversionKey.mockResolvedValue({
    data: { plaintext: "pw_secret_once" },
  });
  mocks.revokeConversionKey.mockResolvedValue({ data: { ok: true } });
  mocks.listIngestSecrets.mockResolvedValue({ data: { items: [] } });
  mocks.issueIngestSecret.mockResolvedValue({
    data: {
      secret: {
        key_id: "0123456789abcdef0123456789abcdef",
        secret: "A".repeat(43),
        label: "Production checkout",
        created_at: "2026-08-30T10:00:00Z",
        identity_projection_status: "pending",
        identity_projection_updated_at: "2026-08-30T10:00:00Z",
      },
      notice: "This is the only time the secret is shown.",
    },
  });
  mocks.revokeIngestSecret.mockResolvedValue({ data: { revoked: true } });
  mocks.writeClipboardText.mockResolvedValue({
    ok: true,
    backend: "web",
    contentClass: "secret",
    clearScheduled: false,
    clearAfterMs: null,
    historyWarning: "Clipboard history may retain this secret.",
  });
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  mocks.listSubscribers.mockResolvedValue({ data: { items: [] } });
  mocks.listProductEvents.mockResolvedValue({
    data: {
      items: [
        {
          id: 701,
          eventName: "checkout.completed",
          subscriberId: "subscriber-701",
          properties: { evidence: "verified-event-visible" },
          occurredAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
        },
      ],
    },
  });
  const asOf = new Date();
  const utcDay = Date.UTC(
    asOf.getUTCFullYear(),
    asOf.getUTCMonth(),
    asOf.getUTCDate(),
  );
  const daily = Array.from({ length: 7 }, (_, index) => ({
    date: new Date(utcDay - (6 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    count: index === 6 ? 1 : 0,
  }));
  mocks.getProductEventCatalog.mockResolvedValue({
    data: {
      items: [],
      totalDistinctEventNames: 0,
      periodDays: 7,
      dailySeriesPeriodDays: 7,
      eventBoundsScope: "period",
      timeZone: "UTC",
      asOf: asOf.toISOString(),
    },
  });
  mocks.getProductEventStats.mockResolvedValue({
    data: {
      periodDays: 7,
      totalEvents: 1,
      uniqueSubscribers: 1,
      uniqueEventNames: 1,
      daily,
      timeZone: "UTC",
      asOf: asOf.toISOString(),
    },
  });
  mocks.productEventStreamUrlAuthed.mockResolvedValue(
    "https://example.test/events/stream?token=short-lived",
  );
  mocks.productEventsCsvUrlAuthed.mockResolvedValue(
    "https://example.test/events.csv?token=short-lived",
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement {
  const candidate = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((item) => item.textContent?.trim() === label);
  if (!candidate) throw new Error(`Missing button: ${label}`);
  return candidate;
}

function setInputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

describe("Track interaction maturity", () => {
  it("keeps sequence-draft creation discoverable but inert without authority", () => {
    render(
      <TrackEventSlideover
        canCreateSequence={false}
        event={{
          id: "event-read-only",
          eventName: "checkout.completed",
          subscriberId: "subscriber-read-only",
          occurredAt: new Date().toISOString(),
          properties: {},
        }}
        onClose={vi.fn()}
      />,
    );
    const create = button("Create sequence draft");
    expect(create.getAttribute("aria-disabled")).toBe("true");
    act(() => create.click());
    expect(mocks.createSequence).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Campaign-write access is required to create a sequence draft.",
    );
  });

  it("shows first-event onboarding for a genuinely empty workspace at the default period", async () => {
    mocks.listProductEvents.mockResolvedValue({ data: { items: [] } });
    render(<Track />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Watch your product breathe in real time.",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "No events match the active filters.",
    );
  });

  it("serializes composer sends, suppresses raw failures, handles IME Escape, and passes axe", async () => {
    let resolveSend: ((value: unknown) => void) | null = null;
    mocks.sendProductEvent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    render(<EventComposer canSend />);
    act(() => button("Send live event").click());
    const identity = document.querySelector<HTMLInputElement>(
      'input[placeholder="alice@example.com"]',
    );
    const eventName = document.querySelector<HTMLInputElement>(
      'input[placeholder="checkout_completed"]',
    );
    expect(identity).not.toBeNull();
    expect(eventName).not.toBeNull();
    act(() => {
      if (identity) setInputValue(identity, "subscriber@example.com");
      if (eventName) setInputValue(eventName, "checkout.completed");
    });
    const acknowledgement = Array.from(document.querySelectorAll("label"))
      .find((label) => label.textContent?.includes("I reviewed the subscriber"))
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(acknowledgement).not.toBeNull();
    act(() => acknowledgement?.click());
    const send = button("Send live event");
    act(() => {
      send.click();
      send.click();
    });
    expect(mocks.sendProductEvent).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSend?.({
        error: {
          message: "postgres password=server-secret",
          code: "unsafe code",
          requestId: "req-track-safe-1",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "The live event couldn't be sent.",
    );
    expect(document.body.textContent).toContain("req-track-safe-1");
    expect(document.body.textContent).not.toContain("server-secret");

    const result = await axe.run(container ?? document.body);
    expect(seriousViolations(result)).toEqual([]);

    act(() => {
      identity?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        }),
      );
    });
    expect(document.body.textContent).toContain("Subscriber (id or email)");
    act(() => {
      identity?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(document.body.textContent).not.toContain("Subscriber (id or email)");
    expect(document.activeElement).toBe(button("Resume live event"));
  });

  it("creates one inactive event-conditioned sequence without an orphan-prone second write", async () => {
    let resolveSequence: ((value: unknown) => void) | null = null;
    mocks.createSequence.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSequence = resolve;
        }),
    );
    const onClose = vi.fn();
    render(
      <TrackEventSlideover
        canCreateSequence
        event={{
          id: "event-complete-identifier-123",
          eventName: "checkout.completed",
          subscriberId: "subscriber-complete-identifier-456",
          occurredAt: "2026-07-16T05:15:30.000Z",
          receivedAt: "2026-07-16T05:15:31.000Z",
          properties: { plan: "enterprise" },
        }}
        onClose={onClose}
      />,
    );
    expect(document.body.textContent).toContain(
      "event-complete-identifier-123",
    );
    expect(document.body.textContent).toContain("2026-07-16T05:15:30.000Z");
    const create = button("Create sequence draft");
    act(() => {
      create.click();
      create.click();
    });
    expect(mocks.createSequence).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSequence?.({ data: { id: "sequence-complete-id-789" } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Sequence draft sequence-complete-id-789 created",
      ),
    );
    expect(mocks.createSequence).toHaveBeenCalledWith({
      name: "Follow up: checkout.completed",
      status: "draft",
      steps: [
        {
          type: "condition",
          position: 1,
          condition: {
            predicate: "product_event",
            value: "checkout.completed",
            yes_branch: [],
            no_branch: [],
          },
        },
      ],
    });
    expect(mocks.createAutomationJourney).not.toHaveBeenCalled();
    expect(mocks.setSection).toHaveBeenCalledWith("sequences");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(button("Create sequence draft").getAttribute("aria-disabled")).toBe(
      "true",
    );

    const result = await axe.run(container ?? document.body);
    expect(seriousViolations(result)).toEqual([]);
  });

  it("blocks a duplicate sequence after an uncertain create acknowledgement", async () => {
    mocks.createSequence.mockResolvedValue({
      error: {
        kind: "network",
        code: "connection_reset",
        message: "postgres password=server-secret",
        requestId: "req-sequence-uncertain-3",
      },
    });
    render(
      <TrackEventSlideover
        canCreateSequence
        event={{
          id: "event-uncertain",
          eventName: "checkout.completed",
          subscriberId: "subscriber-uncertain",
          occurredAt: "2026-07-16T05:15:30.000Z",
          properties: {},
        }}
        onClose={vi.fn()}
      />,
    );

    act(() => button("Create sequence draft").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Open Sequences to verify the result before retrying",
      ),
    );
    expect(document.body.textContent).toContain("req-sequence-uncertain-3");
    expect(document.body.textContent).not.toContain("server-secret");
    const create = button("Create sequence draft");
    expect(create.getAttribute("aria-disabled")).toBe("true");
    act(() => create.click());
    expect(mocks.createSequence).toHaveBeenCalledTimes(1);
    expect(mocks.createAutomationJourney).not.toHaveBeenCalled();
    expect(mocks.setSection).not.toHaveBeenCalled();
  });

  it("uses the timestamp and row ID together when loading older conversions", async () => {
    const boundaryTime = "2026-07-16T05:15:30.123456789Z";
    const page = Array.from({ length: 50 }, (_, index) => ({
      id: 1_000 - index,
      tenant_id: "tenant-complete-id",
      subscriber_email: `customer-${index}@example.com`,
      event_name: "purchase",
      properties: {},
      occurred_at: boundaryTime,
    }));
    mocks.listConversions
      .mockResolvedValueOnce({ data: page })
      .mockResolvedValueOnce({ data: [] });

    render(<ConversionsSection />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Load older conversions"),
    );
    act(() => button("Load older conversions").click());
    await waitFor(() => expect(mocks.listConversions).toHaveBeenCalledTimes(2));
    expect(mocks.listConversions).toHaveBeenNthCalledWith(1);
    expect(mocks.listConversions).toHaveBeenNthCalledWith(2, {
      before: boundaryTime,
      beforeId: 951,
    });
  });

  it("clears raw conversions on scope denial without blocking admin key controls", async () => {
    mocks.listConversions.mockResolvedValueOnce({
      error: {
        status: 403,
        message: "reflected subscriber=customer@example.com",
        requestId: "req-conversion-scope-safe-5",
      },
    });

    render(<ConversionsSection />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Raw conversion feed access requires both read:reports and read:subscribers.",
      ),
    );
    expect(document.body.textContent).toContain("req-conversion-scope-safe-5");
    expect(document.body.textContent).not.toContain(
      "reflected subscriber=customer@example.com",
    );
    expect(document.body.textContent).not.toContain("campaign-complete-id");
    expect(document.body.textContent).not.toContain("PW-501");
    expect(document.body.textContent).toContain("key-complete-id");
    expect(mocks.listConversionKeys).toHaveBeenCalledTimes(1);
    expect(button("+ New key").getAttribute("aria-disabled")).toBeNull();
  });

  it("keeps publishable tracking keys distinct from signing secrets", async () => {
    let resolveCreate: ((value: unknown) => void) | null = null;
    mocks.createConversionKey.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    let resolveCopy: ((value: unknown) => void) | null = null;
    mocks.writeClipboardText.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCopy = resolve;
        }),
    );
    render(<ConversionsSection />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("key-complete-id"),
    );
    expect(document.body.textContent).toContain("campaign-complete-id");
    expect(document.body.textContent).toContain("Last-touch · heuristic");
    expect(document.body.textContent).toContain(
      "every row distinguishes explicit, heuristic, unattributed, and legacy-unclassified attribution",
    );
    expect(document.body.textContent).toContain(
      "A publishable tracking key proves tenant routing, not that revenue came from a trusted source.",
    );
    expect(document.body.textContent).toContain(
      "not an authoritative financial ledger",
    );
    expect(document.body.textContent).toContain(
      "Publishable telemetry example — not signed ingest",
    );
    expect(document.body.textContent).toContain(
      "must never be reused as HMAC signing secrets",
    );
    expect(document.body.textContent).toContain(
      "Browser JSON requires an API-allowed CORS origin.",
    );
    expect(document.body.textContent).toContain("PW-501");
    const propertiesPreview = document.querySelector<HTMLElement>(
      ".track-json-preview",
    );
    expect(propertiesPreview?.getAttribute("role")).toBe("region");
    expect(propertiesPreview?.tabIndex).toBe(0);
    expect(propertiesPreview?.getAttribute("aria-label")).toContain(
      "Properties for conversion",
    );

    act(() => button("+ New key").click());
    const label = document.querySelector<HTMLInputElement>(
      'input[placeholder="storefront"]',
    );
    expect(label?.hasAttribute("maxlength")).toBe(false);
    expect(document.body.textContent).toContain(
      "0/120 characters after trimming",
    );
    act(() => {
      if (label) setInputValue(label, "production checkout");
    });
    const create = button("Create key");
    act(() => {
      create.click();
      create.click();
    });
    expect(mocks.createConversionKey).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCreate?.({ data: { plaintext: "pw_secret_once" } });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("pw_secret_once"),
    );
    expect(document.body.textContent).toContain(
      "The ordinary tracking-key register will not reveal this full value again.",
    );
    expect(document.body.textContent).toContain(
      "Admin-only idempotent retries can replay the exact creation response for 24 hours.",
    );
    expect(document.body.textContent).not.toContain(
      "only a hash is kept server-side",
    );

    const copy = button("Copy publishable tracking key");
    act(() => {
      copy.click();
      copy.click();
    });
    expect(mocks.writeClipboardText).toHaveBeenCalledTimes(1);
    expect(mocks.writeClipboardText).toHaveBeenCalledWith("pw_secret_once", {
      contentClass: "public",
      label: "publishable tracking key",
      clearIfUnchangedAfterMs: undefined,
    });
    await act(async () => {
      resolveCopy?.({
        ok: true,
        backend: "web",
        contentClass: "public",
        clearScheduled: false,
        clearAfterMs: null,
        historyWarning: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "publishable tracking key copied.",
    );
    expect(document.body.textContent).not.toContain(
      "will clear it from the clipboard",
    );

    const result = await axe.run(document.body);
    expect(seriousViolations(result)).toEqual([]);

    mocks.listConversionKeys.mockResolvedValue({
      error: {
        status: 403,
        message: "reflected credential=pw_secret_once",
        requestId: "req-key-access-safe-4",
      },
    });
    act(() => button("Refresh conversions").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("req-key-access-safe-4"),
    );
    expect(document.body.textContent).not.toContain("pw_secret_once");
    expect(document.body.textContent).not.toContain("reflected credential");
  });

  it("blocks duplicate key creation when the acknowledgement is uncertain", async () => {
    mocks.createConversionKey.mockResolvedValue({
      error: {
        kind: "network",
        code: "connection_reset",
        message: "database secret=must-not-render",
      },
    });
    render(<ConversionsSection />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("key-complete-id"),
    );
    act(() => button("+ New key").click());
    const label = document.querySelector<HTMLInputElement>(
      'input[placeholder="storefront"]',
    );
    act(() => {
      if (label) setInputValue(label, "uncertain checkout");
      button("Create key").click();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The key request couldn't be confirmed",
      ),
    );
    expect(document.body.textContent).not.toContain("must-not-render");
    expect(label?.disabled).toBe(true);
    act(() => button("Create unavailable").click());
    expect(mocks.createConversionKey).toHaveBeenCalledTimes(1);
  });

  it("does not claim a key was revoked without server confirmation", async () => {
    mocks.revokeConversionKey.mockResolvedValue({ data: { ok: false } });
    render(<ConversionsSection />);
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) => candidate.textContent?.trim() === "Revoke",
        ),
      ).toBe(true),
    );
    act(() => button("Revoke").click());
    await settle();
    act(() => button("Revoke key").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "did not confirm that the key was revoked",
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalledWith(
      expect.stringContaining("Revoked"),
    );
    expect(document.body.textContent).toContain('Revoke "checkout backend"?');
  });

  it("clears event evidence and shuts down streaming when access is revoked", async () => {
    render(<Track />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("verified-event-visible"),
    );
    act(() => button("Open").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Evidence source"),
    );
    act(() => button("Start live tail").click());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    act(() => source?.onopen?.());
    expect(document.body.textContent).toContain("Live tail connected");

    mocks.listProductEvents.mockResolvedValue({
      error: {
        status: 403,
        message: "reflected secret=never-render",
        requestId: "req-access-safe-3",
      },
    });
    act(() => button("Refresh all event data").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Live tail is unavailable"),
    );
    expect(document.body.textContent).toContain(
      "2 of 3 event reads verified. Could not verify: event feed.",
    );
    expect(source?.closed).toBe(true);
    expect(document.body.textContent).not.toContain("verified-event-visible");
    expect(document.body.textContent).not.toContain("Evidence source");
    expect(document.body.textContent).not.toContain("never-render");
    expect(document.body.textContent).toContain("req-access-safe-3");
    expect(button("Live tail unavailable").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(button("Export unavailable").getAttribute("aria-disabled")).toBe(
      "true",
    );

    act(() =>
      source?.emit("track", {
        id: 702,
        eventName: "checkout.completed",
        subscriberId: "subscriber-702",
        properties: { evidence: "must-not-reappear" },
        occurredAt: "2026-07-16T05:16:30.000Z",
      }),
    );
    expect(document.body.textContent).not.toContain("must-not-reappear");

    const result = await axe.run(container ?? document.body);
    expect(seriousViolations(result)).toEqual([]);
  });
});

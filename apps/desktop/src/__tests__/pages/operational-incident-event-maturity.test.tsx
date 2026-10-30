// @vitest-environment happy-dom

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
  canAdmin: false,
  listPrivacyIncidents: vi.fn(),
  getPrivacyIncident: vi.fn(),
  listPrivacyIncidentEvents: vi.fn(),
  createPrivacyIncident: vi.fn(),
  transitionPrivacyIncident: vi.fn(),
  signoffPrivacyIncident: vi.fn(),
  recordPrivacyIncidentNotification: vi.fn(),
  downloadPrivacyIncidentPacket: vi.fn(),
  listSubscribers: vi.fn(),
  listProductEvents: vi.fn(),
  getProductEventCatalog: vi.fn(),
  getProductEventStats: vi.fn(),
  productEventStreamUrlAuthed: vi.fn(),
  productEventsCsvUrlAuthed: vi.fn(),
  listConversions: vi.fn(),
  listConversionKeys: vi.fn(),
  createConversionKey: vi.fn(),
  revokeConversionKey: vi.fn(),
  listIngestSecrets: vi.fn(),
  issueIngestSecret: vi.fn(),
  revokeIngestSecret: vi.fn(),
  saveFile: vi.fn(),
  downloadUrlToFile: vi.fn(),
  writeClipboardText: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/store")>()),
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listPrivacyIncidents: mocks.listPrivacyIncidents,
      getPrivacyIncident: mocks.getPrivacyIncident,
      listPrivacyIncidentEvents: mocks.listPrivacyIncidentEvents,
      createPrivacyIncident: mocks.createPrivacyIncident,
      transitionPrivacyIncident: mocks.transitionPrivacyIncident,
      signoffPrivacyIncident: mocks.signoffPrivacyIncident,
      recordPrivacyIncidentNotification:
        mocks.recordPrivacyIncidentNotification,
      downloadPrivacyIncidentPacket: mocks.downloadPrivacyIncidentPacket,
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

vi.mock("../../lib/file-transfer", () => ({
  saveFile: mocks.saveFile,
  downloadUrlToFile: mocks.downloadUrlToFile,
}));

vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: vi.fn(),
  },
}));

vi.mock("../../components/track/EventComposer", () => ({
  EventComposer: ({ onSent }: { onSent: () => void }) => (
    <button type="button" onClick={onSent}>
      Send live event
    </button>
  ),
}));

vi.mock("../../components/TrackEventSlideover", () => ({
  TrackEventSlideover: () => null,
}));

vi.mock("../../lib/heroAssets", () => ({ HERO: { track: "track.webp" } }));

import { PrivacyIncidents } from "../../pages/PrivacyIncidents";
import { Track } from "../../pages/Track";

const incident = {
  id: "incident-complete-identifier-123456",
  severity: "critical" as const,
  status: "open" as const,
  detected_at: "2026-07-15T04:30:00.000Z",
  discovered_at: "2026-07-15T04:25:00.000Z",
  clock_started_at: "2026-07-15T04:30:00.000Z",
  gdpr_72h_deadline: "2026-07-18T04:30:00.000Z",
  template_version: "privacy-incident-v7",
  affected_regions: ["EU", "UK"],
  affected_data_categories: ["email", "purchase_history"],
  affected_subject_count: 1820,
  notification_decisions: {},
  jurisdictions: ["DE", "GB"],
  summary:
    "Vendor pipeline exposed subscriber emails and purchase history. Containment is in progress.",
  created_at: "2026-07-15T04:30:00.000Z",
  updated_at: "2026-07-16T05:45:00.000Z",
};

const productEvent = {
  id: 42,
  subscriber_email: "subscriber-with-a-complete-address@example.com",
  subscriberId: "subscriber-complete-identifier",
  eventName: "checkout.completed",
  properties: {
    order_id: "order-complete-identifier-123456789",
    plan: "enterprise annual with onboarding",
  },
  occurredAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
  receivedAt: new Date(Date.now() - 60 * 60 * 1_000 + 1_000).toISOString(),
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as (event: MessageEvent) => void);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = false;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  mocks.listPrivacyIncidents.mockResolvedValue({
    data: { incidents: [incident], known_jurisdictions: [] },
  });
  mocks.getPrivacyIncident.mockResolvedValue({ data: incident });
  mocks.listPrivacyIncidentEvents.mockResolvedValue({
    data: {
      events: [
        {
          event_id: "00000000-0000-7000-8000-000000000101",
          source: "incident_notifications",
          schema_version: 1,
          kind: "notification",
          at: "2026-07-16T05:00:00.000Z",
          audience: "authority",
          recipient_ref:
            "channel=portal; count=1820; notes=Filed with supervisory authority",
          template_key: "manual:portal:privacy-incident-v7",
          actor: "privacy-operator@example.com",
        },
      ],
    },
  });
  mocks.createPrivacyIncident.mockResolvedValue({ data: incident });
  mocks.transitionPrivacyIncident.mockResolvedValue({ data: {} });
  mocks.signoffPrivacyIncident.mockResolvedValue({ data: {} });
  mocks.recordPrivacyIncidentNotification.mockResolvedValue({ data: {} });
  mocks.downloadPrivacyIncidentPacket.mockResolvedValue({
    data: { body: "packet", filename: "incident.md" },
  });
  mocks.listSubscribers.mockResolvedValue({
    data: { items: [{ id: "subscriber-1", email: "recent@example.com" }] },
  });
  mocks.listProductEvents.mockResolvedValue({
    data: { items: [productEvent] },
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
    count: index === 6 ? 25 : 0,
  }));
  mocks.getProductEventCatalog.mockResolvedValue({
    data: {
      items: [
        {
          eventName: "checkout.completed",
          count: 125,
          uniqueSubscribers: 98,
          firstSeen: "2026-07-10T00:00:00.000Z",
          lastSeen: "2026-07-16T05:15:30.000Z",
          daily,
        },
      ],
      totalDistinctEventNames: 1,
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
      totalEvents: 125,
      uniqueSubscribers: 98,
      uniqueEventNames: 1,
      daily,
      timeZone: "UTC",
      asOf: asOf.toISOString(),
    },
  });
  mocks.productEventStreamUrlAuthed.mockResolvedValue(
    "https://example.test/track/stream?token=short-lived",
  );
  mocks.productEventsCsvUrlAuthed.mockResolvedValue(
    "https://example.test/track.csv?token=short-lived",
  );
  mocks.listConversions.mockResolvedValue({ data: [] });
  mocks.listConversionKeys.mockResolvedValue({ data: [] });
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
  mocks.createConversionKey.mockResolvedValue({ data: {} });
  mocks.revokeConversionKey.mockResolvedValue({ data: {} });
  mocks.saveFile.mockResolvedValue({ ok: true, status: "saved" });
  mocks.downloadUrlToFile.mockResolvedValue({ ok: true, status: "saved" });
  mocks.writeClipboardText.mockResolvedValue({ ok: true });
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
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function openIncidentButton(): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Open privacy incident"]',
  );
  if (!match) throw new Error("Missing privacy incident Open action");
  return match;
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

describe("operational privacy and event UI maturity", () => {
  it("ratchets both source owners to zero intrinsic titles without faux rows", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/interactive-title-inventory.mjs", "--json"],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const inventory = JSON.parse(output) as {
      findings: Array<{ file: string }>;
      nonInteractiveFindings: Array<{ file: string }>;
    };
    for (const file of ["pages/PrivacyIncidents.tsx", "pages/Track.tsx"]) {
      expect(
        inventory.findings.filter((finding) => finding.file === file),
      ).toEqual([]);
      expect(
        inventory.nonInteractiveFindings.filter(
          (finding) => finding.file === file,
        ),
      ).toEqual([]);
      const source = readFileSync(`src/${file}`, "utf8");
      expect(source).toContain("<DataTable");
      expect(source).not.toContain('role="button"');
    }
    const trackSource = readFileSync("src/pages/Track.tsx", "utf8");
    expect(trackSource).toContain("nativeEvent.isComposing");
    expect(trackSource).toContain("event.keyCode !== 229");
    expect(trackSource).toContain("generationRef.current");
    expect(trackSource).toContain("mountedRef.current");
    expect(trackSource).toContain('setStatus("reconnecting")');

    const privacyPageSource = readFileSync(
      "src/pages/PrivacyIncidents.tsx",
      "utf8",
    );
    const privacyEvidenceSource = readFileSync(
      "src/components/privacy/PrivacyIncidentEvidenceSections.tsx",
      "utf8",
    );
    for (const unsafeTransport of [
      "signoffPrivacyIncident",
      "recordPrivacyIncidentNotification",
      "downloadPrivacyIncidentPacket",
    ]) {
      expect(privacyPageSource).not.toContain(unsafeTransport);
      expect(privacyEvidenceSource).not.toContain(unsafeTransport);
    }
  });

  it("renders a semantic register with truthful loaded-window metrics and fail-closed legal actions", async () => {
    render(<PrivacyIncidents />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(incident.summary),
    );

    expect(
      document.querySelector('table[aria-label="Privacy incidents"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Critical");
    expect(document.body.textContent).toContain(
      "Stored operational 72h target",
    );
    expect(document.body.textContent).toContain("Needs attention");
    expect(document.body.textContent).toContain("Scope fields complete");
    expect(document.body.textContent).not.toContain("Notifications · 30d");
    expect(document.body.textContent).not.toContain("Avg time to close");
    expect(document.querySelector("[title]")).toBeNull();
    expect(document.querySelector('.list-row[role="button"]')).toBeNull();

    act(() => openIncidentButton().click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Incident closure is on release hold",
      ),
    );
    expect(document.body.textContent).toContain(
      "incident-complete-identifier-123456",
    );
    expect(document.body.textContent).toContain("1,820");
    expect(document.body.textContent).toContain("EU, UK");
    expect(document.body.textContent).toContain("purchase_history");
    expect(document.body.textContent).toContain("privacy-incident-v7");
    expect(document.body.textContent).toContain(
      "Counsel approval is on release hold",
    );
    expect(document.body.textContent).toContain(
      "Manual delivery recording is on release hold",
    );
    expect(document.body.textContent).toContain(
      "Packet generation and download are on release hold",
    );
    expect(document.body.textContent).toContain(
      "Legacy incident schemas and stored records can contain caller-supplied identity text",
    );
    expect(document.body.textContent).toContain(
      "Legacy notification records can contain a manually asserted recipient reference",
    );
    expect(document.body.textContent).toContain(
      "Not generated · not approved · not sent",
    );
    expect(button("Move to Contained")).toBeInstanceOf(HTMLButtonElement);
    expect(button("Move to Notifying")).toBeInstanceOf(HTMLButtonElement);
    for (const testId of [
      "privacy-incident-close-release-hold",
      "privacy-incident-signoff-release-hold",
      "privacy-incident-notification-release-hold",
      "privacy-incident-packets-release-hold",
    ]) {
      const hold = document.querySelector(`[data-testid="${testId}"]`);
      expect(hold).not.toBeNull();
      expect(hold?.querySelector("button, input, select, textarea")).toBeNull();
    }
    expect(() => button("Move to Closed")).toThrow("Missing button");
    expect(() => button("Mark counsel sign-off")).toThrow("Missing button");
    expect(() => button("+ Record notification")).toThrow("Missing button");
    expect(() => button("Download authority packet")).toThrow("Missing button");
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "manual:portal:privacy-incident-v7",
      );
      expect(document.body.textContent).toContain("Withheld in this view");
    });
    expect(document.body.textContent).not.toContain(
      "supervisory portal reference pending verification",
    );
    expect(document.body.textContent).not.toContain(
      "Filed with supervisory authority",
    );
    expect(mocks.transitionPrivacyIncident).not.toHaveBeenCalled();
    expect(mocks.signoffPrivacyIncident).not.toHaveBeenCalled();
    expect(mocks.recordPrivacyIncidentNotification).not.toHaveBeenCalled();
    expect(mocks.downloadPrivacyIncidentPacket).not.toHaveBeenCalled();
    expect(mocks.saveFile).not.toHaveBeenCalled();

    const result = await axe.run(container ?? document.body);
    expect(seriousViolations(result)).toEqual([]);
  });

  it("keeps every unsafe privacy action structurally absent when legacy sign-off data exists", async () => {
    const legacySignedIncident = {
      ...incident,
      counsel_signoff_at: "2026-07-16T04:00:00.000Z",
      signoff_by: "legacy-caller-supplied@example.com",
    };
    mocks.listPrivacyIncidents.mockResolvedValue({
      data: { incidents: [legacySignedIncident], known_jurisdictions: [] },
    });
    mocks.getPrivacyIncident.mockResolvedValue({ data: legacySignedIncident });
    render(<PrivacyIncidents />);
    await settle();
    act(() => openIncidentButton().click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Unverified legacy claim"),
    );
    expect(document.body.textContent).toContain(
      "legacy-caller-supplied@example.com",
    );
    expect(document.body.textContent).not.toContain("Signature receipt");
    expect(() => button("Move to Closed")).toThrow("Missing button");
    expect(() => button("Record sign-off")).toThrow("Missing button");
    expect(() => button("Record notification")).toThrow("Missing button");
    expect(mocks.transitionPrivacyIncident).not.toHaveBeenCalled();
    expect(mocks.signoffPrivacyIncident).not.toHaveBeenCalled();
    expect(mocks.recordPrivacyIncidentNotification).not.toHaveBeenCalled();
    expect(mocks.downloadPrivacyIncidentPacket).not.toHaveBeenCalled();
    expect(mocks.saveFile).not.toHaveBeenCalled();
  });

  it("describes a future incident deadline in the correct direction", async () => {
    const futureDeadline = new Date(
      Date.now() + 2 * 60 * 60 * 1_000,
    ).toISOString();
    mocks.listPrivacyIncidents.mockResolvedValue({
      data: {
        incidents: [{ ...incident, gdpr_72h_deadline: futureDeadline }],
        known_jurisdictions: [],
      },
    });
    render(<PrivacyIncidents />);
    await waitFor(() => expect(document.body.textContent).toContain("in 2h"));
    expect(document.body.textContent).not.toContain("-2h ago");
  });

  it("renders complete event and conversion semantics with focusable permission guidance", async () => {
    render(<Track />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "order-complete-identifier-123456789",
      ),
    );
    expect(
      document.querySelector('table[aria-label="Product event feed"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('table[aria-label="Event catalog"]'),
    ).not.toBeNull();
    expect(
      document
        .querySelector('table[aria-label="Event catalog"] svg')
        ?.getAttribute("tabindex"),
    ).toBeNull();
    expect(
      document.querySelector('table[aria-label="Conversion event feed"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('table[aria-label="Conversion tracking keys"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "subscriber-with-a-complete-address@example.com",
    );
    expect(document.body.textContent).toContain(
      "enterprise annual with onboarding",
    );
    expect(document.querySelector("[title]")).toBeNull();
    expect(document.querySelector('.list-row[role="button"]')).toBeNull();
    const newKey = button("+ New key");
    expect(newKey.disabled).toBe(false);
    expect(newKey.getAttribute("aria-disabled")).toBe("true");
    act(() => newKey.click());
    expect(document.body.textContent).toContain(
      "Admin access is required to create or revoke tracking keys",
    );
    expect(mocks.listConversionKeys).not.toHaveBeenCalled();
    act(() => button("Refresh conversions").click());
    await settle();
    expect(mocks.listConversionKeys).not.toHaveBeenCalled();

    const result = await axe.run(container ?? document.body);
    expect(seriousViolations(result)).toEqual([]);
  });

  it("ignores IME Enter, reuses a same-tick subscriber request, and tells the truth about live pause/resume", async () => {
    let resolveSubscriber: ((value: unknown) => void) | null = null;
    mocks.listSubscribers.mockImplementation((options: { query?: string }) => {
      if (!options.query) {
        return Promise.resolve({ data: { items: [] } });
      }
      return new Promise((resolve) => {
        resolveSubscriber = resolve;
      });
    });
    render(<Track />);
    await settle();
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder*="subscriber@example.com"]',
    );
    expect(input).not.toBeNull();
    act(() => {
      if (!input) return;
      setInputValue(input, "resolved@example.com");
    });
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 229,
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(mocks.listSubscribers).toHaveBeenCalledTimes(1);
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      button("Load events").click();
    });
    expect(mocks.listSubscribers).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveSubscriber?.({
        data: { items: [{ id: "resolved-id", email: "resolved@example.com" }] },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => button("Start live tail").click());
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];
    act(() => source?.onopen?.());
    expect(document.body.textContent).toContain("Live tail connected");
    act(() =>
      source?.emit("track", {
        ...productEvent,
        id: 99,
        subscriberId: "resolved-id",
        eventName: "checkout.completed",
      }),
    );
    expect(document.body.textContent).toContain("1 new live event");
    act(() => button("Pause live tail").click());
    expect(source?.closed).toBe(true);
    expect(document.body.textContent).toContain("Live tail is paused");
    expect(button("Resume live tail").getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("keeps and deduplicates a live event that arrives before the feed snapshot", async () => {
    let resolveFeed: ((value: unknown) => void) | null = null;
    mocks.listProductEvents.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFeed = resolve;
        }),
    );
    const earlyLiveEvent = {
      ...productEvent,
      id: 777,
      properties: { source: "live-before-snapshot" },
    };
    render(<Track />);
    await settle();
    act(() => button("Start live tail").click());
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const source = FakeEventSource.instances[0];
    act(() => {
      source?.onopen?.();
      source?.emit("track", earlyLiveEvent);
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("live-before-snapshot"),
    );

    await act(async () => {
      resolveFeed?.({ data: { items: [earlyLiveEvent, productEvent] } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      document.querySelectorAll(
        'table[aria-label="Product event feed"] tbody tr',
      ),
    ).toHaveLength(2);
  });

  it("stops a delayed confidential export when its page unmounts", async () => {
    let resolveUrl: ((value: string) => void) | null = null;
    mocks.productEventsCsvUrlAuthed.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveUrl = resolve;
        }),
    );
    render(<Track />);
    await settle();
    act(() => button("Export CSV").click());
    expect(mocks.productEventsCsvUrlAuthed).toHaveBeenCalledTimes(1);
    const exportScope = mocks.productEventsCsvUrlAuthed.mock.calls[0]?.[0];
    expect(exportScope).toEqual({
      occurredAfter: expect.any(String),
      limit: 10_000,
    });
    const requestTime = new Date();
    const expectedUTCStart = Date.UTC(
      requestTime.getUTCFullYear(),
      requestTime.getUTCMonth(),
      requestTime.getUTCDate() - 6,
    );
    expect(Date.parse(exportScope?.occurredAfter ?? "")).toBe(expectedUTCStart);

    act(() => {
      root?.unmount();
      root = null;
    });
    await act(async () => {
      resolveUrl?.("https://example.test/track.csv?token=short-lived");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.downloadUrlToFile).not.toHaveBeenCalled();
  });

  it("discloses a capped CSV after save and requests only the relevant response headers", async () => {
    mocks.downloadUrlToFile.mockResolvedValue({
      ok: true,
      status: "saved",
      responseHeaders: {
        "x-postwave-export-limit": "10000",
        "x-postwave-truncated": "true",
      },
    });
    render(<Track />);
    await settle();

    act(() => button("Export CSV").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Additional matches were excluded",
      ),
    );
    expect(mocks.downloadUrlToFile).toHaveBeenCalledWith(
      expect.objectContaining({
        captureResponseHeaders: [
          "X-Postwave-Export-Limit",
          "X-Postwave-Truncated",
        ],
      }),
    );
    expect(document.body.textContent).toContain(
      "newest 10,000 matching events",
    );
  });

  it("uses the same UTC calendar window for feed evidence and excludes future timestamps", async () => {
    mocks.listProductEvents.mockResolvedValue({
      data: {
        items: [
          productEvent,
          {
            ...productEvent,
            id: 998,
            properties: { evidence: "future-evidence-must-not-render" },
            occurredAt: new Date(Date.now() + 60_000).toISOString(),
          },
        ],
      },
    });
    render(<Track />);
    await settle();

    expect(document.body.textContent).toContain("Last 7 UTC days");
    expect(document.body.textContent).toContain("independently verified");
    expect(document.body.textContent).not.toContain(
      "future-evidence-must-not-render",
    );
  });

  it("serializes key revocation and keeps a destructive failure in the confirmation", async () => {
    mocks.canAdmin = true;
    mocks.listConversionKeys.mockResolvedValue({
      data: [
        {
          id: "key-complete-identifier",
          tenant_id: "tenant-1",
          label: "checkout backend",
          prefix: "pw_live_complete",
          created_at: "2026-07-15T04:30:00.000Z",
        },
      ],
    });
    let rejectRevoke: ((reason?: unknown) => void) | null = null;
    mocks.revokeConversionKey.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRevoke = reject;
        }),
    );
    render(<Track />);
    await waitFor(() =>
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) => candidate.textContent?.trim() === "Revoke",
        ),
      ).toBe(true),
    );
    act(() => button("Revoke").click());
    await settle();
    act(() => {
      button("Revoke key").click();
      button("Revoke key").click();
    });
    expect(mocks.revokeConversionKey).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectRevoke?.(new Error("network unavailable"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "The tracking key couldn't be revoked. Check the connection and retry.",
    );
    expect(document.body.textContent).toContain('Revoke "checkout backend"?');
  });

  it("never resolves an email filter to a different fuzzy subscriber", async () => {
    mocks.listSubscribers.mockImplementation((options: { query?: string }) =>
      Promise.resolve({
        data: {
          items: options.query
            ? [{ id: "wrong-subscriber", email: "different@example.com" }]
            : [],
        },
      }),
    );
    render(<Track />);
    await settle();
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder*="subscriber@example.com"]',
    );
    act(() => {
      if (input) setInputValue(input, "target@example.com");
    });
    act(() => button("Load events").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No subscriber matched that email address",
      ),
    );
    expect(mocks.listProductEvents).not.toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: "wrong-subscriber" }),
    );
  });
});

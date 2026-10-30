// @vitest-environment happy-dom

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

import type { Me } from "../../lib/store";

const mocks = vi.hoisted(() => ({
  me: {
    user: "admin-a@example.test",
    tenant: "tenant-a",
    role: "admin",
    effectiveRole: "admin",
  } as Me,
  route: { section: "privacyIncidents" as const },
  list: vi.fn(),
  get: vi.fn(),
  events: vi.fn(),
  create: vi.fn(),
  transition: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/store")>()),
  useMe: () => mocks.me,
}));

vi.mock("../../lib/desktop-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/desktop-router")>();
  return {
    ...actual,
    useDesktopRouteSnapshot: () => ({
      route: mocks.route,
      canonicalUrl: "/app/privacy-incidents",
      revision: 1,
      source: "navigation" as const,
      restoreScrollTop: null,
    }),
    getDesktopRoute: () => mocks.route,
    requestDesktopRouteNavigation: vi.fn((route) => {
      mocks.route = route;
      return Promise.resolve("proceeded" as const);
    }),
  };
});

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listPrivacyIncidents: mocks.list,
      getPrivacyIncident: mocks.get,
      listPrivacyIncidentEvents: mocks.events,
      createPrivacyIncident: mocks.create,
      transitionPrivacyIncident: mocks.transition,
    },
  };
});

vi.mock("../../components/Toast", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
  },
}));

import { PrivacyIncidents } from "../../pages/PrivacyIncidents";

const EVENT_ID = "00000000-0000-7000-8000-000000000111";

function incident(
  id: string,
  summary: string,
  status: "open" | "contained" = "open",
) {
  return {
    id,
    severity: "high" as const,
    status,
    detected_at: "2026-08-18T08:00:00.000Z",
    discovered_at: "2026-08-18T08:15:00.000Z",
    clock_started_at: "2026-08-18T08:00:00.000Z",
    gdpr_72h_deadline: "2026-08-21T08:00:00.000Z",
    template_version: "privacy-v1",
    affected_regions: ["EEA"],
    affected_data_categories: ["contact_data"],
    affected_subject_count: 0,
    notification_decisions: {},
    jurisdictions: ["GDPR"],
    summary,
    created_at: "2026-08-18T08:00:00.000Z",
    updated_at: "2026-08-18T09:00:00.000Z",
    jurisdiction_resolution: {
      status: "release_held" as const,
      release_hold_code: "jurisdiction_rules_release_hold" as const,
      recognized: [
        { code: "GDPR", name: "EU General Data Protection Regulation" },
      ],
    },
  };
}

const incidentA = incident(
  "00000000-0000-7000-8000-00000000000a",
  "Tenant A confidential incident",
);
const incidentB = incident(
  "00000000-0000-7000-8000-00000000000b",
  "Tenant B incident",
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.me = {
    user: "admin-a@example.test",
    tenant: "tenant-a",
    role: "admin",
    effectiveRole: "admin",
  };
  mocks.route = { section: "privacyIncidents" };
  mocks.list.mockResolvedValue({
    data: {
      incidents: [incidentA],
      known_jurisdictions: [
        { code: "CA", name: "California" },
        { code: "GDPR", name: "EU General Data Protection Regulation" },
      ],
    },
  });
  mocks.get.mockResolvedValue({ data: incidentA });
  mocks.events.mockResolvedValue({
    data: {
      events: [
        {
          event_id: EVENT_ID,
          source: "incident_state_transitions",
          schema_version: 1,
          kind: "transition",
          at: "2026-08-18T09:00:00.000Z",
          from_state: "open",
          to_state: "contained",
          actor: "",
          reason: "Tenant A evidence only",
        },
      ],
    },
  });
  mocks.create.mockResolvedValue({ data: incidentA });
  mocks.transition.mockResolvedValue({
    data: {
      incident_id: incidentA.id,
      from: "open",
      to: "contained",
      at: "2026-08-19T09:00:00.000Z",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(element: ReactElement = <PrivacyIncidents />): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

function openIncident(): void {
  const opener = document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Open privacy incident"]',
  );
  if (!opener) throw new Error("Missing incident opener");
  act(() => opener.click());
  render();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("privacy incident ownership, paging, and guarded writes", () => {
  it("deduplicates cursor windows and ignores an append that loses a refresh race", async () => {
    const lateAppend = deferred<{
      data: { incidents: (typeof incidentA)[]; known_jurisdictions: never[] };
    }>();
    let baseCalls = 0;
    mocks.list.mockImplementation((options: { cursor?: string } = {}) => {
      if (options.cursor) return lateAppend.promise;
      baseCalls += 1;
      return Promise.resolve({
        data: {
          incidents: [baseCalls === 1 ? incidentA : incidentB],
          known_jurisdictions: [],
          nextCursor: baseCalls === 1 ? "next-window" : undefined,
        },
      });
    });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(incidentA.summary),
    );

    act(() => button("Load more").click());
    act(() => button("Refresh").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(incidentB.summary),
    );
    expect(document.body.textContent).not.toContain(incidentA.summary);

    await act(async () => {
      lateAppend.resolve({
        data: {
          incidents: [
            incidentA,
            incident("00000000-0000-7000-8000-00000000000c", "Late append PII"),
          ],
          known_jurisdictions: [],
        },
      });
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("Late append PII");
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("appends one cursor window per same-tick intent and deduplicates incident IDs", async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: {
          incidents: [incidentA],
          known_jurisdictions: [],
          nextCursor: "next-window",
        },
      })
      .mockResolvedValueOnce({
        data: {
          incidents: [incidentA, incidentB],
          known_jurisdictions: [],
        },
      });
    render();
    await waitFor(() =>
      expect(button("Load more")).toBeInstanceOf(HTMLButtonElement),
    );
    act(() => {
      button("Load more").click();
      button("Load more").click();
    });
    await waitFor(() =>
      expect(
        document.querySelectorAll(
          'table[aria-label="Privacy incidents"] tbody tr',
        ),
      ).toHaveLength(2),
    );
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("retains the complete verified append window and cursor after refresh failure", async () => {
    const incidentC = incident(
      "00000000-0000-7000-8000-00000000000c",
      "Third verified window",
    );
    mocks.list
      .mockResolvedValueOnce({
        data: {
          incidents: [incidentA],
          known_jurisdictions: [],
          nextCursor: "next-window",
        },
      })
      .mockResolvedValueOnce({
        data: {
          incidents: [incidentB],
          known_jurisdictions: [],
          nextCursor: "third-window",
        },
      })
      .mockResolvedValueOnce({
        error: { status: 503, message: "refresh unavailable" },
      })
      .mockResolvedValueOnce({
        data: {
          incidents: [incidentB, incidentC],
          known_jurisdictions: [],
        },
      });
    render();
    await waitFor(() =>
      expect(button("Load more")).toBeInstanceOf(HTMLButtonElement),
    );
    act(() => button("Load more").click());
    await waitFor(() =>
      expect(
        document.querySelectorAll(
          'table[aria-label="Privacy incidents"] tbody tr',
        ),
      ).toHaveLength(2),
    );
    act(() => button("Refresh").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Showing last verified privacy incidents",
      ),
    );
    expect(
      document.querySelectorAll(
        'table[aria-label="Privacy incidents"] tbody tr',
      ),
    ).toHaveLength(2);
    expect(button("Load more")).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.textContent).toContain(incidentA.summary);
    expect(document.body.textContent).toContain(incidentB.summary);

    act(() => button("Load more").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(incidentC.summary),
    );
    expect(mocks.list.mock.calls[3]?.[0]).toEqual({
      cursor: "third-window",
    });
    expect(
      document.querySelectorAll(
        'table[aria-label="Privacy incidents"] tbody tr',
      ),
    ).toHaveLength(3);
  });

  it("restores focus to the stable register heading when reset controls unmount", async () => {
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(incidentA.summary),
    );
    const closedFilter = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Closed, 0 loaded"]',
    );
    if (!closedFilter) throw new Error("Missing closed filter");
    act(() => closedFilter.click());
    render();
    const reset = button("Reset filters");
    act(() => {
      reset.focus();
      reset.click();
    });
    render();
    await settle();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expect(document.activeElement?.id).toBe("privacy-incident-register-title");
  });

  it("unmounts tenant A rows, detail, events, and late reads immediately on tenant switch", async () => {
    const lateARefresh = deferred<{
      data: { incidents: (typeof incidentA)[]; known_jurisdictions: never[] };
    }>();
    let aCalls = 0;
    mocks.list.mockImplementation(() => {
      if (mocks.me.tenant === "tenant-b") {
        return Promise.resolve({
          error: { status: 503, message: "unavailable" },
        });
      }
      aCalls += 1;
      return aCalls === 1
        ? Promise.resolve({
            data: { incidents: [incidentA], known_jurisdictions: [] },
          })
        : lateARefresh.promise;
    });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(incidentA.summary),
    );
    openIncident();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Tenant A evidence only"),
    );
    expect(document.body.textContent).toContain("Actor not recorded");

    act(() => button("Refresh").click());
    mocks.me = {
      user: "admin-b@example.test",
      tenant: "tenant-b",
      role: "admin",
      effectiveRole: "admin",
    };
    render();
    expect(document.body.textContent).not.toContain(incidentA.summary);
    expect(document.body.textContent).not.toContain("Tenant A evidence only");

    await act(async () => {
      lateARefresh.resolve({
        data: {
          incidents: [
            incident(
              "00000000-0000-7000-8000-00000000000d",
              "Late tenant A response",
            ),
          ],
          known_jurisdictions: [],
        },
      });
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("Late tenant A response");
  });

  it("suppresses a tenant A create success and reload after the identity changes", async () => {
    const pendingCreate = deferred<{ data: typeof incidentA }>();
    mocks.create.mockReturnValue(pendingCreate.promise);
    render();
    await settle();
    act(() => button("New preliminary record").click());
    render();
    const title = document.querySelector<HTMLInputElement>(
      'input[placeholder^="e.g. Vendor pipeline"]',
    );
    if (!title) throw new Error("Missing create title");
    act(() => setInputValue(title, "Tenant A in-flight draft"));
    act(() => button("Create preliminary record").click());
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const listCallsBeforeSwitch = mocks.list.mock.calls.length;

    mocks.me = {
      user: "admin-b@example.test",
      tenant: "tenant-b",
      role: "admin",
      effectiveRole: "admin",
    };
    render();
    await act(async () => {
      pendingCreate.resolve({ data: incidentA });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.list.mock.calls.length).toBe(listCallsBeforeSwitch + 1);
    expect(document.body.textContent).not.toContain("Tenant A in-flight draft");
  });

  it("suppresses a tenant A transition success and toast after the identity changes", async () => {
    const pendingTransition = deferred<{
      data: { incident_id: string; from: "open"; to: "contained"; at: string };
    }>();
    mocks.transition.mockReturnValue(pendingTransition.promise);
    render();
    await settle();
    openIncident();
    await settle();
    act(() => button("Move to Contained").click());
    const reason =
      document.querySelector<HTMLTextAreaElement>("#transition-reason");
    const phrase = document.querySelector<HTMLInputElement>(
      'input[placeholder="Contained"]',
    );
    if (!reason || !phrase)
      throw new Error("Missing transition confirmation fields");
    act(() => {
      setInputValue(reason, "Tenant A reviewed evidence");
      setInputValue(phrase, "Contained");
    });
    await act(async () => {
      button("Transition to Contained").click();
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(1));
    expect(mocks.transition).toHaveBeenCalledWith(
      incidentA.id,
      "contained",
      "Tenant A reviewed evidence",
      "open",
    );

    mocks.me = {
      user: "admin-b@example.test",
      tenant: "tenant-b",
      role: "admin",
      effectiveRole: "admin",
    };
    render();
    await act(async () => {
      pendingTransition.resolve({
        data: {
          incident_id: incidentA.id,
          from: "open",
          to: "contained",
          at: "2026-08-19T09:00:00.000Z",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      "Tenant A reviewed evidence",
    );
  });

  it("reuses one create key after ambiguity and submits zero plus catalog codes", async () => {
    mocks.create
      .mockResolvedValueOnce({ error: { kind: "network", message: "lost" } })
      .mockResolvedValueOnce({ data: incidentA });
    render();
    await settle();
    act(() => button("New preliminary record").click());
    render();
    const title = document.querySelector<HTMLInputElement>(
      'input[placeholder^="e.g. Vendor pipeline"]',
    );
    const subjects = document.querySelector<HTMLInputElement>(
      'input[type="number"]',
    );
    const gdpr = document.querySelector<HTMLInputElement>(
      'input[value="GDPR"]',
    );
    if (!title || !subjects || !gdpr)
      throw new Error("Missing create controls");
    act(() => {
      setInputValue(title, "Catalog-backed preliminary record");
      setInputValue(subjects, "0");
      gdpr.click();
    });
    await act(async () => {
      button("Create preliminary record").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Create outcome not yet verified",
      ),
    );
    expect(title.disabled).toBe(true);
    await act(async () => {
      button("Retry exact create request").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
    const first = mocks.create.mock.calls[0];
    const second = mocks.create.mock.calls[1];
    expect(first?.[0]).toEqual(
      expect.objectContaining({
        affected_subject_count: 0,
        jurisdictions: ["GDPR"],
      }),
    );
    expect(first?.[1]?.idempotencyKey).toBeTruthy();
    expect(second?.[1]?.idempotencyKey).toBe(first?.[1]?.idempotencyKey);
  });

  it("retains a transition reason, refreshes verified evidence, and resets reconfirmation on a stale-state conflict", async () => {
    mocks.transition.mockResolvedValueOnce({
      error: { status: 409, code: "stale_incident_state" },
    });
    render();
    await settle();
    openIncident();
    await settle();
    act(() => button("Move to Contained").click());
    const reason =
      document.querySelector<HTMLTextAreaElement>("#transition-reason");
    const phrase = document.querySelector<HTMLInputElement>(
      'input[placeholder="Contained"]',
    );
    if (!reason || !phrase) throw new Error("Missing transition fields");
    act(() => {
      setInputValue(reason, "Preserve this reviewed reason");
      setInputValue(phrase, "Contained");
    });
    await act(async () => {
      button("Transition to Contained").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Verified detail and activity were reloaded",
      ),
    );
    expect(
      document.querySelector<HTMLTextAreaElement>("#transition-reason")?.value,
    ).toBe("Preserve this reviewed reason");
    expect(
      document.querySelector<HTMLInputElement>('input[placeholder="Contained"]')
        ?.value,
    ).toBe("");
    expect(mocks.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mocks.events.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps confirmation blocked and preserves context when conflict verification fails", async () => {
    mocks.get.mockResolvedValueOnce({ data: incidentA }).mockResolvedValueOnce({
      error: { status: 503, code: "detail_unavailable" },
    });
    mocks.events
      .mockResolvedValueOnce({ data: { events: [] } })
      .mockResolvedValueOnce({
        error: { status: 503, code: "events_unavailable" },
      });
    mocks.transition.mockResolvedValueOnce({
      error: { status: 409, code: "stale_incident_state" },
    });
    render();
    await settle();
    openIncident();
    await settle();
    act(() => button("Move to Contained").click());
    const reason =
      document.querySelector<HTMLTextAreaElement>("#transition-reason");
    const phrase = document.querySelector<HTMLInputElement>(
      'input[placeholder="Contained"]',
    );
    if (!reason || !phrase) throw new Error("Missing transition fields");
    act(() => {
      setInputValue(reason, "Keep this while evidence is unavailable");
      setInputValue(phrase, "Contained");
    });
    await act(async () => {
      button("Transition to Contained").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "current incident state could not be verified",
      ),
    );
    expect(
      document.querySelector<HTMLTextAreaElement>("#transition-reason")?.value,
    ).toBe("Keep this while evidence is unavailable");
    expect(button("Retry current state check")).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(button("Transition to Contained").disabled).toBe(true);
    expect(document.body.textContent).not.toContain(
      "Verified detail and activity were reloaded",
    );
  });

  it("recomputes urgency while the register remains open", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-19T10:00:00.000Z"));
      const tickingIncident = {
        ...incidentA,
        severity: "medium" as const,
        gdpr_72h_deadline: "2026-08-19T10:00:30.000Z",
      };
      mocks.list.mockResolvedValue({
        data: {
          incidents: [tickingIncident],
          known_jurisdictions: [],
        },
      });
      render();
      await settle();
      expect(document.body.textContent).toContain("Active response");
      expect(document.body.textContent).not.toContain("Target passed");

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });
      expect(document.body.textContent).toContain("Target passed");
    } finally {
      vi.useRealTimers();
    }
  });
});

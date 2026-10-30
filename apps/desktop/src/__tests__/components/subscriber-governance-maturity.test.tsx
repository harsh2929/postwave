// @vitest-environment happy-dom

import axe from "axe-core";
import { act, Fragment, type ReactElement } from "react";
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
  createPolicy: vi.fn(),
  deletePolicy: vi.fn(),
  listExecutions: vi.fn(),
  listPolicies: vi.fn(),
  previewReengagement: vi.fn(),
  runPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  scoringRules: vi.fn(),
  scoringPutRules: vi.fn(),
  scoringRecompute: vi.fn(),
  listLinks: vi.fn(),
  linkRecord: vi.fn(),
  updateLink: vi.fn(),
  unlinkRecord: vi.fn(),
  listTypes: vi.fn(),
  listRecords: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    leadScoringApi: {
      rules: mocks.scoringRules,
      putRules: mocks.scoringPutRules,
      recompute: mocks.scoringRecompute,
    },
    customObjectsApi: {
      ...actual.customObjectsApi,
      listTypes: mocks.listTypes,
      listRecords: mocks.listRecords,
    },
    subscriberCustomObjectsApi: {
      list: mocks.listLinks,
      link: mocks.linkRecord,
      update: mocks.updateLink,
      unlink: mocks.unlinkRecord,
    },
  };
});

vi.mock("../../lib/api/sunset", () => ({
  sunsetApi: {
    createPolicy: mocks.createPolicy,
    deletePolicy: mocks.deletePolicy,
    listExecutions: mocks.listExecutions,
    listPolicies: mocks.listPolicies,
    previewReengagement: mocks.previewReengagement,
    runPolicy: mocks.runPolicy,
    updatePolicy: mocks.updatePolicy,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { SubscriberCustomObjectLinks } from "../../components/subscriber/SubscriberCustomObjectLinks";
import { ScoringRulesCard } from "../../components/subscribers/ScoringRulesCard";
import { SunsetPoliciesCard } from "../../components/subscribers/SunsetPoliciesCard";
import type { ProfileObjectLink } from "../../lib/api-client";
import type { SunsetPolicy } from "../../lib/api/sunset";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const SCORING_VERSION = `sha256:${"a".repeat(64)}`;
const NEXT_SCORING_VERSION = `sha256:${"b".repeat(64)}`;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.scoringRules.mockResolvedValue({
    data: {
      rules: [],
      defaults: [
        { id: "", event_type: "clicked", weight: 5 },
        { id: "", event_type: "opened", weight: 1 },
      ],
      event_catalog: [
        {
          event_type: "opened",
          label: "Email opened",
          category: "engagement",
        },
        {
          event_type: "clicked",
          label: "Link clicked",
          category: "engagement",
        },
      ],
      version: SCORING_VERSION,
      window_days: 90,
    },
  });
  mocks.scoringPutRules.mockResolvedValue({
    data: { saved: 1, version: NEXT_SCORING_VERSION },
  });
  mocks.scoringRecompute.mockResolvedValue({ data: { updated: 4 } });
  mocks.listPolicies.mockResolvedValue({ data: { items: [policy()] } });
  mocks.listExecutions.mockResolvedValue({ data: { items: [] } });
  mocks.runPolicy.mockResolvedValue({
    data: {
      policyId: "policy-1",
      startedAt: "2026-07-16T08:00:00.000Z",
      completedAt: "2026-07-16T08:00:01.000Z",
      candidatesSeen: 2,
      byAction: { suppress: 2 },
    },
  });
  mocks.createPolicy.mockResolvedValue({
    data: {
      ...policy(),
      id: "policy-2",
      name: "Safe sunset draft",
      enabled: false,
    },
  });
  mocks.previewReengagement.mockResolvedValue({
    data: {
      subject: "We've missed you",
      preheader: "A quick note",
      bodyText: "Come back when you're ready.",
      bodyHtml: "<p>Come back when you're ready.</p>",
      primaryCta: "Keep me subscribed",
      candidateCount: 0,
      variant: "soft",
    },
  });
  mocks.listLinks.mockResolvedValue({ data: { items: [link()] } });
  mocks.updateLink.mockResolvedValue({
    data: { ...link(), relationship: "owns" },
  });
  mocks.unlinkRecord.mockResolvedValue({ data: undefined });
  mocks.listTypes.mockResolvedValue({ data: { items: [] } });
  mocks.listRecords.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function policy(): SunsetPolicy {
  return {
    id: "policy-1",
    tenantId: "tenant-1",
    name: "Dormant contacts",
    inactiveDays: 180,
    action: "suppress",
    enabled: true,
    excludedTags: ["vip"],
    createdAt: "2026-07-01T08:00:00.000Z",
    updatedAt: "2026-07-01T08:00:00.000Z",
  };
}

function link(): ProfileObjectLink {
  return {
    id: "link-1",
    tenantId: "tenant-1",
    objectTypeId: "type-1",
    objectRecordId: "record-1",
    subscriberId: "subscriber-1",
    relationship: "purchased",
    metadata: null,
    createdAt: "2026-07-01T08:00:00.000Z",
    objectTypeKey: "order",
    objectTypeLabel: "Orders",
    externalId: "order-with-a-long-external-identifier",
    properties: {
      status: "fulfilled",
      shipping_context: { region: "APAC", service: "priority" },
      note: "Complete property values remain visible instead of title-only",
    },
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
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

function openDisclosure(summaryText: string): void {
  const summary = Array.from(document.querySelectorAll("summary")).find(
    (candidate) => candidate.textContent?.includes(summaryText),
  );
  const details = summary?.parentElement as HTMLDetailsElement | null;
  if (!details) throw new Error(`Missing disclosure: ${summaryText}`);
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle", { bubbles: false }));
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.bind(input);
  if (!setter) throw new Error("Missing input value setter");
  act(() => {
    setter(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set?.bind(select);
  if (!setter) throw new Error("Missing select value setter");
  act(() => {
    setter(value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

describe("subscriber governance maturity", () => {
  it("keeps viewer actions discoverable, renders complete data, and is axe-clean", async () => {
    render(
      <Fragment>
        <ScoringRulesCard canMutate={false} canAdmin={false} />
        <SunsetPoliciesCard canMutate={false} canAdmin={false} />
        <SubscriberCustomObjectLinks
          subscriberId="subscriber-1"
          canMutate={false}
        />
      </Fragment>,
    );
    openDisclosure("Lead scoring");
    openDisclosure("Sunset policies");
    await waitFor(() => {
      expect(document.body.textContent).toContain("Dormant contacts");
      expect(document.body.textContent).toContain("order-with-a-long-external");
      expect(document.body.textContent).toContain("Complete property values");
      expect(document.body.textContent).toContain("clicked");
    });

    for (const label of [
      "New policy",
      "Edit",
      "Delete",
      "Generate preview",
      "Link record",
      "Unlink",
    ]) {
      const control = button(label);
      expect(control.disabled).toBe(false);
      expect(control.getAttribute("aria-disabled")).toBe("true");
      act(() => control.click());
    }
    expect(document.body.textContent).toContain("Run unavailable");
    expect(document.body.textContent).toContain("Automatic score refresh");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Recompute scores",
      ),
    ).toBe(false);
    expect(document.body.textContent).toContain(
      "No subscriber is changed from this desktop surface",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Run now",
      ),
    ).toBe(false);
    expect(mocks.scoringRecompute).not.toHaveBeenCalled();
    expect(mocks.runPolicy).not.toHaveBeenCalled();
    expect(mocks.previewReengagement).not.toHaveBeenCalled();
    expect(mocks.unlinkRecord).not.toHaveBeenCalled();
    expect(document.querySelectorAll("[title]")).toHaveLength(0);

    document
      .querySelectorAll<HTMLDetailsElement>("details")
      .forEach((details) => {
        details.open = true;
      });
    const result = await axe.run(container!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("reviews, versions, and serializes whole-set scoring saves", async () => {
    const request = deferred<{
      data: { saved: number; version: string };
    }>();
    mocks.scoringPutRules.mockReturnValue(request.promise);
    render(<ScoringRulesCard canMutate canAdmin />);
    openDisclosure("Lead scoring");
    await waitFor(() => expect(document.body.textContent).toContain("clicked"));

    act(() => button("+ Add rule").click());
    const event = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Rule 1 event type"]',
    );
    if (!event) throw new Error("Missing scoring event catalog");
    setSelectValue(event, "clicked");
    act(() => button("Review changes").click());
    expect(document.body.textContent).toContain(
      "This version-bound save adds 1",
    );
    const confirm = button("Save reviewed rule set");
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(mocks.scoringPutRules).toHaveBeenCalledTimes(1);
    expect(mocks.scoringPutRules).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          event_type: "clicked",
          weight: 1,
        }),
      ],
      SCORING_VERSION,
    );
    expect(mocks.scoringRecompute).not.toHaveBeenCalled();
    await act(async () => {
      request.resolve({ data: { saved: 1, version: NEXT_SCORING_VERSION } });
      await request.promise;
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("refresh automatically within 15 minutes"),
    );
    expect(document.body.textContent).not.toContain("Unsaved changes");
  });

  it("retains the scoring draft on a version conflict and guards refresh", async () => {
    mocks.scoringPutRules.mockResolvedValue({
      error: {
        kind: "http",
        status: 409,
        message: "Scoring rules changed",
      },
    });
    render(<ScoringRulesCard canMutate canAdmin />);
    openDisclosure("Lead scoring");
    await waitFor(() => expect(document.body.textContent).toContain("clicked"));
    act(() => button("+ Add rule").click());
    const event = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Rule 1 event type"]',
    );
    if (!event) throw new Error("Missing scoring event catalog");
    setSelectValue(event, "clicked");
    act(() => button("Review changes").click());
    await act(async () => button("Save reviewed rule set").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Save blocked by a newer server version",
      );
    });
    expect(document.body.textContent).toContain("Unsaved changes");
    expect(event.value).toBe("clicked");

    act(() => button("Refresh").click());
    expect(document.body.textContent).toContain(
      "Refresh the scoring baseline?",
    );
    expect(mocks.scoringRules).toHaveBeenCalledTimes(1);

    mocks.scoringRules.mockResolvedValueOnce({
      data: {
        rules: [{ id: "server-opened", event_type: "opened", weight: 2 }],
        defaults: [
          { id: "", event_type: "clicked", weight: 5 },
          { id: "", event_type: "opened", weight: 1 },
        ],
        event_catalog: [
          {
            event_type: "opened",
            label: "Email opened",
            category: "engagement",
          },
          {
            event_type: "clicked",
            label: "Link clicked",
            category: "engagement",
          },
        ],
        version: `sha256:${"c".repeat(64)}`,
        window_days: 90,
      },
    });
    await act(async () => button("Keep draft and refresh").click());
    await waitFor(() => expect(mocks.scoringRules).toHaveBeenCalledTimes(2));
    expect(
      document.querySelector<HTMLSelectElement>(
        'select[aria-label="Rule 1 event type"]',
      )?.value,
    ).toBe("clicked");
    expect(document.body.textContent).toContain("Unsaved changes");
  });

  it("fails closed on an unversioned scoring response", async () => {
    mocks.scoringRules.mockResolvedValue({
      data: {
        rules: [],
        defaults: [],
        event_catalog: [],
        version: "legacy",
        window_days: 90,
      },
    });
    render(<ScoringRulesCard canMutate canAdmin />);
    openDisclosure("Lead scoring");
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "didn't match the required versioned contract",
      );
    });
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Review changes",
      ),
    ).toBe(false);
  });

  it("keeps sunset definitions paused and never exposes the legacy destructive run", async () => {
    render(<SunsetPoliciesCard canMutate canAdmin />);
    openDisclosure("Sunset policies");
    await waitFor(() =>
      expect(document.body.textContent).toContain("Dormant contacts"),
    );

    expect(document.body.textContent).toContain("Draft mode");
    expect(document.body.textContent).toContain("Run unavailable");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Run now",
      ),
    ).toBe(false);

    act(() => button("New policy").click());
    const name = document.querySelector<HTMLInputElement>("#sunset-name");
    if (!name) throw new Error("Missing sunset policy name field");
    setInputValue(name, "Safe sunset draft");

    expect(document.body.textContent).toContain(
      "This definition will be saved as paused",
    );
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    act(() => button("Create policy").click());

    await waitFor(() => expect(mocks.createPolicy).toHaveBeenCalledTimes(1));
    expect(mocks.createPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Safe sunset draft",
        enabled: false,
      }),
    );
    expect(mocks.runPolicy).not.toHaveBeenCalled();
  });

  it("blocks unsafe re-engagement links before transport and invalidates stale previews", async () => {
    render(<SunsetPoliciesCard canMutate canAdmin />);
    openDisclosure("Sunset policies");
    await waitFor(() =>
      expect(document.body.textContent).toContain("Dormant contacts"),
    );
    openDisclosure("Re-engagement email preview");
    const homepage = document.querySelector<HTMLInputElement>(
      'input[aria-label="Homepage URL"]',
    );
    if (!homepage) throw new Error("Missing homepage URL field");

    setInputValue(homepage, "javascript:alert(1)");
    act(() => button("Generate preview").click());
    expect(mocks.previewReengagement).not.toHaveBeenCalled();
    expect(homepage.getAttribute("aria-invalid")).toBe("true");
    expect(document.body.textContent).toContain(
      "Homepage URL must be an absolute HTTPS URL",
    );

    setInputValue(homepage, "https://postwave.example/winback");
    act(() => button("Generate preview").click());
    await waitFor(() =>
      expect(mocks.previewReengagement).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Come back when you're ready",
      ),
    );
    expect(document.body.textContent).toContain(
      "not linked to a live recipient count",
    );

    setInputValue(homepage, "https://postwave.example/new-destination");
    expect(document.body.textContent).not.toContain(
      "Come back when you're ready",
    );
  });

  it("ignores IME Enter and serializes relationship edits", async () => {
    const request = deferred<{ data: ProfileObjectLink }>();
    mocks.updateLink.mockReturnValue(request.promise);
    render(
      <SubscriberCustomObjectLinks subscriberId="subscriber-1" canMutate />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("Orders"));
    act(() => button("Edit").click());
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="related"]',
    );
    if (!input) throw new Error("Missing relationship editor");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(mocks.updateLink).not.toHaveBeenCalled();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(mocks.updateLink).toHaveBeenCalledTimes(1);
    await act(async () => {
      request.resolve({ data: { ...link(), relationship: "owns" } });
      await request.promise;
    });
    expect(document.body.textContent).toContain("owns");
  });

  it("rejects custom-object links for a different subscriber", async () => {
    mocks.listLinks.mockResolvedValue({
      data: {
        items: [{ ...link(), subscriberId: "subscriber-other" }],
      },
    });
    render(
      <SubscriberCustomObjectLinks subscriberId="subscriber-1" canMutate />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("different subscriber");
    });
    expect(document.body.textContent).not.toContain(
      "order-with-a-long-external-identifier",
    );
  });

  it("does not reconcile a mismatched custom-object update", async () => {
    mocks.updateLink.mockResolvedValue({
      data: {
        ...link(),
        subscriberId: "subscriber-other",
        relationship: "owns",
      },
    });
    render(
      <SubscriberCustomObjectLinks subscriberId="subscriber-1" canMutate />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("Orders"));
    act(() => button("Edit").click());
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="related"]',
    );
    if (!input) throw new Error("Missing relationship editor");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.stringContaining("different custom-object link"),
      );
    });
    expect(document.body.textContent).not.toContain("owns");
  });
});

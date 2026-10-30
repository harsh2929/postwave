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
  getScanConfig: vi.fn(),
  list: vi.fn(),
  listForSubscriber: vi.fn(),
  review: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api/pii-findings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api/pii-findings")>();
  return {
    ...actual,
    piiFindingsApi: {
      ...actual.piiFindingsApi,
      getScanConfig: mocks.getScanConfig,
      list: mocks.list,
      listForSubscriber: mocks.listForSubscriber,
      review: mocks.review,
    },
  };
});

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { PIIFindingsCard } from "../../components/subscribers/PIIFindingsCard";
import { PIIFindingsModal } from "../../components/subscribers/PIIFindingsModal";
import { PIIFindingsPanel } from "../../components/subscriber/PIIFindingsPanel";
import type {
  PIIFinding,
  PIIFindingPage,
  PIIReviewInput,
  PIIScanConfig,
} from "../../lib/api/pii-findings";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const META = {
  scanner_name: "postwave-shadow-pii",
  scanner_version: "2.0.0",
  detector_name: "regex-heuristic",
  detector_version: "2.0.0",
  policy_name: "undeclared-pii-review",
  policy_version: "sub-071-v2",
} as const;

const CONFIG: PIIScanConfig = {
  ...META,
  available: true,
  scan_enabled: true,
  status: "enabled_unverified",
  execution_mode: "partial_write_path_hooks",
  scheduled_scans_available: false,
  fingerprint_scheme: "hmac-sha256-v1",
  fingerprint_key_version: "key-2026-07",
  reliability: "best_effort",
  coverage: "unverified",
  coverage_limitations: [
    "no_durable_scan_intent",
    "no_retry_or_dead_letter_queue",
    "no_coverage_watermark_or_gap_ledger",
    "direct_subscriber_writers_may_bypass_hooks",
  ],
  max_scan_fields: 500,
  max_scan_field_bytes: 65_536,
  max_detections_per_field: 50,
  max_detections_per_subscriber: 200,
  updated_at: "2026-07-18T08:00:00.000Z",
};
const PANEL_SUBSCRIBER_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

function fixtureSuffix(seed: string): string {
  let value = 0;
  for (const character of seed) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return value.toString(16).padStart(12, "0");
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getScanConfig.mockResolvedValue({ data: CONFIG });
  mocks.list.mockImplementation(async (options: { status?: string; perPage?: number; page?: number }) => {
    if (options.perPage === 1) {
      return {
        data: page([], options.status === "pending" ? 3 : 2, 1, 1),
      };
    }
    return { data: page([finding("finding-1")], 1, options.page ?? 1, options.perPage ?? 20) };
  });
  mocks.listForSubscriber.mockResolvedValue({
    data: page([finding("subscriber-detail")], 1, 1, 20),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function finding(id: string, fieldName = "custom_fields.legacy_id"): PIIFinding {
  const suffix = fixtureSuffix(id);
  return {
    ...META,
    id: `11111111-1111-4111-8111-${suffix}`,
    subscriber_id: `22222222-2222-4222-8222-${suffix}`,
    field_name: fieldName,
    detected_type: "other",
    confidence: 0.91,
    fingerprint: "a".repeat(64),
    fingerprint_scheme: "hmac-sha256-v1",
    fingerprint_key_version: "key-2026-07",
    status: "pending",
    created_at: "2026-07-17T12:00:00.000Z",
    updated_at: "2026-07-17T12:00:00.000Z",
  };
}

function reviewed(source: PIIFinding, input: PIIReviewInput): PIIFinding {
  const reviewedAt = "2026-07-18T09:00:00.000Z";
  return {
    ...source,
    status: input.status,
    reviewed_at: reviewedAt,
    reviewed_by: `user:${ACTOR_ID}`,
    updated_at: reviewedAt,
    review_receipt: {
      ...META,
      receipt_id: `44444444-4444-4444-8444-${fixtureSuffix(source.id)}`,
      status: input.status,
      reason: input.reason,
      comment: input.comment,
      evidence_reference: input.evidence_reference,
      reviewed_at: reviewedAt,
      actor_type: "user",
      actor_id: ACTOR_ID,
      fingerprint: source.fingerprint,
      fingerprint_scheme: source.fingerprint_scheme,
      fingerprint_key_version: source.fingerprint_key_version,
      finding_updated_at: input.expected_updated_at,
    },
  };
}

function page(
  items: PIIFinding[],
  total = items.length,
  pageNumber = 1,
  perPage = 20,
): PIIFindingPage {
  return { items, total, page: pageNumber, per_page: perPage };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(node: ReactElement): { rerender: (next: ReactElement) => void } {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return { rerender: (next) => act(() => root?.render(next)) };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

function button(label: string): HTMLButtonElement {
  const match = buttons(label)[0];
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function labeledControl<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
  label: string,
): T {
  const labelElement = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  const control = labelElement?.querySelector("input, select, textarea");
  if (!control) throw new Error(`Missing control: ${label}`);
  return control as T;
}

function change(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const prototype =
      control instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : control instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

describe("Shadow-PII governance UI", () => {
  it("keeps permission and partial-count failures explicit without inventing zero", async () => {
    render(<PIIFindingsCard canAdmin={false} />);
    expect(document.body.textContent).toContain("Admin access required");
    expect(mocks.getScanConfig).not.toHaveBeenCalled();
    expect(button("Review findings").disabled).toBe(true);

    mocks.list.mockImplementation(async (options: { status?: string }) =>
      options.status === "pending"
        ? { data: page([], 8, 1, 1) }
        : { error: { kind: "network", message: "offline" } },
    );
    act(() => root?.render(<PIIFindingsCard canAdmin />));
    await waitFor(() => {
      expect(document.body.textContent).toContain("Scanner service unavailable");
    });
    expect(document.body.textContent).not.toContain("8Needs review");
    expect(button("Review findings").disabled).toBe(true);
  });

  it("clears sensitive cached findings and closes the dialog on permission downgrade", async () => {
    const view = render(<PIIFindingsCard canAdmin />);
    await waitFor(() => expect(button("Review findings").disabled).toBe(false));
    expect(document.body.textContent).toContain("Best-effort scanner enabled");
    expect(document.body.textContent).toContain("Coverage is unverified");
    expect(document.body.textContent).not.toContain("scanner active");
    act(() => button("Review findings").click());
    await waitFor(() => expect(document.body.textContent).toContain("custom_fields.legacy_id"));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    view.rerender(<PIIFindingsCard canAdmin={false} />);
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.body.textContent).not.toContain("custom_fields.legacy_id");
    expect(document.body.textContent).toContain("Admin access required");
  });

  it("distinguishes protected HMAC fingerprints from non-searchable legacy tokens", async () => {
    const protectedFinding = finding("protected", "profile.protected_note");
    const legacyFinding = {
      ...finding("legacy", "profile.legacy_note"),
      scanner_name: "legacy-unversioned",
      scanner_version: "unknown-pre-1760",
      detector_name: "legacy-unversioned",
      detector_version: "unknown-pre-1760",
      policy_name: "legacy-unversioned",
      policy_version: "unknown-pre-1760",
      fingerprint: "b".repeat(64),
      fingerprint_scheme: "legacy-redacted-v1" as const,
      fingerprint_key_version: "legacy",
    };
    mocks.list.mockResolvedValue({
      data: page([protectedFinding, legacyFinding], 2),
    });
    render(<PIIFindingsModal open config={CONFIG} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Protected HMAC fingerprint");
      expect(document.body.textContent).toContain("Legacy redacted token");
    });
    expect(document.body.textContent).toContain(
      "Random migration token · not searchable",
    );
    expect(document.body.textContent).toContain("CoverageUnverified");
    expect(document.body.textContent).not.toContain("SHA-256 · hash only");
  });

  it("ignores stale filter responses and retains the exact verified page on refresh failure", async () => {
    const stale = deferred<{ data: PIIFindingPage }>();
    mocks.list
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ data: page([finding("phone", "profile.phone_note")]) })
      .mockResolvedValueOnce({ error: { kind: "network", message: "offline" } });
    render(<PIIFindingsModal open config={CONFIG} onClose={vi.fn()} />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    change(labeledControl<HTMLSelectElement>("Detected type"), "phone");
    await waitFor(() => expect(document.body.textContent).toContain("profile.phone_note"));

    await act(async () => {
      stale.resolve({ data: page([finding("stale", "stale.secret_field")]) });
      await stale.promise;
    });
    expect(document.body.textContent).not.toContain("stale.secret_field");

    act(() => button("Refresh").click());
    await waitFor(() => expect(document.body.textContent).toContain("Showing the last verified result"));
    expect(document.body.textContent).toContain("profile.phone_note");
  });

  it("requires safe evidence, single-flights decisions, disables peer actions, and restores focus to the receipt", async () => {
    const first = finding("one", "profile.notes");
    const second = finding("two", "profile.reference");
    mocks.list.mockResolvedValue({ data: page([first, second], 2) });
    const pending = deferred<{ data: PIIFinding }>();
    mocks.review.mockReturnValue(pending.promise);
    render(<PIIFindingsModal open config={CONFIG} onClose={vi.fn()} />);
    await waitFor(() => expect(buttons("Review…")).toHaveLength(2));
    act(() => buttons("Review…")[0]!.click());

    change(labeledControl<HTMLSelectElement>("Reason"), "confirmed_pii");
    change(
      labeledControl<HTMLTextAreaElement>("Decision comment"),
      "Verified the copied value 111-22-3333.",
    );
    change(labeledControl<HTMLInputElement>("Evidence reference"), "ticket:DPO-123");
    expect(button("Record reviewed").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "remove the personal-data-shaped value",
    );
    change(labeledControl<HTMLTextAreaElement>("Decision comment"), "Verified against the DPO case without copying personal data.");
    change(labeledControl<HTMLInputElement>("Evidence reference"), "https://example.test/?token=secret");
    expect(button("Record reviewed").disabled).toBe(true);
    change(labeledControl<HTMLInputElement>("Evidence reference"), "ticket:DPO-123");
    expect(button("Record reviewed").disabled).toBe(false);

    act(() => {
      button("Record reviewed").click();
      button("Record reviewed").click();
    });
    expect(mocks.review).toHaveBeenCalledTimes(1);
    expect(buttons("Review…")[0]?.disabled).toBe(true);
    const submitted = mocks.review.mock.calls[0]![1] as PIIReviewInput;
    expect(submitted).toEqual({
      status: "reviewed",
      reason: "confirmed_pii",
      comment: "Verified against the DPO case without copying personal data.",
      evidence_reference: "ticket:DPO-123",
      expected_updated_at: first.updated_at,
    });

    await act(async () => {
      pending.resolve({ data: reviewed(first, submitted) });
      await pending.promise;
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Immutable review receipt");
      expect((document.activeElement as HTMLElement | null)?.getAttribute("aria-label")).toBe("Decision recorded");
    });
    expect(document.body.textContent).toContain("ticket:DPO-123");
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);

    const results = await axe.run(container!);
    expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
  });

  it("clamps and reloads after resolving the last finding on a later page", async () => {
    const pageOne = Array.from({ length: 20 }, (_, index) => finding(`p1-${index}`));
    const last = finding("last-page", "profile.last_page_note");
    mocks.list.mockImplementation(async (options: { page?: number }) =>
      options.page === 2
        ? { data: page([last], 21, 2, 20) }
        : { data: page(pageOne, 21, 1, 20) },
    );
    mocks.review.mockImplementation(async (_id: string, input: PIIReviewInput) => ({ data: reviewed(last, input) }));
    render(<PIIFindingsModal open config={CONFIG} onClose={vi.fn()} />);
    await waitFor(() => expect(button("Next").disabled).toBe(false));
    act(() => button("Next").click());
    await waitFor(() => expect(document.body.textContent).toContain("profile.last_page_note"));
    act(() => button("Review…").click());
    change(labeledControl<HTMLSelectElement>("Reason"), "remediated");
    change(labeledControl<HTMLTextAreaElement>("Decision comment"), "The source field was removed and the remediation was verified.");
    change(labeledControl<HTMLInputElement>("Evidence reference"), "case:privacy/2026-071");
    act(() => button("Record reviewed").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain("Page 1");
      expect(document.body.textContent).not.toContain("21–20 of 20");
    });
    expect(mocks.list.mock.calls.some(([options]) => options.page === 1)).toBe(true);
  });

  it("authoritatively refills a full filtered page after a finding leaves it", async () => {
    const initial = Array.from({ length: 20 }, (_, index) =>
      finding(`fill-${index}`, `profile.pending_${index}`),
    );
    const replacement = finding("fill-replacement", "profile.pending_replacement");
    mocks.list
      .mockResolvedValueOnce({ data: page(initial, 21, 1, 20) })
      .mockResolvedValueOnce({
        data: page([...initial.slice(1), replacement], 20, 1, 20),
      });
    mocks.review.mockImplementation(
      async (_id: string, input: PIIReviewInput) => ({
        data: reviewed(initial[0]!, input),
      }),
    );
    render(<PIIFindingsModal open config={CONFIG} onClose={vi.fn()} />);
    await waitFor(() => expect(buttons("Review…")).toHaveLength(20));
    act(() => buttons("Review…")[0]!.click());
    change(labeledControl<HTMLSelectElement>("Reason"), "remediated");
    change(
      labeledControl<HTMLTextAreaElement>("Decision comment"),
      "The governed replacement field was verified without copying its value.",
    );
    change(
      labeledControl<HTMLInputElement>("Evidence reference"),
      "ticket:DPO-901",
    );
    act(() => button("Record reviewed").click());

    await waitFor(() => {
      expect(document.body.textContent).toContain("profile.pending_replacement");
      expect(document.body.textContent).toContain("1–20 of 20");
    });
    expect(document.body.textContent).not.toContain("profile.pending_0");
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("keeps subscriber-detail permission and unavailable states explicit", async () => {
    const onUnavailable = vi.fn();
    const view = render(
      <PIIFindingsPanel
        subscriberId={PANEL_SUBSCRIBER_ID}
        canAdmin={false}
        onUnavailable={onUnavailable}
      />,
    );
    expect(document.body.textContent).toContain("Admin access required");
    expect(mocks.listForSubscriber).not.toHaveBeenCalled();

    mocks.listForSubscriber.mockResolvedValue({
      error: { status: 404, code: "not_found", message: "not found" },
    });
    view.rerender(
      <PIIFindingsPanel subscriberId={PANEL_SUBSCRIBER_ID} canAdmin onUnavailable={onUnavailable} />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("Scanner capability unavailable");
    });
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("uses the same auditable CAS form in subscriber detail", async () => {
    const source = finding("subscriber-detail");
    source.subscriber_id = PANEL_SUBSCRIBER_ID;
    mocks.listForSubscriber.mockResolvedValue({ data: page([source], 1, 1, 20) });
    mocks.review.mockImplementation(async (_id: string, input: PIIReviewInput) => ({
      data: reviewed(source, input),
    }));
    render(<PIIFindingsPanel subscriberId={PANEL_SUBSCRIBER_ID} canAdmin />);
    await waitFor(() => expect(button("Dismiss…")).toBeTruthy());
    act(() => button("Dismiss…").click());
    change(labeledControl<HTMLSelectElement>("Reason"), "false_positive");
    change(labeledControl<HTMLTextAreaElement>("Decision comment"), "Verified synthetic identifier; no natural person is represented.");
    change(labeledControl<HTMLInputElement>("Evidence reference"), "ticket:DPO-456");
    act(() => button("Record dismissal").click());

    await waitFor(() => expect(document.body.textContent).toContain("Immutable review receipt"));
    expect(mocks.review.mock.calls[0]![1]).toMatchObject({
      status: "dismissed",
      reason: "false_positive",
      evidence_reference: "ticket:DPO-456",
      expected_updated_at: source.updated_at,
    });
  });

  it("clamps subscriber-detail pagination after a concurrent last-page deletion", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => {
      const item = finding(`detail-${index}`);
      item.subscriber_id = PANEL_SUBSCRIBER_ID;
      return item;
    });
    mocks.listForSubscriber.mockImplementation(
      async (_subscriberId: string, options: { page?: number }) =>
        options.page === 2
          ? {
              error: {
                kind: "parse",
                code: "invalid_subscriber_response_contract",
                message: "impossible pagination",
              },
            }
          : { data: page(firstPage, 21, 1, 20) },
    );
    render(<PIIFindingsPanel subscriberId={PANEL_SUBSCRIBER_ID} canAdmin />);
    await waitFor(() => expect(button("Next").disabled).toBe(false));
    act(() => button("Next").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Page 1");
      expect(document.body.textContent).not.toContain("21–20");
      expect(
        mocks.listForSubscriber.mock.calls.some(([, options]) => options.page === 2),
      ).toBe(true);
    });
  });

  it("never reflects thrown or server review details into the privacy UI", async () => {
    const modalFinding = finding("private-error");
    mocks.list.mockResolvedValue({ data: page([modalFinding]) });
    mocks.review.mockRejectedValue(
      new Error("token=super-secret raw_value=111-22-3333"),
    );
    render(<PIIFindingsModal open config={CONFIG} onClose={vi.fn()} />);
    await waitFor(() => expect(button("Review…")).toBeTruthy());
    act(() => button("Review…").click());
    change(labeledControl<HTMLSelectElement>("Reason"), "confirmed_pii");
    change(labeledControl<HTMLTextAreaElement>("Decision comment"), "Verified safely without copying the detected value.");
    change(labeledControl<HTMLInputElement>("Evidence reference"), "ticket:DPO-777");
    act(() => button("Record reviewed").click());
    await waitFor(() => expect(document.body.textContent).toContain("review service did not accept"));
    expect(document.body.textContent).not.toContain("super-secret");
    expect(document.body.textContent).not.toContain("111-22-3333");
  });

  it("maps subscriber-detail review failures to bounded controlled copy", async () => {
    const source = finding("detail-error");
    source.subscriber_id = PANEL_SUBSCRIBER_ID;
    mocks.listForSubscriber.mockResolvedValue({ data: page([source], 1, 1, 20) });
    mocks.review.mockResolvedValue({
      error: {
        status: 500,
        message: "database payload raw_value=private token=secret",
      },
    });
    render(<PIIFindingsPanel subscriberId={PANEL_SUBSCRIBER_ID} canAdmin />);
    await waitFor(() => expect(button("Dismiss…")).toBeTruthy());
    act(() => button("Dismiss…").click());
    change(labeledControl<HTMLSelectElement>("Reason"), "false_positive");
    change(labeledControl<HTMLTextAreaElement>("Decision comment"), "Pattern reviewed against the approved test-data record.");
    change(labeledControl<HTMLInputElement>("Evidence reference"), "ticket:DPO-778");
    act(() => button("Record dismissal").click());
    await waitFor(() => expect(document.body.textContent).toContain("could not commit the receipt"));
    expect(document.body.textContent).not.toContain("raw_value");
    expect(document.body.textContent).not.toContain("token=secret");
  });
});

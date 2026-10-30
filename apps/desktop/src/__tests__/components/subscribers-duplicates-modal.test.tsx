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
  startScan: vi.fn(),
  listPairs: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  apply: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    startSubscriberDuplicateScan: mocks.startScan,
    listSubscriberDuplicateScanPairs: mocks.listPairs,
  },
  deduplicationSettingsApi: {
    get: mocks.getSettings,
    update: mocks.updateSettings,
  },
  mergeApplyApi: { apply: mocks.apply },
}));

vi.mock("../../lib/store", () => ({ useCanAdmin: () => true }));
vi.mock("../../components/Toast", () => ({
  toast: { success: mocks.toastSuccess },
}));

import { DuplicatesModal } from "../../components/subscribers/DuplicatesModal";

const scan = {
  scan_id: "11111111-1111-4111-8111-111111111111",
  status: "complete",
  subscriber_count: 2_105,
  candidate_count: 1,
  created_at: "2026-07-18T12:00:00Z",
  completed_at: "2026-07-18T12:00:01Z",
  expires_at: "2026-07-19T12:00:00Z",
  complete: true,
};

const pair = {
  kind: "plus_alias",
  primary_id: "22222222-2222-4222-8222-222222222222",
  primary_email: "survivor@example.test",
  duplicate_id: "33333333-3333-4333-8333-333333333333",
  duplicate_email: "survivor+campaign@example.test",
  confidence: 0.9,
  primary_updated_at: "2026-07-18T11:00:00Z",
  duplicate_updated_at: "2026-07-18T11:01:00Z",
  stale: false,
  evidence: [
    {
      kind: "plus_alias",
      confidence: 0.9,
      reason:
        "Removing a plus-address suffix resolves both rows to the same mailbox.",
    },
  ],
};

const preview = {
  primary_id: pair.primary_id,
  duplicate_id: pair.duplicate_id,
  dry_run: true,
  plan: {
    tags: ["customer", "newsletter"],
    custom_fields: { plan: "pro", source: "campaign" },
    status: "unsubscribed",
    consent_timestamp: "2025-01-01T00:00:00Z",
    gdpr_permissions: [{ marketing_permission_id: "email", enabled: false }],
    conflicts: [
      {
        field: "custom_fields.plan",
        primary_value: "pro",
        duplicate_value: "free",
        resolution: "primary_wins",
      },
      {
        field: "status",
        primary_value: "enabled",
        duplicate_value: "unsubscribed",
        resolution: "most_restrictive_wins",
      },
    ],
    preserved_on_duplicate: [
      "email and profile identifiers",
      "list memberships, notes, and ID-keyed history",
    ],
  },
  events_moved: 0,
  suppressions_moved: 0,
  loser_soft_deleted: false,
  primary_updated_at: pair.primary_updated_at,
  duplicate_updated_at: pair.duplicate_updated_at,
  plan_fingerprint: `sha256:${"a".repeat(64)}`,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  localStorage.clear();
  mocks.startScan.mockResolvedValue({ data: scan });
  mocks.listPairs.mockResolvedValue({
    data: { scan, pairs: [pair], count: 1, complete: true },
  });
  mocks.getSettings.mockResolvedValue({
    data: { merge_confidence_threshold: 0.85 },
  });
  mocks.updateSettings.mockResolvedValue({
    data: { merge_confidence_threshold: 0.85 },
  });
  mocks.apply.mockImplementation(async (input: { dry_run?: boolean }) =>
    input.dry_run
      ? { data: preview }
      : {
          data: {
            ...preview,
            dry_run: false,
            events_moved: 12,
            suppressions_moved: 1,
            loser_soft_deleted: true,
          },
        },
  );
});

afterEach(() => {
  if (root) {
    const mounted = root;
    act(() => mounted.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement))
    throw new Error(`Missing button ${label}`);
  return match;
}

describe("Subscribers duplicate review workspace", () => {
  it("renders a complete, evidence-rich, keyboard-readable manifest with no axe violations", async () => {
    render(<DuplicatesModal open onClose={vi.fn()} onMerged={vi.fn()} />);
    await settle();

    expect(mocks.startScan).toHaveBeenCalledTimes(1);
    expect(mocks.listPairs).toHaveBeenCalledWith(scan.scan_id, {
      cursor: undefined,
      limit: 50,
      signal: expect.any(AbortSignal),
    });
    expect(document.body.textContent).toContain("2,105");
    expect(document.body.textContent).toContain("active profiles checked");
    expect(document.body.textContent).toContain(pair.primary_email);
    expect(document.body.textContent).toContain(pair.evidence[0].reason);
    expect(document.body.textContent).toContain("90%");
    expect(document.querySelector("table caption")?.textContent).toContain(
      "server evidence",
    );
    expect(
      document.querySelector(".dedupe-table-scroll")?.getAttribute("tabindex"),
    ).toBe("0");

    const accessibility = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("binds typed confirmation to the exact scan, versions, direction, and reviewed fingerprint", async () => {
    const onMerged = vi.fn();
    render(<DuplicatesModal open onClose={vi.fn()} onMerged={onMerged} />);
    await settle();
    act(() => button("Review merge").click());
    await settle();

    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Why this pair was surfaced");
    expect(document.body.textContent).toContain("custom_fields.plan");
    expect(document.body.textContent).toContain("Most restrictive wins");
    expect(document.body.textContent).toContain(
      "list memberships, notes, and ID-keyed history",
    );
    expect(document.activeElement).toBe(
      document.querySelector('input[name="merge-primary"]'),
    );
    expect(mocks.apply).toHaveBeenNthCalledWith(
      1,
      {
        primary_id: pair.primary_id,
        duplicate_id: pair.duplicate_id,
        scan_id: scan.scan_id,
        expected_primary_updated_at: pair.primary_updated_at,
        expected_duplicate_updated_at: pair.duplicate_updated_at,
        dry_run: true,
      },
      { signal: expect.any(AbortSignal) },
    );

    const confirm = button("Apply reviewed merge");
    expect(confirm.disabled).toBe(true);
    const typed = document.querySelector('input[placeholder="MERGE"]');
    if (!(typed instanceof HTMLInputElement))
      throw new Error("Missing typed confirmation");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(typed, "MERGE");
      typed.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirm.disabled).toBe(false);
    act(() => confirm.click());
    await settle();

    expect(mocks.apply).toHaveBeenNthCalledWith(2, {
      primary_id: pair.primary_id,
      duplicate_id: pair.duplicate_id,
      scan_id: scan.scan_id,
      expected_primary_updated_at: pair.primary_updated_at,
      expected_duplicate_updated_at: pair.duplicate_updated_at,
      expected_plan_fingerprint: preview.plan_fingerprint,
      dry_run: false,
    });
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Subscriber rows merged" }),
    );
    expect(JSON.stringify(mocks.toastSuccess.mock.calls)).not.toContain(
      "@example.test",
    );
  });

  it("aborts and rejects a late scan result after the modal closes", async () => {
    let resolveScan: ((value: { data: typeof scan }) => void) | null = null;
    mocks.startScan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
    );
    const view = render(
      <DuplicatesModal open onClose={vi.fn()} onMerged={vi.fn()} />,
    );
    await settle(2);
    const signal = mocks.startScan.mock.calls[0]?.[0]?.signal as AbortSignal;
    view.rerender(
      <DuplicatesModal open={false} onClose={vi.fn()} onMerged={vi.fn()} />,
    );
    expect(signal.aborted).toBe(true);
    await act(async () => resolveScan?.({ data: scan }));
    await settle();
    expect(mocks.listPairs).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("candidate pairs found");
  });

  it("fails closed if a later page repeats an already-reviewed pair", async () => {
    const pagedScan = { ...scan, candidate_count: 2 };
    mocks.startScan.mockResolvedValue({ data: pagedScan });
    mocks.listPairs
      .mockResolvedValueOnce({
        data: {
          scan: pagedScan,
          pairs: [pair],
          count: 2,
          next_cursor: "1",
          complete: true,
        },
      })
      .mockResolvedValueOnce({
        data: {
          scan: pagedScan,
          pairs: [pair],
          count: 2,
          complete: true,
        },
      });
    render(<DuplicatesModal open onClose={vi.fn()} onMerged={vi.fn()} />);
    await settle();
    act(() => button("Load next 50 pairs").click());
    await settle();

    expect(document.body.textContent).toContain(
      "The scanner returned an incomplete manifest",
    );
    expect(button("Review merge").disabled).toBe(true);
    expect(button("Load next 50 pairs").disabled).toBe(true);
  });

  it("uses generic failure copy and keeps a failed group available for retry", async () => {
    mocks.apply.mockResolvedValue({
      error: {
        kind: "http",
        code: "merge_failed",
        status: 500,
        message: "database failed for secret-person@example.test",
      },
    });
    render(<DuplicatesModal open onClose={vi.fn()} onMerged={vi.fn()} />);
    await settle();
    act(() => button("Review merge").click());
    await settle();
    expect(document.body.textContent).toContain(
      "The merge could not be verified. The candidate was kept for a safe retry.",
    );
    expect(document.body.textContent).not.toContain(
      "secret-person@example.test",
    );
    expect(button("Recompute plan")).not.toBeNull();
  });

  it("never misreports a stale 409 as an already-completed merge", async () => {
    const onMerged = vi.fn();
    mocks.apply
      .mockResolvedValueOnce({ data: preview })
      .mockResolvedValueOnce({
        error: {
          kind: "http",
          code: "stale_review",
          status: 409,
          message: "changed",
        },
      });
    render(<DuplicatesModal open onClose={vi.fn()} onMerged={onMerged} />);
    await settle();
    act(() => button("Review merge").click());
    await settle();

    const typed = document.querySelector('input[placeholder="MERGE"]');
    if (!(typed instanceof HTMLInputElement))
      throw new Error("Missing typed confirmation");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(typed, "MERGE");
      typed.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("Apply reviewed merge").click());
    await settle();

    expect(onMerged).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "One of these rows changed after review",
    );
    expect(document.body.textContent).not.toContain("Subscriber rows merged");
  });
});

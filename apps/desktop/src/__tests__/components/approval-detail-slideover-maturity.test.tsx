// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
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
  getApproval: vi.fn(),
  runByApproval: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { getApproval: mocks.getApproval },
  agentRoutinesApi: { runByApproval: mocks.runByApproval },
}));

vi.mock("../../components/ai/AgentTrustPanel", () => ({
  AgentTrustPanel: ({ run }: { run: { id: string } }) => (
    <div data-testid="agent-trust-panel">Verified agent run {run.id}</div>
  ),
}));

import { ApprovalDetailSlideover } from "../../components/ApprovalDetailSlideover";
import { Modal, ModalFooter } from "../../components/Modal";
import type { ApprovalRow } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getApproval.mockImplementation(async (id: string) => ({
    data: approval(id),
  }));
  mocks.runByApproval.mockResolvedValue({
    error: { message: "not found", status: 404 },
  });
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function approval(
  id = "approval-1",
  overrides: Partial<ApprovalRow> = {},
): ApprovalRow {
  return {
    id,
    resourceType: "campaign",
    resourceId: `campaign-${id}`,
    requestedByActorType: "user",
    requestedByActorLabel: "reviewer@example.test",
    status: "pending",
    requestedAt: "2026-08-10T09:15:00.000Z",
    expiresAt: "2030-08-11T09:15:00.000Z",
    notes: "Confirm audience and delivery window.",
    ...overrides,
  };
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender: (next) => act(() => root?.render(next)),
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
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
      await flush();
    }
  }
  throw lastError;
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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((candidate) => candidate.textContent?.trim() === label);
}

function dispatchKey(
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
        key,
      }),
    );
  });
}

function dialog(): HTMLElement {
  const match = document.querySelector<HTMLElement>(
    ".approval-detail-shell[role='dialog']",
  );
  if (!match) throw new Error("Missing approval detail dialog");
  return match;
}

describe("ApprovalDetailSlideover maturity", () => {
  it("loads an exact record before actions, uses semantic facts, omits metadata, and is WCAG A/AA clean", async () => {
    const request = deferred<{ data: ApprovalRow }>();
    const onReject = vi.fn();
    const exact = approval("approval-exact", {
      metadata: {
        access_token: "METADATA_SECRET_CANARY",
        provider_response: { raw: "PROVIDER_METADATA_CANARY" },
      },
    });
    mocks.getApproval.mockReturnValue(request.promise);

    render(
      <ApprovalDetailSlideover
        row={approval("approval-exact")}
        onClose={vi.fn()}
        canDecide
        onReject={onReject}
      />,
    );

    expect(document.body.textContent).toContain(
      "Loading exact approval record",
    );
    expect(buttons("Reject request")).toHaveLength(0);
    expect(document.activeElement).toBe(
      document.querySelector(".approval-detail-truth"),
    );
    expect(document.body.style.overflow).toBe("hidden");

    request.resolve({ data: exact });
    await waitFor(() =>
      expect(document.body.textContent).toContain("Exact record verified"),
    );

    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(document.querySelectorAll("dl").length).toBeGreaterThanOrEqual(3);
    expect(document.querySelectorAll("dt").length).toBeGreaterThanOrEqual(7);
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-10T09:15:00.000Z",
    );
    expect(document.body.textContent).toContain("Campaign approval");
    expect(document.body.textContent).toContain("User");
    expect(document.body.textContent).toContain(
      "downstream execution is not shown here",
    );
    expect(document.documentElement.outerHTML).not.toContain(
      "METADATA_SECRET_CANARY",
    );
    expect(document.documentElement.outerHTML).not.toContain(
      "PROVIDER_METADATA_CANARY",
    );
    expect(document.body.textContent).not.toContain("Metadata");

    act(() => button("Reject request").click());
    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: exact.id,
        resourceType: exact.resourceType,
        resourceId: exact.resourceId,
        status: exact.status,
        requestedAt: exact.requestedAt,
      }),
    );
    const rejectedProjection = onReject.mock.calls[0]?.[0];
    expect(rejectedProjection).not.toHaveProperty("metadata");
    expect(rejectedProjection).not.toHaveProperty("requestedByApiKeyId");
    expect(rejectedProjection).not.toHaveProperty("decidedByUserId");
    expect(mocks.runByApproval).not.toHaveBeenCalled();

    const result = await axe.run(dialog(), {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    expect(result.violations).toEqual([]);
  });

  it("gives the current selection ownership when older approval requests resolve late", async () => {
    const first = deferred<{ data: ApprovalRow }>();
    const second = deferred<{ data: ApprovalRow }>();
    const onReject = vi.fn();
    mocks.getApproval.mockImplementation((id: string) =>
      id === "approval-a" ? first.promise : second.promise,
    );
    const rowA = approval("approval-a", {
      resourceId: "campaign-a",
      notes: "STALE_APPROVAL_A_CANARY",
    });
    const rowB = approval("approval-b", {
      resourceId: "campaign-b",
      notes: "Current selection B",
    });

    const view = render(
      <ApprovalDetailSlideover
        row={rowA}
        onClose={vi.fn()}
        canDecide
        onReject={onReject}
      />,
    );
    view.rerender(
      <ApprovalDetailSlideover
        row={rowB}
        onClose={vi.fn()}
        canDecide
        onReject={onReject}
      />,
    );

    expect(mocks.getApproval.mock.calls.map(([id]) => id)).toEqual([
      "approval-a",
      "approval-b",
    ]);
    second.resolve({ data: rowB });
    await waitFor(() =>
      expect(document.body.textContent).toContain("Current selection B"),
    );
    first.resolve({ data: rowA });
    await flush();

    expect(document.body.textContent).toContain("campaign-b");
    expect(document.body.textContent).not.toContain("campaign-a");
    expect(document.body.textContent).not.toContain("STALE_APPROVAL_A_CANARY");
    act(() => button("Reject request").click());
    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({
        id: rowB.id,
        resourceType: rowB.resourceType,
        resourceId: rowB.resourceId,
        status: rowB.status,
      }),
    );
  });

  it("keeps provider failures private, marks the snapshot read-only, and recovers through retry", async () => {
    const exact = approval("approval-retry", {
      requestedByActorType: "agent",
      metadata: { secret: "RETRY_METADATA_CANARY" },
    });
    mocks.getApproval
      .mockResolvedValueOnce({
        error: {
          message: "RAW_PROVIDER_FAILURE_CANARY",
          status: 503,
          details: { response: "RAW_SERVER_BODY_CANARY" },
        },
      })
      .mockResolvedValueOnce({ data: exact });
    mocks.runByApproval.mockRejectedValue(
      new Error("AGENT_PROVIDER_EXCEPTION_CANARY"),
    );

    render(
      <ApprovalDetailSlideover
        row={exact}
        onClose={vi.fn()}
        canDecide
        onReject={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("Latest record unavailable"),
    );

    expect(buttons("Reject request")).toHaveLength(0);
    expect(button("Retry").disabled).toBe(false);
    const failedHtml = document.documentElement.outerHTML;
    expect(failedHtml).not.toContain("RAW_PROVIDER_FAILURE_CANARY");
    expect(failedHtml).not.toContain("RAW_SERVER_BODY_CANARY");
    expect(failedHtml).not.toContain("AGENT_PROVIDER_EXCEPTION_CANARY");
    expect(failedHtml).not.toContain("RETRY_METADATA_CANARY");
    expect(document.body.textContent).toContain(
      "Agent evidence waits for exact approval verification",
    );

    act(() => button("Retry").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Exact record verified"),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Agent provenance could not be verified right now",
      ),
    );
    expect(buttons("Reject request")).toHaveLength(1);
    expect(document.documentElement.outerHTML).not.toContain(
      "RETRY_METADATA_CANARY",
    );
  });

  it("waits for exact retry verification before requesting agent evidence", async () => {
    const exact = approval("approval-retry-boundary", {
      requestedByActorType: "agent",
    });
    const retry = deferred<{ data: ApprovalRow }>();
    mocks.getApproval
      .mockResolvedValueOnce({
        error: { message: "detail unavailable", status: 503 },
      })
      .mockReturnValueOnce(retry.promise);

    render(<ApprovalDetailSlideover row={exact} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Latest record unavailable"),
    );
    expect(mocks.runByApproval).not.toHaveBeenCalled();

    act(() => button("Retry").click());
    await flush();
    expect(mocks.runByApproval).not.toHaveBeenCalled();

    retry.resolve({ data: exact });
    await waitFor(() => expect(mocks.runByApproval).toHaveBeenCalledTimes(1));
    expect(mocks.runByApproval).toHaveBeenCalledWith(exact.id);
  });

  it("refreshes agent evidence only after a newer exact record is verified", async () => {
    const exact = approval("approval-refresh-boundary", {
      requestedByActorType: "agent",
    });
    const refresh = deferred<{ data: ApprovalRow }>();
    mocks.getApproval
      .mockResolvedValueOnce({ data: exact })
      .mockReturnValueOnce(refresh.promise);

    render(<ApprovalDetailSlideover row={exact} onClose={vi.fn()} />);
    await waitFor(() => expect(mocks.runByApproval).toHaveBeenCalledTimes(1));

    act(() => button("Refresh").click());
    await flush();
    expect(mocks.runByApproval).toHaveBeenCalledTimes(1);

    refresh.resolve({ data: exact });
    await waitFor(() => expect(mocks.runByApproval).toHaveBeenCalledTimes(2));
    expect(mocks.runByApproval).toHaveBeenLastCalledWith(exact.id);
  });

  it("retains a labelled last-verified record after refresh failure and pauses decisions until recovery", async () => {
    const exact = approval("approval-stale", {
      notes: "LAST_VERIFIED_RECORD_CANARY",
    });
    mocks.getApproval
      .mockResolvedValueOnce({ data: exact })
      .mockResolvedValueOnce({
        error: { message: "REFRESH_FAILURE_CANARY", status: 502 },
      })
      .mockResolvedValueOnce({ data: exact });

    render(
      <ApprovalDetailSlideover
        row={exact}
        onClose={vi.fn()}
        canDecide
        onReject={vi.fn()}
      />,
    );
    await waitFor(() => expect(buttons("Refresh")).toHaveLength(1));
    act(() => button("Refresh").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Last verified record may be stale",
      ),
    );

    expect(document.body.textContent).toContain("LAST_VERIFIED_RECORD_CANARY");
    expect(document.documentElement.outerHTML).not.toContain(
      "REFRESH_FAILURE_CANARY",
    );
    expect(buttons("Reject request")).toHaveLength(0);

    act(() => button("Retry").click());
    await waitFor(() => expect(buttons("Reject request")).toHaveLength(1));
  });

  it("rejects a mismatched exact response without reflecting the foreign record", async () => {
    const selected = approval("approval-selected", {
      notes: "Selected list snapshot",
    });
    mocks.getApproval.mockResolvedValue({
      data: approval("approval-foreign", {
        resourceId: "FOREIGN_RESOURCE_CANARY",
        notes: "FOREIGN_NOTES_CANARY",
      }),
    });

    render(
      <ApprovalDetailSlideover
        row={selected}
        onClose={vi.fn()}
        canDecide
        onReject={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("Latest record unavailable"),
    );

    expect(document.body.textContent).toContain("Selected list snapshot");
    expect(document.documentElement.outerHTML).not.toContain(
      "FOREIGN_RESOURCE_CANARY",
    );
    expect(document.documentElement.outerHTML).not.toContain(
      "FOREIGN_NOTES_CANARY",
    );
    expect(buttons("Reject request")).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["elapsed", "2020-01-01T00:00:00.000Z"],
  ])(
    "keeps decision controls hidden when exact evidence has a %s expiry",
    async (_label, expiresAt) => {
      const exact = approval("approval-expiry-gate", { expiresAt });
      mocks.getApproval.mockResolvedValue({ data: exact });
      render(
        <ApprovalDetailSlideover
          row={exact}
          onClose={vi.fn()}
          canDecide
          onReject={vi.fn()}
        />,
      );
      await waitFor(() =>
        expect(document.body.textContent).toContain("Exact record verified"),
      );

      expect(buttons("Reject request")).toHaveLength(0);
      expect(document.body.textContent).toContain(
        "Decisions require a verified, recognized pending record",
      );
    },
  );

  it("fails closed for unknown status, type, requester, identifiers, and invalid timestamps", async () => {
    const rawStatus = "provider_shadow_state_CANARY";
    const rawType = "private_resource_type_CANARY";
    const rawActor = "private_actor_type_CANARY";
    const rawIdentifier = `unsafe id ${"x".repeat(180)}_IDENTIFIER_CANARY`;
    const exact = approval("approval-unknown", {
      status: rawStatus,
      resourceType: rawType,
      requestedByActorType: rawActor,
      requestedByActorLabel: undefined,
      resourceId: rawIdentifier,
      requestedAt: "INVALID_DATE_CANARY",
      metadata: { hidden: "UNKNOWN_METADATA_CANARY" },
    });
    mocks.getApproval.mockResolvedValue({ data: exact });

    render(
      <ApprovalDetailSlideover
        row={exact}
        onClose={vi.fn()}
        canDecide
        onReject={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain("Latest record unavailable"),
    );

    expect(document.body.textContent).toContain("Unrecognized state");
    expect(document.body.textContent).toContain("Unrecognized approval type");
    expect(document.body.textContent).toContain("Unverified requester type");
    expect(document.body.textContent).toContain("Unavailable");
    expect(
      document
        .querySelector(".approval-detail-status")
        ?.getAttribute("data-state"),
    ).toBe("unknown");
    expect(buttons("Reject request")).toHaveLength(0);
    const html = document.documentElement.outerHTML;
    for (const canary of [
      rawStatus,
      rawType,
      rawActor,
      rawIdentifier,
      "INVALID_DATE_CANARY",
      "UNKNOWN_METADATA_CANARY",
    ]) {
      expect(html).not.toContain(canary);
    }
  });

  it("renders agent evidence only when the run proves the exact approval link", async () => {
    const exact = approval("approval-agent", {
      requestedByActorType: "agent",
    });
    mocks.getApproval.mockResolvedValue({ data: exact });
    mocks.runByApproval
      .mockResolvedValueOnce({
        data: {
          id: "run-wrong",
          routine_id: "routine-1",
          approval_id: "approval-elsewhere",
          status: "succeeded",
          started_at: "2026-08-10T09:00:00.000Z",
          reasoning: "UNOWNED_AGENT_EVIDENCE_CANARY",
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "run-exact",
          routine_id: "routine-1",
          approval_id: exact.id,
          status: "succeeded",
          started_at: "2026-08-10T09:00:00.000Z",
        },
      });

    render(<ApprovalDetailSlideover row={exact} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Agent provenance could not be verified right now",
      ),
    );
    expect(
      document.querySelector("[data-testid='agent-trust-panel']"),
    ).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain(
      "UNOWNED_AGENT_EVIDENCE_CANARY",
    );

    act(() => button("Retry evidence").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "A linked agent run was verified for this approval",
      ),
    );
    expect(document.body.textContent).toContain("Verified agent run run-exact");
  });

  it("withholds malformed or oversized exact-linked agent evidence", async () => {
    const exact = approval("approval-agent-bounded", {
      requestedByActorType: "agent",
    });
    const rawCanary = `UNBOUNDED_AGENT_CANARY_${"x".repeat(4_100)}`;
    mocks.getApproval.mockResolvedValue({ data: exact });
    mocks.runByApproval
      .mockResolvedValueOnce({
        data: {
          id: "run-exact",
          routine_id: "routine-1",
          approval_id: exact.id,
          status: "succeeded",
          started_at: "2026-08-10T09:00:00.000Z",
          reasoning: rawCanary,
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "run-impossible-date",
          routine_id: "routine-1",
          approval_id: exact.id,
          status: "succeeded",
          started_at: "2026-02-30T09:00:00.000Z",
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "run-duplicate-positions",
          routine_id: "routine-1",
          approval_id: exact.id,
          status: "succeeded",
          started_at: "2026-08-10T09:00:00.000Z",
          draft_preview: {
            kind: "sequence",
            steps: [{ position: 1 }, { position: 1 }],
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: "run-locale-date",
          routine_id: "routine-1",
          approval_id: exact.id,
          status: "succeeded",
          started_at: "August 10, 2026 09:00:00",
        },
      });

    render(<ApprovalDetailSlideover row={exact} onClose={vi.fn()} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Agent provenance could not be verified right now",
      ),
    );

    expect(
      document.querySelector("[data-testid='agent-trust-panel']"),
    ).toBeNull();
    expect(document.documentElement.outerHTML).not.toContain(
      "UNBOUNDED_AGENT_CANARY",
    );
    for (const invalidRunId of [
      "run-impossible-date",
      "run-duplicate-positions",
      "run-locale-date",
    ]) {
      act(() => button("Retry evidence").click());
      await waitFor(() =>
        expect(mocks.runByApproval).toHaveBeenCalledTimes(
          invalidRunId === "run-impossible-date"
            ? 2
            : invalidRunId === "run-duplicate-positions"
              ? 3
              : 4,
        ),
      );
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Agent provenance could not be verified right now",
        ),
      );
      expect(
        document.querySelector("[data-testid='agent-trust-panel']"),
      ).toBeNull();
      expect(document.documentElement.outerHTML).not.toContain(invalidRunId);
    }
  });

  it("traps focus, defers Escape to a nested decision modal, and restores the exact opener and scroll state", async () => {
    const focusRow = approval("approval-focus");
    function Harness(): ReactElement {
      const [open, setOpen] = useState(false);
      const [confirmOpen, setConfirmOpen] = useState(false);
      return (
        <>
          <button
            id="approval-opener"
            type="button"
            onClick={() => setOpen(true)}
          >
            Inspect approval
          </button>
          {open ? (
            <ApprovalDetailSlideover
              row={focusRow}
              onClose={() => setOpen(false)}
              canDecide
              onReject={() => setConfirmOpen(true)}
            />
          ) : null}
          <Modal
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title="Confirm rejection"
            description="This is the nested decision boundary."
          >
            <p>Review once more before deciding.</p>
            <ModalFooter>
              <button type="button" onClick={() => setConfirmOpen(false)}>
                Cancel decision
              </button>
            </ModalFooter>
          </Modal>
        </>
      );
    }

    document.body.style.overflow = "clip";
    render(<Harness />);
    const opener =
      document.querySelector<HTMLButtonElement>("#approval-opener");
    if (!opener) throw new Error("Missing approval opener");
    act(() => {
      opener.focus();
      opener.click();
    });
    expect(document.activeElement).toBe(
      document.querySelector(".approval-detail-truth"),
    );
    expect(document.body.style.overflow).toBe("hidden");
    expect(opener.inert).toBe(true);
    await waitFor(() => expect(buttons("Reject request")).toHaveLength(1));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "no agent-run lookup was made",
      ),
    );
    expect(mocks.runByApproval).not.toHaveBeenCalled();

    const refresh = button("Refresh");
    const closeDetails = button("Close details");
    act(() => closeDetails.focus());
    dispatchKey("Tab");
    expect(document.activeElement).toBe(refresh);
    dispatchKey("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(closeDetails);

    act(() => button("Reject request").click());
    await waitFor(() =>
      expect(
        document.querySelectorAll("[role='dialog'], [role='alertdialog']"),
      ).toHaveLength(2),
    );
    dispatchKey("Escape");
    await flush();
    expect(
      document.querySelectorAll("[role='dialog'], [role='alertdialog']"),
    ).toHaveLength(1);
    expect(document.querySelector(".approval-detail-shell")).not.toBeNull();

    dispatchKey("Escape");
    await flush();
    await Promise.resolve();
    expect(document.querySelector(".approval-detail-shell")).toBeNull();
    expect(document.body.style.overflow).toBe("clip");
    expect(opener.inert).toBe(false);
    expect(opener.hasAttribute("aria-hidden")).toBe(false);
    expect(document.activeElement).toBe(opener);
    await flush();
  });
});

/**
 * Deciding an AI investigation from a list snapshot.
 *
 * The hazard is specific and was live: approve/reject fired straight off a row
 * the screen fetched at some earlier moment, and the only decidable status is
 * `draft`. So the confirm sheet could describe a plan a teammate had already
 * approved — and the person tapping "Approve plan" was being asked to confirm
 * something that no longer existed. `useAuditInvestigation` was written for
 * exactly this and had no caller, because a declarative query keyed on an id
 * cannot be awaited inside a callback.
 *
 * What is pinned here is the ORDER and the REFUSAL: the server is asked before
 * the person is, and a row that has left `draft` never reaches a confirm sheet
 * at all. Plus the deliberate non-behaviour — a re-read that fails does not
 * block the decision, because `AND status = 'draft'` on the write is the real
 * gate and a flaky phone must not make the queue undecidable.
 */
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditInvestigation } from "@/lib/auditInvestigations";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const calls: string[] = [];
const reread = vi.fn<(id: string) => Promise<AuditInvestigation | null>>();
const mutateAsync = vi.fn(async () => {
  calls.push("mutate");
  return {};
});

vi.mock("@/hooks/useAuditInvestigations", () => ({
  useInvestigationDecision: () => ({ mutateAsync, isPending: false }),
  useInvestigationReread: () => (id: string) => {
    calls.push("reread");
    return reread(id);
  },
}));

vi.mock("@/lib/haptics", () => ({
  haptics: {
    impact: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const { useInvestigationReview } = await import("./useInvestigationReview");

function investigation(over: Partial<AuditInvestigation> = {}): AuditInvestigation {
  return {
    id: "inv_1",
    seed_audit_id: 42,
    findings: [],
    evidence_audit_ids: [],
    proposed_actions: [],
    mitre_techniques: [],
    confidence: 0.8,
    status: "draft",
    ...over,
  };
}

function action(id: string) {
  return { id, kind: "suspend_key", target: "key_1", rationale: "" } as never;
}

let confirmed: { title: string; message: string }[];
let confirmAnswer: boolean;
let toasts: { kind: string; message: string }[];
let review: ReturnType<typeof useInvestigationReview> | undefined;

function Probe() {
  review = useInvestigationReview({
    confirm: (async (copy: { title: string; message: string }) => {
      calls.push("confirm");
      confirmed.push(copy);
      return confirmAnswer;
    }) as never,
    toast: ((entry: { kind: string; message: string }) => {
      toasts.push(entry);
    }) as never,
  });
  return null;
}

let renderer: TestRenderer.ReactTestRenderer | undefined;

async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
}

/** Drain the promise chain the handlers kick off with `void (async () => …)`. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  calls.length = 0;
  confirmed = [];
  toasts = [];
  confirmAnswer = true;
  review = undefined;
  renderer = undefined;
  reread.mockReset();
  mutateAsync.mockClear();
});

describe("approving", () => {
  it("asks the server before it asks the person", async () => {
    reread.mockResolvedValue(investigation());
    await mount();
    act(() => review?.approve(investigation()));
    await settle();
    expect(calls).toEqual(["reread", "confirm", "mutate"]);
  });

  it("describes the plan the server has now, not the one the list cached", async () => {
    // The list row is stale by one action. Confirming against the stale copy
    // would understate what is about to be approved.
    reread.mockResolvedValue(
      investigation({ proposed_actions: [action("a"), action("b"), action("c")] }),
    );
    await mount();
    act(() => review?.approve(investigation({ proposed_actions: [action("a")] })));
    await settle();
    expect(confirmed[0]?.message).toContain("3 proposed actions");
  });

  it("refuses a row someone already decided, without a confirm sheet", async () => {
    reread.mockResolvedValue(investigation({ status: "approved" }));
    await mount();
    act(() => review?.approve(investigation()));
    await settle();
    expect(calls).toEqual(["reread"]);
    expect(confirmed).toEqual([]);
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(toasts[0]?.kind).toBe("error");
    expect(toasts[0]?.message).toContain("already approved");
  });

  it("says an executed plan was executed, not merely approved", async () => {
    reread.mockResolvedValue(investigation({ status: "executed" }));
    await mount();
    act(() => review?.approve(investigation()));
    await settle();
    expect(toasts[0]?.message).toContain("approved and executed");
  });

  it("refuses a row that is gone", async () => {
    reread.mockResolvedValue(null);
    await mount();
    act(() => review?.approve(investigation()));
    await settle();
    expect(confirmed).toEqual([]);
    expect(toasts[0]?.message).toContain("no longer available");
  });

  it("still lets the decision through when the re-read itself fails", async () => {
    // The safety net is not the gate. `Store.Approve` carries
    // `AND status = 'draft'`, so a stale decision is a 409 and never a wrong
    // write — and refusing to act on a dropped connection would make the
    // queue undecidable to prevent something the server already prevents.
    reread.mockRejectedValue(new Error("offline"));
    await mount();
    act(() => review?.approve(investigation()));
    await settle();
    expect(calls).toEqual(["reread", "confirm", "mutate"]);
  });

  it("does not decide when the person declines the sheet", async () => {
    reread.mockResolvedValue(investigation());
    confirmAnswer = false;
    await mount();
    act(() => review?.approve(investigation()));
    await settle();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe("rejecting", () => {
  it("re-reads at submit, not at open — the sheet can sit there for minutes", async () => {
    reread.mockResolvedValue(investigation());
    await mount();
    act(() => review?.openReject(investigation()));
    // Opening the sheet asks nothing of the server.
    expect(calls).toEqual([]);
    act(() =>
      review?.setRejectDraft({
        id: "inv_1",
        label: "investigation from event #42",
        reason: "Not our incident",
      }),
    );
    act(() => review?.submitReject());
    await settle();
    expect(calls).toEqual(["reread", "mutate"]);
  });

  it("reports a row decided out from under the open sheet in the sheet", async () => {
    // A toast would be the wrong surface: the person is looking at the reject
    // sheet, and the error belongs where their attention is.
    reread.mockResolvedValue(investigation({ status: "rejected" }));
    await mount();
    act(() =>
      review?.setRejectDraft({
        id: "inv_1",
        label: "investigation from event #42",
        reason: "Not our incident",
      }),
    );
    act(() => review?.submitReject());
    await settle();
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(review?.rejectError).toContain("already rejected");
    expect(toasts).toEqual([]);
  });

  it("still refuses an empty reason before it asks the server anything", async () => {
    // The pre-existing client mirror of the server's `reason_required` 400 —
    // it must keep firing first, so an empty reason costs no round trip.
    await mount();
    act(() =>
      review?.setRejectDraft({ id: "inv_1", label: "l", reason: "   " }),
    );
    act(() => review?.submitReject());
    await settle();
    expect(calls).toEqual([]);
    expect(review?.rejectError).toContain("reason is required");
  });
});

import { describe, expect, it } from "vitest";

import {
  approvalArrivalLabel,
  approvalArrivalSpokenLabel,
  displayedApprovalIds,
  withheldApprovals,
} from "./approvalArrivals";

const row = (id: string, status = "pending") => ({ id, status });

describe("withheldApprovals", () => {
  it("renders everything on a first load — a null hold is not an empty one", () => {
    const incoming = [row("a"), row("b"), row("c")];
    expect(withheldApprovals(incoming, null)).toEqual({
      rows: incoming,
      newCount: 0,
      autoAdopted: false,
    });
  });

  it("holds arrivals back instead of sliding them under the thumb", () => {
    const displayed = ["b", "c"];
    // The poll returns the new request FIRST — newest-first ordering is
    // exactly what makes this dangerous.
    const { rows, newCount } = withheldApprovals(
      [row("new"), row("b"), row("c")],
      displayed,
    );
    expect(rows.map((r) => r.id)).toEqual(["b", "c"]);
    expect(newCount).toBe(1);
  });

  it("counts several arrivals across a single poll", () => {
    const { rows, newCount } = withheldApprovals(
      [row("n1"), row("n2"), row("n3"), row("a")],
      ["a"],
    );
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(newCount).toBe(3);
  });

  it("lets an UPDATE to a visible row through — a frozen status walks an approver into a 409", () => {
    const { rows, newCount } = withheldApprovals(
      [row("a", "approved")],
      ["a"],
    );
    expect(rows).toEqual([{ id: "a", status: "approved" }]);
    expect(newCount).toBe(0);
  });

  it("lets a REMOVAL through — a phantom row offers a decision the server refuses", () => {
    const { rows, newCount } = withheldApprovals([row("b")], ["a", "b"]);
    expect(rows.map((r) => r.id)).toEqual(["b"]);
    expect(newCount).toBe(0);
  });

  it("survives an undefined page without claiming arrivals", () => {
    expect(withheldApprovals(undefined, ["a"])).toEqual({
      rows: [],
      newCount: 0,
      autoAdopted: false,
    });
    expect(withheldApprovals(undefined, null)).toEqual({
      rows: [],
      newCount: 0,
      autoAdopted: false,
    });
  });

  it("does not mutate or alias the incoming page", () => {
    const incoming = [row("a")];
    const out = withheldApprovals(incoming, null);
    expect(out.rows).not.toBe(incoming);
    out.rows.push(row("z"));
    expect(incoming).toHaveLength(1);
  });

  it("reports every row as new only when the hold set is genuinely empty", () => {
    // An empty ARRAY means "nothing was on screen" — distinct from null. With
    // nothing left to protect the hold is overridden rather than rendering
    // "You're caught up" over requests that exist.
    const out = withheldApprovals([row("a"), row("b")], []);
    expect(out.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out.newCount).toBe(0);
    expect(out.autoAdopted).toBe(true);
  });

  it("never renders an empty queue while arrivals are held", () => {
    // The teammate-cleared-the-queue case: every held id is gone and only
    // arrivals remain.
    const out = withheldApprovals([row("n1"), row("n2")], ["old"]);
    expect(out.rows).toHaveLength(2);
    expect(out.newCount).toBe(0);
    expect(out.autoAdopted).toBe(true);
  });

  it("keeps holding while even one row survives to anchor the position", () => {
    const out = withheldApprovals([row("n1"), row("a")], ["a", "gone"]);
    expect(out.rows.map((r) => r.id)).toEqual(["a"]);
    expect(out.newCount).toBe(1);
    expect(out.autoAdopted).toBe(false);
  });

  it("does not claim an auto-adopt when the queue is simply empty", () => {
    const out = withheldApprovals([], ["a"]);
    expect(out.rows).toEqual([]);
    expect(out.newCount).toBe(0);
    expect(out.autoAdopted).toBe(false);
  });

  it("round-trips through displayedApprovalIds so adopting clears the count", () => {
    const page = [row("new"), row("a")];
    const adopted = displayedApprovalIds(page);
    expect(withheldApprovals(page, adopted).newCount).toBe(0);
  });
});

describe("approvalArrivalLabel", () => {
  it("says nothing when nothing arrived", () => {
    expect(approvalArrivalLabel(0)).toBeNull();
    expect(approvalArrivalLabel(-1)).toBeNull();
  });

  it("agrees the noun with the count and names the action", () => {
    expect(approvalArrivalLabel(1)).toBe("1 new request — tap to load");
    expect(approvalArrivalLabel(4)).toBe("4 new requests — tap to load");
  });

  it("never calls an incoming request an approval", () => {
    // "3 new approvals" reads as three decisions already made — the opposite
    // of what actually arrived.
    expect(approvalArrivalLabel(3)).not.toContain("approval");
  });

  it("speaks the whole sentence, including what activation does", () => {
    expect(approvalArrivalSpokenLabel(1)).toBe(
      "1 new approval request arrived. Double tap to load them.",
    );
    expect(approvalArrivalSpokenLabel(2)).toContain("2 new approval requests");
  });
});

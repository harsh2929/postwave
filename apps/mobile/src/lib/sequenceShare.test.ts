import { describe, expect, it } from "vitest";

import { sequenceShare } from "./sequenceShare";

const ID = "11111111-1111-4111-8111-111111111111";

describe("sequenceShare", () => {
  it("builds the canonical universal link, never a hand-rolled URL", () => {
    const share = sequenceShare({ id: ID, name: "Welcome", statusLabel: "Draft", stepCount: 4 });
    expect(share?.url).toBe(`https://app.moosewave.com/app/sequences/${ID}`);
    expect(share?.title).toBe("Welcome");
    expect(share?.message).toBe(
      `Welcome\nDraft · 4 steps\nhttps://app.moosewave.com/app/sequences/${ID}`,
    );
  });

  it("singularises one step", () => {
    expect(sequenceShare({ id: ID, stepCount: 1 })?.message).toContain("1 step\n");
  });

  it("omits facts it does not have rather than printing placeholders", () => {
    const share = sequenceShare({ id: ID });
    expect(share?.message).toBe(
      `Sequence\nhttps://app.moosewave.com/app/sequences/${ID}`,
    );
  });

  it("refuses to share when there is no usable id", () => {
    // Sharing a URL that resolves to the wrong thing is worse than not
    // offering the action, so the caller gets null and hides the control.
    expect(sequenceShare({})).toBeNull();
    expect(sequenceShare({ id: "  " })).toBeNull();
    expect(sequenceShare({ id: "../../admin" })).toBeNull();
  });
});

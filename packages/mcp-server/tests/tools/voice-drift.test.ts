// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";

import { voiceDriftTools } from "../../src/tools/voice-drift.js";

function makeClient() {
  const voiceDrift = {
    check: vi.fn().mockResolvedValue({ score: 82, severity: "ok" }),
  };
  return { client: { voiceDrift }, voiceDrift };
}

describe("voiceDriftTools", () => {
  it("exposes exactly 1 tool", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = voiceDriftTools(client as any);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("voice_drift_check");
  });

  it("has a schema and a non-trivial description", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceDriftTools(client as any)[0]!;
    expect(typeof t.schema.safeParse).toBe("function");
    expect(t.description.length).toBeGreaterThan(15);
  });

  it("is annotated read-only (advisory, non-mutating)", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(voiceDriftTools(client as any)[0]!.annotations?.readOnlyHint).toBe(true);
  });

  it("forwards html, text and profile_id to the SDK", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceDriftTools(c.client as any)[0]!;
    await t.handler({ html: "<p>hi</p>", text: "hi", profile_id: "vp_1" });
    expect(c.voiceDrift.check).toHaveBeenCalledWith({
      html: "<p>hi</p>",
      text: "hi",
      profile_id: "vp_1",
    });
  });

  it("forwards undefined optionals when only html is given", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceDriftTools(c.client as any)[0]!;
    await t.handler({ html: "<p>hi</p>" });
    expect(c.voiceDrift.check).toHaveBeenCalledWith({
      html: "<p>hi</p>",
      text: undefined,
      profile_id: undefined,
    });
  });

  it("requires a non-empty html body", () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceDriftTools(c.client as any)[0]!;
    expect(t.schema.safeParse({}).success).toBe(false);
    expect(t.schema.safeParse({ html: "" }).success).toBe(false);
  });

  it("wraps SDK errors with the tool name", async () => {
    const c = makeClient();
    c.voiceDrift.check.mockRejectedValueOnce(new Error("boom"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = voiceDriftTools(c.client as any)[0]!;
    await expect(t.handler({ html: "<p>x</p>" })).rejects.toThrow("voice_drift_check: boom");
  });
});

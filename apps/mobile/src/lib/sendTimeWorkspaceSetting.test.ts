/**
 * The workspace send-time default's wire reader. {enabled: bool} both ways —
 * anything else is null, which HOLDS the switch (SendTimeDefaultCard renders
 * a held switch for null, never a guessed one): a policy toggle must not
 * default to a value nobody set.
 */
import { describe, expect, it } from "vitest";

import { readSendTimeSetting } from "./sendTimeWorkspaceSetting";

describe("readSendTimeSetting", () => {
  it("reads {enabled} in both states", () => {
    expect(readSendTimeSetting({ enabled: true })).toBe(true);
    expect(readSendTimeSetting({ enabled: false })).toBe(false);
  });

  it("returns null for every off-shape answer (the held-switch state)", () => {
    expect(readSendTimeSetting(null)).toBeNull();
    expect(readSendTimeSetting(undefined)).toBeNull();
    expect(readSendTimeSetting({})).toBeNull();
    expect(readSendTimeSetting({ enabled: "true" })).toBeNull();
    expect(readSendTimeSetting({ enabled: 1 })).toBeNull();
    // The envelope-passed-to-parser mistake: {data,error} handed straight in.
    expect(readSendTimeSetting({ data: { enabled: true }, error: null })).toBeNull();
  });
});

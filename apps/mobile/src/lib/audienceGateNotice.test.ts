import { describe, expect, it } from "vitest";

import { audienceGateNotice } from "./audienceGateNotice";

describe("audienceGateNotice", () => {
  it("says nothing when the gate is open", () => {
    expect(
      audienceGateNotice({ gateEnabled: true, hasTenant: true, noun: "segments" }),
    ).toBeNull();
    // An open gate with no tenant still yields null — the query's own
    // `Boolean(tenantId)` guard handles that, and the screen would show a
    // spinner, not a false empty.
    expect(
      audienceGateNotice({
        gateEnabled: true,
        hasTenant: false,
        noun: "segments",
      }),
    ).toBeNull();
  });

  it("asks to re-validate a cached session", () => {
    const notice = audienceGateNotice({
      gateEnabled: false,
      hasTenant: true,
      noun: "segments",
    });
    expect(notice?.title).toBe("Reconnect to load segments");
    expect(notice?.description).toContain("segments");
    expect(notice?.staleMessage).toContain("segments");
  });

  it("asks for a workspace when there is no tenant", () => {
    const notice = audienceGateNotice({
      gateEnabled: false,
      hasTenant: false,
      noun: "segments",
    });
    expect(notice?.title).toBe("Reconnect your workspace");
    // The workspace-level copy must NOT name the resource — the problem is
    // upstream of it.
    expect(notice?.description).not.toContain("segments");
  });

  it("carries the caller's noun verbatim into every string", () => {
    const notice = audienceGateNotice({
      gateEnabled: false,
      hasTenant: true,
      noun: "list members",
    });
    expect(notice?.title).toBe("Reconnect to load list members");
    expect(notice?.staleMessage).toContain("list members");
  });
});

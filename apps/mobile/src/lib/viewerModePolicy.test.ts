import { describe, expect, it } from "vitest";

import {
  shouldShowViewerBadge,
  viewerModeFailureMessage,
  viewerModeGate,
  viewerModeToggleMessage,
} from "@/lib/viewerModePolicy";

describe("viewerModeGate", () => {
  it("hides the control for api-key installs — the endpoint is session-only", () => {
    expect(
      viewerModeGate({
        mode: "api_key",
        viewerMode: false,
        canUseViewerMode: true,
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("hides the control for a role that may not preview", () => {
    expect(
      viewerModeGate({
        mode: "session",
        viewerMode: false,
        canUseViewerMode: false,
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("offers the switch to a capable admin", () => {
    expect(
      viewerModeGate({
        mode: "session",
        viewerMode: false,
        canUseViewerMode: true,
      }),
    ).toEqual({ kind: "available", active: false, exitOnly: false });
  });

  it("ALWAYS offers an exit when the preview is already active", () => {
    // The trap this prevents: capability computed from the effective role
    // would read false while previewing, hiding the only way out.
    expect(
      viewerModeGate({
        mode: "session",
        viewerMode: true,
        canUseViewerMode: false,
      }),
    ).toEqual({ kind: "available", active: true, exitOnly: true });
  });

  it("does not badge a signed-out or api-key app", () => {
    expect(
      shouldShowViewerBadge({ mode: "api_key", viewerMode: true }),
    ).toBe(false);
    expect(
      shouldShowViewerBadge({ mode: "session", viewerMode: true }),
    ).toBe(true);
  });
});

describe("viewer mode copy", () => {
  it("names the consequence in both directions", () => {
    expect(viewerModeToggleMessage(true)).toContain("read-only");
    expect(viewerModeToggleMessage(false)).toContain("permissions");
  });

  it("distinguishes a forbidden role from a dead connection", () => {
    expect(viewerModeFailureMessage(403)).toContain("role");
    expect(viewerModeFailureMessage(401)).toContain("Sign in");
    expect(viewerModeFailureMessage(0)).toContain("connection");
    expect(viewerModeFailureMessage(undefined)).toContain("connection");
  });
});

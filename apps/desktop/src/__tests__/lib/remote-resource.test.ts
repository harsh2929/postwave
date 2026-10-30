import { describe, expect, it } from "vitest";

import {
  beginRemoteLoad,
  completeRemoteLoad,
  createRemoteResource,
  failRemoteLoad,
  hasVerifiedRemoteData,
  remoteFailureFromError,
} from "../../lib/remote-resource";

describe("remote resource truth contract", () => {
  it("keeps verified empty data distinct from an initial failure", () => {
    const verifiedEmpty = completeRemoteLoad(
      createRemoteResource<string[]>(),
      [],
      10,
    );
    const failedInitial = failRemoteLoad(createRemoteResource<string[]>(), {
      message: "database internals must not be reflected",
      status: 500,
      requestId: "request-safe-1",
    });

    expect(hasVerifiedRemoteData(verifiedEmpty)).toBe(true);
    expect(verifiedEmpty).toMatchObject({
      data: [],
      transport: "ready",
      access: "allowed",
      stale: false,
      lastVerifiedAt: 10,
    });
    expect(hasVerifiedRemoteData(failedInitial)).toBe(false);
    expect(failedInitial).toMatchObject({
      data: null,
      transport: "error",
      access: "unknown",
      stale: false,
    });
    expect(failedInitial.failure?.message).not.toContain("database internals");
    expect(failedInitial.failure?.requestId).toBe("request-safe-1");
    expect(
      remoteFailureFromError({
        message: "bad diagnostics",
        code: "unsafe <script>",
        requestId: "line\nbreak",
      }),
    ).toEqual({
      access: "unknown",
      message: "The server could not verify this data.",
    });
  });

  it("retains and labels verified data across a failed background refresh", () => {
    const ready = completeRemoteLoad(
      createRemoteResource<string[]>(),
      ["row-1"],
      10,
    );
    const refreshing = beginRemoteLoad(ready);
    const failedRefresh = failRemoteLoad(refreshing, {
      message: "offline",
      kind: "offline",
    });

    expect(refreshing).toMatchObject({
      data: ["row-1"],
      transport: "loading",
    });
    expect(failedRefresh).toMatchObject({
      data: ["row-1"],
      transport: "error",
      stale: true,
      lastVerifiedAt: 10,
    });

    const retried = completeRemoteLoad(
      beginRemoteLoad(failedRefresh),
      ["row-2"],
      20,
    );
    expect(retried).toMatchObject({
      data: ["row-2"],
      transport: "ready",
      stale: false,
      lastVerifiedAt: 20,
    });
  });

  it("treats permission as an independent axis and clears prior sensitive data", () => {
    const ready = completeRemoteLoad(createRemoteResource<string[]>(), [
      "sensitive",
    ]);
    const denied = failRemoteLoad(ready, {
      message: "role query detail",
      status: 403,
      code: "insufficient_scope",
    });

    expect(denied).toMatchObject({
      data: null,
      transport: "error",
      access: "denied",
      stale: false,
    });
    expect(denied.failure?.message).toContain("does not have permission");
    expect(denied.failure?.message).not.toContain("role query detail");
    expect(
      remoteFailureFromError({ message: "expired", status: 401 }).message,
    ).toContain("no longer authorized");
  });
});

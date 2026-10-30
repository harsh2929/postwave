import { describe, expect, it, vi } from "vitest";

import {
  createExpiredSessionHandler,
  errorCodeFromBody,
  isExpiredSessionResponse,
} from "./sessionExpiry";

describe("isExpiredSessionResponse", () => {
  it("treats a 401 with no code as an expired session", () => {
    expect(isExpiredSessionResponse(401, null)).toBe(true);
    expect(isExpiredSessionResponse(401, "")).toBe(true);
    expect(isExpiredSessionResponse(401, undefined)).toBe(true);
  });

  it("recognises the session codes the API actually emits", () => {
    for (const code of ["no_session", "no_user", "session_expired"]) {
      expect(isExpiredSessionResponse(401, code)).toBe(true);
    }
    expect(isExpiredSessionResponse(401, "NO_SESSION")).toBe(true);
  });

  it("does not sign the app out for a per-resource 401 with its own code", () => {
    expect(isExpiredSessionResponse(401, "webhook_signature_invalid")).toBe(
      false,
    );
  });

  it("ignores every other status, including the mfa_required 403", () => {
    expect(isExpiredSessionResponse(403, "mfa_required")).toBe(false);
    expect(isExpiredSessionResponse(200, null)).toBe(false);
    expect(isExpiredSessionResponse(500, "no_session")).toBe(false);
  });
});

describe("errorCodeFromBody", () => {
  it("reads both envelope shapes", () => {
    expect(errorCodeFromBody('{"error":{"code":"no_session"}}')).toBe(
      "no_session",
    );
    expect(errorCodeFromBody('{"code":"no_session"}')).toBe("no_session");
  });

  it("returns null for empty, non-JSON or non-string codes", () => {
    expect(errorCodeFromBody("")).toBeNull();
    expect(errorCodeFromBody("<html>502</html>")).toBeNull();
    expect(errorCodeFromBody('{"error":{"code":42}}')).toBeNull();
  });
});

describe("createExpiredSessionHandler", () => {
  it("coalesces concurrent 401s into exactly one revalidation", async () => {
    let release: (() => void) | undefined;
    const revalidate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const handler = createExpiredSessionHandler(revalidate);

    const all = Promise.all([
      handler.handle(),
      handler.handle(),
      handler.handle(),
    ]);
    expect(handler.inFlight).toBe(true);
    release?.();
    await all;

    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(handler.inFlight).toBe(false);
  });

  it("re-arms after the in-flight revalidation settles", async () => {
    const revalidate = vi.fn(async () => {});
    const handler = createExpiredSessionHandler(revalidate);
    await handler.handle();
    await handler.handle();
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("swallows a failing revalidation instead of rejecting into the transport", async () => {
    const revalidate = vi.fn(async () => {
      throw new Error("offline");
    });
    const handler = createExpiredSessionHandler(revalidate);
    await expect(handler.handle()).resolves.toBeUndefined();
    expect(handler.inFlight).toBe(false);
  });
});

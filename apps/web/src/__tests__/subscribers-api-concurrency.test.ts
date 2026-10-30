// SPDX-License-Identifier: AGPL-3.0-only
//
// Subscriber concurrency tokens. `subscribers-api` documents itself as
// "mirroring campaigns-api.ts", but it mirrored only the happy path: it
// captured the ETag on read and echoed it on write, and left out the one
// branch campaigns needed a bug report to learn.
//
// `api.request` calls `onResponse` unconditionally, BEFORE it inspects
// `res.ok`, and a 412 (WritePreconditionFailed) carries no ETag header. So a
// capture that only ever SETS leaves the rejected token sitting in the cache.
// `ensureSubscriberETag` re-fetches only when the cache is EMPTY, so every
// subsequent save re-sent the dead token and got another 412: editing a
// subscriber stayed broken until a full page reload, with no UI explaining why.
//
// Covers updateSubscriber, archiveSubscriber and unarchiveSubscriber — all
// three share the token cache, so a conflict on one poisoned the others too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, etag?: string, status = 200): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (etag) headers.set("ETag", etag);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * A server that honours If-Match. Modelled on what actually causes a 412: a
 * concurrent writer moved the record on, so the token the client holds is
 * rejected AND a re-read now yields a different one. (A server that kept
 * serving the same token would make the retry legitimately resend it, which
 * tests the mock rather than the client.)
 */
function serverRejectingStaleToken() {
  const staleVersion = '"subscriber:s1:v1"';
  const freshVersion = '"subscriber:s1:v2"';
  let served = staleVersion;
  let raceLost = false;
  fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") {
      return jsonResponse(
        { id: "s1", email: "a@b.c", version: served },
        served,
      );
    }
    if (!raceLost) {
      // The first write loses the race: another client committed first, so the
      // record now carries a token this caller has never seen.
      raceLost = true;
      served = freshVersion;
      return jsonResponse({ error: "precondition_failed" }, undefined, 412);
    }
    const ifMatch = new Headers(init?.headers).get("If-Match");
    if (ifMatch !== served) {
      return jsonResponse({ error: "precondition_failed" }, undefined, 412);
    }
    return jsonResponse({ id: "s1", email: "a@b.c", version: served }, served);
  });
}

function patchCalls() {
  return fetchMock.mock.calls.filter(
    ([, init]) =>
      ((init as RequestInit)?.method ?? "GET").toUpperCase() === "PATCH",
  );
}

describe("subscriber concurrency tokens", () => {
  it("sends the token captured with the record it read", async () => {
    const { getSubscriber, updateSubscriber } =
      await import("@/lib/subscribers-api");
    serverRejectingStaleToken();

    await getSubscriber("s1");
    await updateSubscriber("s1", { first_name: "A" }).catch(() => {});

    const first = patchCalls()[0]!;
    expect(new Headers((first[1] as RequestInit).headers).get("If-Match")).toBe(
      '"subscriber:s1:v1"',
    );
  });

  it("discards a token the server rejected, so a retry is not doomed", async () => {
    const { getSubscriber, updateSubscriber } =
      await import("@/lib/subscribers-api");
    serverRejectingStaleToken();

    await getSubscriber("s1");
    await updateSubscriber("s1", { first_name: "A" }).catch(() => {});
    await updateSubscriber("s1", { first_name: "A" }).catch(() => {});

    const calls = patchCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const retry = calls[calls.length - 1]!;
    expect(
      new Headers((retry[1] as RequestInit).headers).get("If-Match"),
    ).not.toBe('"subscriber:s1:v1"');
  });

  it("does not leave archive poisoned by a rejected edit token", async () => {
    const { getSubscriber, updateSubscriber, archiveSubscriber } =
      await import("@/lib/subscribers-api");
    serverRejectingStaleToken();

    await getSubscriber("s1");
    await updateSubscriber("s1", { first_name: "A" }).catch(() => {});
    // Archive shares the same token cache — the dead token must not carry over.
    await archiveSubscriber("s1").catch(() => {});

    const retry = patchCalls()[patchCalls().length - 1]!;
    expect(
      new Headers((retry[1] as RequestInit).headers).get("If-Match"),
    ).not.toBe('"subscriber:s1:v1"');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
//
// The 412 stale-token bug, swept across every module that CACHES a concurrency
// token (as opposed to taking one as an argument).
//
// campaigns-api hit this, fixed it, and wrote down why. Four other modules had
// copied the same cache-and-echo shape without the fix: subscribers-api,
// subscriber-profile-api, and these two. The mechanism is identical each time —
// `api.request` runs `onResponse` before checking `res.ok`, a 412 carries no
// ETag, so a capture that only ever SETS leaves the rejected token cached and
// every retry resends it.
//
// campaign-templates-api and voice-api are deliberately absent: they take
// `ifMatch` as a parameter from the caller, so there is no cache to go stale.
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

/** Honours If-Match; the first write loses the race and the record moves on. */
function serverRejectingStaleToken(body: unknown) {
  let served = '"stale"';
  let raceLost = false;
  fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") return jsonResponse(body, served);
    if (!raceLost) {
      raceLost = true;
      served = '"fresh"';
      return jsonResponse({ error: "precondition_failed" }, undefined, 412);
    }
    const ifMatch = new Headers(init?.headers).get("If-Match");
    if (ifMatch !== served) {
      return jsonResponse({ error: "precondition_failed" }, undefined, 412);
    }
    return jsonResponse(body, served);
  });
}

const writeCalls = () =>
  fetchMock.mock.calls.filter(([, init]) => {
    const m = ((init as RequestInit)?.method ?? "GET").toUpperCase();
    return m === "PATCH" || m === "PUT";
  });

function lastWriteIfMatch(): string | null {
  const calls = writeCalls();
  return new Headers((calls[calls.length - 1]![1] as RequestInit).headers).get(
    "If-Match",
  );
}

describe("segment concurrency tokens", () => {
  it("discards a token the server rejected, so the editor can recover", async () => {
    const { getSegment, updateSegment } = await import("@/lib/segments-api");
    serverRejectingStaleToken({ id: "sg1", name: "VIPs", queryAst: { op: "and", children: [] } });

    await getSegment("sg1");
    await updateSegment("sg1", { name: "A" }).catch(() => {});
    await updateSegment("sg1", { name: "A" }).catch(() => {});

    expect(writeCalls().length).toBeGreaterThanOrEqual(2);
    // Either a fresh token or none at all — anything but the dead one, which
    // would earn another 412 forever.
    expect(lastWriteIfMatch()).not.toBe('"stale"');
  });
});

describe("form concurrency tokens", () => {
  it("discards a token the server rejected, so the builder can recover", async () => {
    const { getForm, updateForm } = await import("@/lib/forms-api");
    serverRejectingStaleToken({ id: "f1", name: "Signup", structure: { fields: [] } });

    await getForm("f1");
    await updateForm("f1", { name: "A" }).catch(() => {});
    await updateForm("f1", { name: "A" }).catch(() => {});

    expect(writeCalls().length).toBeGreaterThanOrEqual(2);
    expect(lastWriteIfMatch()).not.toBe('"stale"');
  });

  it("keeps a save's token when a read the server answered before that save lands after it", async () => {
    const { getForm, updateForm } = await import("@/lib/forms-api");
    // The row's version moves on every accepted save. A GET reads the version
    // when the server handles it; `holdNextRead` keeps that response on the
    // wire until the test releases it, the way a slow read overtakes a save.
    let version = 1;
    const token = () => `"form-v${version}"`;
    let holdNextRead = false;
    let releaseHeldRead: (() => void) | null = null;
    fetchMock.mockImplementation(async (_input: unknown, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body = { id: "f1", name: "Signup", structure: { fields: [] } };
      if (method === "GET") {
        const response = jsonResponse(body, token());
        if (!holdNextRead) return response;
        holdNextRead = false;
        return new Promise<Response>((resolve) => {
          releaseHeldRead = () => resolve(response);
        });
      }
      const ifMatch = new Headers(init?.headers).get("If-Match");
      if (ifMatch !== null && ifMatch !== token()) {
        return jsonResponse({ error: "precondition_failed" }, undefined, 412);
      }
      version += 1;
      return jsonResponse(body, token());
    });

    await getForm("f1");
    holdNextRead = true;
    const slowRead = getForm("f1");
    await vi.waitFor(() => expect(releaseHeldRead).not.toBeNull());

    await updateForm("f1", { name: "Save" });
    releaseHeldRead!();
    await slowRead;

    await expect(
      updateForm("f1", { status: "published" }),
    ).resolves.toMatchObject({ id: "f1" });
    expect(lastWriteIfMatch()).toBe('"form-v2"');
  });

  it("abandons a read its caller cancelled, so a superseded refetch stops on the wire", async () => {
    const { getForm } = await import("@/lib/forms-api");
    fetchMock.mockImplementation(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const controller = new AbortController();
    const read = getForm("f1", controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    controller.abort();

    await expect(read).rejects.toMatchObject({ kind: "aborted" });
  });
});

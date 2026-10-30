/**
 * The tracking-consent transport's safety lives in a HEADER pair: the GET
 * captures the strong ETag the server computed, and the PATCH must carry it
 * back as `If-Match` — unconditionally refusing to write without one, because
 * an unconditional tracking-consent write is exactly what the server 428s.
 * Component tests mock the hook away, so this file pins the transport itself
 * with `getClient` mocked (the serviceSuite idiom).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@/api/client", () => ({
  getClient: () => ({ client: { request } }),
}));

// eslint-disable-next-line import/first
import { fetchTrackingPrefs, patchTrackingPrefs } from "./subscribersTracking";

beforeEach(() => request.mockReset());

describe("GET /subscribers/{id}/tracking-consent", () => {
  it("returns the body WITH the ETag captured from the response headers", async () => {
    request.mockImplementation(async (...args: unknown[]) => {
      const opts = args[2] as
        | { onResponseHeaders?: (h: Headers) => void }
        | undefined;
      opts?.onResponseHeaders?.(new Headers({ ETag: '"v7"' }));
      return { subscriber_id: "sub-1" };
    });
    const res = await fetchTrackingPrefs("sub 1");
    expect(res).toEqual({ body: { subscriber_id: "sub-1" }, etag: '"v7"' });
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/api/v1/subscribers/sub%201/tracking-consent",
      expect.objectContaining({ onResponseHeaders: expect.any(Function) }),
    );
  });

  it("hands back an empty etag when the server sent none", async () => {
    request.mockResolvedValue({ subscriber_id: "sub-1" });
    const res = await fetchTrackingPrefs("sub-1");
    expect(res.etag).toBe("");
  });
});

describe("PATCH /subscribers/{id}/tracking-consent", () => {
  it("sends the body conditionally on the exact reviewed state", async () => {
    request.mockResolvedValue({ ok: true });
    await patchTrackingPrefs("sub-1", '"v7"', { open_opt_out: true });
    expect(request).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/subscribers/sub-1/tracking-consent",
      {
        body: { open_opt_out: true },
        headers: { "If-Match": '"v7"' },
      },
    );
  });

  it("REFUSES to write without the token — on-device, before the wire", async () => {
    await expect(
      patchTrackingPrefs("sub-1", "", { open_opt_out: true }),
    ).rejects.toThrow(/can't be saved without the version/);
    expect(request).not.toHaveBeenCalled();
  });
});

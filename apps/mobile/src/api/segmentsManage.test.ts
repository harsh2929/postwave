/**
 * DELETE /api/v1/segments/{id} at the transport seam (rawRequest mocked —
 * the idiom src/api/audienceDestinations.test.ts documents).
 *
 * The two things worth pinning about an irreversible delete:
 *  - it hits exactly the editor-floor path it claims to (an encoded id, so
 *    a hostile id can't re-route the verb);
 *  - a refusal THROWS with the envelope's status attached, so the screen
 *    can present a 403 as the permission rule it is instead of resolving
 *    into a false "deleted" toast.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteSegment } from "./segmentsManage";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("deleteSegment", () => {
  it("DELETEs the segment's own path, id encoded", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await deleteSegment("seg/1");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/segments/seg%2F1",
    );
  });

  it("throws the envelope error with its status (a 403 is a rule, not a success)", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "editor role required", status: 403 },
    });
    await expect(deleteSegment("s1")).rejects.toMatchObject({
      message: "editor role required",
      status: 403,
    });
  });

  it("falls back to honest copy when the envelope has no message", async () => {
    rawRequest.mockResolvedValue({ data: null, error: { status: 500 } });
    await expect(deleteSegment("s1")).rejects.toThrow(
      "Couldn't delete the segment.",
    );
  });
});

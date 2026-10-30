// SPDX-License-Identifier: AGPL-3.0-only
//
// A "not available in this environment" answer (a sidecar that is not
// deployed, Campaign Assurance switched off) cannot change on a retry. The
// shared query client retried it twice anyway, so every page that depends on
// a sidecar showed its state about three seconds late, after two more
// requests. Real failures keep their two retries.
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { makeQueryClient } from "@/lib/query-client";

describe("the shared query client's retries", () => {
  it.each(["service_not_deployed", "campaign_assurance_not_enabled"])(
    "asks once for %s",
    async (code) => {
      const client = makeQueryClient();
      const queryFn = vi.fn(async () => {
        throw new ApiError("This feature isn't available in this environment.", 503, undefined, {
          code,
        });
      });
      await expect(
        client.fetchQuery({ queryKey: ["environment-state", code], queryFn, retryDelay: 0 }),
      ).rejects.toBeInstanceOf(ApiError);
      expect(queryFn).toHaveBeenCalledTimes(1);
      client.clear();
    },
  );

  it("still retries a failure twice", async () => {
    const client = makeQueryClient();
    const queryFn = vi.fn(async () => {
      throw new ApiError("upstream service did not respond", 502, undefined, {
        code: "upstream_unavailable",
      });
    });
    await expect(
      client.fetchQuery({ queryKey: ["real-failure"], queryFn, retryDelay: 0 }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(queryFn).toHaveBeenCalledTimes(3);
    client.clear();
  });
});

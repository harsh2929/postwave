/**
 * The seam a parser test cannot see.
 *
 * `lib/audienceDestinationRows.test.ts` drives the parsers with hand-built
 * BODIES (`{items: [...]}`) and passes; `__tests__/integrations-panels.native.test.tsx`
 * mocks `useDestinationSyncJobs` outright. Both were green while every real
 * response produced an empty list, because `rawRequest` resolves to the
 * `{data, error}` ENVELOPE and the transport handed that envelope to a parser
 * that reads `.items` off whatever object it is given.
 *
 * So these tests assert on the boundary itself: given exactly what `rawRequest`
 * really returns, does a row come out?
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchDestinationJobs, fetchDestinations } from "./audienceDestinations";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

// The exact bodies apps/api writes: handlers.go:199 (List) and :560 (ListJobs)
// both send `map[string]any{"items": ...}`.
const SERVER_DESTINATIONS = {
  items: [
    {
      id: "dest-1",
      provider: "mailchimp",
      status: "active",
      list_id: "7",
      external_audience_id: "aud_9",
    },
  ],
};
const SERVER_JOBS = {
  items: [
    {
      id: "job-1",
      status: "failed",
      error: "429 from provider",
      members_synced: 0,
      started_at: "2026-08-18T10:00:00Z",
      finished_at: "2026-08-18T10:00:09Z",
    },
  ],
};

describe("audience-destination reads unwrap the response envelope", () => {
  it("returns a destination from the envelope rawRequest actually resolves to", async () => {
    rawRequest.mockResolvedValue({ data: SERVER_DESTINATIONS, error: null });
    const rows = await fetchDestinations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("dest-1");
  });

  it("returns a run from the envelope rawRequest actually resolves to", async () => {
    rawRequest.mockResolvedValue({ data: SERVER_JOBS, error: null });
    const rows = await fetchDestinationJobs("dest-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toBe("429 from provider");
  });

  it("asks for the jobs of the destination it was given, id-encoded", async () => {
    rawRequest.mockResolvedValue({ data: SERVER_JOBS, error: null });
    await fetchDestinationJobs("dest/1");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/audience-destinations/dest%2F1/jobs",
    );
  });

  // A failed read must reach the error state. Returning [] here is what made
  // the original bug invisible: "request failed" and "no destinations yet"
  // rendered identically.
  it.each([
    ["fetchDestinations", () => fetchDestinations()],
    ["fetchDestinationJobs", () => fetchDestinationJobs("dest-1")],
  ])("surfaces a failed %s instead of reporting an empty list", async (_n, call) => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "boom", status: 500 },
    });
    await expect(call()).rejects.toMatchObject({ message: "boom", status: 500 });
  });
});

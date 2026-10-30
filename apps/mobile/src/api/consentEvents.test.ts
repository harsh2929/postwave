/**
 * The consent-events transport seam, driven with the real `{data, error}`
 * envelope shape — a broken read must throw, never render as "no signals".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConsentEventsError,
  fetchRecentConsentEvents,
  isConsentReadDenied,
} from "./consentEvents";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("fetchRecentConsentEvents", () => {
  it("unwraps the {events} page and encodes the since bound", async () => {
    rawRequest.mockResolvedValue({
      data: {
        events: [
          {
            subject_type: "visitor",
            source: "gpc",
            created_at: "2026-08-27T12:00:00Z",
          },
        ],
      },
      error: null,
    });
    const rows = await fetchRecentConsentEvents("2026-07-29T12:00:00+02:00");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("gpc");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/consent/events?limit=200&since=2026-07-29T12%3A00%3A00%2B02%3A00",
    );
  });

  it("surfaces a failure as a throw carrying the status", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "boom" },
    });
    await expect(fetchRecentConsentEvents("x")).rejects.toBeInstanceOf(
      ConsentEventsError,
    );
  });

  it("classifies exactly a 403 as a permission refusal", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    const denied = await fetchRecentConsentEvents("x").catch((e: unknown) => e);
    expect(isConsentReadDenied(denied)).toBe(true);

    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "" },
    });
    const other = await fetchRecentConsentEvents("x").catch((e: unknown) => e);
    expect(isConsentReadDenied(other)).toBe(false);
    expect(isConsentReadDenied(new Error("plain"))).toBe(false);
  });
});

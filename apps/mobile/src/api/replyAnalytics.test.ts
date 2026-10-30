/**
 * The transport seam for reply analytics, driven with exactly what rawRequest
 * resolves to — the {data, error} envelope. Parser tests and mocked-hook tests
 * leave the api function itself uncovered otherwise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchReplySummary,
  fetchReplyTimeseries,
  fetchReplyTopSenders,
  ReplyAnalyticsError,
  ReplyAnalyticsShapeError,
} from "./replyAnalytics";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("reply analytics reads", () => {
  it("summary asks ?days= and returns the parsed reading", async () => {
    rawRequest.mockResolvedValue({
      data: { window_days: 7, total: 3, human_replies: 2 },
      error: null,
    });
    const s = await fetchReplySummary(7);
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/replies/summary?days=7");
    expect(s).toMatchObject({ windowDays: 7, total: 3, humanReplies: 2 });
  });

  it("timeseries and top-senders hit their sibling routes, top-senders with the desktop's limit", async () => {
    rawRequest.mockResolvedValue({ data: { points: [], senders: [] }, error: null });
    await fetchReplyTimeseries(30);
    await fetchReplyTopSenders(90);
    await fetchReplyTopSenders(90, 3);
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/replies/timeseries?days=30");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/replies/top-senders?days=90&limit=8",
    );
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/replies/top-senders?days=90&limit=3",
    );
  });

  it("reads an absent subsystem (404/405/501) as null / empty, not as a failure", async () => {
    for (const status of [404, 405, 501]) {
      rawRequest.mockResolvedValue({ data: null, error: { status, message: "nope" } });
      await expect(fetchReplySummary(30)).resolves.toBeNull();
      await expect(fetchReplyTimeseries(30)).resolves.toEqual([]);
      await expect(fetchReplyTopSenders(30)).resolves.toEqual([]);
    }
  });

  it("rethrows every other failure with its status, code and denial intact", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 403,
        message: "forbidden",
        code: "not_authorized",
        denial: { reason: "role" },
      },
    });
    const err = await fetchReplySummary(30).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplyAnalyticsError);
    expect(err).toMatchObject({
      status: 403,
      code: "not_authorized",
      message: "forbidden",
      denial: { reason: "role" },
    });
    await expect(fetchReplyTimeseries(30)).rejects.toBeInstanceOf(ReplyAnalyticsError);
    await expect(fetchReplyTopSenders(30)).rejects.toBeInstanceOf(ReplyAnalyticsError);
  });

  it("falls back to its own sentence when the server sent no message", async () => {
    rawRequest.mockResolvedValue({ data: null, error: { status: 500, message: "" } });
    await expect(fetchReplySummary(30)).rejects.toThrow(
      "Couldn't load reply analytics.",
    );
  });

  it("treats an unreadable 2xx body as an error, never as an empty card", async () => {
    rawRequest.mockResolvedValue({ data: "<html>", error: null });
    await expect(fetchReplySummary(30)).rejects.toBeInstanceOf(ReplyAnalyticsShapeError);
    await expect(fetchReplyTimeseries(30)).rejects.toBeInstanceOf(ReplyAnalyticsShapeError);
    await expect(fetchReplyTopSenders(30)).rejects.toBeInstanceOf(ReplyAnalyticsShapeError);
    // A body WITH the object frame but without the load-bearing total: same.
    rawRequest.mockResolvedValue({ data: { window_days: 30 }, error: null });
    await expect(fetchReplySummary(30)).rejects.toBeInstanceOf(ReplyAnalyticsShapeError);
  });
});

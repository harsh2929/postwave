// SPDX-License-Identifier: AGPL-3.0-only
//
// What a reply-analytics failure SAYS, driven through the real api functions
// and the real errorCopy. The sibling replyAnalytics.test.ts pins the classes
// and fields; this pins the sentence the section shows and whether it offers
// Retry.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorPresentation } from "@/lib/errorCopy";
import { WireShapeError } from "@/lib/wireShapeError";

import {
  fetchReplySummary,
  fetchReplyTimeseries,
  ReplyAnalyticsError,
} from "./replyAnalytics";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("reply analytics failures read as what they are", () => {
  it("an unreadable 2xx body is a WireShapeError and says so", async () => {
    rawRequest.mockResolvedValue({ data: "<html>", error: null });
    const err = await fetchReplySummary(30).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WireShapeError);
    expect(err).toMatchObject({
      name: "ReplyAnalyticsShapeError",
      code: "wire_shape",
      message: "The server sent an unexpected reply summary response.",
    });
    expect(errorPresentation(err)).toEqual({
      message:
        "Moosewave sent a response this version of the app can't read. If this keeps happening, update the app.",
      retryable: true,
    });
  });

  it("a deliberately disabled runtime is a product boundary, not a retryable fault", async () => {
    // runtimecapability.WriteUnavailable: a 503 whose `retryable: false` is
    // the contract. ReplyAnalyticsError kept only status/code/denial, so this
    // arrived as a plain 503 and the section offered a Retry that cannot work.
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 503,
        message: "Reply intelligence is not enabled for this deployment.",
        code: "capability_unavailable",
        capability: "reply_intelligence",
        runtimeStatus: "unavailable",
        retryable: false,
      },
    });
    const err = await fetchReplyTimeseries(30).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReplyAnalyticsError);
    expect(err).toMatchObject({
      name: "ReplyAnalyticsError",
      status: 503,
      capability: "reply_intelligence",
      runtimeStatus: "unavailable",
      retryable: false,
    });
    expect(errorPresentation(err)).toEqual({
      message: "Reply intelligence is not enabled for this deployment.",
      retryable: false,
    });
  });
});

// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import type { PostwaveClient } from "@postwave/sdk";
import {
  normalizeSubjectCandidates,
  SubjectCopilot,
} from "../../src/dev/subject.js";

function mockClient(): PostwaveClient {
  return {
    inboxReality: {
      predict: vi.fn(async ({ subject }: { subject: string }) => ({
        predicted: {
          primary: subject === "Best subject" ? 1.5 : 0.25,
          promotions: -1,
          spam: Number.NaN,
        },
        content: {},
        at: new Date().toISOString(),
      })),
    },
  } as unknown as PostwaveClient;
}

describe("SubjectCopilot", () => {
  it("normalizes subject candidates before scoring", () => {
    expect(
      normalizeSubjectCandidates([
        "  Best   subject  ",
        "",
        "Best subject",
        "Second",
        "Third",
        "Fourth",
        123,
      ]),
    ).toEqual(["Best subject", "Second", "Third"]);
  });

  it("caps inputs and clamps prediction scores", async () => {
    const client = mockClient();
    const copilot = new SubjectCopilot(client, 0);
    const onResult = vi.fn();

    await copilot.run(
      {
        html: "x".repeat(250_000),
        candidates: ["Best subject", "Other subject"],
      },
      onResult,
    );

    expect(client.inboxReality.predict).toHaveBeenCalledWith({
      html: "x".repeat(200_000),
      subject: "Best subject",
    });
    expect(onResult).toHaveBeenCalledWith([
      {
        subject: "Best subject",
        predicted: { primary: 1, promotions: 0, spam: 0 },
        rank: 1,
      },
      {
        subject: "Other subject",
        predicted: { primary: 0.25, promotions: 0, spam: 0 },
        rank: 2,
      },
    ]);
  });
});

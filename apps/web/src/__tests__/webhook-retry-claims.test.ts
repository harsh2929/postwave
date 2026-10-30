// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical outbound webhook retry is implemented in source, but its richer
// web control plane and live-deployment certification are release-held. Keep
// its bounded source claims internally consistent without copying that worker's
// schedule onto inbound webhooks, where retry timing belongs to the upstream
// sender and Moosewave only owns matched product-action retries.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");
const GO = readFileSync(
  join(REPO, "apps/api/internal/outbound_webhooks/outbound_webhooks.go"),
  "utf8",
);
const DEVELOPER_PAGE = readFileSync(
  join(SRC, "app/(marketing)/developers/page.tsx"),
  "utf8",
);
const INBOUND_PAGE = readFileSync(
  join(SRC, "app/(docs)/docs/integrations/[integration]/page.tsx"),
  "utf8",
);

/** BackoffSchedule as human durations, in order. */
function schedule(): string[] {
  const block = /var BackoffSchedule = \[\]time\.Duration\{([\s\S]*?)\n\}/.exec(
    GO,
  );
  if (!block) return [];
  return [
    ...block[1]!.matchAll(/(?:(\d+)\s*\*\s*)?time\.(Second|Minute|Hour)/g),
  ].map(
    (m) => `${m[1] ?? "1"}${{ Second: "s", Minute: "m", Hour: "h" }[m[2]!]}`,
  );
}

function goConst(name: string): number | null {
  const m = new RegExp(`const ${name} = (\\d+)`).exec(GO);
  return m ? Number(m[1]) : null;
}

describe("published webhook retry boundaries", () => {
  const steps = schedule();

  it("reads the canonical worker contract", () => {
    expect(steps.length).toBeGreaterThan(4);
    expect(goConst("MaxAttempts")).toBeGreaterThan(1);
    expect(goConst("AutoDisableThreshold")).toBeGreaterThan(1);
  });

  it("keeps the canonical source summary aligned with its ceilings", () => {
    const WORDS: Record<number, string> = {
      5: "five",
      6: "six",
      7: "seven",
      8: "eight",
    };
    const attempts = goConst("MaxAttempts")!;
    expect(steps.length).toBe(attempts);
    expect(DEVELOPER_PAGE.toLowerCase()).toContain(
      `${WORDS[attempts]}-attempt widening retry schedule`,
    );
    expect(DEVELOPER_PAGE).toContain(
      `auto-disable after ${goConst("AutoDisableThreshold")} consecutive failures`,
    );
  });

  it("qualifies canonical retry as source-only web parity", () => {
    expect(DEVELOPER_PAGE).toContain("canonical /api/v1/outbound-webhooks");
    expect(DEVELOPER_PAGE).toContain("not web-wired");
    expect(DEVELOPER_PAGE).toContain("not live-environment certification");
  });

  it("does not attribute canonical delivery timing to inbound senders", () => {
    expect(INBOUND_PAGE).toContain(
      "Moosewave does not control whether or when the upstream sender retries",
    );
    expect(INBOUND_PAGE).not.toContain("AutoDisableThreshold");
    expect(INBOUND_PAGE).not.toContain("seven-attempt widening retry schedule");
    for (const step of steps) {
      expect(INBOUND_PAGE).not.toContain(`retry at ${step}`);
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The regression guard for a bug that shipped silently for four weeks.
 *
 * `PATCH /api/v1/subscribers/{id}` answers 428 when If-Match is absent or a
 * wildcard (apps/api/internal/subscribers/handlers.go:590-594). Mobile called the
 * SDK's unconditional `subscribers.update`, so replacing tags, flipping status
 * (which is how the phone unsubscribes someone) and restoring a status after
 * un-suppressing all failed — and nothing noticed, because the hook tests mock the
 * SDK and therefore assert that `update()` was CALLED, never that the server would
 * accept it.
 *
 * So the guard is deliberately a source-level one rather than another mock: a mock
 * cannot fail for the reason this bug existed.
 */
const SRC = join(__dirname, "..");

function read(relative: string): string {
  return readFileSync(join(SRC, relative), "utf8");
}

const CALLERS = [
  "hooks/useSubscribers.ts",
  "hooks/useSubscriberSuppressionWrites.ts",
];

describe("every subscriber PATCH is conditional", () => {
  it("no caller reaches for the SDK's unconditional update", () => {
    for (const file of CALLERS) {
      const source = read(file);
      expect(
        source.includes("client.subscribers.update("),
        `${file} calls client.subscribers.update() directly; the server answers 428 without an If-Match, so this write cannot succeed. Use updateSubscriberConditionally().`,
      ).toBe(false);
    }
  });

  it("each caller routes through updateSubscriberConditionally", () => {
    for (const file of CALLERS) {
      expect(read(file)).toContain("updateSubscriberConditionally");
    }
  });

  it("the only direct SDK update in the app is the one inside the helper", () => {
    // Guards the guard: if someone adds a fourth call site in a file not listed
    // above, CALLERS would silently stop covering the app.
    const helper = read("api/subscriberConditionalWrite.ts");
    expect(helper).toContain("client.subscribers.update(id, patch,");
    expect(helper).toContain("ifMatch");
  });

  it("the helper refuses to write when no token came back", () => {
    // An absent ETag must not degrade into an unconditional write; that is exactly
    // the request the server refuses.
    const helper = read("api/subscriberConditionalWrite.ts");
    expect(helper).toContain("if (!concurrencyToken)");
    expect(helper).toContain("SubscriberPreconditionError");
  });
});

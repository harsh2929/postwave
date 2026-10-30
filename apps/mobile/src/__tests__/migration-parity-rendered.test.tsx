/**
 * The parity snapshot must be RENDERED, not merely exported.
 *
 * `getMobileMailchimpParitySnapshot` existed complete, was exported from
 * `api/mobileParity.ts` and re-exported through `api/client.ts`, and was
 * rendered by nothing. A grep for the symbol returned two hits and the product
 * had zero, because a re-export is not a consumer — the same shape as the
 * unmounted step-up prompt this repo already found on mobile once.
 *
 * A test that the function returns the right shape would have passed for that
 * entire period. This checks that a screen renders it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(relative: string): string {
  return readFileSync(join(mobileRoot, relative), "utf8");
}

describe("the Mailchimp parity snapshot reaches a screen", () => {
  it("a hook consumes the api function", () => {
    const hook = read("src/hooks/useMigrations.ts");
    expect(hook.length).toBeGreaterThan(1_000);
    expect(
      hook.includes("getMobileMailchimpParitySnapshot("),
      "no hook calls the snapshot; api/client.ts re-exporting it is not a consumer",
    ).toBe(true);
  });

  it("the migrations screen renders the card", () => {
    const screen = read("app/(tabs)/migrations.tsx");
    expect(screen.length).toBeGreaterThan(1_000);
    expect(
      screen.includes("useMobileMailchimpParity("),
      "the migrations screen does not call the parity hook",
    ).toBe(true);
    expect(
      /<MigrationParityCard\s/.test(screen),
      "the migrations screen imports the card but never renders it — which is " +
        "exactly the state the snapshot itself was in",
    ).toBe(true);
  });
});

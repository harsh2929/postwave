// SPDX-License-Identifier: AGPL-3.0-only
//
// The voice service exposes one non-persisting regenerated-email candidate at
// a time. Accepting that candidate is a separate, version-checked sequence
// update. There is no atomic whole-sequence regeneration operation, so public
// copy must not turn the per-email workflow into a batch-action promise.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const marketingRoot = resolve(process.cwd(), "src/app/(marketing)");
const voice = readFileSync(resolve(marketingRoot, "voice/page.tsx"), "utf8");
const features = readFileSync(
  resolve(marketingRoot, "features/page.tsx"),
  "utf8",
);

describe("public sequence-regeneration claims", () => {
  it("claims only the qualified per-email review-and-accept workflow", () => {
    const copy = `${voice}\n${features}`;

    expect(copy).not.toMatch(
      /whole[- ]sequence regenerate|re[- ]walk every position|re-run the entire sequence/iu,
    );
    expect(copy).toMatch(/non-persisting (?:candidate|preview)/iu);
    expect(copy).toMatch(/versioned acceptance|sequence version/iu);
    expect(copy).toMatch(/rest of the sequence stays unchanged/iu);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../pages/APIPlayground.tsx", import.meta.url),
  "utf8",
);

describe("API Playground authority lifecycle", () => {
  it("remounts transient workbench state when role or context authority changes", () => {
    expect(source).toContain("useSyncExternalStore(");
    expect(source).toContain("onContextEpochObserved");
    expect(source).toContain("readContextEpoch");
    expect(source).toMatch(
      /const workspaceKey = JSON\.stringify\(\[[\s\S]*historyScope[\s\S]*roleStatus[\s\S]*effectiveRole[\s\S]*contextEpoch/,
    );
    expect(source).toContain("key={workspaceKey}");
    expect(source).toMatch(
      /historyScope = useMemo[\s\S]*me\?\.tenant[\s\S]*me\?\.user/,
    );
  });
});

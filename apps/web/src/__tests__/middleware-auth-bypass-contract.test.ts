// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("middleware local-auth bypass bundling", () => {
  it("uses statically named env lookups that the Next edge compiler can inline", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/middleware.ts"),
      "utf8",
    );

    for (const name of [
      "NEXT_PUBLIC_USE_MOCKS",
      "POSTWAVE_AUTH_BYPASS",
      "POSTWAVE_LOCAL_AUTH_BYPASS",
    ]) {
      expect(source).toContain(`process.env.${name} === "1"`);
    }
    expect(source).not.toMatch(/process\.env\s*\[[^\]]+\]/);
  });
});

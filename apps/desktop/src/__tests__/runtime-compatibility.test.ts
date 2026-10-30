import { describe, expect, it } from "vitest";

import {
  REQUIRED_DESKTOP_RUNTIME,
  runtimeCompatibilityIssues,
} from "../lib/runtime-compatibility";

describe("desktop runtime feature floor", () => {
  it("accepts the complete renderer capability set", () => {
    expect(
      runtimeCompatibilityIssues({
        colorMix: true,
        containerQueries: true,
        inert: true,
        secureCrypto: true,
      }),
    ).toEqual([]);
  });

  it("reports every missing capability without probing customer data", () => {
    expect(
      runtimeCompatibilityIssues({
        colorMix: false,
        containerQueries: false,
        inert: false,
        secureCrypto: false,
      }),
    ).toEqual([
      "CSS color mixing",
      "CSS container queries",
      "accessible modal isolation",
      "secure browser cryptography",
    ]);
    expect(REQUIRED_DESKTOP_RUNTIME).toEqual({
      macosWebKit: "16.2",
      windowsWebView2: "111",
    });
  });
});

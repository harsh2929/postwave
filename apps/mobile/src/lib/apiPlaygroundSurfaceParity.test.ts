import { describe, expect, it } from "vitest";

import { EN_MESSAGES } from "./messagesEn";

describe("API playground surface parity copy", () => {
  it("distinguishes desktop live execution from the web API reference", () => {
    expect(EN_MESSAGES["desktopOnly.apiPlayground.hint"]).toBe(
      "Run live Moosewave API calls in the desktop app. Web provides API reference only.",
    );
    expect(EN_MESSAGES["desktopOnly.body"]).not.toContain(
      "live on desktop and web",
    );
  });
});

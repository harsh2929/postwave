import { describe, expect, it } from "vitest";

import {
  normalizePushPermissionState,
  pushPrimingPrompt,
} from "./pushPriming";

describe("normalizePushPermissionState", () => {
  it("trusts `granted` over the status string", () => {
    expect(normalizePushPermissionState("undetermined", true)).toBe("granted");
  });

  it("recognises an explicit denial", () => {
    expect(normalizePushPermissionState("denied", false)).toBe("denied");
    expect(normalizePushPermissionState(" DENIED ", false)).toBe("denied");
  });

  it("fails safe to undetermined for anything unrecognised", () => {
    expect(normalizePushPermissionState(undefined, false)).toBe("undetermined");
    expect(normalizePushPermissionState("provisional", false)).toBe(
      "undetermined",
    );
  });
});

describe("pushPrimingPrompt", () => {
  it("says nothing when permission is already granted", () => {
    expect(pushPrimingPrompt("granted")).toBeNull();
  });

  it("explains the VALUE before the one-shot OS dialog", () => {
    const prompt = pushPrimingPrompt("undetermined");
    expect(prompt?.outcome).toBe("os_prompt");
    // The rationale must name what the user gets, not what the app does.
    expect(prompt?.message).toMatch(/approval requests/i);
    expect(prompt?.consequence).toMatch(/declining here costs nothing/i);
  });

  it("never pretends the OS can be asked again after a denial", () => {
    const prompt = pushPrimingPrompt("denied");
    expect(prompt?.outcome).toBe("open_settings");
    expect(prompt?.confirmLabel).toBe("Open Settings");
    expect(prompt?.message).toMatch(/only asks once/i);
  });
});

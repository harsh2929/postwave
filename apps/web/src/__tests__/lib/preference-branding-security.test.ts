import { describe, expect, it } from "vitest";

import {
  isSafePublicHttpsAssetURL,
  preferredContrastingTextColor,
} from "@/lib/preference-branding-security";

describe("preference branding security", () => {
  it.each([
    ["", true],
    ["https://assets.example.com/logo.png", true],
    ["http://assets.example.com/logo.png", false],
    ["https://user:pass@assets.example.com/logo.png", false],
    ["https://localhost/logo.png", false],
    ["https://127.0.0.1/logo.png", false],
    ["https://10.0.0.8/logo.png", false],
    ["https://[fd00::8]/logo.png", false],
    ["https://intranet/logo.png", false],
    ["https://printer.local/logo.png", false],
    ["data:image/svg+xml,<svg/>", false],
  ])("classifies %s", (url, expected) => {
    expect(isSafePublicHttpsAssetURL(url)).toBe(expected);
  });

  it("chooses an accessible black/white foreground for light and dark accents", () => {
    expect(preferredContrastingTextColor("#FFFFFF")).toBe("#000000");
    expect(preferredContrastingTextColor("#000000")).toBe("#FFFFFF");
    expect(preferredContrastingTextColor("#5B6CFF")).toBe("#000000");
  });
});

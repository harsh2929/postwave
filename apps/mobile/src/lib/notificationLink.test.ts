import { describe, expect, it } from "vitest";

import { planNotificationTap, webFallbackUrl } from "./notificationLink";

describe("webFallbackUrl", () => {
  it("accepts an https link on the Moosewave web host", () => {
    expect(webFallbackUrl("https://app.moosewave.com/app/forms/1")).toBe(
      "https://app.moosewave.com/app/forms/1",
    );
  });

  it("rejects a foreign host — a deep_link is not an open-redirect", () => {
    expect(webFallbackUrl("https://evil.example.com/app/forms/1")).toBeNull();
  });

  it("rejects non-https schemes", () => {
    expect(webFallbackUrl("http://app.moosewave.com/app/forms/1")).toBeNull();
    expect(webFallbackUrl("javascript:alert(1)")).toBeNull();
    expect(webFallbackUrl("moosewave://form/1")).toBeNull();
  });

  it("rejects garbage and missing links", () => {
    expect(webFallbackUrl("not a url")).toBeNull();
    expect(webFallbackUrl(undefined)).toBeNull();
    expect(webFallbackUrl("")).toBeNull();
  });
});

describe("planNotificationTap", () => {
  it("reports a link-less notification as inert rather than broken", () => {
    expect(planNotificationTap(undefined, false)).toEqual({ kind: "none" });
  });

  it("prefers in-app navigation when route-map resolved the link", () => {
    expect(planNotificationTap("moosewave://campaign/1", true)).toEqual({
      kind: "in-app",
    });
  });

  it("falls back to the web admin for an unresolvable https link", () => {
    expect(
      planNotificationTap("https://app.moosewave.com/app/forms/1", false),
    ).toEqual({ kind: "web", url: "https://app.moosewave.com/app/forms/1" });
  });

  it("reports unsupported for an unresolvable moosewave:// link instead of guessing a URL", () => {
    expect(planNotificationTap("moosewave://form/1", false)).toEqual({
      kind: "unsupported",
    });
  });
});

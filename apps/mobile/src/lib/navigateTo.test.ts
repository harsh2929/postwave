import { describe, expect, it } from "vitest";

import {
  navigationMode,
  normalizeRoutePath,
  resolveTargetPath,
  targetFromHref,
} from "./navigateTo";

describe("normalizeRoutePath", () => {
  it("strips route groups, which are presentation not identity", () => {
    expect(normalizeRoutePath("/(tabs)/campaigns/42")).toBe("/campaigns/42");
    expect(normalizeRoutePath("/(tabs)/(inner)/x")).toBe("/x");
  });

  it("ignores a trailing slash and a missing leading slash", () => {
    expect(normalizeRoutePath("campaigns/42/")).toBe("/campaigns/42");
    expect(normalizeRoutePath("/")).toBe("/");
  });
});

describe("resolveTargetPath", () => {
  it("substitutes [id] so a template compares equal to a concrete path", () => {
    expect(
      resolveTargetPath({
        pathname: "/(tabs)/campaigns/[id]",
        params: { id: "42" },
      }),
    ).toBe("/campaigns/42");
  });

  it("leaves an unsupplied param placeholder alone", () => {
    expect(resolveTargetPath({ pathname: "/(tabs)/campaigns/[id]" })).toBe(
      "/campaigns/[id]",
    );
  });
});

describe("navigationMode", () => {
  it("replaces when the target is the screen already on top", () => {
    // Three notifications about the SAME campaign used to stack three
    // identical screens, costing three back presses to escape.
    expect(
      navigationMode("/campaigns/42", {
        pathname: "/(tabs)/campaigns/[id]",
        params: { id: "42" },
      }),
    ).toBe("replace");
  });

  it("pushes a DIFFERENT entity so back returns to the previous one", () => {
    expect(
      navigationMode("/campaigns/42", {
        pathname: "/(tabs)/campaigns/[id]",
        params: { id: "43" },
      }),
    ).toBe("push");
  });

  it("collapses a re-entry into the same list screen with a new filter", () => {
    expect(
      navigationMode("/tags", { pathname: "/(tabs)/tags", params: { q: "vip" } }),
    ).toBe("replace");
  });

  it("pushes when the current path is unknown", () => {
    expect(navigationMode(null, { pathname: "/(tabs)/dashboard" })).toBe("push");
    expect(navigationMode(undefined, { pathname: "/(tabs)/dashboard" })).toBe(
      "push",
    );
  });
});

describe("targetFromHref", () => {
  it("accepts the string form expo-router uses for list routes", () => {
    expect(targetFromHref("/(tabs)/lists")).toEqual({
      pathname: "/(tabs)/lists",
    });
  });

  it("accepts the object form used for detail routes", () => {
    expect(
      targetFromHref({ pathname: "/(tabs)/campaigns/[id]", params: { id: "7" } }),
    ).toEqual({ pathname: "/(tabs)/campaigns/[id]", params: { id: "7" } });
  });

  it("drops non-string params rather than passing junk to the router", () => {
    expect(
      targetFromHref({ pathname: "/x", params: { id: 7, ok: "yes" } }),
    ).toEqual({ pathname: "/x", params: { ok: "yes" } });
  });

  it("returns null for anything unusable", () => {
    expect(targetFromHref(null)).toBeNull();
    expect(targetFromHref("")).toBeNull();
    expect(targetFromHref({ params: { id: "1" } })).toBeNull();
  });
});

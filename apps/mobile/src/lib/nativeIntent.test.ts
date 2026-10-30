import { describe, expect, it } from "vitest";

import {
  bareSystemPath,
  nativePathForHref,
  rewriteNativeSystemPath,
} from "./nativeIntent";
import { routeForNavSlug } from "./navDeepLinks";

describe("rewriteNativeSystemPath", () => {
  it("rewrites a custom-scheme alias to the route Expo actually registers", () => {
    expect(rewriteNativeSystemPath("moosewave://sms-suppressions")).toBe(
      "/(tabs)/sms/suppressions",
    );
  });

  it("rewrites entity links with encoded route params", () => {
    expect(rewriteNativeSystemPath("moosewave://campaign/cmp-42")).toBe(
      "/(tabs)/campaigns/[id]?id=cmp-42",
    );
  });

  it("rewrites auth callbacks before Router can mistake them for routes", () => {
    expect(rewriteNativeSystemPath("moosewave://auth/oauth-return")).toBe(
      "/(auth)/sign-in",
    );
  });

  it("passes unknown and already-routable paths through unchanged", () => {
    expect(rewriteNativeSystemPath("moosewave://unknown/value")).toBe(
      "moosewave://unknown/value",
    );
    expect(rewriteNativeSystemPath("/sms/suppressions")).toBe(
      "/sms/suppressions",
    );
  });
});

describe("nativePathForHref", () => {
  it("rejects malformed hrefs and ignores non-scalar params", () => {
    expect(nativePathForHref("relative" as never)).toBeNull();
    expect(
      nativePathForHref({
        pathname: "/(tabs)/forms/[id]",
        params: { id: "form 7", ignored: ["x"] },
      } as never),
    ).toBe("/(tabs)/forms/[id]?id=form+7");
  });
});

describe("unrecognised links are not a way to set a screen's parameters", () => {
  it("keeps the pathname so not-found stays reportable, and drops the query", () => {
    // Known slugs resolve through the nav grammar to the route Expo actually
    // registers — and arrive there without the caller's parameters.
    const campaigns = rewriteNativeSystemPath("/campaigns?new=1");
    expect(campaigns).toBe(routeForNavSlug("campaigns"));
    expect(campaigns).not.toContain("new=");
    // Whether or not a slug is in the nav grammar, no caller-supplied
    // parameter survives an unrecognised link.
    const settings = rewriteNativeSystemPath("/settings?anchor=danger&x=1#frag");
    expect(settings.startsWith("/")).toBe(true);
    expect(settings).not.toMatch(/[?#]/u);
    // An unknown slug keeps its pathname (so not-found stays reportable) and
    // nothing else.
    expect(rewriteNativeSystemPath("/no-such-screen?anything=goes")).toBe("/no-such-screen");
  });

  it("still forwards the parameters a recognised family validated itself", () => {
    // A bounded search term is part of the entity-link grammar, not a
    // free-form pass-through; it must survive.
    const out = rewriteNativeSystemPath("/subscribers?q=ana%40example.com");
    expect(out.startsWith("/")).toBe(true);
    expect(out).toContain("q=");
  });

  it("bareSystemPath cuts at the first ? or #, and leaves a plain path alone", () => {
    expect(bareSystemPath("/a/b?c=1#d")).toBe("/a/b");
    expect(bareSystemPath("/a/b#d")).toBe("/a/b");
    expect(bareSystemPath("/a/b")).toBe("/a/b");
  });
});

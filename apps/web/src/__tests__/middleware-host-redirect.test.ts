// Tests the host-shortcut redirect logic that sits at the top of the
// middleware. We model the predicate here directly because driving
// the real middleware function requires a fully-formed NextRequest +
// next-intl instance, which is overkill for a 3-line predicate.
//
// The actual middleware lives at apps/web/src/middleware.ts and the
// implementation here MUST track that file — if either changes, the
// other does too.

import { describe, expect, it } from "vitest";

// shouldRedirectShortLink mirrors the predicate used in
// apps/web/src/middleware.ts:
//
//   if (host.startsWith("forms.") &&
//       pathname !== "/" &&
//       pathname.split("/").filter(Boolean).length === 1 &&
//       !pathname.includes(".")) {
//     redirect to /forms/<segment>
//   }
function rewrittenForFormsHost(
  host: string,
  pathname: string,
): string | null {
  if (!host.startsWith("forms.")) return null;
  if (pathname === "/") return null;
  if (pathname.includes(".")) return null;
  const segs = pathname.split("/").filter(Boolean);
  if (segs.length !== 1) return null;
  return `/forms${pathname}`;
}

describe("middleware short-link rewrite (forms.* host)", () => {
  it("rewrites a one-segment path under the forms.* host", () => {
    expect(rewrittenForFormsHost("forms.moosewave.com", "/abc")).toBe(
      "/forms/abc",
    );
  });

  it("leaves the bare root alone", () => {
    expect(rewrittenForFormsHost("forms.moosewave.com", "/")).toBeNull();
  });

  it("does not rewrite multi-segment paths (those are real form paths)", () => {
    expect(rewrittenForFormsHost("forms.moosewave.com", "/a/b")).toBeNull();
    expect(
      rewrittenForFormsHost("forms.moosewave.com", "/forms/foo"),
    ).toBeNull();
  });

  it("does not rewrite asset-shaped paths (favicon.ico etc.)", () => {
    expect(
      rewrittenForFormsHost("forms.moosewave.com", "/favicon.ico"),
    ).toBeNull();
  });

  it("only fires on the forms.* host", () => {
    expect(rewrittenForFormsHost("app.moosewave.com", "/abc")).toBeNull();
    expect(rewrittenForFormsHost("moosewave.com", "/abc")).toBeNull();
  });
});

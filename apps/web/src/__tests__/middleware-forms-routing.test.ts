import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Regression guard for audit MKTP-001: bare `/forms` must reach the
// (marketing)/forms capability page, not be locale-routed to `/en/forms`
// (which has no [locale]/forms index and hard-404s). Only `/forms/<slug>`
// hosted subscriber routes opt into locale routing. Other public-localized
// prefixes keep their bare→locale behavior.
import { describe, expect, it } from "vitest";

import {
  isEmbeddablePublicPath,
  isPublicLocalizedPath,
} from "@/lib/public-localized-paths";

describe("isPublicLocalizedPath — /forms marketing collision (MKTP-001)", () => {
  it("does NOT locale-route the bare /forms marketing page", () => {
    expect(isPublicLocalizedPath("/forms")).toBe(false);
  });

  it("still locale-routes hosted subscriber form sub-paths", () => {
    expect(isPublicLocalizedPath("/forms/newsletter")).toBe(true);
    expect(isPublicLocalizedPath("/forms/newsletter/success")).toBe(true);
  });

  it("leaves the other public-localized prefixes unchanged", () => {
    for (const bare of ["/preferences", "/gift", "/landing", "/archive"]) {
      expect(isPublicLocalizedPath(bare)).toBe(true);
      expect(isPublicLocalizedPath(`${bare}/tok_123`)).toBe(true);
    }
  });

  it("does not match unrelated marketing routes", () => {
    expect(isPublicLocalizedPath("/features")).toBe(false);
    expect(isPublicLocalizedPath("/landing-pages")).toBe(false);
  });
});

// The product generates `<iframe src="…/forms/<slug>">` from its own embed
// panel, but the middleware stamped `frame-ancestors 'none'` +
// `X-Frame-Options: DENY` on every public locale-routed page. Every customer
// embed therefore rendered a blank box, failing console-only on a third-party
// site. Framing must follow the page's purpose, not one blanket rule.
describe("isEmbeddablePublicPath — hosted embeds must be frameable", () => {
  it("allows framing for the pages the embed snippets target", () => {
    expect(isEmbeddablePublicPath("/forms/newsletter")).toBe(true);
    expect(isEmbeddablePublicPath("/landing/spring-sale")).toBe(true);
    expect(isEmbeddablePublicPath("/es/forms/newsletter")).toBe(true);
  });

  it("keeps subscriber-PII surfaces unframeable", () => {
    // A capability token in the URL plus an overlay on a hostile page is a
    // click-harvesting vector against a named subscriber.
    for (const path of [
      "/preferences/abc123",
      "/es/preferences/abc123",
      "/gift/abc123",
      "/app",
      "/app/subscribers",
      "/login",
    ]) {
      expect(isEmbeddablePublicPath(path), path).toBe(false);
    }
  });

  it("does not make the bare marketing pages frameable", () => {
    expect(isEmbeddablePublicPath("/forms")).toBe(false);
    expect(isEmbeddablePublicPath("/landing")).toBe(false);
  });

  it("wires the predicate into both framing controls in middleware", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/middleware.ts"),
      "utf8",
    );
    // frame-ancestors must branch on it...
    expect(source).toMatch(
      /isEmbeddablePublicPath\(pathname\)\s*\n?\s*\?\s*"frame-ancestors \*"/,
    );
    // ...and X-Frame-Options must be omitted for those routes, since the
    // header has no "allow any origin" value.
    expect(source).toMatch(
      /if \(!isEmbeddablePublicPath\([^)]*\)\) \{\s*\n\s*response\.headers\.set\("X-Frame-Options", "DENY"\);/,
    );
  });
});

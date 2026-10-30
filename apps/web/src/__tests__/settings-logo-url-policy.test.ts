// SPDX-License-Identifier: AGPL-3.0-only
//
// The workspace Logo URL field used to invite a third-party CDN URL that the
// dashboard's own CSP always blocks (img-src is 'self' data: blob: + the
// configured assets origin; the https: wildcard applies only to published
// archive paths). The <img> therefore 404'd before a byte was fetched, a CSP
// report was POSTed, and the UI told the operator their URL was broken.
//
// Classifying the URL up front means the blocked case is never attempted and
// the message names the real constraint.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyLogoPreview,
  logoPreviewBlockedMessage,
} from "@/app/(dashboard)/app/settings/logo-url-policy";

const PAGE_ORIGIN = "https://app.postwave.test";
const ASSETS = "https://assets.postwave.test";

let previousAssets: string | undefined;

beforeEach(() => {
  previousAssets = process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL;
  process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL = `${ASSETS}/previews/`;
});

afterEach(() => {
  if (previousAssets === undefined) {
    delete process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL;
  } else {
    process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL = previousAssets;
  }
});

describe("classifyLogoPreview", () => {
  it("treats an empty field as nothing to preview", () => {
    expect(classifyLogoPreview("   ", PAGE_ORIGIN)).toEqual({ kind: "empty" });
  });

  it("allows the configured assets origin", () => {
    expect(classifyLogoPreview(`${ASSETS}/logo.png`, PAGE_ORIGIN)).toEqual({
      kind: "allowed",
    });
  });

  it("allows same-origin, relative, and data URLs", () => {
    expect(classifyLogoPreview("/brand/logo.png", PAGE_ORIGIN).kind).toBe(
      "allowed",
    );
    expect(
      classifyLogoPreview(`${PAGE_ORIGIN}/brand/logo.png`, PAGE_ORIGIN).kind,
    ).toBe("allowed");
    expect(
      classifyLogoPreview("data:image/png;base64,AA", PAGE_ORIGIN).kind,
    ).toBe("allowed");
  });

  it("marks a third-party CDN as blocked by policy, not broken", () => {
    const verdict = classifyLogoPreview(
      "https://cdn.example.com/logo.png",
      PAGE_ORIGIN,
    );
    expect(verdict).toEqual({
      kind: "blocked",
      origin: "https://cdn.example.com",
      allowedOrigin: ASSETS,
    });
    const message = logoPreviewBlockedMessage(
      verdict as Extract<typeof verdict, { kind: "blocked" }>,
    );
    // The message must blame the policy and name both origins — the old copy
    // ("check it resolves to an image") sent operators back to their CDN.
    expect(message).toContain("security policy");
    expect(message).toContain("https://cdn.example.com");
    expect(message).toContain(ASSETS);
    expect(message).toContain("Preview unavailable");
    // This notice also appears while editing an unsaved draft.
    expect(message.toLowerCase()).not.toContain("saved");
  });

  it("blocks everything but 'self' when no assets origin is configured", () => {
    delete process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL;
    const verdict = classifyLogoPreview(
      "https://cdn.example.com/logo.png",
      PAGE_ORIGIN,
    );
    expect(verdict.kind).toBe("blocked");
    expect(
      logoPreviewBlockedMessage(
        verdict as Extract<typeof verdict, { kind: "blocked" }>,
      ),
    ).toContain("asset host");
  });

  it("reports a non-image scheme as invalid", () => {
    expect(classifyLogoPreview("javascript:alert(1)", PAGE_ORIGIN).kind).toBe(
      "invalid",
    );
    expect(classifyLogoPreview("https://", PAGE_ORIGIN).kind).toBe("invalid");
  });

  it("still treats a bare relative reference as same-origin", () => {
    // The browser resolves it against the page, so 'self' covers it and the
    // ordinary "didn't load" path applies — that message is accurate there.
    expect(classifyLogoPreview("logo.png", PAGE_ORIGIN).kind).toBe("allowed");
  });
});

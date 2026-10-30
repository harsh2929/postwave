import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import LegalLayout from "@/app/(marketing)/legal/layout";
import { legalDraftPreviewAllowed } from "@/lib/legal-publication";

const request = vi.hoisted(() => ({ host: "127.0.0.1:3000" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: request.host }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  request.host = "127.0.0.1:3000";
});

describe("local legal draft preview", () => {
  it.each(["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000"])(
    "allows development requests from %s",
    (host) => expect(legalDraftPreviewAllowed(host, "development")).toBe(true),
  );

  it.each([
    undefined,
    "",
    "moosewave.com",
    "staging.moosewave.com",
    "localhost.example.com",
    "localhost@evil.example",
    "localhost/preview",
    "127.0.0.1:3000,evil.example",
    "localhost:65536",
  ])("rejects non-local or malformed hosts: %s", (host) => {
    expect(legalDraftPreviewAllowed(host, "development")).toBe(false);
  });

  it.each(["production", "test", undefined])(
    "does not allow an unapproved preview in %s",
    (environment) => {
      vi.stubEnv("NODE_ENV", environment);
      expect(legalDraftPreviewAllowed("localhost:3000")).toBe(false);
    },
  );

  it("renders the actual policy content with a draft notice locally", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("POSTWAVE_LEGAL_PUBLICATION_APPROVAL", "");
    const html = renderToStaticMarkup(
      await LegalLayout({ children: <h1>Privacy Policy</h1> }),
    );
    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Draft for local review");
    expect(html).toContain("not been approved for publication");
  });

  it("keeps unapproved policies unavailable in production, including localhost", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTWAVE_LEGAL_PUBLICATION_APPROVAL", "");
    await expect(LegalLayout({ children: "policy" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("keeps unapproved policies unavailable on non-local development hosts", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("POSTWAVE_LEGAL_PUBLICATION_APPROVAL", "");
    request.host = "staging.moosewave.com";
    await expect(LegalLayout({ children: "policy" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("renders approved policies without the local draft notice", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "POSTWAVE_LEGAL_PUBLICATION_APPROVAL",
      "approved:COUNSEL-2026-09",
    );
    const html = renderToStaticMarkup(
      await LegalLayout({ children: "published policy" }),
    );
    expect(html).toContain("published policy");
    expect(html).not.toContain("Draft for local review");
  });
});

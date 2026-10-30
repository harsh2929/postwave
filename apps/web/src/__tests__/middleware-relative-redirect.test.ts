// SPDX-License-Identifier: AGPL-3.0-only
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl/middleware", () => ({
  default: () => () => new Response(null),
}));

import { middleware } from "@/middleware";

afterEach(() => vi.unstubAllEnvs());

describe("middleware redirects stay on the browser-facing origin", () => {
  it("does not emit Next's internal standalone origin for an auth redirect", () => {
    const response = middleware(
      new NextRequest("http://localhost:3000/app/billing", {
        headers: {
          accept: "text/x-component",
          host: "127.0.0.1:3000",
        },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://127.0.0.1:3000/login?next=%2Fapp%2Fbilling",
    );
  });

  it("uses a relative location for hosted-form shortcuts", () => {
    vi.stubEnv("NEXT_PUBLIC_FORMS_ORIGIN", "http://forms.example.test");
    const response = middleware(
      new NextRequest("http://localhost:3000/newsletter", {
        headers: { accept: "text/html", host: "forms.example.test" },
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://forms.example.test/forms/newsletter",
    );
  });

  it("pins a configured origin without trusting forwarded host or scheme", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
    const response = middleware(
      new NextRequest("http://localhost:3000/app", {
        headers: {
          accept: "text/html",
          host: "app.example.test",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "http",
        },
      }),
    );

    expect(response.headers.get("location")).toBe(
      "https://app.example.test/login?next=%2Fapp",
    );
  });
});

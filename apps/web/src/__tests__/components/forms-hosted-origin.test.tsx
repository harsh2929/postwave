// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormsHostedOrigin } from "@/app/(dashboard)/app/forms/forms-page-actions";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  vi.unstubAllEnvs();
  document.body.innerHTML = "";
});
describe("Forms hosted-origin hint", () => {
  it("keeps deterministic server HTML and then follows the local editor origin", () => {
    vi.stubEnv("NEXT_PUBLIC_FORMS_ORIGIN", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(renderToString(createElement(FormsHostedOrigin))).toContain(
      "https://forms.moosewave.com",
    );
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    try {
      act(() => root.render(createElement(FormsHostedOrigin)));
      expect(el.textContent).toBe(`${window.location.origin}/forms/<slug>`);
    } finally {
      act(() => root.unmount());
    }
  });
  it("keeps an explicitly configured forms host on the client", () => {
    vi.stubEnv("NEXT_PUBLIC_FORMS_ORIGIN", "https://forms.example.test/");
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    try {
      act(() => root.render(createElement(FormsHostedOrigin)));
      expect(el.textContent).toBe("https://forms.example.test/forms/<slug>");
    } finally {
      act(() => root.unmount());
    }
  });
});

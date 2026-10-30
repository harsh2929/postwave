// SPDX-License-Identifier: AGPL-3.0-only
//
// Every dashboard page logged CSP violations for its lazily loaded chunks:
// next/dynamic's PreloadChunks (Next 15.5) called ReactDOM.preload(href,
// {as: "script"}) without a nonce, so each server-rendered dynamic import
// emitted a <link rel=preload as=script> that the nonce + 'strict-dynamic'
// policy blocked, and the chunk was fetched late on demand instead
// (vercel/next.js#64091). patches/next@15.5.25.patch reads the request's
// nonce the way app-render does. This renders the installed PreloadChunks
// inside the same async-storage contexts Next's server render provides.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Next's server runtime installs this global before any of its async storages
// is created (server/node-environment); without it they refuse to exist.
await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage =
    AsyncLocalStorage;
});

import { PreloadChunks } from "next/dist/shared/lib/lazy-dynamic/preload-chunks.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";

const NONCE = "3f2c9a7e-5d41-4b8e-a0f6-7c1d2e3b4a59";
// The document policy middleware.ts issues on a dashboard request.
const REQUEST_CSP = `default-src 'self'; script-src 'self' 'nonce-${NONCE}' 'sha256-cepvyKym128tSq8q5LbN2S8TgsFXseJ4SmWfNTOz4f0=' 'strict-dynamic'; report-uri /api/csp-report`;

function renderPreload(requestHeaders: Headers | null): string {
  const workStore = {
    assetPrefix: "",
    reactLoadableManifest: {
      "app/(dashboard)/app/tags/page.tsx -> ./tags-client": {
        id: 62944,
        files: ["static/chunks/62944-4b1c.js"],
      },
    },
  };
  const render = () =>
    renderToString(
      createElement(PreloadChunks, {
        moduleIds: ["app/(dashboard)/app/tags/page.tsx -> ./tags-client"],
      }),
    );
  return workAsyncStorage.run(workStore as never, () =>
    requestHeaders
      ? workUnitAsyncStorage.run(
          { type: "request", headers: requestHeaders } as never,
          render,
        )
      : render(),
  );
}

function scriptPreloads(html: string): string[] {
  return html.match(/<link[^>]*rel="preload"[^>]*>/g) ?? [];
}

describe("next/dynamic chunk preloads under a nonce CSP", () => {
  it("carry the request's nonce", () => {
    const html = renderPreload(
      new Headers({ "content-security-policy": REQUEST_CSP }),
    );

    const links = scriptPreloads(html);
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="/_next/static/chunks/62944-4b1c.js"');
    expect(links[0]).toContain('as="script"');
    expect(links[0]).toContain(`nonce="${NONCE}"`);
  });

  it("stay nonce-free outside a request (prerendered pages have no nonce to give)", () => {
    const links = scriptPreloads(renderPreload(null));

    expect(links).toHaveLength(1);
    expect(links[0]).not.toContain("nonce=");
  });
});

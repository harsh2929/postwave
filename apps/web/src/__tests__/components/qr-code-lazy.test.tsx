// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// `qrcode` must stay out of the initial JS of the routes that render a QR code
// behind a click (WEBJS-002).
//
// The package is Galois-field tables, Reed-Solomon math and an SJIS map: 24.5
// KiB raw / 9.4 KiB gz in the emitted chunk. A static import put that chunk in
// the INITIAL graph of /login, /totp-challenge, settings/security and the form
// embed page. /login is one of the five Lighthouse-certified public routes with
// a total-blocking-time budget, and the QR code there is reached only by
// clicking "Sign in with another device".
//
// A bundle assertion needs a build, so this file guards the property the build
// derives from — no module on those routes may name `qrcode` in a static import
// — and then proves the deferred path still produces a QR code.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { QrCode } from "@/components/qr-code";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Every module that reaches the encoder, and the routes each one is on. */
const REACHES_QRCODE = [
  "src/components/qr-code.tsx",
  "src/components/auth/device-sign-in.tsx",
  "src/app/totp-challenge/page.tsx",
  "src/app/(dashboard)/app/settings/security/totp-enrollment-card.tsx",
];

/** `import ... from "qrcode"` / `require("qrcode")`, but NOT `import("qrcode")`. */
const STATIC_IMPORT = /(?:^|\n)\s*import[^;]*?from\s*["']qrcode["']|require\(\s*["']qrcode["']\s*\)/;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("qrcode is loaded on demand", () => {
  it("is not statically imported by anything on a budgeted route", () => {
    for (const file of REACHES_QRCODE) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(
        STATIC_IMPORT.test(source),
        `${file} statically imports qrcode, putting it in the initial chunk`,
      ).toBe(false);
    }
  });

  it("still renders a scannable QR code once the chunk arrives", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        createElement(QrCode, {
          value: "otpauth://totp/Moosewave:qa@postwave.test?secret=JBSWY3DPEHPK3PXP",
          size: 176,
        }),
      );
    });
    // Resolving the deferred module is a real async step whose cost depends on
    // whether the module graph is warm, so flush turns until it lands rather
    // than betting the whole test on one macrotask.
    for (let turn = 0; turn < 20 && !container.querySelector("svg"); turn += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }

    const svg = container.querySelector("svg");
    expect(svg, "no SVG rendered — the deferred import did not resolve").not.toBeNull();
    // A QR symbol is drawn as modules, not as an empty frame.
    expect(svg!.querySelectorAll("path, rect").length).toBeGreaterThan(0);
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "QR code for two-factor authentication setup",
    );
  });
});

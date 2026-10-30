// SPDX-License-Identifier: MIT

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PostwaveAuditPortal } from "./PostwaveAuditPortal.js";

const origin = "https://audit.moosewave.com";
const token = `${"a".repeat(32)}.${"b".repeat(32)}.${"c".repeat(32)}`;
const sessionUrl = `${origin}/portal/audit#bootstrap=${token}`;

describe("PostwaveAuditPortal", () => {
  it("renders a least-privilege iframe for an origin-bound session", () => {
    const markup = renderToStaticMarkup(
      <PostwaveAuditPortal
        sessionUrl={sessionUrl}
        portalOrigin={origin}
        parentOrigin="https://customer.example"
        theme="dark"
        height={Number.POSITIVE_INFINITY}
      />,
    );

    expect(markup).toContain(
      `src="${origin}/portal/audit?theme=dark&amp;parent_origin=https%3A%2F%2Fcustomer.example#bootstrap=${token}"`,
    );
    expect(markup).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain("height:600px");
    expect(markup).not.toContain("allow-forms");
    expect(markup).not.toContain("allow-popups");
    expect(markup).not.toContain("allow-top-navigation");
  });

  it("fails closed when the session URL is not on the configured origin", () => {
    const markup = renderToStaticMarkup(
      <PostwaveAuditPortal
        sessionUrl={sessionUrl}
        portalOrigin="https://attacker.example"
        parentOrigin="https://customer.example"
      />,
    );

    expect(markup).toContain('src="about:blank"');
    expect(markup).not.toContain(token);
  });
});

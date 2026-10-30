// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { sanitizeArchiveHTML } from "@/lib/sanitize-html";

describe("sanitizeArchiveHTML", () => {
  it("removes executable block tags and event handlers", () => {
    const input = `<h1 onclick="alert(1)">Hello</h1><script>alert(1)</script><iframe src="https://evil.test"></iframe>`;

    expect(sanitizeArchiveHTML(input)).toBe("<h1>Hello</h1>");
  });

  it("neutralizes unsafe URL schemes, including mixed-case and encoded schemes", () => {
    const input = [
      `<a href="JaVaScRiPt:alert(1)">bad</a>`,
      `<img src='data:text/html,<script>alert(1)</script>'>`,
      `<a href="java&#x73;cript:alert(1)">encoded</a>`,
      `<a href="https://moosewave.com">good</a>`,
    ].join("");

    expect(sanitizeArchiveHTML(input)).toBe(
      `<a>bad</a><img /><a>encoded</a><a href="https://moosewave.com">good</a>`,
    );
  });

  it("drops unsafe srcset candidates and CSS-url declarations", () => {
    const input = `<img srcset="javascript:alert(1) 1x, https://cdn.test/a.png 2x" style="background:url(javascript:alert(1)); color: red" alt="x">`;
    const output = sanitizeArchiveHTML(input);

    expect(output).toContain(`srcset="https://cdn.test/a.png 2x"`);
    expect(output).toContain(`style="color:red"`);
    expect(output).toContain(`alt="x"`);
    expect(output).not.toContain("javascript");
    expect(output).not.toContain("background");
  });

  it("removes SVG blocks from the archive body", () => {
    const input = `<p>Before</p><svg><a xlink:href="javascript:alert(1)"><circle /></a></svg><p>After</p>`;

    expect(sanitizeArchiveHTML(input)).toBe("<p>Before</p><p>After</p>");
  });

  it("is idempotent", () => {
    const once = sanitizeArchiveHTML(
      `<a onmouseover="alert(1)" href="javascript:alert(1)">Link</a>`,
    );

    expect(sanitizeArchiveHTML(once)).toBe(once);
  });

  it("discards non-text dangerous containers even when nested markup is allowed", () => {
    const input = `<p>Before</p><noscript><a href="https://moosewave.com">fallback</a></noscript><math><mi>x</mi></math><p>After</p>`;

    expect(sanitizeArchiveHTML(input)).toBe("<p>Before</p><p>After</p>");
  });

  it("rejects protocol-relative URLs and protects blank-target links", () => {
    const input = `<a href="//evil.test/path">scheme relative</a><a href="https://moosewave.com" target="_blank">safe</a>`;

    expect(sanitizeArchiveHTML(input)).toBe(
      `<a>scheme relative</a><a href="https://moosewave.com" target="_blank" rel="noopener noreferrer">safe</a>`,
    );
  });

  it("escapes text and strips comments while preserving safe archive markup", () => {
    const input = `<!-- hidden --><table><tr><td>2 < 3 & ok</td></tr></table>`;

    expect(sanitizeArchiveHTML(input)).toBe(
      '<table tabindex="0"><tr><td>2 &lt; 3 &amp; ok</td></tr></table>',
    );
  });

  it("makes authored horizontal scroll regions keyboard reachable without accepting positive tab order", () => {
    const input = `<pre tabindex="7"><code>npm run a-very-long-command</code></pre><table tabindex="5"><tr><td>wide</td></tr></table>`;

    expect(sanitizeArchiveHTML(input)).toBe(
      '<pre tabindex="0"><code>npm run a-very-long-command</code></pre><table tabindex="0"><tr><td>wide</td></tr></table>',
    );
  });
});

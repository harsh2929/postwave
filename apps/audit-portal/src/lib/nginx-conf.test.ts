import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The standalone image's server block is the only place these two properties
// can be expressed — the stock nginx http block leaves gzip off, and the
// forwarded chain is rewritten per proxied location. Both were silently wrong,
// so they are pinned here rather than left to a reviewer's eye.
const nginxConf = readFileSync(
  fileURLToPath(new URL("../../nginx.conf", import.meta.url)),
  "utf8",
);

describe("audit-portal nginx contract", () => {
  it("appends to the forwarded chain so the auditor, not the gateway, is audited", () => {
    const proxied = nginxConf.match(/proxy_set_header X-Forwarded-For [^;]+;/gu) ?? [];
    expect(proxied).toHaveLength(3);
    for (const directive of proxied) {
      expect(directive).toContain("$proxy_add_x_forwarded_for");
      expect(directive).not.toContain("$remote_addr");
    }
  });

  it("compresses the immutable asset bundle", () => {
    const assets = nginxConf.slice(
      nginxConf.indexOf("location ~ ^/portal/audit/assets/"),
      nginxConf.indexOf("location = /portal/audit "),
    );
    expect(assets).toMatch(/^\s*gzip\s+on;/mu);
    expect(assets).toMatch(/^\s*gzip_vary\s+on;/mu);
    expect(assets).toMatch(/gzip_types[^;]*javascript/u);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => "/tenants",
}));

import AppBar from "@/components/AppBar";
import {
  TenantDirectory,
  TenantDirectoryError,
} from "@/components/TenantDirectory";

const tenant = {
  tenant_id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b1",
  slug: "acme",
  name: "Acme",
  tier: "pro",
  current_period_end: "2026-08-01T00:00:00Z",
  dunning: true,
  sending_paused: true,
  health: "suspended" as const,
  created_at: "2026-07-01T12:30:00Z",
};

describe("TenantDirectory", () => {
  it("renders a labeled, horizontally scrollable table with textual status", () => {
    const html = renderToStaticMarkup(
      <TenantDirectory search="Acme" tenants={[tenant]} truncated={false} />,
    );

    expect(html).toContain('aria-label="Tenant directory search"');
    expect(html).toContain('name="search"');
    expect(html).toContain('maxLength="128"');
    expect(html).toContain("<caption");
    expect(html.match(/scope="col"/gu)).toHaveLength(7);
    expect(html).toContain('scope="row"');
    expect(html).toContain("Dunning, Sending paused");
    expect(html).toContain("Health and controls are stated in text");
  });

  it("keeps every ops view reachable from the one global navigation landmark", () => {
    const html = renderToStaticMarkup(<AppBar />);

    expect(html).toContain('<nav class="appbar__nav" aria-label="Ops console">');
    for (const href of ["/", "/tenants", "/send", "/deliverability", "/billing", "/incidents"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('class="navlink" aria-current="page" href="/tenants"');
  });

  it("escapes tenant and search text at the rendering boundary", () => {
    const injection = '<img src=x onerror="alert(1)">';
    const html = renderToStaticMarkup(
      <TenantDirectory
        search={injection}
        tenants={[{ ...tenant, name: injection }]}
        truncated={false}
      />,
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("makes an empty unfiltered directory explicit instead of silently green", () => {
    const html = renderToStaticMarkup(
      <TenantDirectory search="" tenants={[]} truncated={false} />,
    );

    expect(html).toContain("No tenants were returned");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<table");
  });

  it("associates a loud error message with an alert heading", () => {
    const html = renderToStaticMarkup(
      <TenantDirectoryError message="operator access was denied" />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-labelledby="tenant-directory-error-title"');
    expect(html).toContain("operator access was denied");
  });
});

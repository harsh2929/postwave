import { describe, expect, it } from "vitest";

import {
  mergeAgencyChildrenWirePages,
  parseAgencyBrandingWire,
  parseAgencyChildrenWire,
} from "./agencyWire";

const child = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme-child",
  name: "Acme Child",
  tier: "studio",
  parent_tenant_id: "22222222-2222-4222-8222-222222222222",
  billing_mode: "self",
  reseller_markup_bps: 250,
  whitelabel_enabled: false,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
};

const branding = {
  whitelabel_enabled: false,
  brand_name: "",
  custom_domain: "legacy.example.com",
  logo_url: "",
  primary_color: "",
  support_email: "",
  legal_entity: "Legacy LLC",
  updated_at: "2026-09-02T00:00:00Z",
  etag: '"agency-branding:22222222-2222-4222-8222-222222222222:v1"',
};

describe("agency read wire contracts", () => {
  it("accepts exact terminal and continuation roster pages", () => {
    expect(
      parseAgencyChildrenWire({
        children: [child],
        count: 1,
        has_more: true,
        next_cursor: "opaque-cursor",
      }).next_cursor,
    ).toBe("opaque-cursor");
    expect(
      parseAgencyChildrenWire({
        children: [{ ...child, slug: "a".repeat(63) }],
        count: 1,
        has_more: false,
      }).children,
    ).toHaveLength(1);
  });

  it("rejects page-count lies, invalid continuation, unknown keys, and coercion", () => {
    expect(() =>
      parseAgencyChildrenWire({
        children: [child],
        count: 0,
        has_more: false,
      }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyChildrenWire({
        children: [child],
        count: 1,
        has_more: true,
        next_cursor: "",
      }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyChildrenWire({
        children: [{ ...child, reseller_markup_bps: "250" }],
        count: 1,
        has_more: false,
      }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyChildrenWire({
        children: [child],
        count: 1,
        has_more: false,
        total: 1,
      }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyChildrenWire({
        children: [child],
        count: 1,
        has_more: false,
        next_cursor: "terminal-cursor",
      }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyChildrenWire({
        children: [{ ...child, id: "00000000-0000-0000-0000-000000000000" }],
        count: 1,
        has_more: false,
      }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyChildrenWire({
        children: [{ ...child, updated_at: "2026-07-31T23:59:59Z" }],
        count: 1,
        has_more: false,
      }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyChildrenWire({
        children: [{ ...child, created_at: "2026-02-31T00:00:00Z" }],
        count: 1,
        has_more: false,
      }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyChildrenWire({
        children: [child],
        count: 1,
        has_more: true,
        next_cursor: "not/url-safe=",
      }),
    ).toThrow(/malformed/i);
  });

  it("requires the complete branding projection and rejects unknown members", () => {
    expect(parseAgencyBrandingWire(branding)).toEqual(branding);
    const { legal_entity: _held, ...partial } = branding;
    expect(() => parseAgencyBrandingWire(partial)).toThrow(/malformed/i);
    expect(() =>
      parseAgencyBrandingWire({ ...branding, subscriber_pages_live: true }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyBrandingWire({ ...branding, brand_name: "spoof\u061cvalue" }),
    ).toThrow(/malformed/i);
    expect(() =>
      parseAgencyBrandingWire({
        ...branding,
        logo_url: "https://127.1/logo.svg",
      }),
    ).toThrow(/malformed/i);
  });

  it("accepts 200 legal-entity code points and rejects 201", () => {
    expect(
      parseAgencyBrandingWire({ ...branding, legal_entity: "a".repeat(200) })
        .legal_entity,
    ).toHaveLength(200);
    expect(() =>
      parseAgencyBrandingWire({ ...branding, legal_entity: "a".repeat(201) }),
    ).toThrow(/malformed/i);
  });

  it("fails closed when loaded pages overlap or cycle cursors", () => {
    const first = parseAgencyChildrenWire({
      children: [child],
      count: 1,
      has_more: true,
      next_cursor: "next",
    });
    const duplicate = parseAgencyChildrenWire({
      children: [child],
      count: 1,
      has_more: false,
    });
    if (!first.has_more) throw new Error("fixture must continue");
    expect(
      mergeAgencyChildrenWirePages([first, duplicate], ["", "next"]),
    ).toMatchObject({
      children: [],
      issue: expect.stringMatching(/same workspace/i),
    });
    const duplicateSlug = parseAgencyChildrenWire({
      children: [
        {
          ...child,
          id: "33333333-3333-4333-8333-333333333333",
        },
      ],
      count: 1,
      has_more: false,
    });
    expect(
      mergeAgencyChildrenWirePages([first, duplicateSlug], ["", "next"]),
    ).toMatchObject({
      children: [],
      issue: expect.stringMatching(/same workspace/i),
    });
    expect(
      mergeAgencyChildrenWirePages(
        [
          { ...first, next_cursor: "next" },
          { ...first, children: [], count: 0 },
        ],
        ["", "next"],
      ),
    ).toMatchObject({ children: [], issue: expect.stringMatching(/cursor/i) });
  });
});

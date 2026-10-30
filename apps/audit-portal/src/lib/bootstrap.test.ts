import { describe, expect, it, vi } from "vitest";

import { consumePortalBootstrap, portalParentOrigin } from "./bootstrap";

function fakeLocation(pathname: string, search: string, hash: string) {
  return { pathname, search, hash } as Pick<Location, "pathname" | "search" | "hash">;
}

describe("consumePortalBootstrap", () => {
  it("captures the fragment token and scrubs it synchronously", () => {
    const replaceState = vi.fn();
    const token = consumePortalBootstrap(
      fakeLocation("/portal/audit", "", "#bootstrap=header.payload.signature"),
      { replaceState },
    );

    expect(token).toBe("header.payload.signature");
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/portal/audit");
  });

  it("removes legacy credential paths and secret-looking query parameters", () => {
    const replaceState = vi.fn();
    const token = consumePortalBootstrap(
      fakeLocation(
        "/portal/audit/legacy.jwt.value",
        "?token=legacy.jwt.value&bootstrap=also-secret&theme=dark&trace=1",
        "",
      ),
      { replaceState },
    );

    expect(token).toBe("");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/portal/audit?theme=dark");
  });

  it("rejects oversized fragments while still removing them", () => {
    const replaceState = vi.fn();
    const token = consumePortalBootstrap(
      fakeLocation("/portal/audit", "", `#bootstrap=${"x".repeat(2049)}`),
      { replaceState },
    );

    expect(token).toBe("");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/portal/audit");
  });

  it("does not rewrite an already-safe themed URL", () => {
    const replaceState = vi.fn();
    expect(
      consumePortalBootstrap(
        fakeLocation("/portal/audit", "?theme=light", ""),
        { replaceState },
      ),
    ).toBe("");
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("preserves only a validated exact HTTPS parent origin", () => {
    const replaceState = vi.fn();
    const search =
      "?parent_origin=https%3A%2F%2Fcustomer.example&debug=secret";
    consumePortalBootstrap(fakeLocation("/portal/audit", search, ""), {
      replaceState,
    });
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/portal/audit?parent_origin=https%3A%2F%2Fcustomer.example",
    );
    expect(portalParentOrigin({ search })).toBe("https://customer.example");
  });

  it.each([
    "http://customer.example",
    "https://user@customer.example",
    "https://customer.example/path",
    "not-an-origin",
  ])("rejects an unsafe postMessage parent origin: %s", (parentOrigin) => {
    expect(
      portalParentOrigin({
        search: `?parent_origin=${encodeURIComponent(parentOrigin)}`,
      }),
    ).toBe("");
  });
});

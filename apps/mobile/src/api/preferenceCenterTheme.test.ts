/**
 * Transport seam for the preference-centre theme.
 *
 * The parse and the policy are pinned in lib/preferenceCenterTheme.test.ts and
 * the card in __tests__/preference-center-theme.native.test.tsx; neither covers
 * THIS layer, where the method, the path and the body shape live — and where a
 * mistake would be invisible until an operator's save 404s or 422s.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getPreferenceCenterTheme,
  savePreferenceCenterTheme,
} from "./preferenceCenterTheme";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

const PATH = "/api/v1/privacy/portal/preference-center";

beforeEach(() => rawRequest.mockReset());

describe("getPreferenceCenterTheme", () => {
  it("GETs the privacy-portal route and parses the row", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenantId: "t-1",
        logo_url: "https://cdn.example.com/l.png",
        primary_color: "#123456",
        footer_text: "bye",
        show_postwave_badge: false,
      },
      error: null,
    });
    const res = await getPreferenceCenterTheme();
    expect(rawRequest).toHaveBeenCalledWith("GET", PATH);
    expect(res.error).toBeNull();
    expect(res.data).toEqual({
      logoUrl: "https://cdn.example.com/l.png",
      primaryColor: "#123456",
      footerText: "bye",
      showPostwaveBadge: false,
    });
  });

  it("passes the error envelope through untouched", async () => {
    const error = { status: 403, code: "not_authorized", message: "nope" };
    rawRequest.mockResolvedValue({ data: null, error });
    expect(await getPreferenceCenterTheme()).toEqual({ data: null, error });
  });

  it("does not throw on an unparseable body — the card renders defaults", async () => {
    rawRequest.mockResolvedValue({ data: "<html>proxy</html>", error: null });
    const res = await getPreferenceCenterTheme();
    expect(res.error).toBeNull();
    expect(res.data?.primaryColor).toBe("#5B6CFF");
  });
});

describe("savePreferenceCenterTheme", () => {
  it("PATCHes all four columns and never echoes tenantId", async () => {
    rawRequest.mockResolvedValue({
      data: { logo_url: "", primary_color: "#5B6CFF", footer_text: "hi", show_postwave_badge: true },
      error: null,
    });
    await savePreferenceCenterTheme({
      logoUrl: "  https://cdn.example.com/l.png ",
      primaryColor: " #ABCDEF ",
      footerText: "hi",
      showPostwaveBadge: true,
    });
    expect(rawRequest).toHaveBeenCalledWith("PATCH", PATH, {
      logo_url: "https://cdn.example.com/l.png",
      primary_color: "#ABCDEF",
      footer_text: "hi",
      show_postwave_badge: true,
    });
  });

  it("adopts the server's normalisation from the response body", async () => {
    // An emptied colour comes back as the default the server substituted.
    rawRequest.mockResolvedValue({
      data: { logo_url: "", primary_color: "#5B6CFF", footer_text: "", show_postwave_badge: true },
      error: null,
    });
    const res = await savePreferenceCenterTheme({
      logoUrl: "",
      primaryColor: "",
      footerText: "",
      showPostwaveBadge: true,
    });
    expect(res.data?.primaryColor).toBe("#5B6CFF");
  });

  it("returns the 422 envelope so the card can render the validator's sentence", async () => {
    const error = {
      status: 422,
      code: "validation_failed",
      message: "primary_color must match /^#[0-9A-Fa-f]{6}$/",
    };
    rawRequest.mockResolvedValue({ data: null, error });
    const res = await savePreferenceCenterTheme({
      logoUrl: "",
      primaryColor: "#zzz",
      footerText: "",
      showPostwaveBadge: true,
    });
    expect(res).toEqual({ data: null, error });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { getPublicPopup, submitPublicPopup } from "@/lib/mailchimp-compat-api";
import { createPublicCheckout } from "@/lib/public-billing-api";
import { publicLookup, publicUpdate } from "@/lib/preferences-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public token-gated API helpers", () => {
  it("omits credentials for preference lookup and updates", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          email: "reader@example.com",
          expiresAt: "2027-01-01T00:00:00Z",
          topics: [],
          frequencyPreference: "default",
          gpc: false,
          customization: {
            logo_url: "",
            primary_color: "#000000",
            footer_text: "",
            show_postwave_badge: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await publicLookup("pref-token");
    await publicUpdate("pref-token", []);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/public/preferences/pref-token"),
      expect.objectContaining({ credentials: "omit" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/api/public/preferences/pref-token"),
      expect.objectContaining({ method: "POST", credentials: "omit" }),
    );
  });

  it("omits credentials for public popup lookup and conversion", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true, popup_id: "pop_1" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "pop_1",
          public_key: "pk_1",
          name: "Popup",
          status: "published",
          trigger: {},
          targeting: {},
          blocks: [],
          metrics: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await getPublicPopup("pk_1", "demo");
    await submitPublicPopup("pk_1", { email: "reader@example.com" }, "demo");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/public/popups/pk_1?tenant=demo"),
      expect.objectContaining({ credentials: "omit" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/api/public/popups/pk_1/convert?tenant=demo"),
      expect.objectContaining({ method: "POST", credentials: "omit" }),
    );
  });

  it("omits credentials for the release-gated public checkout helper", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/billing/checkout")) {
        return new Response(
          JSON.stringify({ url: "https://checkout.example" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await createPublicCheckout({
      tier: "studio_ltd",
      customerEmail: "reader@example.com",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/public/billing/checkout"),
      expect.objectContaining({ method: "POST", credentials: "omit" }),
    );
  });
});

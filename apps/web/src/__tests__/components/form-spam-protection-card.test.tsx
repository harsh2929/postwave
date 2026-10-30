// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Spam protection (desktop FormSpamSettings) on web, driven through the REAL
// lib/api transport against a fetch stub that honours If-Match like the Go
// handler does. Asserts what reaches the wire: PATCH /api/v1/forms/{id} with
// ONLY `settings`, the full settings map (the server replaces it wholesale),
// the If-Match token of the version on screen, and a fresh authority check
// first. Then the 412 path: the reload control re-reads the form and the next
// save carries the new token.
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpamProtectionCard } from "@/components/forms/spam-protection-card";
import type { MeResponse } from "@/lib/auth-api";
import { FORM_READ_ONLY_MESSAGE } from "@/lib/forms-authority";
import { getForm } from "@/lib/forms-api";
import type { Form } from "@/lib/forms-types";

import {
  button,
  choose,
  click,
  eventually,
  field,
  identity,
  json,
  mount,
  stubFetch,
  typeInto,
  unmountAll,
  type RecordedCall,
} from "../helpers/forms-extras-harness";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

const FORM_ID = "form_1";
const PATH = `/api/v1/forms/${FORM_ID}`;

function form(overrides: Partial<Form> = {}): Form {
  return {
    id: FORM_ID,
    tenantId: "tenant-1",
    slug: "newsletter",
    name: "Newsletter",
    optInMode: "double",
    structure: { fields: [] },
    settings: { successMessage: "Thanks!", targetListId: "42" },
    status: "published",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

let server: { form: Form; etag: string; me: MeResponse; conflictNextPatch: boolean };
let calls: RecordedCall[];

function patches() {
  return calls.filter((c) => c.method === "PATCH" && c.path === PATH);
}

beforeEach(() => {
  server = {
    form: form(),
    etag: '"v1"',
    me: identity({ role: "editor", effective_role: "editor" }),
    conflictNextPatch: false,
  };
  ({ calls } = stubFetch((call) => {
    if (call.path === "/api/v1/auth/me") return json(server.me);
    if (call.path !== PATH) return undefined;
    if (call.method === "GET") return json(server.form, { etag: server.etag });
    if (call.method === "PATCH") {
      if (server.conflictNextPatch) {
        // Someone else saved first: the record and its token moved on.
        server.conflictNextPatch = false;
        server.form = form({
          updatedAt: "2026-09-02T00:00:00Z",
          settings: {
            successMessage: "Thanks!",
            targetListId: "42",
            captchaProvider: "hcaptcha",
            captchaSiteKey: "hc-other",
          } as Form["settings"],
        });
        server.etag = '"v3"';
      }
      if (call.headers.get("If-Match") !== server.etag) {
        return json(
          { error: { code: "precondition_failed", message: "stale" } },
          { status: 412 },
        );
      }
      const body = call.body as { settings: Form["settings"] };
      server.form = {
        ...server.form,
        settings: body.settings,
        updatedAt: "2026-09-03T00:00:00Z",
      };
      server.etag = '"v4"';
      return json(server.form, { etag: server.etag });
    }
    return undefined;
  }));
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

async function mountLoaded(me: MeResponse, onSaved = vi.fn()) {
  // Seeds forms-api's ETag cache exactly as the editor page's query does.
  const loaded = await getForm(FORM_ID);
  mount(createElement(SpamProtectionCard, { form: loaded, identity: me, onSaved }));
  return onSaved;
}

describe("SpamProtectionCard", () => {
  it("saves honeypot, provider, site key and rate limit as ONE settings PATCH carrying If-Match", async () => {
    const onSaved = await mountLoaded(server.me);

    await click(field("Honeypot field"));
    choose(field<HTMLSelectElement>("Captcha"), "turnstile");
    typeInto(field("Turnstile site key"), "0x4AAAAAAA");
    typeInto(field("Rate limit"), "30");
    await click(button("Save spam protection"));

    await eventually(() => expect(patches()).toHaveLength(1));
    const [patch] = patches();
    expect(patch.headers.get("If-Match")).toBe('"v1"');
    expect(Object.keys(patch.body as object)).toEqual(["settings"]);
    expect((patch.body as { settings: unknown }).settings).toEqual({
      successMessage: "Thanks!",
      targetListId: "42",
      honeypotEnabled: false,
      captchaProvider: "turnstile",
      captchaSiteKey: "0x4AAAAAAA",
      captchaRequired: false,
      rateLimitPerMin: 30,
    });
    // The authority was re-read before the write, not trusted from mount.
    const meIdx = calls.findIndex((c) => c.path === "/api/v1/auth/me");
    expect(meIdx).toBeGreaterThan(-1);
    expect(meIdx).toBeLessThan(calls.indexOf(patch));

    await eventually(() =>
      expect(document.body.textContent).toContain("Spam protection saved."),
    );
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: "2026-09-03T00:00:00Z" }),
    );
  });

  it("maps reCAPTCHA v2 onto the keys the server enforces", async () => {
    await mountLoaded(server.me);

    choose(field<HTMLSelectElement>("Captcha"), "recaptcha");
    typeInto(field("reCAPTCHA site key"), "6LcSITEKEY");
    await click(button("Save spam protection"));

    await eventually(() => expect(patches()).toHaveLength(1));
    const settings = (patches()[0].body as { settings: Record<string, unknown> })
      .settings;
    expect(settings.captchaProvider).toBe("recaptcha");
    expect(settings.captchaRequired).toBe(true);
    expect(settings.recaptchaSiteKey).toBe("6LcSITEKEY");
    expect(settings.captchaSiteKey).toBe("6LcSITEKEY");
  });

  it("withholds every control from a viewer with the reason and sends nothing", async () => {
    const viewer = identity({ role: "viewer", effective_role: "viewer" });
    await mountLoaded(viewer);
    const before = calls.length;

    expect(document.body.textContent).toContain(FORM_READ_ONLY_MESSAGE);
    expect(field("Honeypot field").disabled).toBe(true);
    expect(field<HTMLSelectElement>("Captcha").disabled).toBe(true);
    expect(button("Save spam protection").disabled).toBe(true);
    await click(button("Save spam protection"));
    expect(calls.length).toBe(before);
  });

  it("refuses an out-of-range rate limit before any request", async () => {
    await mountLoaded(server.me);
    typeInto(field("Rate limit"), "5000");

    expect(document.body.textContent).toContain(
      "Enter a whole number from 0 to 1000",
    );
    expect(button("Save spam protection").disabled).toBe(true);
    expect(patches()).toHaveLength(0);
  });

  it("stops when the caller's authority changed since the card opened", async () => {
    await mountLoaded(server.me);
    server.me = identity({ role: "viewer", effective_role: "viewer" });

    await click(field("Honeypot field"));
    await click(button("Save spam protection"));

    await eventually(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "authority changed",
      ),
    );
    expect(patches()).toHaveLength(0);
  });

  it("on 412 offers a reload that confirms the discard, re-reads the form, and saves on the fresh token", async () => {
    const onSaved = await mountLoaded(server.me);
    server.conflictNextPatch = true;

    choose(field<HTMLSelectElement>("Captcha"), "turnstile");
    await click(button("Save spam protection"));

    await eventually(() =>
      expect(document.body.textContent).toContain("Form changed elsewhere"),
    );
    expect(patches()).toHaveLength(1);
    expect(button("Save spam protection").disabled).toBe(true);

    // Unsaved edits → the reload names its consequence before acting.
    const getsBefore = calls.filter((c) => c.method === "GET" && c.path === PATH)
      .length;
    await click(button("Reload latest version"));
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "Discard your changes and reload?",
      ),
    );
    expect(
      calls.filter((c) => c.method === "GET" && c.path === PATH).length,
    ).toBe(getsBefore);
    await click(button("Discard and reload"));

    await eventually(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.path === PATH).length,
      ).toBe(getsBefore + 1),
    );
    // The other session's choice is what the card now shows.
    await eventually(() =>
      expect(field<HTMLSelectElement>("Captcha").value).toBe("hcaptcha"),
    );
    expect(field("hCaptcha site key").value).toBe("hc-other");
    expect(document.body.textContent).not.toContain("Form changed elsewhere");
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: "2026-09-02T00:00:00Z" }),
    );

    // The next save is conditional on the version just loaded.
    typeInto(field("Rate limit"), "12");
    await click(button("Save spam protection"));
    await eventually(() => expect(patches()).toHaveLength(2));
    expect(patches()[1].headers.get("If-Match")).toBe('"v3"');
    expect(
      (patches()[1].body as { settings: Record<string, unknown> }).settings,
    ).toMatchObject({ captchaProvider: "hcaptcha", rateLimitPerMin: 12 });
  });
});

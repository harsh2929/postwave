// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// DISABLED-CONTROL TRANSITIONS ON THE SETTINGS SAVE BUTTONS.
//
// WHY A SECOND FILE. _disabled-transitions.test.tsx covers the ACTION pages —
// alerting-access, data-operations, maintenance, preflight, the admin gate,
// the import file picker. Every one of those controls is gated on a single
// condition. The settings save buttons are the other shape, and the one the
// operator meets every day:
//
//     disabled={saving || loading || !dirty || brandColorInvalid}
//
// Four conditions on one button, two of them preconditions the user satisfies
// and un-satisfies by typing, one of them an in-flight flag. That expression
// has four independent ways to strand somebody, and none of them is visible to
// the click sweep, which skips disabled controls entirely.
//
// The specific failures being tested for, in the order they bite:
//
//   1. NEVER ENABLES. `!dirty` computed against the wrong baseline, so editing
//      the form does nothing and there is no error to read, because no request
//      was ever made.
//   2. ENABLES WHEN IT MUST NOT. `brandColorInvalid` dropped from the
//      expression, so "postwave-qa" is submitted as a hex colour.
//   3. STAYS BUSY. `setSaving(false)` in the success path instead of a
//      `finally`, so a FAILED save leaves the button dead: no request in
//      flight, no way to fire one, no way out but a page reload — with unsaved
//      edits still in the form.
//   4. STAYS DEAD AFTER SUCCESS. The baseline not moving, or moving somewhere
//      wrong, so the button is stuck off and the next edit cannot be saved.
//
// (3) is the one the brief calls out and the one that is genuinely dangerous,
// so it is tested on every surface here, always by stubbing a real 400 rather
// than by reasoning about the code.
//
// HOW "BUSY" IS OBSERVED. stubTransport() resolves immediately and renderPage()
// flushes until the DOM stops changing, so a busy state that lasts one
// microtask is invisible — "briefly disabled" and "never disabled" look
// identical. gateTransport() below installs a fetch that answers nothing until
// this file releases it, so the in-flight window can be held open, asserted in,
// and then closed to assert the settled state. Without it, (3) is untestable.
//
// WHY 400 AND NOT 500. http-fetch.ts retries every 5xx with decorrelated
// jitter, so a stubbed 500 leaves the button legitimately busy for the whole
// retry window: the test would be asserting the retry policy, not the finally
// block. A 400 is a failure the client does not retry.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, stubTransport, unmount, WHOAMI } from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/settings",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
  whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
}));

// sonner renders into its own portal and is irrelevant to the disabled state;
// mocked so a toast cannot throw inside the handler under test and be mistaken
// for the page failing to recover.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

/* ------------------------------------------------------------------ *
 * Helpers.
 * ------------------------------------------------------------------ */

async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** The exact button whose trimmed text starts with `label`. */
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").trim().startsWith(label),
  );
  if (!found) {
    const all = [...container.querySelectorAll("button")]
      .map((b) => `"${(b.textContent ?? "").trim()}"`)
      .join(", ");
    throw new Error(`no button starting with "${label}"; page has: ${all}`);
  }
  return found as HTMLButtonElement;
}

/** React installs its own value setter; assigning `.value` is swallowed. */
async function typeInto(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function press(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function field(container: HTMLElement, id: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`no field #${id} on the page`);
  return el;
}

/** A 400 whose error body carries exactly `message`. */
function failWith(message: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { code: "bad_request", message } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

/** A transport that answers nothing until released. See the header. */
function gateTransport(
  status = 200,
  body: unknown = {},
): { release: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { release: open };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubTransport("loaded");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ================================================================== *
 * 1. /app/settings — "Save changes"
 *
 *    disabled={saving || loading || !dirty || brandColorInvalid}
 * ================================================================== */

const SETTINGS = () => import("@/app/(dashboard)/app/settings/page");

describe("workspace settings: Save changes walks its whole state machine", () => {
  it("pristine → edited → invalid → valid, in both directions", async () => {
    const Page = (await SETTINGS()).default;
    const { container, root } = await renderPage(Page);
    try {
      const save = button(container, "Save changes");

      // PRISTINE. Nothing has been edited, so there is nothing to save.
      expect(save.disabled).toBe(true);

      // EDITED. `dirty` is the only condition that changed.
      await typeInto(field(container, "ws-name"), "Acme Marketing");
      expect(save.disabled).toBe(false);

      // INVALID. The inverse direction, and the one that matters: a
      // precondition that only ever ENABLES is not a validation gate. Brand
      // colour is a six-digit hex; this is not one, and the button must go
      // back to dead while the form is still dirty — so `dirty` cannot be
      // what is doing the work here.
      await typeInto(field(container, "ws-brand"), "postwave-qa");
      expect(save.disabled).toBe(true);

      // VALID AGAIN. And it must recover — a validation gate that latches is
      // just a slower dead end.
      await typeInto(field(container, "ws-brand"), "#3b82f6");
      expect(save.disabled).toBe(false);

      // EMPTY IS VALID TOO: brand colour is optional, and `brandColorInvalid`
      // is written to ignore an empty string. A rule that treated "" as
      // invalid would lock Save for every workspace that never set one.
      await typeInto(field(container, "ws-brand"), "");
      expect(save.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("busy is transient: disabled in flight, enabled again on the way out", async () => {
    const Page = (await SETTINGS()).default;
    const { container, root } = await renderPage(Page);
    try {
      const save = button(container, "Save changes");
      await typeInto(field(container, "ws-name"), "Acme Marketing");
      expect(save.disabled).toBe(false);

      const { release } = gateTransport(200, {
        tenant_id: WHOAMI.tenant_id,
        display_name: "Acme Marketing",
        timezone: "UTC",
        date_format: "MMM D, YYYY",
        default_reply_to: "qa@postwave.test",
        brand_color: "",
        logo_url: "",
      });
      await press(save);

      // In flight. Nothing has released the request, so it CANNOT have
      // settled — this is a real in-flight observation, not a race won.
      expect(save.disabled).toBe(true);
      expect(save.textContent).toContain("Saving…");

      release();
      await flush(10);

      // Settled. The label comes back, and the button is disabled again for a
      // DIFFERENT reason: the form now matches what the server holds.
      expect(save.textContent).toContain("Save changes");
      expect(save.disabled).toBe(true);

      // Which is only meaningful if a further edit re-arms it. Without this,
      // "disabled after a successful save" is indistinguishable from the
      // stuck-forever bug.
      await typeInto(field(container, "ws-name"), "Acme Marketing HQ");
      expect(save.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("a FAILED save re-enables the button and keeps the operator's edits", async () => {
    const Page = (await SETTINGS()).default;
    const { container, root } = await renderPage(Page);
    try {
      const save = button(container, "Save changes");
      await typeInto(field(container, "ws-name"), "Acme Marketing");
      expect(save.disabled).toBe(false);

      failWith("Workspace name is already taken.");
      await press(save);
      await flush(10);

      // THE ASSERTION THIS FILE EXISTS FOR. A save that fails and leaves the
      // control dead strands the operator: no request in flight, no way to
      // fire one, and unsaved edits in the form.
      expect(save.disabled).toBe(false);
      expect(save.textContent).toContain("Save changes");

      // And they must be told why, or a re-enabled button is just a button
      // that silently does nothing twice.
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent ?? "").toContain(
        "Workspace name is already taken.",
      );

      // The typed value survived, so "enabled" is not the result of the page
      // having reset itself out from under them.
      expect(field(container, "ws-name").value).toBe("Acme Marketing");
    } finally {
      unmount(root);
    }
  });

  // ---------------------------------------------------------------- //
  // FINDING — settings/page.tsx:446
  //
  //     return body?.error?.message ?? e.message ?? fallback;
  //
  // `??` falls through on null/undefined ONLY, so an error body carrying an
  // EMPTY message wins over both the ApiError's own message and the stated
  // fallback. `setError("")` then renders nothing, because the banner is
  // `{error ? <div role="alert">…</div> : null}` and "" is falsy.
  //
  // The result is the worst version of a recoverable failure: the request is
  // gone, the button is enabled again, the operator's edits are still on
  // screen — and the page says absolutely nothing. Pressing Save again looks
  // to them like the button does nothing at all. `toast.error("")` is raised
  // on the same path, so the toast is empty too.
  //
  // The neighbouring security page is written `err.message` with no body
  // unwrapping and does NOT have this hole — the test above it passes with an
  // alert on the very same 400 — which is what makes this a defect in this
  // page rather than a property of the transport.
  //
  // Keep the fallback visible even when a server envelope omits its safe
  // public message.
  // ---------------------------------------------------------------- //
  it("shows a useful fallback when error.message is empty", async () => {
    const Page = (await SETTINGS()).default;
    const { container, root } = await renderPage(Page);
    try {
      const save = button(container, "Save changes");
      await typeInto(field(container, "ws-name"), "Acme Marketing");

      // Exactly the shape _harness.tsx's own error mode sends, and a shape a
      // Go handler produces whenever it returns a bare error code.
      failWith("");
      await press(save);
      await flush(10);

      // Recovery works…
      expect(save.disabled).toBe(false);
      expect(field(container, "ws-name").value).toBe("Acme Marketing");
      // …and the failure is still visible rather than becoming an empty toast.
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.textContent ?? "").toMatch(/could not save/i);
    } finally {
      unmount(root);
    }
  });

  it("retrying after a failure actually reaches the network again", async () => {
    // Re-enabling is only half of recovery. A button that is enabled but whose
    // handler is wedged behind a stale `saving` flag looks identical.
    const Page = (await SETTINGS()).default;
    const { container, root } = await renderPage(Page);
    try {
      const save = button(container, "Save changes");
      await typeInto(field(container, "ws-name"), "Acme Marketing");

      stubTransport("error");
      await press(save);
      await flush(10);
      expect(save.disabled).toBe(false);

      const attempts = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              tenant_id: WHOAMI.tenant_id,
              display_name: "Acme Marketing",
              timezone: "UTC",
              date_format: "MMM D, YYYY",
              default_reply_to: "qa@postwave.test",
              brand_color: "",
              logo_url: "",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      vi.stubGlobal("fetch", attempts);
      await press(save);
      await flush(10);

      const writes = attempts.mock.calls.filter(
        ([, init]) => (init?.method ?? "GET").toUpperCase() !== "GET",
      );
      expect(writes.length).toBeGreaterThan(0);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 2. /app/settings/security — "Save security settings"
 *
 *    disabled={loading || saving || !dirty}
 *
 * Same shape, different page, and one the click sweep can never arm: the
 * precondition is a CHECKBOX, and fillEveryInput() skips type="checkbox"
 * because there is no string to type into one.
 * ================================================================== */

const SECURITY = () => import("@/app/(dashboard)/app/settings/security/page");

/** The 2FA-for-admins checkbox, which is what makes the page dirty. */
function twoFactorBox(container: HTMLElement): HTMLInputElement {
  const box = container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!box) throw new Error("no checkbox on the security settings page");
  return box;
}

describe("security settings: a checkbox arms the save, and a failure disarms nothing", () => {
  it("dead until a policy is actually changed", async () => {
    const Page = (await SECURITY()).default;
    const { container, root } = await renderPage(Page);
    try {
      const save = button(container, "Save security settings");
      expect(save.disabled).toBe(true);

      await press(twoFactorBox(container));
      await flush(2);

      expect(save.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("disabled in flight, and disabled again once the policy is saved", async () => {
    const Page = (await SECURITY()).default;
    const { container, root } = await renderPage(Page);
    try {
      const save = button(container, "Save security settings");
      await press(twoFactorBox(container));
      await flush(2);
      expect(save.disabled).toBe(false);

      const { release } = gateTransport(200, {
        require_2fa_for_admins: true,
        require_2fa_for_all: false,
        allow_trusted_devices: true,
        sso_provider: "",
        sso_metadata_url: "",
        session_max_minutes: null,
      });
      await press(save);

      expect(save.disabled).toBe(true);
      expect(save.textContent).toContain("Saving…");

      release();
      await flush(12);

      expect(save.textContent).toContain("Save security settings");
      expect(save.disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("a FAILED save re-enables it, surfaces the reason, and keeps the toggle", async () => {
    const Page = (await SECURITY()).default;
    const { container, root } = await renderPage(Page);
    try {
      const save = button(container, "Save security settings");
      const box = twoFactorBox(container);
      await press(box);
      await flush(2);
      const armed = box.checked;

      stubTransport("error");
      await press(save);
      await flush(12);

      expect(save.disabled).toBe(false);
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      // The operator's unsaved change is still on screen — a page that
      // silently reverted it would also show an enabled button, and only this
      // assertion tells the two apart.
      expect(twoFactorBox(container).checked).toBe(armed);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 3. THE CROSS-PAGE INVARIANT.
 *
 * The two pages above are checked in detail. This asks the blunt version of
 * the same question of both at once, and of any page added to the list later:
 * after a failed write, is there STILL a way forward?
 *
 * A page with zero enabled controls after an error is a dead end regardless of
 * which button caused it, and that is the state a missing `finally` produces.
 * ================================================================== */

describe("no settings page is a dead end after a failed write", () => {
  const SURFACES: Array<{
    name: string;
    load: () => Promise<{ default: unknown }>;
    save: string;
    arm: (container: HTMLElement) => Promise<void>;
  }> = [
    {
      name: "settings",
      load: SETTINGS,
      save: "Save changes",
      arm: async (c) => typeInto(field(c, "ws-name"), "Acme Marketing"),
    },
    {
      name: "settings/security",
      load: SECURITY,
      save: "Save security settings",
      arm: async (c) => press(twoFactorBox(c)),
    },
  ];

  for (const surface of SURFACES) {
    it(`${surface.name}: still operable after the write fails`, async () => {
      stubTransport("loaded");
      const Page = (await surface.load()).default;
      const { container, root } = await renderPage(Page as never);
      try {
        await surface.arm(container);
        await flush(2);
        const save = button(container, surface.save);
        expect(
          save.disabled,
          `${surface.name}: arming did not enable ${surface.save}, so the failure below proves nothing`,
        ).toBe(false);

        stubTransport("error");
        await press(save);
        await flush(12);

        const enabled = [...container.querySelectorAll("button")].filter(
          (b) => !b.disabled,
        );
        expect(enabled.length).toBeGreaterThan(0);
        expect(enabled).toContain(save);
      } finally {
        unmount(root);
      }
    });
  }
});

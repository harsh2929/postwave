// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// TYPING AND SUBMITTING — the four things a form has to get right.
//
// WHY THIS EXISTS. The click sweep in _harness.tsx presses every enabled
// button and asserts only that nothing throws. It types nothing, so it cannot
// tell a form that validates from one that does not, cannot tell a POST that
// carries the user's values from one that carries stale state, and — the
// expensive one — cannot tell a failed save that keeps what the user typed
// from one that throws it away. Losing twenty minutes of typing to a 400 is
// the single most common form defect and no test in this app looked for it.
//
// Each form below is exercised on the same four axes, because these are the
// four ways a real user meets a form:
//
//   1. REQUIRED-EMPTY  — submission is blocked and the page SAYS which field.
//   2. INVALID         — a malformed value is rejected client-side, by name,
//                        and no request leaves the client.
//   3. VALID           — exactly one request, carrying the typed values. The
//                        assertion is on the recorded fetch body, not on a
//                        prop spy: a spy proves a callback ran, which is not
//                        the same as the write leaving the browser.
//   4. FAILED          — the error is surfaced AND the typed input survives.
//
// The forms are chosen by consequence, not by convenience: creating an
// account, creating a capture form, wiring an outbound webhook, and creating
// a campaign. A user cannot route around any of them.
//
// RADIX PORTALS. DialogContent renders through a portal into document.body,
// not into the container renderPage returns. Everything dialog-side is scoped
// to `openDialog()`, which throws when nothing is mounted rather than handing
// back a null that lets `?.` swallow the mistake and pass vacuously.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";

import { FORM_TEMPLATES } from "@/lib/form-templates";
import {
  readOfflineQueue,
  resetOfflineStorageIdentity,
  setOfflineStorageIdentity,
} from "@/lib/offline-store";
import {
  STEP_UP_PROMPT_EVENT,
  resetStepUpState,
  type StepUpPromptDetail,
} from "@/lib/step-up";

import { renderPage, unmount, WHOAMI } from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
  whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
}));

vi.mock("@/lib/admin-mutation-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin-mutation-authority")>()),
  verifyFreshAdminAuthority: vi.fn().mockResolvedValue(WHOAMI),
}));

// Several of these forms report validation failures through a toast rather
// than inline text. No <Toaster/> is mounted here, so a real toast() call
// leaves no DOM trace at all and "the page says so" would be untestable —
// which is exactly how a form that silently swallows a bad value would look.
// Recording the calls keeps that assertion honest.
const toastLog = vi.hoisted(() => [] as { level: string; text: string }[]);
vi.mock("sonner", () => {
  const rec = (level: string) => (message: unknown) => {
    toastLog.push({ level, text: String(message) });
    return "toast-id";
  };
  const toast = Object.assign(rec("message"), {
    error: rec("error"),
    success: rec("success"),
    warning: rec("warning"),
    info: rec("info"),
    loading: rec("loading"),
    custom: rec("custom"),
    dismiss: () => undefined,
    promise: () => undefined,
  });
  return { toast, Toaster: () => null };
});

/** Every toast message at a given level, for the "it said so" assertions. */
function toastsAt(level: string): string[] {
  return toastLog.filter((t) => t.level === level).map((t) => t.text);
}

/* ------------------------------------------------------------------ *
 * Transport recorder.
 *
 * Records METHOD, path and the PARSED JSON body of every request, so a
 * "valid submission" assertion can name the values the user typed instead
 * of settling for "a POST happened".
 * ------------------------------------------------------------------ */

interface Recorded {
  method: string;
  path: string;
  body: unknown;
  cache?: RequestCache;
  headers?: HeadersInit;
  redirect?: RequestRedirect;
}

type Reply = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};
type ReplyResult = Reply | undefined | Promise<Reply | undefined>;

let calls: Recorded[] = [];

/**
 * Records every request and answers from `handler`.
 *
 * An `undefined` reply means "not stubbed", and that answers 404 rather than
 * 200 `{}` — the same correction _harness.tsx documents. A truthy-but-empty
 * object is a shape the server never sends, so `?.` chains do not
 * short-circuit on it and pages appear to crash for a state they cannot reach.
 * A 404 is a state the app genuinely sees.
 */
function transport(handler: (req: Recorded) => ReplyResult = () => undefined) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0];
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const record: Recorded = {
        method,
        path,
        body,
        cache: init?.cache,
        headers: init?.headers,
        redirect: init?.redirect,
      };
      calls.push(record);
      const reply = await handler(record);
      if (!reply) {
        return new Response(
          JSON.stringify({ error: { code: "not_found", message: "" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: {
          "content-type": "application/json",
          ...reply.headers,
        },
      });
    }),
  );
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Every write attempted, as "METHOD /path". Reads are dropped. */
function writes(): string[] {
  return calls
    .filter((c) => MUTATING.has(c.method))
    .map((c) => `${c.method} ${c.path}`);
}

/** The recorded writes to one path — the set a "exactly one request" claim needs. */
function writesTo(path: string): Recorded[] {
  return calls.filter((c) => MUTATING.has(c.method) && c.path === path);
}

function headerValue(request: Recorded, name: string): string | null {
  const headers = request.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const normalized = name.toLowerCase();
  const entries = Array.isArray(headers)
    ? headers
    : Object.entries(headers as Record<string, string>);
  return entries.find(([key]) => key.toLowerCase() === normalized)?.[1] ?? null;
}

/* ------------------------------------------------------------------ *
 * DOM helpers.
 * ------------------------------------------------------------------ */

/**
 * Types through React's OWN value setter.
 *
 * Assigning `.value` directly is swallowed: React installs a setter on the
 * element instance, so a plain assignment never reaches onChange and the
 * component keeps its old state. A test written that way submits an empty
 * form, watches the required-field guard fire, and calls it a pass.
 */
async function typeInto(
  el: Element | null | undefined,
  value: string,
  what: string,
): Promise<void> {
  if (!el) throw new Error(`no field to type into: ${what}`);
  const node = el as HTMLInputElement | HTMLTextAreaElement;
  const proto =
    node.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("no native value setter available");
  await act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(
  el: Element | null | undefined,
  what: string,
): Promise<void> {
  if (!el) throw new Error(`no control to click: ${what}`);
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
  // A submit handler's await chain resolves on later turns: one flush records
  // the click but not the request it caused.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** Fires a real submit event, the path Enter-in-a-field takes. */
async function submitForm(form: Element | null | undefined): Promise<void> {
  if (!form) throw new Error("no form to submit");
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

function openDialog(): HTMLElement {
  const nodes = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
  if (nodes.length === 0) throw new Error("no dialog is open");
  return nodes[nodes.length - 1];
}

function button(
  scope: ParentNode,
  label: string,
): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
}

/** A field by id, scoped to wherever it actually rendered (page or portal). */
function field(id: string): HTMLInputElement | HTMLTextAreaElement {
  const el = document.body.querySelector<HTMLInputElement>(`#${id}`);
  if (!el) throw new Error(`no field with id "${id}" is rendered`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  toastLog.length = 0;
  calls = [];
});

afterEach(() => {
  resetStepUpState();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/* ================================================================== *
 * 1. /signup — src/app/signup/page.tsx
 *
 * The only door into the product. Four typed fields, two client-side
 * gates (slug shape, password length), and a 409 on slug collision that
 * the page promises in its own header comment to surface "so the user can
 * pick a different one WITHOUT LOSING THEIR OTHER INPUTS". That promise is
 * a comment; nothing tested it.
 * ================================================================== */

describe("/signup — creating the account", () => {
  const loadPage = async () => (await import("@/app/signup/page")).default;

  async function fillValid(over: Partial<Record<string, string>> = {}) {
    await typeInto(field("email"), over.email ?? "qa@postwave.test", "email");
    await typeInto(
      field("password"),
      over.password ?? "correct-horse-battery",
      "password",
    );
    await typeInto(
      field("workspace-name"),
      over.workspaceName ?? "Acme Newsletter",
      "workspace name",
    );
    if (over.slug !== undefined) {
      await typeInto(field("workspace-slug"), over.slug, "workspace slug");
    }
  }

  it("an empty workspace slug blocks submission and names the field", async () => {
    transport();
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await fillValid({ slug: "" });

      await submitForm(container.querySelector("form"));

      // It said so, in the DOM, naming the field.
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent ?? "").toMatch(/workspace slug/i);
      // And nothing left the client.
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a malformed slug is refused client-side and the submit button is shut", async () => {
    transport();
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await fillValid({ slug: "Acme Newsletter!" });

      // The page's own affordance: the button closes while the slug is bad.
      const submit = container.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      );
      expect(submit?.disabled).toBe(true);

      // And the handler refuses independently of the button, so a keyboard
      // submit cannot slip past. (Clicking the disabled button would prove
      // nothing: React skips onClick on a disabled control.)
      await submitForm(container.querySelector("form"));
      expect(
        container.querySelector('[role="alert"]')?.textContent ?? "",
      ).toMatch(/a-z, 0-9, hyphen/i);
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a too-short password is refused client-side and named", async () => {
    transport();
    const { MIN_PASSWORD_LENGTH } = await import("@/lib/password-strength");
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await fillValid({ password: "ab1", slug: "acme" });

      await submitForm(container.querySelector("form"));

      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent ?? "").toMatch(/password must be at least/i);
      expect(alert?.textContent ?? "").toContain(String(MIN_PASSWORD_LENGTH));
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a valid submission issues exactly one POST carrying the typed values", async () => {
    transport();
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await fillValid({ slug: "acme-news" });

      await submitForm(container.querySelector("form"));

      const posts = writesTo("/api/v1/auth/signup");
      expect(posts.length).toBe(1);
      expect(posts[0].method).toBe("POST");
      expect(posts[0].body).toEqual({
        email: "qa@postwave.test",
        password: "correct-horse-battery",
        workspace_name: "Acme Newsletter",
        workspace_slug: "acme-news",
      });
    } finally {
      unmount(root);
    }
  });

  it("a 409 on the slug is surfaced and keeps every other typed value", async () => {
    transport((req) =>
      req.path === "/api/v1/auth/signup"
        ? {
            status: 409,
            body: { error: { code: "conflict", message: "taken" } },
          }
        : undefined,
    );
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await fillValid({ slug: "acme-news" });
      await submitForm(container.querySelector("form"));

      expect(writesTo("/api/v1/auth/signup").length).toBe(1);
      expect(
        container.querySelector('[role="alert"]')?.textContent ?? "",
      ).toMatch(/slug is taken/i);

      // THE POINT OF THIS TEST. The password especially: retyping a
      // passphrase after a slug collision is the moment people abandon.
      expect(field("email").value).toBe("qa@postwave.test");
      expect(field("password").value).toBe("correct-horse-battery");
      expect(field("workspace-name").value).toBe("Acme Newsletter");
      expect(field("workspace-slug").value).toBe("acme-news");

      // And the form is usable again rather than stuck mid-submit.
      expect(
        container.querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.disabled,
      ).toBe(false);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 2. /app/forms/new — src/app/(dashboard)/app/forms/new/page.tsx
 *
 * Creates the public capture form a whole audience arrives through. Two
 * client-side validators worth having: a slug charset, and a success-redirect
 * allowlist that is a genuine open-redirect control, not cosmetics.
 * ================================================================== */

describe("/app/forms/new — creating a capture form", () => {
  const loadPage = async () =>
    (await import("@/app/(dashboard)/app/forms/new/page")).default;

  it("an empty name shuts the submit button", async () => {
    transport((req) =>
      req.path === "/api/v1/forms" ? { body: [] } : undefined,
    );
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      expect(button(container, "Create")?.disabled).toBe(true);
      await typeInto(field("form-name"), "Newsletter signup", "name");
      expect(button(container, "Create")?.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("enforces the API name bound and focuses the named field", async () => {
    transport((req) =>
      req.path === "/api/v1/forms" && req.method === "GET"
        ? { body: [] }
        : undefined,
    );
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const name = field("form-name");
      expect(name.maxLength).toBe(200);
      await typeInto(name, "x".repeat(201), "name");

      await submitForm(container.querySelector("form"));

      expect(container.querySelector("#form-name-error")?.textContent).toMatch(
        /200 characters or fewer/i,
      );
      expect(document.activeElement).toBe(name);
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("does not replace a deliberately cleared slug with a generated value", async () => {
    transport((req) =>
      req.path === "/api/v1/forms" && req.method === "GET"
        ? { body: [] }
        : undefined,
    );
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(field("form-name"), "Launch newsletter", "name");
      await typeInto(field("form-slug"), "", "slug");

      expect(container.textContent).toContain("/forms/your-slug");
      expect(container.textContent).not.toContain("/forms/launch-newsletter");

      await submitForm(container.querySelector("form"));

      expect(container.querySelector("#form-slug-error")?.textContent).toMatch(
        /slug is required/i,
      );
      expect(document.activeElement).toBe(field("form-slug"));
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a slug with illegal characters is named and blocks the write", async () => {
    transport((req) =>
      req.path === "/api/v1/forms" ? { body: [] } : undefined,
    );
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(field("form-name"), "Newsletter signup", "name");
      await typeInto(field("form-slug"), "news letter!", "slug");

      await submitForm(container.querySelector("form"));

      const err = container.querySelector("#form-slug-error");
      expect(err?.textContent ?? "").toMatch(/letters, numbers/i);
      expect(field("form-slug").getAttribute("aria-invalid")).toBe("true");
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("restores focus to the first invalid field when blur errors already exist", async () => {
    transport((req) =>
      req.path === "/api/v1/forms" && req.method === "GET"
        ? { body: [{ id: "existing", slug: "taken-slug" }] }
        : undefined,
    );
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(field("form-name"), "Launch newsletter", "name");
      await typeInto(field("form-slug"), "taken-slug", "slug");
      await typeInto(
        field("form-redirect"),
        "http://unsafe.example.test/thanks",
        "redirect",
      );

      await submitForm(container.querySelector("form"));
      expect(container.querySelector("#form-slug-error")?.textContent).toMatch(
        /already taken/i,
      );
      expect(container.querySelector("#form-redirect-error")).not.toBeNull();

      // Reproduce a pointer submit after both fields already own blur errors.
      // The submit control may receive native focus first; the post-commit
      // validation handoff must still land on the earliest invalid field.
      await act(async () => {
        button(container, "Create")?.focus();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await submitForm(container.querySelector("form"));

      expect(document.activeElement).toBe(field("form-slug"));
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("an off-allowlist redirect URL is named and blocks the write", async () => {
    transport((req) =>
      req.path === "/api/v1/forms" ? { body: [] } : undefined,
    );
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(field("form-name"), "Newsletter signup", "name");
      // Plain http on a public host: the exact open-redirect shape the
      // allowlist exists to refuse.
      await typeInto(
        field("form-redirect"),
        "http://evil.example.com/x",
        "redirect",
      );

      await submitForm(container.querySelector("form"));

      const err = container.querySelector("#form-redirect-error");
      expect(err?.textContent ?? "").toMatch(/https/i);
      expect(field("form-redirect").getAttribute("aria-invalid")).toBe("true");
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a valid submission POSTs the typed name, slug and redirect", async () => {
    transport((req) => {
      if (req.path === "/api/v1/forms" && req.method === "GET")
        return { body: [] };
      if (req.path === "/api/v1/forms")
        return { body: { id: "f_1", slug: "vip" } };
      return undefined;
    });
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(field("form-name"), "VIP list", "name");
      await typeInto(field("form-slug"), "vip", "slug");
      await typeInto(
        field("form-redirect"),
        "https://acme.test/thanks",
        "redirect",
      );

      await submitForm(container.querySelector("form"));

      const posts = writesTo("/api/v1/forms");
      expect(posts.length).toBe(1);
      const body = posts[0].body as Record<string, unknown>;
      expect(body.name).toBe("VIP list");
      expect(body.slug).toBe("vip");
      expect(body.successRedirectUrl).toBe("https://acme.test/thanks");
      expect(body.optInMode).toBe("double");
    } finally {
      unmount(root);
    }
  });

  it("the Blank starter performs one create and no dependent structure write", async () => {
    transport((req) => {
      if (req.path === "/api/v1/forms" && req.method === "GET") {
        return { body: [] };
      }
      if (req.path === "/api/v1/forms" && req.method === "POST") {
        return {
          status: 201,
          body: {
            id: "f_blank",
            name: "Blank capture",
            slug: "blank-capture",
          },
        };
      }
      return undefined;
    });
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const blank = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim().startsWith("Blank"),
      );
      await click(blank, "Blank starter");
      expect(blank?.getAttribute("aria-pressed")).toBe("true");
      await typeInto(field("form-name"), "Blank capture", "name");

      await submitForm(container.querySelector("form"));

      expect(writes()).toEqual(["POST /api/v1/forms"]);
      expect(writesTo("/api/v1/forms")).toHaveLength(1);
      expect(writes().some((write) => write.startsWith("PATCH "))).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("the Waitlist starter preserves its single-opt-in payload and exact structure", async () => {
    const created = {
      id: "f_waitlist",
      name: "Product waitlist",
      slug: "product-waitlist",
    };
    transport((req) => {
      if (req.path === "/api/v1/forms" && req.method === "GET") {
        return { body: [] };
      }
      if (req.path === "/api/v1/forms" && req.method === "POST") {
        return { status: 201, body: created };
      }
      if (req.path === "/api/v1/forms/f_waitlist" && req.method === "PATCH") {
        return { body: created };
      }
      return undefined;
    });
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const waitlist = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim().startsWith("Waitlist"),
      );
      await click(waitlist, "Waitlist starter");
      expect(waitlist?.getAttribute("aria-pressed")).toBe("true");
      await typeInto(field("form-name"), "Product waitlist", "name");

      await submitForm(container.querySelector("form"));

      expect(writes()).toEqual([
        "POST /api/v1/forms",
        "PATCH /api/v1/forms/f_waitlist",
      ]);
      expect(writesTo("/api/v1/forms")[0]?.body).toMatchObject({
        name: "Product waitlist",
        optInMode: "single",
        slug: "product-waitlist",
      });
      expect(writesTo("/api/v1/forms/f_waitlist")[0]?.body).toEqual({
        structure: FORM_TEMPLATES.find((template) => template.id === "waitlist")
          ?.structure,
      });
    } finally {
      unmount(root);
    }
  });

  it("a 400 on create is surfaced and keeps everything typed", async () => {
    transport((req) => {
      if (req.path === "/api/v1/forms" && req.method === "GET")
        return { body: [] };
      if (req.path === "/api/v1/forms") {
        return {
          status: 400,
          body: {
            error: { code: "bad_request", message: "slug already exists" },
          },
        };
      }
      return undefined;
    });
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(field("form-name"), "VIP list", "name");
      await typeInto(field("form-slug"), "vip", "slug");
      await typeInto(
        field("form-success"),
        "Welcome aboard.",
        "success message",
      );

      await submitForm(container.querySelector("form"));

      expect(writesTo("/api/v1/forms").length).toBe(1);
      expect(container.textContent ?? "").toMatch(/slug already exists/i);

      expect(field("form-name").value).toBe("VIP list");
      expect(field("form-slug").value).toBe("vip");
      expect(field("form-success").value).toBe("Welcome aboard.");
      // Re-submittable, not wedged in "Creating…".
      expect(button(container, "Create")?.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("fails clearly offline instead of queueing half of a two-write creation", async () => {
    const onlineDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "onLine",
    );
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    setOfflineStorageIdentity("forms-new-user", "forms-new-tenant");
    transport();
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(field("form-name"), "Offline launch", "name");

      await submitForm(container.querySelector("form"));

      expect(writes()).toEqual([]);
      expect(readOfflineQueue()).toEqual([]);
      const alert = container.querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.textContent).toMatch(/nothing was queued/i);
      expect(document.activeElement).toBe(alert);
      expect(button(container, "Create")?.disabled).toBe(false);
    } finally {
      unmount(root);
      resetOfflineStorageIdentity();
      if (onlineDescriptor) {
        Object.defineProperty(window.navigator, "onLine", onlineDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "onLine");
      }
    }
  });

  it("recovers with PATCH only when connectivity drops after create", async () => {
    const onlineDescriptor = Object.getOwnPropertyDescriptor(
      window.navigator,
      "onLine",
    );
    let online = true;
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => online,
    });
    setOfflineStorageIdentity("forms-new-user", "forms-new-tenant");
    const created = {
      id: "f_connection_drop",
      name: "Connection drop",
      slug: "connection-drop",
    };
    transport((req) => {
      if (req.path === "/api/v1/forms" && req.method === "GET") {
        return { body: [] };
      }
      if (req.path === "/api/v1/forms" && req.method === "POST") {
        online = false;
        return { status: 201, body: created };
      }
      if (
        req.path === "/api/v1/forms/f_connection_drop" &&
        req.method === "PATCH"
      ) {
        return { body: created };
      }
      return undefined;
    });
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(field("form-name"), "Connection drop", "name");

      await submitForm(container.querySelector("form"));

      expect(writesTo("/api/v1/forms")).toHaveLength(1);
      expect(writesTo("/api/v1/forms/f_connection_drop")).toHaveLength(0);
      expect(readOfflineQueue()).toEqual([]);
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
        /starter could not be applied/i,
      );

      online = true;
      await click(button(container, "Retry starter"), "retry starter");

      expect(writesTo("/api/v1/forms")).toHaveLength(1);
      expect(writesTo("/api/v1/forms/f_connection_drop")).toHaveLength(1);
      expect(readOfflineQueue()).toEqual([]);
    } finally {
      unmount(root);
      resetOfflineStorageIdentity();
      if (onlineDescriptor) {
        Object.defineProperty(window.navigator, "onLine", onlineDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "onLine");
      }
    }
  });

  it("dedupes a pending create and retries only the starter after PATCH failure", async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let patchAttempts = 0;
    const created = {
      id: "f_pending",
      name: "Launch newsletter",
      slug: "launch-newsletter",
    };
    transport(async (req) => {
      if (req.path === "/api/v1/forms" && req.method === "GET") {
        return { body: [] };
      }
      if (req.path === "/api/v1/forms" && req.method === "POST") {
        await createGate;
        return { status: 201, body: created };
      }
      if (req.path === "/api/v1/forms/f_pending" && req.method === "PATCH") {
        patchAttempts += 1;
        return patchAttempts === 1
          ? {
              status: 409,
              body: {
                error: {
                  code: "starter_conflict",
                  message: "Starter application was temporarily blocked.",
                },
              },
            }
          : { body: created };
      }
      return undefined;
    });
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      await typeInto(field("form-name"), "Launch newsletter", "name");
      const form = container.querySelector("form");
      if (!form) throw new Error("new-form form is not rendered");

      await act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(writesTo("/api/v1/forms")).toHaveLength(1);
      expect(form.getAttribute("aria-busy")).toBe("true");
      expect(field("form-name").disabled).toBe(true);
      expect(button(container, "Cancel")?.disabled).toBe(true);

      await act(async () => {
        releaseCreate();
        await new Promise((resolve) => setTimeout(resolve, 60));
      });

      const alert = container.querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.textContent).toMatch(/starter could not be applied/i);
      expect(document.activeElement).toBe(alert);
      expect(writesTo("/api/v1/forms")).toHaveLength(1);
      expect(writesTo("/api/v1/forms/f_pending")).toHaveLength(1);
      expect(field("form-name").disabled).toBe(true);
      expect(button(container, "Retry starter")?.disabled).toBe(false);
      expect(button(container, "Open saved form")?.disabled).toBe(false);

      await click(button(container, "Retry starter"), "retry starter");

      expect(writesTo("/api/v1/forms")).toHaveLength(1);
      expect(writesTo("/api/v1/forms/f_pending")).toHaveLength(2);
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 3. /app/settings/webhooks — the Add-webhook dialog
 *
 * Sends workspace events to a third party. Two gates a user cannot be
 * allowed past: the endpoint must be HTTPS (a plaintext URL leaks
 * subscriber PII off the wire), and at least one event must be chosen
 * (a webhook with none is a silent no-op the operator will trust).
 * ================================================================== */

describe("/app/settings/webhooks — adding an endpoint", () => {
  const loadPage = async () =>
    (await import("@/app/(dashboard)/app/settings/webhooks/page")).default;

  async function openCreate(container: HTMLElement) {
    await click(button(container, "Add webhook"), "Add webhook");
    return openDialog();
  }

  /** The checkbox for one specific event, found by its mono-spaced label. */
  function eventCheckbox(dialog: HTMLElement, event: string): HTMLInputElement {
    const label = [...dialog.querySelectorAll("label")].find((l) =>
      [...l.querySelectorAll("span")].some((s) => s.textContent === event),
    );
    const box = label?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!box) throw new Error(`no checkbox for event ${event}`);
    return box;
  }

  it("a plaintext URL is refused and nothing is written", async () => {
    transport((req) =>
      req.path === "/api/v1/webhooks" && req.method === "GET"
        ? { body: [] }
        : undefined,
    );
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const dialog = await openCreate(container);
      await typeInto(field("wh-url"), "http://hooks.example.com/in", "url");
      await click(eventCheckbox(dialog, "subscriber.created"), "event");

      await click(button(dialog, "Create"), "Create");

      expect(toastsAt("error")).toContain("URL must use HTTPS.");
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("choosing no events is refused and nothing is written", async () => {
    transport((req) =>
      req.path === "/api/v1/webhooks" && req.method === "GET"
        ? { body: [] }
        : undefined,
    );
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const dialog = await openCreate(container);
      await typeInto(field("wh-url"), "https://hooks.example.com/in", "url");

      await click(button(dialog, "Create"), "Create");

      expect(toastsAt("error")).toContain("Pick at least one event.");
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a valid submission POSTs the typed URL and the chosen events only", async () => {
    transport((req) => {
      if (req.path === "/api/v1/webhooks" && req.method === "GET")
        return { body: [] };
      if (req.path === "/api/v1/webhooks") {
        return {
          body: {
            webhook: {
              id: "wh_1",
              tenantId: "t_test",
              url: "https://hooks.example.com/in",
              events: ["subscriber.created"],
              status: "active",
            },
            secret: "whsec_test",
          },
        };
      }
      return undefined;
    });
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const dialog = await openCreate(container);
      await typeInto(
        field("wh-url"),
        "  https://hooks.example.com/in  ",
        "url",
      );
      await click(eventCheckbox(dialog, "subscriber.created"), "created");
      await click(eventCheckbox(dialog, "campaign.sent"), "sent");

      await click(button(dialog, "Create"), "Create");

      const posts = writesTo("/api/v1/webhooks");
      expect(posts.length).toBe(1);
      expect(posts[0].body).toEqual({
        url: "https://hooks.example.com/in",
        events: ["subscriber.created", "campaign.sent"],
      });
    } finally {
      unmount(root);
    }
  });

  it("a 400 on create is surfaced and keeps the URL and the chosen events", async () => {
    transport((req) => {
      if (req.path === "/api/v1/webhooks" && req.method === "GET")
        return { body: [] };
      if (req.path === "/api/v1/webhooks") {
        return {
          status: 400,
          body: {
            error: { code: "bad_request", message: "endpoint unreachable" },
          },
        };
      }
      return undefined;
    });
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const dialog = await openCreate(container);
      await typeInto(field("wh-url"), "https://hooks.example.com/in", "url");
      await click(eventCheckbox(dialog, "subscriber.created"), "created");

      await click(button(dialog, "Create"), "Create");

      expect(writesTo("/api/v1/webhooks").length).toBe(1);
      expect(toastsAt("error").join(" ")).toMatch(
        /endpoint unreachable|create webhook/i,
      );

      // Twenty-one checkboxes: re-picking them after a failed save is the
      // thing worth protecting, more than the URL.
      const stillOpen = openDialog();
      expect(field("wh-url").value).toBe("https://hooks.example.com/in");
      expect(eventCheckbox(stillOpen, "subscriber.created").checked).toBe(true);
      expect(stillOpen.textContent ?? "").toContain("1 selected");
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 4. /app/campaigns — the New-campaign dialog
 *
 * The most-used create in the product. It is also the one place where the
 * page clears the draft BEFORE the request resolves, so "what happens to
 * the typing on a failure" has a real answer to find rather than an
 * assumed one.
 *
 * WHAT THAT ANSWER TURNED OUT TO BE — a partial defect, recorded here rather
 * than pinned as expected behaviour. page.tsx:337 runs
 * `setDraft({ name: "", subject: "" }); setOpen(false);` BEFORE awaiting the
 * create, so on a 400:
 *
 *   - reopening the New-campaign dialog shows two EMPTY fields (measured:
 *     name "", subject "");
 *   - the failed row renders the name and a retry link, but NOT the subject
 *     (campaigns-table.tsx:190 gives the subject cell over to the link), so
 *     the subject the user typed is on screen nowhere;
 *   - "Sync failed - Retry" replays the identical payload with no chance to
 *     edit it, so a 400 caused BY the input — a subject the server rejects —
 *     can never succeed, and the text that caused it is no longer visible to
 *     fix.
 *
 * The last test below therefore asserts what genuinely holds today: the
 * values survive in the mutation cache and the retry resends BOTH of them.
 * If the draft is ever kept until the request resolves, that test still
 * passes, and this note is what says the gap was known.
 * ================================================================== */

describe("/app/campaigns — creating a campaign", () => {
  const loadPage = async () => {
    // The production submit path lazy-loads its fail-closed link validator.
    // Warm that module so this transport-level suite measures the mutation
    // lifecycle instead of leaking a cold import past its fixed click flush.
    // Mount the concrete client because happy-dom does not reliably hydrate
    // the route's `next/dynamic({ ssr: false })` wrapper on a cold first test.
    await import("@/lib/campaign-block-renderer");
    return (await import("@/app/(dashboard)/app/campaigns/campaigns-client"))
      .CampaignsClient;
  };

  async function openCreate(container: HTMLElement) {
    await click(button(container, "New campaign"), "New campaign");
    return openDialog();
  }

  /**
   * The list endpoint answers an ARRAY, so it must answer one here.
   * The default `{}` is a shape the server never sends, and the page's
   * `campaigns.filter` would blow up on it — a harness artefact, not a page
   * defect, and chasing it would harden code against an unreachable state.
   */
  function campaignTransport(onCreate: () => Reply) {
    transport((req) => {
      if (req.path === "/api/v1/campaigns" && req.method === "GET") {
        return { body: [] };
      }
      if (req.path === "/api/v1/campaigns" && req.method === "POST") {
        return onCreate();
      }
      return undefined;
    });
  }

  it("empty name and subject block the write and both are named inline", async () => {
    campaignTransport(() => ({}));
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const dialog = await openCreate(container);
      await click(button(dialog, "Create"), "Create");

      const text = openDialog().textContent ?? "";
      expect(text).toContain("Name is required.");
      expect(text).toContain("Subject is required.");
      expect(writesTo("/api/v1/campaigns")).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a name of only whitespace is still refused", async () => {
    campaignTransport(() => ({}));
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const dialog = await openCreate(container);
      await typeInto(field("campaign-name"), "   ", "name");
      await typeInto(field("campaign-subject"), "Spring sale", "subject");

      await click(button(dialog, "Create"), "Create");

      expect(openDialog().textContent ?? "").toContain("Name is required.");
      expect(writesTo("/api/v1/campaigns")).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a valid submission POSTs the typed name and subject once", async () => {
    campaignTransport(() => ({
      body: { id: "c_1", name: "Spring", subject: "Spring sale" },
    }));
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const dialog = await openCreate(container);
      await typeInto(field("campaign-name"), "  Spring  ", "name");
      await typeInto(field("campaign-subject"), "Spring sale", "subject");

      await click(button(dialog, "Create"), "Create");

      const posts = writesTo("/api/v1/campaigns");
      expect(posts.length).toBe(1);
      const body = posts[0].body as Record<string, unknown>;
      expect(body.name).toBe("Spring");
      expect(body.subject).toBe("Spring sale");
    } finally {
      unmount(root);
    }
  });

  it("a failed create keeps the typed values recoverable and retry resends them", async () => {
    campaignTransport(() => ({
      status: 400,
      body: { error: { code: "bad_request", message: "campaign rejected" } },
    }));
    const Page = await loadPage();
    const { container, root } = await renderPage(Page);
    try {
      const dialog = await openCreate(container);
      await typeInto(field("campaign-name"), "Spring", "name");
      await typeInto(field("campaign-subject"), "Spring sale", "subject");
      await click(button(dialog, "Create"), "Create");

      expect(writesTo("/api/v1/campaigns").length).toBe(1);
      expect(toastsAt("error").join(" ")).toMatch(
        /campaign rejected|create campaign/i,
      );

      // The dialog closes and the draft is cleared before the request
      // resolves, so the ONLY thing standing between the user and retyping
      // is this row. It has to name the campaign and offer the retry.
      const failedRow = container.querySelector(
        '[aria-label="Failed to create Spring"]',
      );
      expect(failedRow).not.toBeNull();
      expect(failedRow?.textContent ?? "").toContain("Spring");

      // And the retry must carry the SUBJECT too — the field the failed row
      // never renders, and therefore the one a regression would silently drop.
      await click(
        failedRow?.querySelector("button.pw-retry-link"),
        "Sync failed - Retry",
      );
      const posts = writesTo("/api/v1/campaigns");
      expect(posts.length).toBe(2);
      const retried = posts[1].body as Record<string, unknown>;
      expect(retried.name).toBe("Spring");
      expect(retried.subject).toBe("Spring sale");
    } finally {
      unmount(root);
    }
  });
});

/* ================================================================== *
 * 5. Sending limits — settings/sender/sending-limits-card.tsx
 *
 * The one form in the app where a typo is a throughput decision: the hourly
 * cap throttles every campaign the workspace sends. It is a free-text number
 * field saved through a FULL-REPLACE PUT, so invalid and stale values must be
 * stopped before they become the whole settings row. Send-time optimization
 * remains owned by its separate settings surface and must be omitted here.
 *
 * Rendered as the component it is, with the props the page passes it. That is
 * the real code path; wrapping it in the settings page as well would add a
 * dozen unrelated queries without adding a single assertion.
 * ================================================================== */

describe("settings/sender — the sending-limits form", () => {
  const loadCard = async () =>
    (await import("@/app/(dashboard)/app/settings/sender/sending-limits-card"))
      .SendingLimitsCard;

  const REVISION = "2026-08-30T08:00:00Z";
  const TENANT = WHOAMI.tenant_id;
  const PROPS = {
    readiness: null,
    settings: {
      tenant_id: TENANT,
      max_sends_per_hour: null,
      quiet_hours_per_recipient: true,
      updated_at: REVISION,
    },
    canWrite: true,
    onSaved: () => undefined,
    identity: WHOAMI,
    authorityKey: `${WHOAMI.tenant_id}:${WHOAMI.user_id}:owner:member`,
    beginSharedMutation: () => true,
    endSharedMutation: () => undefined,
  };
  const SAVE = "Save sending limits";
  const SETTINGS = "/api/v1/settings/sending";

  const savedBody = {
    tenant_id: TENANT,
    max_sends_per_hour: 250,
    quiet_hours_start: "",
    quiet_hours_end: "",
    quiet_hours_tz: "",
    quiet_hours_per_recipient: true,
    fallback_hour_utc: 9,
    updated_at: "2026-08-30T08:00:00.000000001Z",
  };

  it.each([
    ["an over-limit cap", { ...savedBody, max_sends_per_hour: 1_000_001 }],
    ["a coerced cap", { ...savedBody, max_sends_per_hour: "250" }],
    ["partial quiet hours", { ...savedBody, quiet_hours_start: "22:00" }],
    [
      "an unknown timezone",
      {
        ...savedBody,
        quiet_hours_start: "22:00",
        quiet_hours_end: "07:00",
        quiet_hours_tz: "Mars/Olympus",
      },
    ],
    [
      "equal quiet times",
      {
        ...savedBody,
        quiet_hours_start: "22:00",
        quiet_hours_end: "22:00",
        quiet_hours_tz: "UTC",
      },
    ],
    [
      "a missing recipient mode",
      { ...savedBody, quiet_hours_per_recipient: undefined },
    ],
    ["a malformed revision", { ...savedBody, updated_at: "yesterday" }],
    ["a non-UUID tenant", { ...savedBody, tenant_id: "tenant-1" }],
    ["a non-UUID updater", { ...savedBody, updated_by_user_id: "user-1" }],
    ["an unknown top-level member", { ...savedBody, route_proven: true }],
    [
      "an unknown pool member",
      {
        ...savedBody,
        ip_pool: { name: "shared", dedicated: false, route_proven: true },
      },
    ],
    [
      "a zero row carrying a fallback",
      {
        tenant_id: TENANT,
        quiet_hours_per_recipient: true,
        updated_at: "0001-01-01T00:00:00Z",
        fallback_hour_utc: 9,
      },
    ],
    [
      "a zero row carrying an updater",
      {
        tenant_id: TENANT,
        quiet_hours_per_recipient: true,
        updated_at: "0001-01-01T00:00:00Z",
        updated_by_user_id: WHOAMI.user_id,
      },
    ],
    [
      "a malformed pool",
      { ...savedBody, ip_pool: { name: "", dedicated: true } },
    ],
  ] as const)(
    "rejects a normal settings read with %s before it can seed the form",
    async (_name, value) => {
      transport((req) =>
        req.method === "GET" && req.path === SETTINGS
          ? { body: value }
          : undefined,
      );
      const { sendingSettingsApi } = await import("@/lib/sending-settings-api");

      await expect(sendingSettingsApi.get()).rejects.toThrow(
        /invalid sending-settings response/i,
      );
      expect(calls).toHaveLength(1);
    },
  );

  it("a negative hourly cap is marked on the field and shuts the save", async () => {
    transport();
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "-5", "hourly cap");

      expect(field("cap").getAttribute("aria-invalid")).toBe("true");
      expect(button(container, SAVE)?.disabled).toBe(true);
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a fractional hourly cap is refused too", async () => {
    transport();
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "12.5", "hourly cap");

      expect(field("cap").getAttribute("aria-invalid")).toBe("true");
      expect(button(container, SAVE)?.disabled).toBe(true);
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("refuses an hourly cap above the API maximum", async () => {
    transport();
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "1000001", "hourly cap");

      expect(field("cap").getAttribute("max")).toBe("1000000");
      expect(field("cap").getAttribute("aria-invalid")).toBe("true");
      expect(container.textContent).toContain("1 to 1,000,000");
      expect(button(container, SAVE)?.disabled).toBe(true);
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("keeps send-time optimization separate from the limits editor", async () => {
    transport();
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      expect(container.querySelector("#fallback-hour")).toBeNull();
      expect(
        container.querySelector('a[href="/app/settings/send-time"]')
          ?.textContent,
      ).toMatch(/open send-time settings/i);
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a valid save issues exactly one PUT and omits the separate timing policy", async () => {
    transport((req) =>
      req.path === SETTINGS
        ? {
            body: savedBody,
            headers: { "x-postwave-sending-cap-outcome": "committed" },
          }
        : undefined,
    );
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "250", "hourly cap");

      expect(button(container, SAVE)?.disabled).toBe(false);
      await click(button(container, SAVE), SAVE);

      const puts = writesTo(SETTINGS);
      expect(puts.length).toBe(1);
      expect(puts[0].method).toBe("PUT");
      expect(headerValue(puts[0], "Idempotency-Key")).toBeNull();
      expect(puts[0].redirect).toBe("error");
      // Numbers, not the strings the inputs hold: the API rejects "250".
      expect(puts[0].body).toEqual({
        max_sends_per_hour: 250,
        quiet_hours_start: "",
        quiet_hours_end: "",
        quiet_hours_tz: "",
        quiet_hours_per_recipient: true,
        expected_updated_at: REVISION,
      });
      expect(puts[0].body).not.toHaveProperty("fallback_hour_utc");
    } finally {
      unmount(root);
    }
  });

  it("does not replay the one-attempt PUT after a successful step-up proof", async () => {
    let prompts = 0;
    const prompt = (event: Event) => {
      const detail = (event as CustomEvent<StepUpPromptDetail>).detail;
      if (!detail.claim()) return;
      prompts += 1;
      detail.settle(true);
    };
    window.addEventListener(STEP_UP_PROMPT_EVENT, prompt);
    transport((req) =>
      req.method === "PUT" && req.path === SETTINGS
        ? {
            status: 401,
            body: {
              error: {
                code: "step_up_required",
                action: "sending.settings.update",
                message:
                  "Confirm your identity before changing sending limits.",
              },
            },
            headers: {
              "x-postwave-step-up": "sending.settings.update",
            },
          }
        : undefined,
    );
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(prompts).toBe(1);
      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(headerValue(writesTo(SETTINGS)[0], "Idempotency-Key")).toBeNull();
      expect(writesTo(SETTINGS)[0].redirect).toBe("error");
      expect(toastsAt("success")).toEqual([]);
      expect(field("cap").value).toBe("250");
    } finally {
      window.removeEventListener(STEP_UP_PROMPT_EVENT, prompt);
      unmount(root);
    }
  });

  for (const [name, response] of [
    [
      "a mismatched committed projection",
      { ...savedBody, max_sends_per_hour: 999 },
    ],
    [
      "a committed projection without a durable revision",
      { ...savedBody, updated_at: "0001-01-01T00:00:00Z" },
    ],
    [
      "a committed projection with an impossible calendar revision",
      { ...savedBody, updated_at: "2026-02-30T08:01:00Z" },
    ],
    [
      "a committed projection whose revision did not advance",
      { ...savedBody, updated_at: REVISION },
    ],
    [
      "a stale committed projection",
      { ...savedBody, updated_at: "2026-08-30T07:59:59.999999999Z" },
    ],
    [
      "an equal-instant committed projection in another offset",
      { ...savedBody, updated_at: "2026-08-30T09:00:00+01:00" },
    ],
  ] as const) {
    it(`reconciles ${name} instead of reporting success`, async () => {
      transport((req) => {
        if (req.method === "PUT" && req.path === SETTINGS) {
          return {
            body: response,
            headers: { "x-postwave-sending-cap-outcome": "committed" },
          };
        }
        if (req.method === "GET" && req.path === SETTINGS) {
          return { body: PROPS.settings };
        }
        if (
          req.method === "GET" &&
          req.path === "/api/v1/settings/sending/status"
        ) {
          return { body: {} };
        }
        return undefined;
      });
      const Card = await loadCard();
      const { container, root } = await renderPage(Card, PROPS);
      try {
        await typeInto(field("cap"), "250", "hourly cap");
        await click(button(container, SAVE), SAVE);

        expect(writesTo(SETTINGS)).toHaveLength(1);
        expect(toastsAt("success")).toEqual([]);
        expect(field("cap").value).toBe("250");
        expect(container.textContent).toMatch(
          /mutation window has not been proven quiescent|editing remains held/i,
        );
        expect(field("cap").disabled).toBe(true);
      } finally {
        unmount(root);
      }
    });
  }

  it("preserves a workspace-timezone policy during an unrelated cap edit", async () => {
    const saved = {
      ...savedBody,
      quiet_hours_per_recipient: false,
    };
    transport((req) =>
      req.method === "PUT" && req.path === SETTINGS
        ? {
            body: saved,
            headers: { "x-postwave-sending-cap-outcome": "committed" },
          }
        : undefined,
    );
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, {
      ...PROPS,
      settings: {
        ...PROPS.settings,
        quiet_hours_per_recipient: false,
      },
    });
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(writesTo(SETTINGS)[0]?.body).toMatchObject({
        quiet_hours_per_recipient: false,
      });
    } finally {
      unmount(root);
    }
  });

  it("reconciles a committed 503 with reads and never sends a second PUT", async () => {
    transport((req) => {
      if (req.method === "PUT" && req.path === SETTINGS) {
        return {
          status: 503,
          body: {
            error: {
              code: "sending_cap_convergence_pending",
              message: "settings committed; convergence pending",
            },
          },
          headers: {
            "x-postwave-sending-cap-outcome": "committed-conservatively-fenced",
          },
        };
      }
      if (req.method === "GET" && req.path === SETTINGS) {
        return { body: savedBody };
      }
      if (
        req.method === "GET" &&
        req.path === "/api/v1/settings/sending/status"
      ) {
        return {
          body: {
            ...savedBody,
            cap_coordination_state: "ready",
            cap_coordination_ready: true,
            cap_coordination_cap: 250,
            cap_coordination_matches_settings: true,
          },
        };
      }
      return undefined;
    });
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(
        calls.filter((call) => call.method === "GET" && call.path === SETTINGS),
      ).toEqual([expect.objectContaining({ cache: "no-store" })]);
      expect(toastsAt("success").join(" ")).toMatch(/saved and verified/i);
      expect(field("cap").value).toBe("250");
    } finally {
      unmount(root);
    }
  });

  it("holds editing until an unknown outcome is reconciled, without replaying the PUT", async () => {
    let coordinationReady = false;
    transport((req) => {
      if (req.method === "PUT" && req.path === SETTINGS) {
        return {
          status: 503,
          body: {
            error: {
              code: "sending_cap_commit_outcome_unknown",
              message: "commit outcome unknown",
            },
          },
          headers: {
            "x-postwave-sending-cap-outcome":
              "commit-outcome-unknown-conservatively-fenced",
          },
        };
      }
      if (req.method === "GET" && req.path === SETTINGS) {
        return { body: savedBody };
      }
      if (
        req.method === "GET" &&
        req.path === "/api/v1/settings/sending/status"
      ) {
        return {
          body: {
            ...savedBody,
            cap_coordination_state: coordinationReady
              ? "ready"
              : "conservatively_fenced",
            cap_coordination_ready: coordinationReady,
            cap_coordination_cap: 250,
            cap_coordination_matches_settings: coordinationReady,
          },
        };
      }
      return undefined;
    });
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(button(container, "Refresh to reconcile")).not.toBeNull();
      expect(field("cap").disabled).toBe(true);

      coordinationReady = true;
      await click(
        button(container, "Refresh to reconcile"),
        "Refresh to reconcile",
      );

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(button(container, "Refresh to reconcile")).toBeUndefined();
      expect(toastsAt("success").join(" ")).toMatch(/saved and verified/i);
    } finally {
      unmount(root);
    }
  });

  it("does not accept a matching 200 body without the committed outcome header", async () => {
    transport((req) => {
      if (req.method === "PUT" && req.path === SETTINGS) {
        return { body: savedBody };
      }
      if (req.method === "GET" && req.path === SETTINGS) {
        return { body: PROPS.settings };
      }
      if (
        req.method === "GET" &&
        req.path === "/api/v1/settings/sending/status"
      ) {
        return { body: {} };
      }
      return undefined;
    });
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(toastsAt("success")).toEqual([]);
      expect(field("cap").value).toBe("250");
      expect(container.textContent).toMatch(
        /mutation window has not been proven quiescent|editing remains held/i,
      );
      expect(field("cap").disabled).toBe(true);
    } finally {
      unmount(root);
    }
  });

  it("holds the draft when ambiguous-outcome verification payloads are malformed", async () => {
    transport((req) => {
      if (req.method === "PUT" && req.path === SETTINGS) {
        return {
          status: 503,
          body: {
            error: {
              code: "sending_cap_commit_outcome_unknown",
              message: "commit outcome unknown",
            },
          },
          headers: {
            "x-postwave-sending-cap-outcome":
              "commit-outcome-unknown-conservatively-fenced",
          },
        };
      }
      if (req.method === "GET" && req.path === SETTINGS) {
        return { body: { tenant_id: TENANT } };
      }
      if (
        req.method === "GET" &&
        req.path === "/api/v1/settings/sending/status"
      ) {
        return { body: { tenant_id: TENANT } };
      }
      return undefined;
    });
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(button(container, "Refresh to reconcile")).not.toBeNull();
      expect(field("cap").disabled).toBe(true);
      expect(toastsAt("success")).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  for (const [name, statusOverrides] of [
    ["missing readiness", { cap_coordination_ready: undefined }],
    ["coerced readiness", { cap_coordination_ready: "true" }],
    ["missing match proof", { cap_coordination_matches_settings: undefined }],
    ["coerced matching cap", { cap_coordination_cap: "250" }],
    ["contradictory cap", { cap_coordination_cap: 251 }],
    [
      "active fence",
      { cap_coordination_fence_started_at: "2026-08-30T08:01:01Z" },
    ],
    ["malformed fence", { cap_coordination_fence_started_at: 1 }],
    ["malformed quiet-hours field", { quiet_hours_start: 2200 }],
  ] as const) {
    it(`does not accept a superficially ready status with ${name}`, async () => {
      transport((req) => {
        if (req.method === "PUT" && req.path === SETTINGS) {
          return {
            status: 503,
            body: { error: { code: "sending_cap_commit_outcome_unknown" } },
            headers: {
              "x-postwave-sending-cap-outcome":
                "commit-outcome-unknown-conservatively-fenced",
            },
          };
        }
        if (req.method === "GET" && req.path === SETTINGS) {
          return { body: savedBody };
        }
        if (
          req.method === "GET" &&
          req.path === "/api/v1/settings/sending/status"
        ) {
          return {
            body: {
              ...savedBody,
              cap_coordination_state: "ready",
              cap_coordination_ready: true,
              cap_coordination_cap: 250,
              cap_coordination_matches_settings: true,
              cap_coordination_fence_started_at: null,
              ...(statusOverrides as Record<string, unknown>),
            },
          };
        }
        return undefined;
      });
      const Card = await loadCard();
      const { container, root } = await renderPage(Card, PROPS);
      try {
        await typeInto(field("cap"), "250", "hourly cap");
        await click(button(container, SAVE), SAVE);

        expect(writesTo(SETTINGS)).toHaveLength(1);
        expect(button(container, "Refresh to reconcile")).not.toBeNull();
        expect(field("cap").disabled).toBe(true);
        expect(toastsAt("success")).toEqual([]);
      } finally {
        unmount(root);
      }
    });
  }

  it.each([
    ["missing", undefined],
    ["Go-zero", "0001-01-01T00:00:00Z"],
    ["impossible", "2026-02-30T08:01:00Z"],
    ["unchanged", REVISION],
    ["stale", "2026-08-30T07:59:59.999999999Z"],
    ["equal-instant alternate-offset", "2026-08-30T09:00:00+01:00"],
  ])(
    "does not promote matching reconciliation with a %s revision",
    async (_name, updatedAt) => {
      transport((req) => {
        if (req.method === "PUT" && req.path === SETTINGS) {
          return {
            status: 503,
            body: { error: { code: "sending_cap_commit_outcome_unknown" } },
            headers: {
              "x-postwave-sending-cap-outcome":
                "commit-outcome-unknown-conservatively-fenced",
            },
          };
        }
        if (req.method === "GET" && req.path === SETTINGS) {
          return { body: { ...savedBody, updated_at: updatedAt } };
        }
        if (
          req.method === "GET" &&
          req.path === "/api/v1/settings/sending/status"
        ) {
          return {
            body: {
              ...savedBody,
              cap_coordination_state: "ready",
              cap_coordination_ready: true,
              cap_coordination_cap: 250,
              cap_coordination_matches_settings: true,
            },
          };
        }
        return undefined;
      });
      const Card = await loadCard();
      const { container, root } = await renderPage(Card, PROPS);
      try {
        await typeInto(field("cap"), "250", "hourly cap");
        await click(button(container, SAVE), SAVE);

        expect(writesTo(SETTINGS)).toHaveLength(1);
        expect(button(container, "Refresh to reconcile")).not.toBeNull();
        expect(field("cap").disabled).toBe(true);
        expect(toastsAt("success")).toEqual([]);
      } finally {
        unmount(root);
      }
    },
  );

  it("releases an ambiguous first write only for the exact canonical no-row projection", async () => {
    let monotonicNow = 100;
    const clock = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => monotonicNow);
    const noRow = {
      tenant_id: TENANT,
      quiet_hours_per_recipient: true,
      updated_at: "0001-01-01T00:00:00Z",
    };
    transport((req) => {
      if (req.method === "PUT" && req.path === SETTINGS) {
        return {
          status: 503,
          body: { error: { code: "sending_cap_commit_outcome_unknown" } },
          headers: {
            "x-postwave-sending-cap-outcome":
              "commit-outcome-unknown-conservatively-fenced",
          },
        };
      }
      if (req.method === "GET" && req.path === SETTINGS) {
        return { body: noRow };
      }
      if (
        req.method === "GET" &&
        req.path === "/api/v1/settings/sending/status"
      ) {
        return {
          body: {
            tenant_id: TENANT,
            quiet_hours_per_recipient: true,
            cap_coordination_state: "ready",
            cap_coordination_ready: true,
            cap_coordination_matches_settings: true,
            cap_coordination_fence_started_at: null,
          },
        };
      }
      return undefined;
    });
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, {
      ...PROPS,
      settings: noRow,
    });
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(button(container, "Refresh to reconcile")).toBeDefined();
      expect(field("cap").disabled).toBe(true);

      monotonicNow += 35_001;
      await click(
        button(container, "Refresh to reconcile"),
        "Refresh to reconcile",
      );

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(button(container, "Refresh to reconcile")).toBeUndefined();
      expect(field("cap").disabled).toBe(false);
      expect(button(container, SAVE)?.disabled).toBe(false);
      expect(container.textContent).toMatch(/first write did not apply/i);
    } finally {
      clock.mockRestore();
      unmount(root);
    }
  });

  it("waits for causal quiescence before an unchanged baseline proves not applied", async () => {
    let monotonicNow = 500;
    const clock = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => monotonicNow);
    transport((req) => {
      if (req.method === "PUT" && req.path === SETTINGS) {
        return {
          status: 503,
          body: { error: { code: "sending_cap_commit_outcome_unknown" } },
          headers: {
            "x-postwave-sending-cap-outcome":
              "commit-outcome-unknown-conservatively-fenced",
          },
        };
      }
      if (req.method === "GET" && req.path === SETTINGS) {
        return { body: PROPS.settings };
      }
      if (
        req.method === "GET" &&
        req.path === "/api/v1/settings/sending/status"
      ) {
        return {
          body: {
            tenant_id: TENANT,
            quiet_hours_per_recipient: true,
            cap_coordination_state: "ready",
            cap_coordination_ready: true,
            cap_coordination_matches_settings: true,
            cap_coordination_fence_started_at: null,
          },
        };
      }
      return undefined;
    });
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(button(container, "Refresh to reconcile")).toBeDefined();
      expect(field("cap").disabled).toBe(true);

      monotonicNow += 35_001;
      await click(
        button(container, "Refresh to reconcile"),
        "Refresh to reconcile",
      );

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(button(container, "Refresh to reconcile")).toBeUndefined();
      expect(field("cap").disabled).toBe(false);
      expect(container.textContent).toMatch(/did not apply/i);
    } finally {
      clock.mockRestore();
      unmount(root);
    }
  });

  it("releases a rolled-back no-op after an unchanged revision is quiescent and ready", async () => {
    const clock = vi
      .spyOn(globalThis.performance, "now")
      .mockImplementation(() => 35_101);
    transport((req) => {
      if (req.method === "GET" && req.path === SETTINGS) {
        return { body: PROPS.settings };
      }
      if (
        req.method === "GET" &&
        req.path === "/api/v1/settings/sending/status"
      ) {
        return {
          body: {
            tenant_id: TENANT,
            quiet_hours_per_recipient: true,
            cap_coordination_state: "ready",
            cap_coordination_ready: true,
            cap_coordination_matches_settings: true,
            cap_coordination_fence_started_at: null,
          },
        };
      }
      return undefined;
    });
    const { reconcileSendingSettingsMutation } =
      await import("@/lib/sending-settings-api");

    try {
      await expect(
        reconcileSendingSettingsMutation(
          {
            max_sends_per_hour: null,
            quiet_hours_start: "",
            quiet_hours_end: "",
            quiet_hours_tz: "",
            quiet_hours_per_recipient: true,
            expected_updated_at: REVISION,
          },
          TENANT,
          undefined,
          100,
        ),
      ).resolves.toMatchObject({ kind: "not-applied" });
      expect(writesTo(SETTINGS)).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  for (const [name, projectionOverrides] of [
    ["missing revision", { updated_at: undefined }],
    ["null revision", { updated_at: null }],
    ["empty revision", { updated_at: "" }],
    ["zero-prefix revision", { updated_at: "0001-01-01T00:00:00Z-extra" }],
    ["explicit null cap", { max_sends_per_hour: null }],
    ["explicit empty quiet field", { quiet_hours_start: "" }],
    ["legacy fallback", { fallback_hour_utc: 9 }],
    ["updater identity", { updated_by_user_id: WHOAMI.user_id }],
  ] as const) {
    it(`keeps a first write held for a no-row projection with ${name}`, async () => {
      const initialNoRow = {
        tenant_id: TENANT,
        quiet_hours_per_recipient: true,
        updated_at: "0001-01-01T00:00:00Z",
      };
      transport((req) => {
        if (req.method === "PUT" && req.path === SETTINGS) {
          return {
            status: 503,
            body: { error: { code: "sending_cap_commit_outcome_unknown" } },
            headers: {
              "x-postwave-sending-cap-outcome":
                "commit-outcome-unknown-conservatively-fenced",
            },
          };
        }
        if (req.method === "GET" && req.path === SETTINGS) {
          return {
            body: { ...initialNoRow, ...projectionOverrides },
          };
        }
        return { body: {} };
      });
      const Card = await loadCard();
      const { container, root } = await renderPage(Card, {
        ...PROPS,
        settings: initialNoRow,
      });
      try {
        await typeInto(field("cap"), "250", "hourly cap");
        await click(button(container, SAVE), SAVE);

        expect(writesTo(SETTINGS)).toHaveLength(1);
        expect(button(container, "Refresh to reconcile")).not.toBeNull();
        expect(field("cap").disabled).toBe(true);
        expect(toastsAt("success")).toEqual([]);
      } finally {
        unmount(root);
      }
    });
  }

  it("fails closed when the exact loaded revision is unavailable", async () => {
    transport();
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, {
      ...PROPS,
      settings: { ...PROPS.settings, updated_at: undefined },
    });
    try {
      expect(container.textContent).toContain(
        "The exact sending-settings revision is unavailable",
      );
      expect(field("cap").disabled).toBe(true);
      expect(button(container, SAVE)?.disabled).toBe(true);
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("keeps a last-verified baseline visible but read-only after a stale refresh", async () => {
    transport();
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, {
      ...PROPS,
      settings: {
        ...PROPS.settings,
        max_sends_per_hour: 500,
        fallback_hour_utc: 9,
      },
      readOnly: true,
    });
    try {
      expect(field("cap").value).toBe("500");
      expect(field("cap").disabled).toBe(true);
      expect(container.querySelector("#fallback-hour")).toBeNull();
      expect(button(container, SAVE)?.disabled).toBe(true);
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("holds a dirty R1 draft when a background refresh brings R2", async () => {
    transport();
    const Card = await loadCard();
    type TestSettings = Omit<typeof PROPS.settings, "max_sends_per_hour"> & {
      max_sends_per_hour: number | null;
    };
    let publishRemote!: (next: TestSettings) => void;
    function Host() {
      const [current, setCurrent] = useState<TestSettings>(PROPS.settings);
      publishRemote = (next) => setCurrent(next);
      return <Card {...PROPS} settings={current} />;
    }
    const { container, root } = await renderPage(Host);
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await act(async () => {
        publishRemote({
          ...PROPS.settings,
          max_sends_per_hour: 600,
          updated_at: "2026-08-30T08:02:00Z",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(field("cap").value).toBe("250");
      expect(container.textContent).toMatch(
        /newer sending limits are available/i,
      );
      expect(button(container, SAVE)?.disabled).toBe(true);
      expect(writes()).toEqual([]);

      await click(
        button(container, "Discard draft and load current settings"),
        "Discard draft and load current settings",
      );
      expect(field("cap").value).toBe("600");
      expect(container.textContent).not.toMatch(
        /newer sending limits are available/i,
      );
      expect(writes()).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("a 400 on save surfaces the error and keeps the typed numbers", async () => {
    transport((req) =>
      req.path === SETTINGS
        ? {
            status: 400,
            body: { error: { code: "bad_request", message: "cap above plan" } },
            headers: {
              "x-postwave-sending-cap-outcome": "not-committed",
            },
          }
        : undefined,
    );
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(writesTo(SETTINGS).length).toBe(1);
      expect(toastsAt("error").join(" ")).toMatch(
        /cap above plan|save sending limits/i,
      );

      expect(field("cap").value).toBe("250");
      // Still dirty, so the operator can hit save again rather than being told
      // there is nothing to save.
      expect(button(container, SAVE)?.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("treats a direct redirect response as ambiguous and keeps the PUT to one attempt", async () => {
    transport((req) => {
      if (req.method === "PUT" && req.path === SETTINGS) {
        return {
          status: 307,
          body: { error: { code: "temporary_redirect" } },
          headers: { location: "https://api.example.test/replayed" },
        };
      }
      return {
        status: 400,
        body: { error: { code: "verification_unavailable" } },
      };
    });
    const Card = await loadCard();
    const { container, root } = await renderPage(Card, PROPS);
    try {
      await typeInto(field("cap"), "250", "hourly cap");
      await click(button(container, SAVE), SAVE);

      expect(writesTo(SETTINGS)).toHaveLength(1);
      expect(writesTo(SETTINGS)[0].redirect).toBe("error");
      expect(button(container, "Refresh to reconcile")).not.toBeNull();
      expect(field("cap").disabled).toBe(true);
      expect(toastsAt("success")).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  for (const [name, outcome] of [
    ["missing", undefined],
    ["malformed", "probably-not-committed"],
    ["contradictory committed", "committed"],
  ] as const) {
    it(`holds an HTTP 400 with a ${name} outcome until reconciliation`, async () => {
      transport((req) => {
        if (req.method === "PUT" && req.path === SETTINGS) {
          return {
            status: 400,
            body: { error: { code: "bad_request", message: "write refused" } },
            ...(outcome
              ? {
                  headers: {
                    "x-postwave-sending-cap-outcome": outcome,
                  },
                }
              : {}),
          };
        }
        if (req.method === "GET") {
          return {
            status: 400,
            body: {
              error: { code: "verification_failed", message: "no proof" },
            },
          };
        }
        return undefined;
      });
      const Card = await loadCard();
      const { container, root } = await renderPage(Card, PROPS);
      try {
        await typeInto(field("cap"), "250", "hourly cap");
        await click(button(container, SAVE), SAVE);

        expect(writesTo(SETTINGS)).toHaveLength(1);
        expect(button(container, "Refresh to reconcile")).not.toBeNull();
        expect(field("cap").disabled).toBe(true);
        expect(toastsAt("success")).toEqual([]);
      } finally {
        unmount(root);
      }
    });
  }
});

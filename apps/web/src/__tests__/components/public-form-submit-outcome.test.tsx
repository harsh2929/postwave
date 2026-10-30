// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import FormSuccessPage from "@/app/[locale]/forms/success/page";
import { HostedCompiledForm } from "@/components/HostedCompiledForm";
import { SurveyForm } from "@/components/SurveyForm";
import { compileFormHtml, type Form } from "@/lib/forms-types";
import {
  postPublicForm,
  publicFormSuccessURL,
} from "@/lib/public-form-submission";

// The copy a visitor reads comes from the shipped English messages, so these
// assertions fail if the wrong key is rendered or the key loses its text.
const WEB_ROOT = existsSync(resolve(process.cwd(), "src"))
  ? process.cwd()
  : resolve(process.cwd(), "apps/web");
const english = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "locales/en.json"), "utf8"),
) as Record<string, Record<string, string>>;
const forms = english.forms;

function translator(namespace: string) {
  return (key: string, values?: Record<string, string | number>) => {
    const message = english[namespace]?.[key];
    if (typeof message !== "string") {
      throw new Error(`missing ${namespace}.${key}`);
    }
    return message.replace(/\{(\w+)\}/g, (_, name: string) =>
      String(values?.[name] ?? ""),
    );
  };
}

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => translator(namespace),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async (namespace: string) => translator(namespace)),
  setRequestLocale: vi.fn(),
}));

function textOf(html: string): string {
  return (
    new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
  );
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const form: Form = {
  id: "form_outcome",
  tenantId: "tenant_outcome",
  slug: "outcome",
  name: "Outcome",
  optInMode: "single",
  status: "published",
  createdAt: "2026-09-15T00:00:00Z",
  updatedAt: "2026-09-15T00:00:00Z",
  settings: { successMessage: "Thanks" },
  structure: {
    fields: [
      { id: "email", kind: "email", label: "Email", required: true },
      { id: "submit", kind: "submit", label: "Subscribe", required: false },
    ],
  },
};

function mount(node: React.ReactNode): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { root, container };
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  });
}

function typeEmail(container: HTMLElement, value: string) {
  const email = container.querySelector<HTMLInputElement>(
    'input[name="email"]',
  )!;
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(email, value);
  email.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submitAndReadAlert(container: HTMLElement): Promise<string> {
  const formElement = container.querySelector("form")!;
  await act(async () => {
    formElement.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
  return container.querySelector('[role="alert"]')?.textContent ?? "";
}

describe("a public form submission the server could not complete", () => {
  // A failed submit used to say "We couldn't load this form right now.
  // Please refresh in a moment." — page-load copy, telling the visitor to
  // reload a form that had loaded fine.
  it.each([502, 503])(
    "tells a survey visitor the SUBMISSION failed and to try again (%i)",
    async (status) => {
      globalThis.fetch = vi.fn(
        async () => new Response("", { status }),
      ) as typeof fetch;
      const { root, container } = mount(
        createElement(SurveyForm, {
          form,
          actionUrl: "/api/public/forms/outcome/submit",
        }),
      );
      try {
        await flush();
        typeEmail(container, "reader@example.com");
        await flush();
        const alert = await submitAndReadAlert(container);
        expect(alert).toBe(
          "We couldn't submit this form right now. Please try again in a moment.",
        );
        expect(alert).not.toContain(forms.unavailable_body);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("tells a compiled-form visitor the same", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("", { status: 502 }),
    ) as typeof fetch;
    const { root, container } = mount(
      createElement(HostedCompiledForm, {
        html: compileFormHtml(form),
        actionURL: "/api/public/forms/outcome/submit",
        slug: "outcome",
      }),
    );
    try {
      await flush();
      typeEmail(container, "reader@example.com");
      await flush();
      expect(await submitAndReadAlert(container)).toBe(
        "We couldn't submit this form right now. Please try again in a moment.",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("a response that did not ask to subscribe", () => {
  it("is accepted and lands on the received page, not a subscription page", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ ok: true, state: "received" }),
    ) as typeof fetch;
    const formElement = document.createElement("form");
    formElement.innerHTML = '<input name="email" value="reader@example.com">';
    await expect(postPublicForm("/submit", formElement)).resolves.toEqual({
      kind: "accepted",
      state: "received",
    });
    expect(publicFormSuccessURL("outcome", "received")).toBe(
      "/forms/success?form=outcome&mode=received",
    );
    // The existing double opt-in landing is unchanged.
    expect(publicFormSuccessURL("outcome", "pending-confirmation")).toBe(
      "/forms/success?form=outcome&mode=double",
    );
  });

  it("renders the received page without claiming a subscription", async () => {
    // No form can be read, so every state shows its translated default.
    globalThis.fetch = vi.fn(
      async () => new Response("", { status: 404 }),
    ) as typeof fetch;
    const page = async (mode: string) =>
      textOf(
        renderToStaticMarkup(
          await FormSuccessPage({
            params: Promise.resolve({ locale: "en" }),
            searchParams: Promise.resolve({ form: "outcome", mode }),
          }),
        ),
      );
    const received = await page("received");
    expect(received).toBe("Response receivedThanks for filling in the form.");
    expect(received).not.toContain(forms.success_title);
    expect(await page("double")).toBe(
      forms.success_almost_there + forms.success_double_check_inbox,
    );
    expect(await page("single")).toBe(
      forms.success_title + forms.success_thanks,
    );
  });
});

// A form's "Success message" setting reached nothing: the hosted success page
// rendered fixed translated text, so a form set to say something of its own
// still told its visitors "Thanks for signing up."
describe("a form's own success message", () => {
  const authored = "You're in. The next letter goes out on Friday.";

  function servePublicForm(successMessage: string) {
    const requests: Array<{ url: string; lookup: string | null }> = [];
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        lookup: headers.get("X-Postwave-Form-Lookup"),
      });
      return Response.json({
        form: {
          slug: "outcome",
          optInMode: "single",
          structure: { fields: [] },
          settings: { successMessage },
          status: "published",
        },
      });
    }) as unknown as typeof fetch;
    return requests;
  }

  const page = async (mode: string, form: string | null = "outcome") =>
    textOf(
      renderToStaticMarkup(
        await FormSuccessPage({
          params: Promise.resolve({ locale: "en" }),
          searchParams: Promise.resolve(
            form === null ? { mode } : { form, mode },
          ),
        }),
      ),
    );

  it("is shown for a single opt-in, after the subscribed title", async () => {
    servePublicForm(authored);
    expect(await page("single")).toBe(forms.success_title + authored);
  });

  it("is shown for the double opt-in check-your-inbox state too", async () => {
    servePublicForm(authored);
    expect(await page("double")).toBe(forms.success_almost_there + authored);
  });

  it("is read without counting the landing as a view of the form", async () => {
    const requests = servePublicForm(authored);
    await page("single");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/api/public/forms/outcome");
    // The API skips the visit counter for exactly this value; without it every
    // conversion would also count as a visit.
    expect(requests[0]?.lookup).toBe("success-copy");
  });

  it("keeps the translated default when the form set no message", async () => {
    servePublicForm("   ");
    expect(await page("single")).toBe(
      forms.success_title + forms.success_thanks,
    );
    servePublicForm("");
    expect(await page("double")).toBe(
      forms.success_almost_there + forms.success_double_check_inbox,
    );
  });

  it("renders an authored message as text, never as markup", async () => {
    servePublicForm("<b>Thanks</b> & welcome");
    const html = renderToStaticMarkup(
      await FormSuccessPage({
        params: Promise.resolve({ locale: "en" }),
        searchParams: Promise.resolve({ form: "outcome", mode: "single" }),
      }),
    );
    expect(html).not.toContain("<b>Thanks</b>");
    expect(textOf(html)).toContain("<b>Thanks</b> & welcome");
  });

  it("does not ask for a message the received state would not use", async () => {
    const requests = servePublicForm(authored);
    expect(await page("received")).toBe(
      forms.success_received_title + forms.success_received_body,
    );
    expect(requests).toHaveLength(0);
  });

  it("shows the default when the landing names no form", async () => {
    const requests = servePublicForm(authored);
    expect(await page("single", null)).toBe(
      forms.success_title + forms.success_thanks,
    );
    expect(requests).toHaveLength(0);
  });
});

describe("every locale", () => {
  it("translates the submit-failure and received copy", () => {
    for (const locale of ["en", "de", "es", "fr", "ja", "pt"]) {
      const messages = JSON.parse(
        readFileSync(resolve(WEB_ROOT, `locales/${locale}.json`), "utf8"),
      ).forms as Record<string, string>;
      for (const key of [
        "submit_unavailable_body",
        "success_received_title",
        "success_received_body",
      ]) {
        expect(messages[key], `${locale} forms.${key}`).toBeTruthy();
        if (locale !== "en") {
          expect(
            messages[key],
            `${locale} forms.${key} is untranslated`,
          ).not.toBe(forms[key]);
        }
      }
      expect(messages.submit_unavailable_body).not.toBe(
        messages.unavailable_body,
      );
    }
  });
});

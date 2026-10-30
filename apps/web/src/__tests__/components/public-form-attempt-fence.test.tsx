// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostedCompiledForm } from "@/components/HostedCompiledForm";
import { SurveyForm } from "@/components/SurveyForm";
import { compileFormHtml, type Form } from "@/lib/forms-types";
import {
  mintSubmissionAttemptID,
  postPublicForm,
  PUBLIC_FORM_SUBMIT_TIMEOUT_MS,
  SUBMISSION_ATTEMPT_FIELD,
} from "@/lib/public-form-submission";

vi.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      if (key === "step_progress") {
        return `Step ${values?.step} of ${values?.total}`;
      }
      if (key === "unavailable_body") return "Transport outcome uncertain.";
      return key;
    },
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.innerHTML = "";
  delete (
    globalThis as typeof globalThis & { grecaptcha?: { reset: () => void } }
  ).grecaptcha;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(node: React.ReactNode): {
  root: Root;
  container: HTMLDivElement;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { root, container };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  });
}

function attemptValue(container: ParentNode): string {
  return (
    container.querySelector<HTMLInputElement>(
      `input[name="${SUBMISSION_ATTEMPT_FIELD}"]`,
    )?.value ?? ""
  );
}

function setValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    control,
    value,
  );
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit(form: HTMLFormElement) {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

const baseForm: Form = {
  id: "form_attempt",
  tenantId: "tenant_attempt",
  slug: "attempt",
  name: "Attempt fence",
  optInMode: "single",
  status: "published",
  createdAt: "2026-08-29T00:00:00Z",
  updatedAt: "2026-08-29T00:00:00Z",
  settings: { successMessage: "Thanks" },
  structure: {
    fields: [
      { id: "email", kind: "email", label: "Email", required: true },
      { id: "submit", kind: "submit", label: "Submit", required: false },
    ],
  },
};

describe("public form paid-verification attempt fence", () => {
  it("mints at least 16 random URL-safe bytes", () => {
    const token = mintSubmissionAttemptID();
    expect(token).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(token).toHaveLength(32);
    expect(
      mintSubmissionAttemptID({
        getRandomValues: () => {
          throw new Error("browser entropy unavailable");
        },
      }),
    ).toBe("");
  });

  it("bounds hung transport as uncertain without changing the submitted token", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    ) as typeof fetch;
    const form = document.createElement("form");
    form.innerHTML = `<input name="email" value="reader@example.com"><input name="${SUBMISSION_ATTEMPT_FIELD}" value="0123456789abcdef0123456789abcdef">`;
    const outcomePromise = postPublicForm("/submit", form);
    await vi.advanceTimersByTimeAsync(PUBLIC_FORM_SUBMIT_TIMEOUT_MS);
    await expect(outcomePromise).resolves.toEqual({ kind: "uncertain" });
    expect(attemptValue(form)).toBe("0123456789abcdef0123456789abcdef");
  });

  it("bounds an undeclared streamed response before accepting its JSON", async () => {
    const oversizedButOtherwiseAccepted = JSON.stringify({
      ok: true,
      state: "subscribed",
      padding: "x".repeat(33 * 1024),
    });
    globalThis.fetch = vi.fn(
      async () => new Response(oversizedButOtherwiseAccepted, { status: 200 }),
    );
    const form = document.createElement("form");
    form.innerHTML = '<input name="email" value="reader@example.com">';

    await expect(postPublicForm("/submit", form)).resolves.toEqual({
      kind: "uncertain",
    });
  });

  it("leaves a normal native POST fallback with a blank attempt id", () => {
    const html = compileFormHtml(baseForm);
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="/api/public/forms/attempt/submit"');
    expect(html).toContain(
      '<input type="hidden" name="submission_attempt_id" value="" />',
    );
  });

  it("keeps the survey native POST usable when browser entropy is unavailable", async () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("browser entropy unavailable");
    });
    globalThis.fetch = vi.fn() as typeof fetch;
    const { root, container } = mount(
      createElement(SurveyForm, {
        form: baseForm,
        actionUrl: "/api/public/forms/attempt/submit",
      }),
    );
    try {
      await flush();
      const form = container.querySelector("form")!;
      const email = container.querySelector<HTMLInputElement>(
        'input[name="email"]',
      )!;
      setValue(email, "reader@example.com");
      await flush();

      expect(attemptValue(container)).toBe("");
      expect(form.method.toLowerCase()).toBe("post");
      expect(form.action).toContain("/api/public/forms/attempt/submit");
      expect(
        container.querySelector<HTMLButtonElement>('button[type="submit"]')
          ?.disabled,
      ).toBe(false);
      const event = new Event("submit", { bubbles: true, cancelable: true });
      await act(async () => {
        form.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps the compiled native POST usable when browser entropy is unavailable", async () => {
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(() => {
      throw new Error("browser entropy unavailable");
    });
    globalThis.fetch = vi.fn() as typeof fetch;
    const { root, container } = mount(
      createElement(HostedCompiledForm, {
        html: compileFormHtml(baseForm),
        actionURL: "/api/public/forms/attempt/submit",
        slug: "attempt",
      }),
    );
    try {
      await flush();
      const form = container.querySelector("form")!;
      expect(attemptValue(container)).toBe("");
      const event = new Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("compiled hosted forms retain the token on uncertain retries and rotate for changed/deterministic intent", async () => {
    const resetCaptcha = vi.fn();
    (
      globalThis as typeof globalThis & { grecaptcha?: { reset: () => void } }
    ).grecaptcha = { reset: resetCaptcha };
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 }));
    const html = compileFormHtml(baseForm);
    const { root, container } = mount(
      createElement(HostedCompiledForm, {
        html,
        actionURL: "/api/public/forms/attempt/submit",
        slug: "attempt",
      }),
    );
    try {
      await flush();
      const form = container.querySelector("form")!;
      const email = container.querySelector<HTMLInputElement>(
        'input[name="email"]',
      )!;
      setValue(email, "reader@example.com");
      await flush();
      const first = attemptValue(container);
      expect(first).toMatch(/^[a-f0-9]{32}$/);

      submit(form);
      await flush();
      expect(attemptValue(container)).toBe(first);
      expect(resetCaptcha).toHaveBeenCalledTimes(1);
      submit(form);
      await flush();
      expect(attemptValue(container)).toBe(first);

      setValue(email, "second@example.com");
      await flush();
      const changed = attemptValue(container);
      expect(changed).not.toBe(first);

      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "bad_email", message: "Review the address." },
            }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          ),
      );
      submit(form);
      await flush();
      expect(attemptValue(container)).not.toBe(changed);
      expect(container.textContent).toContain("Review the address.");
    } finally {
      act(() => root.unmount());
    }
  });

  it("survey forms retain uncertain retries and rotate on changed or deterministic intent", async () => {
    const resetCaptcha = vi.fn();
    (
      globalThis as typeof globalThis & { grecaptcha?: { reset: () => void } }
    ).grecaptcha = { reset: resetCaptcha };
    const survey: Form = {
      ...baseForm,
      structure: {
        fields: [
          ...baseForm.structure.fields.slice(0, 1),
          { id: "break", kind: "step_break", label: "Next", required: false },
          { id: "notes", kind: "long_text", label: "Notes", required: false },
          ...baseForm.structure.fields.slice(1),
        ],
      },
    };
    globalThis.fetch = vi.fn(async () => new Response("", { status: 503 }));
    const { root, container } = mount(
      createElement(SurveyForm, {
        form: survey,
        actionUrl: "/api/public/forms/attempt/submit",
      }),
    );
    try {
      await flush();
      const email = container.querySelector<HTMLInputElement>(
        'input[name="email"]',
      )!;
      setValue(email, "reader@example.com");
      await flush();
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "next")
        ?.click();
      await flush();

      const form = container.querySelector("form")!;
      const first = attemptValue(container);
      submit(form);
      await flush();
      expect(attemptValue(container)).toBe(first);
      expect(resetCaptcha).toHaveBeenCalledTimes(1);
      submit(form);
      await flush();
      expect(attemptValue(container)).toBe(first);
      expect(resetCaptcha).toHaveBeenCalledTimes(2);

      const notes = container.querySelector<HTMLTextAreaElement>(
        'textarea[name="cf_notes"]',
      )!;
      setValue(notes, "new intent");
      await flush();
      const changed = attemptValue(container);
      expect(changed).not.toBe(first);

      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "bad_email", message: "Review the survey." },
            }),
            { status: 422, headers: { "Content-Type": "application/json" } },
          ),
      );
      submit(form);
      await flush();
      expect(attemptValue(container)).not.toBe(changed);
      expect(resetCaptcha).toHaveBeenCalledTimes(3);
      expect(container.textContent).toContain("Review the survey.");
    } finally {
      act(() => root.unmount());
    }
  });
});

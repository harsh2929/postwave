// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SurveyForm } from "@/components/SurveyForm";
import type { Form } from "@/lib/forms-types";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next-intl", () => ({
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      if (key === "step_progress") {
        return `Step ${values?.step} of ${values?.total}`;
      }
      if (key === "complete_required") return "Complete required fields.";
      if (key === "no_options") return "No choices are available.";
      return key;
    },
}));

const survey: Form = {
  id: "form_navigation",
  tenantId: "tenant_1",
  slug: "navigation",
  name: "Navigation survey",
  optInMode: "single",
  status: "published",
  createdAt: "2026-08-26T00:00:00Z",
  updatedAt: "2026-08-26T00:00:00Z",
  settings: { successMessage: "Thanks" },
  structure: {
    fields: [
      {
        id: "email",
        kind: "email",
        label: "Email",
        required: true,
      },
      {
        id: "break",
        kind: "step_break",
        label: "Next step",
        required: false,
      },
      {
        id: "notes",
        kind: "long_text",
        label: "Notes",
        required: false,
      },
      {
        id: "submit",
        kind: "submit",
        label: "Submit",
        required: false,
      },
    ],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function render(): { root: Root; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(SurveyForm, {
        form: survey,
        actionUrl: "/api/public/forms/navigation/submit",
      }),
    );
  });
  return { root, container };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 20));
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SurveyForm step navigation", () => {
  it("blocks an invalid email, then moves focus with forward and back navigation", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const { root, container } = render();
    try {
      const email = container.querySelector<HTMLInputElement>(
        'input[type="email"]',
      );
      const next = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "next",
      );
      expect(email).not.toBeNull();
      expect(next).toBeTruthy();

      await act(async () => {
        if (email) {
          setInputValue(email, "not-an-email");
        }
        next?.click();
        await flush();
      });

      expect(container.textContent).toContain("Step 1 of 2");
      expect(container.textContent).toContain("Complete required fields.");
      expect(document.activeElement).toBe(email);

      await act(async () => {
        if (email) {
          setInputValue(email, "reader@example.com");
        }
        await flush();
      });
      const nextAfterEdit = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "next",
      );
      await act(async () => {
        nextAfterEdit?.click();
        await flush();
      });

      expect(container.textContent).toContain("Step 2 of 2");
      expect(document.activeElement?.getAttribute("role")).toBe("group");

      const back = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "back",
      );
      await act(async () => {
        back?.click();
        await flush();
      });
      expect(container.textContent).toContain("Step 1 of 2");
      expect(document.activeElement?.getAttribute("role")).toBe("group");
    } finally {
      act(() => root.unmount());
    }
  });
});

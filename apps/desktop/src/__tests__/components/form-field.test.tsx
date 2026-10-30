// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { FormErrorSummary, FormField } from "../../components/FormField";
import { InlineHelp } from "../../components/InlineHelp";
import { SectionHeader } from "../../components/SectionHeader";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

describe("FormField semantic contract", () => {
  it("generates and connects label, help, required, invalid, and error semantics", () => {
    render(
      <FormField
        label="From email"
        help="Use a verified sending domain."
        error="This address is not verified."
        required
      >
        <input type="email" />
      </FormField>,
    );

    const input = document.querySelector<HTMLInputElement>("input");
    const label = document.querySelector<HTMLLabelElement>("label");
    expect(input?.id).toBeTruthy();
    expect(label?.htmlFor).toBe(input?.id);
    expect(input?.required).toBe(true);
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    const describedBy =
      input?.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(input?.getAttribute("aria-errormessage")).toBe(describedBy.at(-1));
    expect(describedBy).toHaveLength(2);
    expect(
      describedBy.map((id) => document.getElementById(id)?.textContent),
    ).toEqual([
      "Use a verified sending domain.",
      expect.stringContaining("This address is not verified."),
    ]);
    expect(label?.textContent).toContain("required");
  });

  it("preserves caller-provided descriptions while adding field help", () => {
    render(
      <>
        <span id="unit">seconds</span>
        <FormField label="Timeout" help="Maximum request time.">
          <input id="timeout" aria-describedby="unit" />
        </FormField>
      </>,
    );
    const input = document.getElementById("timeout");
    expect(input?.getAttribute("aria-describedby")?.split(" ")[0]).toBe("unit");
    expect(input?.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
  });

  it("preserves caller-owned invalid and error-message semantics", () => {
    render(
      <>
        <span id="server-error">Server rejected this value</span>
        <FormField label="Endpoint">
          <input
            id="endpoint"
            aria-invalid="true"
            aria-errormessage="server-error"
          />
        </FormField>
      </>,
    );
    const input = document.getElementById("endpoint");
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(input?.getAttribute("aria-errormessage")).toBe("server-error");
  });

  it("keeps native-control semantics intact with label actions and adornments", () => {
    render(
      <FormField
        label="Password"
        help="Caps Lock is on."
        error="Enter your password."
        labelAction={<button type="button">Forgot password?</button>}
        startAdornment={<span aria-hidden="true">lock</span>}
        endAdornment={
          <button type="button" aria-label="Show password">
            eye
          </button>
        }
      >
        <input id="field-password" type="password" required />
      </FormField>,
    );

    const input = document.querySelector<HTMLInputElement>("#field-password");
    const control = document.querySelector(".field-v2-control");
    expect(control?.contains(input ?? null)).toBe(true);
    expect(document.querySelector("label")?.htmlFor).toBe("field-password");
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(input?.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
    expect(input?.getAttribute("aria-errormessage")).toBeTruthy();
    expect(
      document.querySelector(".field-v2-label-actions")?.textContent,
    ).toContain("Forgot password?");
    expect(
      document
        .querySelector(".field-v2-adornment-end button")
        ?.getAttribute("aria-label"),
    ).toBe("Show password");
  });

  it("renders a linked error summary", () => {
    render(
      <>
        <input id="email" />
        <FormErrorSummary
          errors={[
            { fieldId: "email", label: "Email", message: "Enter an address" },
          ]}
        />
      </>,
    );
    const summary = document.querySelector<HTMLElement>(".form-error-summary");
    const link = document.querySelector<HTMLAnchorElement>("a");
    expect(summary?.getAttribute("role")).toBe("alert");
    expect(summary?.tabIndex).toBe(-1);
    expect(link?.getAttribute("href")).toBe("#email");
    act(() => link?.click());
    expect(document.activeElement).toBe(document.getElementById("email"));
  });
});

describe("InlineHelp tooltip contract", () => {
  it("keeps the first pointer click open after the preceding hover and focus events", () => {
    render(<InlineHelp text="Only admins can change this setting." />);
    const trigger = document.querySelector<HTMLButtonElement>(".inline-help");
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');

    act(() => {
      trigger?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      trigger?.focus();
      trigger?.click();
    });

    expect(tooltip?.dataset.open).toBe("true");

    act(() => trigger?.click());
    expect(tooltip?.dataset.open).toBe("false");
  });

  it("lets a pointer cross from the trigger into the tooltip before closing", () => {
    vi.useFakeTimers();
    render(<InlineHelp text="Only admins can change this setting." />);
    const trigger = document.querySelector<HTMLButtonElement>(".inline-help");
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');

    act(() => {
      trigger?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(tooltip?.dataset.open).toBe("true");

    act(() => {
      trigger?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      tooltip?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(150);
    });
    expect(tooltip?.dataset.open).toBe("true");

    act(() => {
      tooltip?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      vi.advanceTimersByTime(150);
    });
    expect(tooltip?.dataset.open).toBe("false");
  });

  it("is keyboard reachable, described, and dismissible with Escape", () => {
    render(<InlineHelp text="Only admins can change this setting." />);
    const trigger = document.querySelector<HTMLButtonElement>(".inline-help");
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(trigger?.tabIndex).toBe(0);
    expect(trigger?.getAttribute("aria-describedby")).toBe(tooltip?.id);
    expect(tooltip?.dataset.open).toBe("false");

    act(() => trigger?.focus());
    expect(tooltip?.dataset.open).toBe("true");
    act(() => {
      trigger?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(tooltip?.dataset.open).toBe("false");
    expect(document.querySelector("[title]")).toBeNull();
  });
});

describe("SectionHeader help semantics", () => {
  it("keeps the help control outside the heading accessible name", () => {
    render(
      <SectionHeader
        title="Predicted customer value"
        description="Customer-value distribution."
        helpText="These values are projections."
      />,
    );

    const heading = document.querySelector<HTMLHeadingElement>("h3");
    const help = document.querySelector<HTMLButtonElement>(".inline-help");
    const titleRow = document.querySelector<HTMLElement>(
      ".section-header-v2-title-row",
    );

    expect(heading?.textContent).toBe("Predicted customer value");
    expect(heading?.querySelector("button")).toBeNull();
    expect(help?.getAttribute("aria-label")).toBe("More information");
    expect(Array.from(titleRow?.children ?? [])).toEqual([heading, help]);
    expect(document.querySelector("[title]")).toBeNull();
  });
});

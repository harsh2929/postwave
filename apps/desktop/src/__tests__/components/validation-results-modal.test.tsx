// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ValidationResultsModal } from "../../components/subscribers/ValidationResultsModal";
import type { EmailValidationBatchResponse } from "../../lib/api-client";

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
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

const response: EmailValidationBatchResponse = {
  summary: { total: 3, valid: 2, invalid: 1 },
  results: [
    {
      email: "valid@example.test",
      valid: true,
      verdict: "ok",
      has_mx: true,
      disposable: false,
      role_account: false,
      reasons: [],
    },
    {
      email: "idless@example.test",
      valid: true,
      verdict: "ok",
      has_mx: true,
      disposable: false,
      role_account: false,
      reasons: [],
    },
    {
      email: "invalid@example.test",
      valid: false,
      verdict: "no_mx",
      has_mx: false,
      disposable: false,
      role_account: false,
      reasons: ["No MX record"],
    },
  ],
};

describe("ValidationResultsModal valid-subset action", () => {
  it("offers only the exact id-bearing valid subset as a safe read-only action", async () => {
    const onExport = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ValidationResultsModal
          open
          onClose={() => undefined}
          response={response}
          skipped={1}
          validSubsetCount={1}
          validSubsetWithoutId={1}
          onExportValidSubset={onExport}
        />,
      );
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("3 checked");
    expect(dialog?.textContent).toContain(
      "1 valid result has no stable subscriber id",
    );
    const exportButton = [...document.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.trim() === "Export valid subset (1)",
    );
    expect(exportButton).not.toBeUndefined();
    act(() => exportButton?.click());
    expect(onExport).toHaveBeenCalledTimes(1);

    const results = await axe.run(dialog!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("keeps the valid-only action unavailable when no stable valid scope exists", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ValidationResultsModal
          open
          onClose={() => undefined}
          response={response}
          skipped={0}
          validSubsetCount={0}
          onExportValidSubset={() => undefined}
        />,
      );
    });
    const exportButton = [...document.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.trim() === "Export valid subset (0)",
    ) as HTMLButtonElement | undefined;
    expect(exportButton?.disabled).toBe(true);
  });
});

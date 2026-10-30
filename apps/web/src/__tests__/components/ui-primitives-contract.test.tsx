// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { Alert, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { normalizeProgressValue, Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe("shared UI primitive contracts", () => {
  it("keeps text controls at 16px on narrow screens and compact above sm", async () => {
    const container = await mount(
      <>
        <Input aria-label="Name" />
        <Textarea aria-label="Notes" />
        <Select aria-label="Status">
          <option>Active</option>
        </Select>
      </>,
    );

    for (const slot of ["input", "textarea", "select"]) {
      const control = container.querySelector<HTMLElement>(
        `[data-slot="${slot}"]`,
      );
      expect(control?.className).toContain("text-base");
      expect(control?.className).toContain("sm:text-sm");
      expect(control?.className).toContain(
        "[@media(pointer:coarse)]:text-base",
      );
    }
    expect(container.querySelector('[data-slot="input"]')?.className).toContain(
      "h-11",
    );
    expect(
      container.querySelector('[data-slot="select"]')?.className,
    ).toContain("h-11");
    expect(container.querySelector('[data-slot="input"]')?.className).toContain(
      "[@media(pointer:coarse)]:h-11",
    );
    expect(
      container.querySelector('[data-slot="select"]')?.className,
    ).toContain("[@media(pointer:coarse)]:h-11");
    expect(
      container.querySelector('[data-slot="textarea"]')?.className,
    ).toContain("[@media(pointer:coarse)]:min-h-[96px]");
  });

  it("clamps determinate progress and exposes the real accessible value", async () => {
    expect(normalizeProgressValue(-12)).toBe(0);
    expect(normalizeProgressValue(48)).toBe(48);
    expect(normalizeProgressValue(140)).toBe(100);
    expect(normalizeProgressValue(Number.NaN)).toBe(0);
    expect(normalizeProgressValue(null)).toBeNull();

    const container = await mount(<Progress value={140} aria-label="Import" />);
    const progress = container.querySelector('[role="progressbar"]');
    const indicator = progress?.firstElementChild as HTMLElement | null;
    expect(progress?.getAttribute("aria-valuenow")).toBe("100");
    expect(indicator?.style.transform).toBe("translateX(-0%)");
  });

  it("does not announce static informational alerts as urgent", async () => {
    const container = await mount(
      <>
        <Alert>
          <AlertTitle>Helpful context</AlertTitle>
        </Alert>
        <Alert variant="destructive">Could not save</Alert>
      </>,
    );
    const alerts = container.querySelectorAll("[role='alert']");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Could not save");
    expect(alerts[0]?.className).toContain("text-destructive-emphasis");
    expect(container.querySelector("h5")).toBeNull();
  });
});

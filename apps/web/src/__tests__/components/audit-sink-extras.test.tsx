// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-58 / 62 / 68: circuit legend + synthesized history, JWKS URL
// copy, and the OCSF mapping/sample disclosure beside the output-format
// selector. Each assertion checks the consequence (what is copied, what the
// history says, what the operator sees after switching format), not merely
// that a control exists.
import { act, createElement, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateSinkDialog } from "@/app/(dashboard)/app/settings/audit-sinks/audit-sink-dialogs";
import type { SinkFormValue } from "@/app/(dashboard)/app/settings/audit-sinks/sink-form";
import {
  SinkCircuitLegend,
  synthesizeCircuitHistory,
  type SinkCircuitSnapshot,
} from "@/components/settings/sink-circuit-legend";
import {
  SinkJwksCopyButton,
  sinkJwksUrl,
} from "@/components/settings/sink-jwks-copy-button";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.navigator, "clipboard");
  document.body.innerHTML = "";
});

function render(ui: ReactNode): void {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(ui));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (element) => element.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return match;
}

function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

const OPEN_SINK: SinkCircuitSnapshot = {
  circuitState: "open",
  consecutiveFailures: 3,
  autoDisableAfter: 5,
  lastFailureAt: "2026-09-12T09:00:00Z",
  lastSuccessAt: "2026-09-11T09:00:00Z",
  cooldownUntil: "2026-09-12T10:00:00Z",
};

describe("SinkCircuitLegend (governance-58)", () => {
  it("discloses the breaker legend and a history synthesized from the sink row", () => {
    render(createElement(SinkCircuitLegend, { sink: OPEN_SINK }));

    const toggle = buttonByText("Show circuit legend & history");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      document.querySelector('[data-testid="sink-circuit-history"]'),
    ).toBeNull();

    act(() => toggle.click());

    expect(
      buttonByText("Hide circuit legend & history").getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
    const legendText = document.querySelector("table")?.textContent ?? "";
    expect(legendText).toContain("closed");
    expect(legendText).toContain("Healthy — events flow normally");
    expect(legendText).toContain("half-open");
    expect(legendText).toContain("Probing — one tentative delivery");
    expect(legendText).toContain("open");
    expect(legendText).toContain("short-circuit to the dead-letter queue");

    const entries = Array.from(
      document.querySelectorAll('[data-testid="sink-circuit-history"] li'),
    );
    expect(entries.map((entry) => entry.getAttribute("data-entry"))).toEqual([
      "last-failure",
      "last-success",
      "current",
      "threshold",
    ]);
    expect(entries[0].textContent).toContain(
      "Last failed delivery · 3 of 5 consecutive failures",
    );
    expect(entries[0].querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-09-12T09:00:00Z",
    );
    expect(entries[1].querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-09-11T09:00:00Z",
    );
    expect(entries[2].textContent).toContain(
      "Current state: open · cooldown ends",
    );
    expect(entries[2].querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-09-12T10:00:00Z",
    );
    expect(entries[3].textContent).toBe(
      "Auto-disables after 5 consecutive failures.",
    );
  });

  it("claims no failure or cooldown the sink did not record", () => {
    const history = synthesizeCircuitHistory({
      circuitState: "closed",
      consecutiveFailures: 0,
      autoDisableAfter: 10,
      lastSuccessAt: "2026-09-12T08:00:00Z",
      lastFailureAt: null,
      cooldownUntil: null,
    });
    expect(history).toEqual([
      {
        key: "last-success",
        at: "2026-09-12T08:00:00Z",
        text: "Last successful delivery",
      },
      { key: "current", text: "Current state: closed" },
      {
        key: "threshold",
        text: "Auto-disables after 10 consecutive failures.",
      },
    ]);
    expect(
      synthesizeCircuitHistory({
        circuitState: "half_open",
        consecutiveFailures: 5,
        autoDisableAfter: 5,
      })[0],
    ).toEqual({
      key: "current",
      text: "Current state: half-open · the next delivery tests the upstream",
    });
  });
});

describe("SinkJwksCopyButton (governance-62)", () => {
  it("copies the sink's JWKS URL built from the browser origin, without fetching it", async () => {
    const writeText = stubClipboard();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(createElement(SinkJwksCopyButton, { sinkId: "sink/1 a" }));
    await flush();

    const expected = `${window.location.origin}/api/v1/audit-sinks/sink%2F1%20a/.well-known/jwks.json`;
    expect(document.querySelector("code")?.textContent).toBe(expected);

    await act(async () => {
      buttonByText("Copy JWKS URL").click();
    });
    await flush();

    expect(writeText.mock.calls).toEqual([[expected]]);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("JWKS URL copied.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prefers the configured public API origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.test/");
    const writeText = stubClipboard();
    render(createElement(SinkJwksCopyButton, { sinkId: "snk_42" }));
    await flush();

    await act(async () => {
      buttonByText("Copy JWKS URL").click();
    });
    await flush();

    expect(writeText.mock.calls).toEqual([
      ["https://api.example.test/api/v1/audit-sinks/snk_42/.well-known/jwks.json"],
    ]);
    expect(sinkJwksUrl("a b", "https://x.test///")).toBe(
      "https://x.test/api/v1/audit-sinks/a%20b/.well-known/jwks.json",
    );
  });

  it("surfaces an unavailable clipboard instead of claiming a copy", async () => {
    Object.defineProperty(window.navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    render(createElement(SinkJwksCopyButton, { sinkId: "snk_42" }));
    await flush();
    await act(async () => {
      buttonByText("Copy JWKS URL").click();
    });
    await flush();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Clipboard unavailable — copy the JWKS URL shown below manually.",
    );
  });
});

const BASE_FORM: SinkFormValue = {
  name: "Prod SIEM",
  kind: "splunk",
  config: {},
  credentials: {},
  outputFormat: "postwave_native",
  webhookFormat: "postwave_v1",
};

function CreateHarness() {
  const [form, setForm] = useState<SinkFormValue>(BASE_FORM);
  const savingRef = useRef(false);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  return createElement(CreateSinkDialog, {
    saving: false,
    savingRef,
    returnFocusRef,
    onOpenChange: () => undefined,
    form,
    error: null,
    testReceipt: null,
    errorRef,
    tested: false,
    onFormChange: setForm,
    onTest: async () => undefined,
    onSubmit: async () => undefined,
  });
}

function selectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("OcsfMappingInfo in the sink form (governance-68)", () => {
  it("explains the chosen format and discloses an OCSF sample event after switching", async () => {
    render(createElement(CreateHarness));
    await flush();

    const notes = () =>
      Array.from(document.querySelectorAll('[role="note"]')).map(
        (note) => note.textContent ?? "",
      );
    expect(notes().some((text) => text.includes("postwave_native"))).toBe(
      true,
    );
    expect(document.body.textContent).not.toContain("Sample event");

    const select = document.querySelector("#sink-output");
    if (!(select instanceof HTMLSelectElement)) throw new Error("no select");
    act(() => selectValue(select, "ocsf_1_8"));

    const ocsfNote = Array.from(
      document.querySelectorAll('[role="note"]'),
    ).find((note) => note.textContent?.includes("OCSF 1.8"));
    expect(ocsfNote?.textContent).toContain(
      "3001 (Account Change), 3002 (Authentication), 3004 (Entity Management), and 6003 (API Activity)",
    );
    expect(ocsfNote?.textContent).toContain("docs/audit/ocsf-mapping.md");
    const details = ocsfNote?.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe(
      "Sample event",
    );
    const sample = JSON.parse(details?.querySelector("pre")?.textContent ?? "");
    expect(sample).toMatchObject({
      class_uid: 3004,
      type_uid: 300404,
      metadata: { version: "1.8.0" },
    });
    expect(notes().some((text) => text.includes("historic envelope"))).toBe(
      false,
    );
  });
});

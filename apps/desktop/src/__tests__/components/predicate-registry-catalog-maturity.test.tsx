// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({ registry: vi.fn() }));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { registry: mocks.registry },
}));

import { PredicateRegistryCatalog } from "../../components/segments/PredicateRegistryCatalog";

const registry = {
  registry_version: "registry-complete-v7",
  boolean_ops: ["and", "or", "not"],
  predicates: [
    {
      key: "consent_timestamp",
      label: "Consent timestamp",
      category: "Consent",
      value_type: "date",
      comparators: ["before", "after", "between"],
      source: "subscriber",
      source_ref: "consent_timestamp",
      activation: ["segment"],
      compiler_status: "supported",
      help: "The complete verified consent timestamp for this subscriber.",
    },
    {
      key: "planned_field",
      label: "Planned field",
      category: "Future",
      value_type: "string",
      comparators: ["equals"],
      source: "future",
      activation: ["segment"],
      compiler_status: "planned",
    },
  ],
  metrics: [
    {
      key: "subscriber_events.opened.count",
      label: "Opened email count",
      source: "subscriber_events",
      event_name: "opened",
      aggregation: "count",
      value_type: "number",
      total: 12345,
      last_seen_at: "2026-07-16T08:30:00.000Z",
    },
  ],
  custom_objects: [
    {
      id: "custom-object-complete-id-123456789",
      key: "loyalty_profile",
      label: "Loyalty profile",
      primary_key: "subscriber_id",
      status: "active",
      updated_at: "2026-07-15T06:00:00.000Z",
    },
  ],
  warnings: ["private internal registry implementation warning"],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registry.mockResolvedValue({ data: registry });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderCatalog(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<PredicateRegistryCatalog />));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setSearch(value: string): void {
  const search = document.querySelector<HTMLInputElement>(
    'input[type="search"]',
  );
  if (!search) throw new Error("Missing catalog search");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(search, value);
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PredicateRegistryCatalog interaction maturity", () => {
  it("shows complete verified metadata and only compiler-valid comparisons", async () => {
    renderCatalog();
    act(() => button("What can I segment on?").click());
    await flush();

    expect(document.body.textContent).toContain("registry-complete-v7");
    expect(document.body.textContent).toContain("Consent timestamp");
    expect(document.body.textContent).toContain("before · after");
    expect(document.body.textContent).not.toContain("between");
    expect(document.body.textContent).not.toContain("Planned field");
    expect(document.body.textContent).toContain(
      "The complete verified consent timestamp",
    );
    expect(document.body.textContent).toContain("12,345");
    expect(document.body.textContent).toContain(
      "custom-object-complete-id-123456789",
    );
    expect(document.querySelectorAll("time")).toHaveLength(2);
    expect(document.body.textContent).not.toContain(
      "private internal registry implementation warning",
    );
    expect(document.body.textContent).toContain(
      "reported 1 availability warning",
    );
    expect(container?.querySelector("[title]")).toBeNull();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("provides labelled filtering, no-match truth, and clear recovery", async () => {
    renderCatalog();
    act(() => button("What can I segment on?").click());
    await flush();
    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    expect(search?.getAttribute("aria-describedby")).toBeTruthy();
    expect(search?.labels?.[0]?.textContent).toContain(
      "Filter segment fields and metrics",
    );
    setSearch("no catalog result");
    expect(document.body.textContent).toContain(
      "Nothing matches “no catalog result”",
    );
    expect(document.body.textContent).toContain("0 matching catalog items");
    act(() => button("Clear filter").click());
    expect(document.body.textContent).toContain("3 matching catalog items");
  });

  it("contains synchronous failure, retries once, and retains data across reopen", async () => {
    mocks.registry
      .mockImplementationOnce(() => {
        throw new Error("private registry SQL and tenant detail");
      })
      .mockResolvedValueOnce({ data: registry });
    renderCatalog();
    const toggle = button("What can I segment on?");
    act(() => toggle.click());
    await flush();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private registry SQL");
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    await flush();
    expect(mocks.registry).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Consent timestamp");

    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(mocks.registry).toHaveBeenCalledTimes(2);
  });
});

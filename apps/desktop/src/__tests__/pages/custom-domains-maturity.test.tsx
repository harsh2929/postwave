// @vitest-environment happy-dom

import { act, type ReactElement, StrictMode } from "react";
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

const mocks = vi.hoisted(() => ({
  listCustomDomains: vi.fn(),
  listDnsHealth: vi.fn(),
  getSenderReputation: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listCustomDomains: mocks.listCustomDomains,
    listDnsHealth: mocks.listDnsHealth,
    getSenderReputation: mocks.getSenderReputation,
  },
}));

vi.mock("../../components/CustomDomainSlideover", () => ({
  CustomDomainSlideover: ({ domain }: { domain: { domain: string } }) => (
    <section
      role="dialog"
      aria-label={`DNS ownership details for ${domain.domain}`}
    >
      Mock DNS ownership detail for {domain.domain}
    </section>
  ),
}));

import { CustomDomains } from "../../pages/CustomDomains";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const populatedRows = [
  domain({
    id: "domain-zeta",
    domain: "zeta.forms.example.com",
    purpose: "forms",
    verified: true,
    createdAt: "2026-07-01T08:00:00.000Z",
    verifiedAt: "2026-07-02T08:00:00.000Z",
  }),
  domain({
    id: "domain-alpha",
    domain: "alpha.links.example.com",
    purpose: "links",
    verified: false,
    createdAt: "2026-07-03T08:00:00.000Z",
    verifiedAt: null,
  }),
  domain({
    id: "domain-middle",
    domain: "middle.web.example.com",
    purpose: "web",
    verified: true,
    createdAt: "2026-07-02T08:00:00.000Z",
    verifiedAt: "2026-07-02T09:00:00.000Z",
  }),
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listCustomDomains.mockResolvedValue({ data: populatedRows });
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function domain(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "domain-default",
    tenantId: "tenant-test",
    domain: "default.example.com",
    purpose: "forms",
    verified: false,
    dns_records: [
      {
        type: "CNAME",
        name: "default.example.com",
        value: "edge.moosewave.com",
        verified: false,
        error: "CNAME lookup failed",
      },
      {
        type: "TXT",
        name: "_postwave-verify.default.example.com",
        value: "pw-verify=safe-test-token",
        verified: false,
        error: "TXT lookup failed",
      },
    ],
    createdAt: "2026-07-01T08:00:00.000Z",
    verifiedAt: null,
    ...overrides,
  };
}

function renderRoute(element: ReactElement = <CustomDomains />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

async function settle(turns = 5): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < turns; turn += 1) {
      await Promise.resolve();
    }
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function button(name: string | RegExp): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => {
    const accessibleName =
      candidate.getAttribute("aria-label") ??
      candidate.textContent?.replace(/\s+/gu, " ").trim() ??
      "";
    return typeof name === "string"
      ? accessibleName === name
      : name.test(accessibleName);
  });
  if (!match) throw new Error(`Missing button: ${String(name)}`);
  return match;
}

function click(target: HTMLElement): void {
  act(() => target.click());
}

function setInput(target: HTMLInputElement, value: string): void {
  act(() => {
    Reflect.set(HTMLInputElement.prototype, "value", value, target);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(target: HTMLSelectElement, value: string): void {
  act(() => {
    Reflect.set(HTMLSelectElement.prototype, "value", value, target);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function metricValue(label: string): string {
  const term = Array.from(
    document.querySelectorAll<HTMLElement>(".cd-metric dt"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  const value = term?.parentElement?.querySelector("dd")?.textContent?.trim();
  if (!value) throw new Error(`Missing metric: ${label}`);
  return value;
}

function visibleHostnames(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("tbody th[scope='row'] code"),
  ).map((node) => node.textContent?.trim() ?? "");
}

describe("Custom Domains maturity", () => {
  it("renders an honest ownership snapshot without borrowing deliverability signals", async () => {
    renderRoute();
    await settle();

    expect(mocks.listCustomDomains).toHaveBeenCalledOnce();
    expect(mocks.listDnsHealth).not.toHaveBeenCalled();
    expect(mocks.getSenderReputation).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Evidence, not activation");
    expect(document.body.textContent).toContain("3 stored");
    expect(document.body.textContent).toContain("2 of 3 latest checks passed");
    expect(document.body.textContent).toContain("TLS issued");
    expect(document.body.textContent).toContain("Traffic routed");
    expect(document.body.textContent).toContain("Not connected");
    expect(metricValue("Registered")).toBe("3");
    expect(metricValue("Latest check passed")).toBe("2");
    expect(metricValue("Needs DNS")).toBe("1");
    expect(metricValue("Traffic-ready")).toBe("Not measured");
    expect(visibleHostnames()).toHaveLength(3);

    const register = button("Register hostname");
    expect(register.getAttribute("aria-disabled")).toBe("true");
    const reasonId = register.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId ?? "")?.textContent).toContain(
      "Registration is held until automated TLS issuance",
    );
  });

  it("rejects a malformed list as a contract error instead of an empty registry or zero KPI state", async () => {
    mocks.listCustomDomains.mockResolvedValueOnce({
      data: { items: [] },
    });
    renderRoute();
    await settle();

    expect(document.body.textContent).toContain(
      "This response cannot be displayed safely.",
    );
    expect(document.body.textContent).toContain(
      "rejected an unexpected server payload",
    );
    expect(
      document.querySelector('[aria-label="Domain registry summary"]'),
    ).toBeNull();
    expect(document.querySelector(".cd-empty-state")).toBeNull();
    expect(document.querySelector(".cd-table")).toBeNull();
    expect(document.body.textContent).toContain("Snapshot unavailable");
    expect(document.body.textContent).not.toContain("0 stored");
    expect(document.body.textContent).not.toContain(
      "The ownership registry is empty.",
    );
  });

  it("presents a request failure as unknown instead of manufacturing an empty registry", async () => {
    mocks.listCustomDomains.mockResolvedValueOnce({
      error: { kind: "network", message: "offline" },
    });
    renderRoute();
    await settle();

    expect(document.body.textContent).toContain(
      "The domain registry could not be reached.",
    );
    expect(document.body.textContent).toContain(
      "No zero counts or empty state are being inferred.",
    );
    expect(
      document.querySelector('[aria-label="Domain registry summary"]'),
    ).toBeNull();
    expect(document.querySelector(".cd-empty-state")).toBeNull();
    expect(document.querySelector(".cd-table")).toBeNull();
    expect(document.body.textContent).toContain("Snapshot unavailable");
    expect(document.body.textContent).not.toContain("0 stored");
  });

  it("retains the last successful snapshot when a refresh fails", async () => {
    renderRoute();
    await settle();
    mocks.listCustomDomains.mockResolvedValueOnce({
      error: { kind: "server", message: "temporarily unavailable" },
    });

    click(button("Refresh registry"));
    await settle();

    expect(mocks.listCustomDomains).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "Registry refresh did not complete.",
    );
    expect(document.body.textContent).toContain(
      "Showing the last successful snapshot",
    );
    expect(metricValue("Registered")).toBe("3");
    expect(visibleHostnames()).toEqual([
      "alpha.links.example.com",
      "middle.web.example.com",
      "zeta.forms.example.com",
    ]);
  });

  it("allows only the latest request generation to replace the registry", async () => {
    const stale = deferred<{ data: Array<Record<string, unknown>> }>();
    const latest = deferred<{ data: Array<Record<string, unknown>> }>();
    mocks.listCustomDomains
      .mockReset()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);

    renderRoute(
      <StrictMode>
        <CustomDomains />
      </StrictMode>,
    );
    await settle();
    expect(mocks.listCustomDomains).toHaveBeenCalledTimes(2);

    latest.resolve({
      data: [domain({ id: "latest", domain: "latest.example.com" })],
    });
    await settle();
    expect(visibleHostnames()).toEqual(["latest.example.com"]);

    stale.resolve({
      data: [domain({ id: "stale", domain: "stale.example.com" })],
    });
    await settle();
    expect(visibleHostnames()).toEqual(["latest.example.com"]);
    expect(document.body.textContent).not.toContain("stale.example.com");
  });

  it("searches, filters and sorts the semantic registry table, then opens detail", async () => {
    renderRoute();
    await settle();

    const table = document.querySelector<HTMLTableElement>(".cd-table");
    expect(table).not.toBeNull();
    expect(table?.querySelector("caption")?.textContent).toContain(
      "DNS ownership evidence",
    );
    expect(table?.querySelectorAll("thead th[scope='col']")).toHaveLength(6);
    expect(table?.querySelectorAll("tbody th[scope='row']")).toHaveLength(3);

    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    if (!search) throw new Error("Missing domain search");
    setInput(search, "hosted-web");
    expect(visibleHostnames()).toEqual(["middle.web.example.com"]);

    setInput(search, "");
    click(button(/^Needs DNS\s*1$/u));
    expect(visibleHostnames()).toEqual(["alpha.links.example.com"]);
    expect(button(/^Needs DNS\s*1$/u).getAttribute("aria-pressed")).toBe(
      "true",
    );

    click(button(/^All\s*3$/u));
    const sort = document.querySelector<HTMLSelectElement>(".cd-sort select");
    if (!sort) throw new Error("Missing domain sort");
    setSelect(sort, "domain");
    expect(visibleHostnames()).toEqual([
      "alpha.links.example.com",
      "middle.web.example.com",
      "zeta.forms.example.com",
    ]);

    const open = button(
      "Open DNS ownership details for alpha.links.example.com",
    );
    click(open);
    expect(
      document.querySelector(
        '[role="dialog"][aria-label="DNS ownership details for alpha.links.example.com"]',
      ),
    ).not.toBeNull();
  });

  it("explains why genuine empty registration is intentionally held", async () => {
    mocks.listCustomDomains.mockResolvedValueOnce({ data: [] });
    renderRoute();
    await settle();

    expect(document.body.textContent).toContain(
      "The ownership registry is empty.",
    );
    expect(document.body.textContent).toContain(
      "New hostname intake is intentionally held",
    );
    expect(document.body.textContent).toContain(
      "Registration unavailable · Existing sending domains are managed in Deliverability",
    );
    expect(button("Register hostname").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });
});

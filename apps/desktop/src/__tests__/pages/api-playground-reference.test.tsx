// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  APIPlaygroundReference,
  apiPlaygroundReferenceOperationKey,
} from "../../pages/APIPlaygroundReference";
import type { NormalizedPlaygroundOperation } from "../../pages/api-playground-openapi";

vi.mock("../../components/playground/Copy", () => ({
  CopyButton: ({
    value,
    label,
    ariaLabel,
  }: {
    value: string;
    label?: string;
    ariaLabel?: string;
  }) => (
    <button type="button" data-copy-value={value} aria-label={ariaLabel}>
      {label}
    </button>
  ),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function operation(
  overrides: Partial<NormalizedPlaygroundOperation> = {},
): NormalizedPlaygroundOperation {
  return {
    method: "get",
    path: "/api/v1/reports",
    operationId: "listReports",
    summary: "List reports",
    description: "Returns reports visible to the current workspace.",
    tags: ["Reports"],
    primaryTag: "Reports",
    deprecated: false,
    parameters: [],
    responses: {
      statuses: ["200"],
      mediaTypes: ["application/json"],
      mediaTypesByStatus: { "200": ["application/json"] },
      private: false,
    },
    security: [{ schemes: ["bearerAuth"] }],
    explicitlyPublic: false,
    requiredRole: "viewer",
    requiredScopes: ["read:reports"],
    requiredScopeMode: "all",
    bodyless: true,
    contractIssues: [],
    ...overrides,
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
}

function click(button: HTMLButtonElement): void {
  act(() => button.click());
}

function button(label: string): HTMLButtonElement {
  const candidate = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((item) => item.textContent?.trim() === label);
  if (!candidate) throw new Error("Missing button: " + label);
  return candidate;
}

function changeSearch(value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    'input[type="search"]',
  );
  if (!input) throw new Error("Missing search input");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function chooseTag(value: string): void {
  const select = document.querySelector<HTMLSelectElement>("select");
  if (!select) throw new Error("Missing tag select");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function statusText(): string {
  return (
    document.querySelector<HTMLElement>(".pwar__filter-summary [role=status]")
      ?.textContent ?? ""
  );
}

async function expectNoSeriousAxeViolations(): Promise<void> {
  const result = await axe.run(container ?? document.body, {
    rules: { region: { enabled: false } },
  });
  expect(
    result.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    ),
  ).toEqual([]);
}

describe("APIPlaygroundReference", () => {
  it("virtualizes a large normalized catalog and exposes one selected detail", async () => {
    const operations = Array.from({ length: 2_000 }, (_, index) =>
      operation({
        path: "/api/v1/reports/" + String(index),
        operationId: "getReport" + String(index),
        summary: "Get report " + String(index),
      }),
    );

    render(<APIPlaygroundReference operations={operations} listHeight={340} />);
    await flush();

    const list = document.querySelector<HTMLElement>(
      '[role="list"][aria-label="API operations"]',
    );
    const mountedRows =
      list?.querySelectorAll<HTMLElement>('[role="listitem"]') ?? [];
    expect(list).toBeTruthy();
    expect(statusText()).toContain("2000 of 2000 operations");
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThan(20);
    expect(mountedRows[0]?.getAttribute("aria-posinset")).toBe("1");
    expect(mountedRows[0]?.getAttribute("aria-setsize")).toBe("2000");
    expect(document.querySelectorAll("article.pwar__detail")).toHaveLength(1);
    expect(
      document.querySelectorAll<HTMLButtonElement>(".pwar__operation")[0]?.type,
    ).toBe("button");
  });

  it("renders the complete normalized contract and accessible copyable route", async () => {
    const selected = operation({
      method: "post",
      path: "/api/v1/accounts/{account_id}/exports",
      operationId: "createAccountExport",
      summary: "Create account export",
      description: "Queues a private export for the selected account.",
      tags: ["Exports", "Accounts"],
      primaryTag: "Exports",
      deprecated: true,
      parameters: [
        {
          name: "account_id",
          location: "path",
          required: true,
          description: "Path-level inherited account identifier.",
          schema: { type: "string", format: "uuid" },
          example: "account-123",
          style: "simple",
          explode: false,
        },
        {
          name: "cursor",
          location: "query",
          required: false,
          description: "Pagination cursor.",
          schema: { type: "string" },
        },
        {
          name: "Idempotency-Key",
          location: "header",
          required: true,
          description: "Deduplicates export requests.",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        description: "Export selection.",
        mediaTypes: [
          "application/json",
          "application/vnd.postwave.export+json",
        ],
        selectedMediaType: "application/json",
        schema: {
          type: "object",
          required: ["format"],
          properties: { format: { type: "string" } },
        },
        example: { format: "csv" },
        exampleSource: "explicit",
      },
      responses: {
        statuses: ["201", "400", "default"],
        mediaTypes: ["application/json", "application/problem+json"],
        mediaTypesByStatus: {
          "201": ["application/json"],
          "400": ["application/problem+json"],
          default: [],
        },
        private: true,
      },
      security: [
        { schemes: ["sessionCookie", "bearerAuth"] },
        { schemes: ["serviceToken"] },
      ],
      requiredRole: "owner",
      requiredScopes: ["exports:write", "accounts:read"],
      requiredScopeMode: "all",
      releaseHold: "Blocked until desktop export review is complete.",
      maxBodyBytes: 1_048_576,
      bodyless: false,
      contractIssues: [
        "Missing 429 response.",
        "Header schema needs an example.",
      ],
    });

    render(<APIPlaygroundReference operations={[selected]} listHeight={280} />);
    await flush();

    const content = container?.textContent ?? "";
    expect(content).toContain("Path-level inherited account identifier.");
    expect(content).toContain("account_id");
    expect(content).toContain("cursor");
    expect(content).toContain("Idempotency-Key");
    expect(
      Array.from(document.querySelectorAll("summary")).map((summary) =>
        summary.getAttribute("aria-label"),
      ),
    ).toEqual(
      expect.arrayContaining([
        "Example for account_id",
        "Schema for account_id",
        "Schema for cursor",
        "Schema for Idempotency-Key",
      ]),
    );
    expect(content).toContain("application/vnd.postwave.export+json");
    expect(content).toContain("application/problem+json");
    expect(content).toContain("201, 400, default");
    expect(content).toContain("No response body media declared");
    expect(content).toContain("sessionCookie + bearerAuth");
    expect(content).toContain("serviceToken");
    expect(content).toContain("owner");
    expect(content).toContain("exports:write, accounts:read");
    expect(content).toContain(
      "Blocked until desktop export review is complete.",
    );
    expect(content).toContain("Private response");
    expect(
      document.querySelector(
        '[role="region"][aria-label="Request schema JSON"]',
      ),
    ).toBeNull();
    const schemaDisclosure = Array.from(
      document.querySelectorAll<HTMLDetailsElement>("details.pwar__json"),
    ).find(
      (details) =>
        details.querySelector("summary")?.textContent === "Request schema",
    );
    act(() => {
      if (schemaDisclosure) {
        schemaDisclosure.open = true;
        schemaDisclosure.dispatchEvent(new Event("toggle"));
      }
    });
    expect(
      document.querySelector(
        '[role="region"][aria-label="Request schema JSON"]',
      ),
    ).not.toBeNull();
    const accountSchema = Array.from(
      document.querySelectorAll<HTMLDetailsElement>("details.pwar__json"),
    ).find(
      (details) =>
        details.querySelector("summary")?.getAttribute("aria-label") ===
        "Schema for account_id",
    );
    act(() => {
      if (accountSchema) {
        accountSchema.open = true;
        accountSchema.dispatchEvent(new Event("toggle"));
      }
    });
    expect(
      document.querySelector(
        '[role="region"][aria-label="Schema for account_id JSON"]',
      ),
    ).not.toBeNull();
    expect(content).toContain("Deprecated");
    expect(content).toContain("Missing 429 response.");
    expect(content).toContain("1.0 MiB");
    expect(
      document
        .querySelector('[aria-label^="Copy route"]')
        ?.getAttribute("data-copy-value"),
    ).toBe("POST /api/v1/accounts/{account_id}/exports");
    expect(document.querySelectorAll("article.pwar__detail")).toHaveLength(1);
    expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).every(
        (item) => item.type === "button",
      ),
    ).toBe(true);
    await expectNoSeriousAxeViolations();
  });

  it("combines method, tag, and deferred text filters with honest live states", async () => {
    const operations = [
      operation(),
      operation({
        method: "post",
        path: "/api/v1/campaigns",
        operationId: "createCampaign",
        summary: "Create campaign",
        tags: ["Campaigns"],
        primaryTag: "Campaigns",
        requiredScopes: ["campaigns:write"],
        bodyless: false,
      }),
      operation({
        method: "delete",
        path: "/api/v1/campaigns/{campaign_id}",
        operationId: "deleteCampaign",
        summary: "Delete campaign",
        tags: ["Campaigns"],
        primaryTag: "Campaigns",
        requiredRole: "owner",
        requiredScopes: ["campaigns:delete"],
      }),
    ];
    const onSelection = vi.fn();

    render(
      <APIPlaygroundReference
        operations={operations}
        onSelectedOperationChange={onSelection}
        listHeight={300}
      />,
    );
    await flush();

    click(button("POST"));
    expect(statusText()).toContain("1 of 3 operations");
    click(button("All"));
    chooseTag("Campaigns");
    expect(statusText()).toContain("2 of 3 operations");

    changeSearch("owner campaigns:delete");
    await flush();
    expect(statusText()).toContain("1 of 3 operations");
    const selectedButton =
      document.querySelector<HTMLButtonElement>(".pwar__operation");
    expect(selectedButton?.textContent).toContain(
      "/api/v1/campaigns/{campaign_id}",
    );
    click(selectedButton!);
    expect(onSelection).toHaveBeenCalledWith(operations[2]);
    expect(
      document.querySelector("article.pwar__detail")?.textContent,
    ).toContain("Delete campaign");

    changeSearch("definitely absent from this contract");
    await flush();
    expect(statusText()).toContain("0 of 3 operations");
    expect(container?.textContent).toContain("No operations match");
    expect(container?.textContent).toContain(
      "Change the search, method, or tag filters",
    );
    click(
      document.querySelector<HTMLButtonElement>(".pwar__no-results button")!,
    );
    await flush();
    expect(statusText()).toContain("3 of 3 operations");
  });

  it("does not pretend an absent contract is merely a filtered catalog", () => {
    render(<APIPlaygroundReference operations={[]} />);

    expect(container?.textContent).toContain("API contract is empty");
    expect(container?.textContent).toContain(
      "No supported normalized operations were supplied.",
    );
    expect(document.querySelector('[aria-label="API operations"]')).toBeNull();
  });

  it("uses the stable method and path identity contract", () => {
    const selected = operation({
      method: "patch",
      path: "/api/v1/reports/{report_id}",
      operationId: "updateReport",
      summary: "Update report",
    });
    expect(apiPlaygroundReferenceOperationKey(selected)).toBe(
      "PATCH /api/v1/reports/{report_id}",
    );

    render(
      <APIPlaygroundReference
        operations={[operation(), selected]}
        selectedOperationKey="PATCH /api/v1/reports/{report_id}"
      />,
    );
    expect(
      document.querySelector("article.pwar__detail")?.textContent,
    ).toContain("Update report");
    expect(
      document.querySelectorAll('.pwar__operation[aria-pressed="true"]'),
    ).toHaveLength(1);
  });
});

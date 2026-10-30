// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { APIPlaygroundWorkbench } from "../../pages/APIPlaygroundWorkbench";
import openapi from "../../../../../packages/openapi/openapi.json";
import {
  PLAYGROUND_PARAMETER_ENUM_MAX_VALUES,
  normalizePlaygroundCatalog,
  type NormalizedPlaygroundOperation,
} from "../../pages/api-playground-openapi";
import { executionPolicyFor } from "../../pages/api-playground-policy";
import {
  PLAYGROUND_HEADER_VALUE_MAX_BYTES,
  PLAYGROUND_PATH_VALUE_MAX_BYTES,
  PLAYGROUND_QUERY_MAX_BYTES,
  PLAYGROUND_REQUEST_BODY_MAX_BYTES,
  buildPlaygroundRequest,
} from "../../pages/api-playground-request";
import type { PlaygroundTransportResponse } from "../../pages/api-playground-transport";
import type {
  PlaygroundDraft,
  PlaygroundReviewSnapshot,
  PlaygroundWorkbenchController,
} from "../../pages/api-playground-workbench-state";

vi.mock("../../components/playground/Copy", () => ({
  CopyButton: ({ value, label }: { value: string; label?: string }) => (
    <button type="button" data-copy-value={value}>
      {label ?? "Copy"}
    </button>
  ),
}));

vi.mock("../../components/playground/PlaygroundCodeGen", () => ({
  PlaygroundCodeGen: ({ plan }: { plan: { url: string } }) => (
    <output data-code-url={plan.url}>Portable code preview</output>
  ),
}));

const API_URL = "https://api.postwave.test";
const ENVIRONMENT = {
  host: "api.postwave.test",
  kind: "non-production" as const,
  label: "Non-production",
  tone: "warning" as const,
};
const LIVE_REVIEWED_OPERATIONS = new Map(
  normalizePlaygroundCatalog(openapi).operations.map((item) => [
    `${item.method.toUpperCase()} ${item.path}`,
    item,
  ]),
);

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
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function operation(
  overrides: Partial<NormalizedPlaygroundOperation> = {},
): NormalizedPlaygroundOperation {
  return {
    method: "get",
    path: "/api/v1/tags",
    operationId: "listTags",
    summary: "List tags",
    description: "Lists tags visible to the current workspace.",
    tags: ["Tags"],
    primaryTag: "Tags",
    deprecated: false,
    parameters: [],
    responses: {
      statuses: ["200"],
      mediaTypes: ["application/json"],
      mediaTypesByStatus: { "200": ["application/json"] },
      private: true,
    },
    security: [{ schemes: ["bearerAuth"] }],
    explicitlyPublic: false,
    requiredRole: "viewer",
    requiredScopes: ["read:tags"],
    requiredScopeMode: "all",
    bodyless: true,
    contractIssues: [],
    ...overrides,
  };
}

function draft(overrides: Partial<PlaygroundDraft> = {}): PlaygroundDraft {
  return {
    path: {},
    query: {},
    headers: {},
    customHeaders: [],
    body: "",
    idempotencyKey: "",
    touched: false,
    ...overrides,
  };
}

function response(
  overrides: Partial<PlaygroundTransportResponse> = {},
): PlaygroundTransportResponse {
  return {
    status: 200,
    statusText: "OK",
    body: '{"ok":true}',
    headers: { "content-type": "application/json" },
    contentType: "application/json",
    previewBytes: 11,
    truncated: false,
    durationMs: 15,
    outcome: "http",
    ambiguous: false,
    requestId: "request-1",
    ...overrides,
  };
}

function controllerFor(
  selected: NormalizedPlaygroundOperation,
  values = draft(),
  overrides: Partial<PlaygroundWorkbenchController> = {},
): PlaygroundWorkbenchController {
  const policy = executionPolicyFor(selected);
  const request = buildPlaygroundRequest(API_URL, selected, policy, values);
  return {
    selectedKey: `${selected.method.toUpperCase()} ${selected.path}`,
    selected,
    select: vi.fn(),
    draft: values,
    updateDraft: vi.fn(),
    updateDraftMap: vi.fn(),
    request,
    policy,
    response: null,
    sending: false,
    review: null,
    setReview: vi.fn(),
    requestSend: vi.fn(async () => undefined),
    confirmSend: vi.fn(async () => undefined),
    cancel: vi.fn(),
    newAttempt: vi.fn(),
    replay: vi.fn(),
    ...overrides,
  };
}

function renderWorkbench({
  operations,
  controller,
  favorites = new Set<string>(),
  role = "admin",
  onToggleFavorite = vi.fn(),
  workspaceLabel = "Workspace Alpha",
}: {
  operations: NormalizedPlaygroundOperation[];
  controller: PlaygroundWorkbenchController;
  favorites?: ReadonlySet<string>;
  role?: string;
  onToggleFavorite?: (key: string) => void;
  workspaceLabel?: string;
}): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <APIPlaygroundWorkbench
        operations={operations}
        controller={controller}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
        environment={ENVIRONMENT}
        workspaceLabel={workspaceLabel}
        principalLabel="developer@example.com"
        effectiveRole={role}
      />,
    ),
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function setValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}

function primaryAction(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    ".play-sticky-actions > .btn-primary",
  );
  if (!button) throw new Error("Missing workbench primary action");
  return button;
}

function reviewSnapshot(
  target: NormalizedPlaygroundOperation,
  values: PlaygroundDraft,
): PlaygroundReviewSnapshot {
  const policy = executionPolicyFor(target);
  const request = buildPlaygroundRequest(API_URL, target, policy, values);
  return {
    operation: target,
    policy,
    request,
    bodyBytes: new TextEncoder().encode(request.plan.body).byteLength,
    values,
  };
}

describe("APIPlaygroundWorkbench", () => {
  it("virtualizes one catalog and mounts each favorite action once", () => {
    const operations = Array.from({ length: 1_000 }, (_, index) =>
      operation({
        path: `/api/v1/catalog/${index}`,
        operationId: `catalogItem${index}`,
        summary: `Catalog item ${index}`,
      }),
    );
    const favoriteKey = "GET /api/v1/catalog/999";
    renderWorkbench({
      operations,
      controller: controllerFor(operations[0]!),
      favorites: new Set([favoriteKey]),
    });

    const list = document.querySelector<HTMLElement>(
      '[role="list"][aria-label="Filtered API operations"]',
    );
    const rows = Array.from(
      list?.querySelectorAll<HTMLElement>('[role="listitem"]') ?? [],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(30);
    const mountedPaths = rows.map(
      (row) => row.querySelector(".play-endpoint-copy code")?.textContent,
    );
    expect(new Set(mountedPaths).size).toBe(mountedPaths.length);
    expect(
      document.querySelectorAll(
        `[aria-label="Remove ${favoriteKey} from favorites"]`,
      ),
    ).toHaveLength(1);
  });

  it("provides explicit filter labels and an honest combined empty state", async () => {
    const operations = [
      operation(),
      operation({
        method: "post",
        path: "/api/v1/tags",
        operationId: "createTag",
        summary: "Create tag",
        requiredRole: "editor",
        requiredScopes: ["write:tags"],
      }),
      operation({
        path: "/api/v1/unreviewed",
        operationId: "unreviewed",
        summary: "Unreviewed route",
        primaryTag: "Reference",
        tags: ["Reference"],
      }),
    ];
    renderWorkbench({
      operations,
      controller: controllerFor(operations[0]!),
    });

    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    const selects = Array.from(document.querySelectorAll("select"));
    expect(search?.labels?.[0]?.textContent).toContain("Search endpoints");
    expect(search?.maxLength).toBe(200);
    expect(
      selects.map((item) =>
        item.labels?.[0]?.querySelector(":scope > span")?.textContent?.trim(),
      ),
    ).toEqual(["Method", "Availability", "Tag"]);
    expect(
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.labels?.[0]?.textContent,
    ).toContain("Favorites only");

    act(() => setValue(search!, "x".repeat(500)));
    await flush();
    expect(search?.value).toHaveLength(200);
    act(() => setValue(search!, ""));
    await flush();

    act(() => setValue(selects[0]!, "post"));
    await flush();
    expect(
      document.querySelector(".play-navigator-heading .badge")?.textContent,
    ).toContain("1 / 3");
    act(() => setValue(search!, "definitely-no-match"));
    await flush();
    const empty = document.querySelector<HTMLElement>(
      ".pw-windowed-list__empty[role=status]",
    );
    expect(empty?.textContent).toContain("No operations match.");
    expect(empty?.textContent).toContain("Clear a filter");
  });

  it("exposes the specific reference-only reason and disables execution", () => {
    const reference = operation({
      path: "/api/v1/unreviewed",
      operationId: "unreviewed",
      summary: "Unreviewed route",
    });
    const controller = controllerFor(reference);
    const reason = controller.policy.reason;
    renderWorkbench({ operations: [reference], controller });

    expect(reason).toContain("Not yet reviewed for live execution");
    expect(document.body.textContent).toContain(reason);
    expect(primaryAction().disabled).toBe(true);
    expect(
      document
        .querySelector(".play-availability-dot")
        ?.getAttribute("aria-label"),
    ).toContain(reason);
  });

  it("does not materialize oversized parameter enums as DOM options", () => {
    const target = operation({
      parameters: [
        {
          name: "status",
          location: "query",
          required: false,
          schema: {
            type: "string",
            enum: Array.from(
              { length: PLAYGROUND_PARAMETER_ENUM_MAX_VALUES + 1 },
              (_, index) => `status-${index}`,
            ),
          },
        },
      ],
      contractIssues: ["query parameter status declares too many enum values"],
    });
    renderWorkbench({
      operations: [target],
      controller: controllerFor(target),
    });

    const field = document.querySelector(".api-playground-param");
    expect(field?.querySelector("select")).toBeNull();
    expect(field?.querySelector('input[type="text"]')).not.toBeNull();
    expect(document.body.textContent).toContain("too many enum values");
    expect(primaryAction().disabled).toBe(true);
  });

  it.each([
    ["viewer", "read", false],
    ["viewer", "edit", true],
    ["editor", "edit", false],
    ["editor", "admin", true],
    ["admin", "admin", false],
  ] as const)(
    "gates %s authority against a %s operation",
    (role, kind, disabled) => {
      const target = structuredClone(
        LIVE_REVIEWED_OPERATIONS.get("GET /api/v1/tags")!,
      );
      const requiredRole =
        kind === "read" ? "viewer" : kind === "edit" ? "editor" : "admin";
      const baseController = controllerFor(target);
      renderWorkbench({
        operations: [target],
        controller: {
          ...baseController,
          policy: { ...baseController.policy, requiredRole },
        },
        role,
      });

      expect(primaryAction().disabled).toBe(disabled);
      if (disabled) {
        expect(
          document.querySelector(".play-sticky-actions [role=status]")
            ?.textContent,
        ).toContain(`Effective role ${role}`);
      }
    },
  );

  it("associates required path, query, header, and body errors with inputs", () => {
    const target = operation({
      method: "patch",
      path: "/api/v1/tags/{id}",
      operationId: "updateTag",
      summary: "Update tag",
      requiredRole: "admin",
      requiredScopes: ["write:tags"],
      parameters: [
        { name: "id", location: "path", required: true },
        {
          name: "mode",
          location: "query",
          required: true,
          schema: { type: "integer" },
        },
        { name: "If-Match", location: "header", required: true },
      ],
      requestBody: {
        required: true,
        mediaTypes: ["application/json"],
        selectedMediaType: "application/json",
      },
      bodyless: false,
    });
    renderWorkbench({
      operations: [target],
      controller: controllerFor(target),
      role: "admin",
    });

    const alerts = Array.from(
      document.querySelectorAll<HTMLElement>('[role="alert"]'),
    ).map((item) => item.textContent);
    expect(alerts).toEqual(
      expect.arrayContaining([
        "id is required.",
        "mode is required.",
        "If-Match is required.",
        "Request body is required.",
      ]),
    );
    expect(document.querySelectorAll('[aria-invalid="true"]')).toHaveLength(4);
    const fields = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        ".api-playground-param input",
      ),
    );
    expect(fields.map((field) => field.maxLength)).toEqual([
      PLAYGROUND_PATH_VALUE_MAX_BYTES,
      PLAYGROUND_QUERY_MAX_BYTES,
      PLAYGROUND_HEADER_VALUE_MAX_BYTES,
    ]);
    expect(fields[1]).toMatchObject({ type: "text", inputMode: "decimal" });
    expect(fields.every((field) => field.required)).toBe(true);
    expect(
      document.querySelector<HTMLTextAreaElement>(".api-playground-body")
        ?.maxLength,
    ).toBe(PLAYGROUND_REQUEST_BODY_MAX_BYTES);
    expect(
      document.querySelector<HTMLTextAreaElement>(".api-playground-body")
        ?.required,
    ).toBe(true);
    expect(primaryAction().disabled).toBe(true);
  });

  it("keeps the in-flight cancel action visible and wired", () => {
    const target = operation();
    const cancel = vi.fn();
    renderWorkbench({
      operations: [target],
      controller: controllerFor(target, draft(), {
        sending: true,
        cancel,
      }),
      role: "viewer",
    });

    expect(primaryAction().textContent).toContain("Request in flight");
    expect(primaryAction().disabled).toBe(true);
    const cancelButton = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel request",
    );
    act(() => cancelButton?.click());
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("renders the frozen exact mutation URL, headers, and body before confirm", async () => {
    const target = operation({
      method: "post",
      path: "/api/v1/tags",
      operationId: "createTag",
      summary: "Create tag",
      requiredRole: "editor",
      requiredScopes: ["write:tags"],
      parameters: [
        {
          name: "Idempotency-Key",
          location: "header",
          required: true,
        },
      ],
      requestBody: {
        required: true,
        mediaTypes: ["application/json"],
        selectedMediaType: "application/json",
      },
      bodyless: false,
    });
    const values = draft({
      body: '{"name":"VIP"}',
      idempotencyKey: "idem-exact",
    });
    const snapshot = reviewSnapshot(target, values);
    const confirmSend = vi.fn(async () => undefined);
    renderWorkbench({
      operations: [target],
      controller: controllerFor(target, values, {
        review: snapshot,
        confirmSend,
      }),
      role: "editor",
    });

    const review = document.querySelector(".play-exact-review");
    expect(review?.textContent).toContain(
      "https://api.postwave.test/api/v1/tags",
    );
    expect(review?.textContent).toContain("Idempotency-Key");
    expect(review?.textContent).toContain("idem-exact");
    expect(review?.textContent).toContain('{"name":"VIP"}');
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Send mutation",
    );
    await act(async () => confirm?.click());
    expect(confirmSend).toHaveBeenCalledTimes(1);
  });

  it("requires the resolved destructive path and workspace phrase", async () => {
    const target = operation({
      method: "delete",
      path: "/api/v1/tags/{id}",
      operationId: "deleteTag",
      summary: "Delete tag",
      requiredRole: "admin",
      requiredScopes: ["write:tags"],
      parameters: [{ name: "id", location: "path", required: true }],
    });
    const values = draft({ path: { id: "team tag" } });
    const snapshot = reviewSnapshot(target, values);
    const phrase = "DELETE /api/v1/tags/team%20tag @ Workspace Alpha";
    renderWorkbench({
      operations: [target],
      controller: controllerFor(target, values, { review: snapshot }),
      role: "admin",
    });

    const input = document.querySelector<HTMLInputElement>(
      `input[placeholder="${phrase}"]`,
    );
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Run destructive request",
    );
    expect(document.body.textContent).toContain(phrase);
    expect(confirm?.disabled).toBe(true);
    act(() => setValue(input!, phrase));
    await flush();
    expect(confirm?.disabled).toBe(false);
  });

  it("shows ambiguous-outcome guidance beside the retained key and verified-state fresh attempt", () => {
    const target = operation({
      method: "post",
      path: "/api/v1/tags",
      operationId: "createTag",
      summary: "Create tag",
      requiredRole: "editor",
      requiredScopes: ["write:tags"],
      parameters: [
        {
          name: "Idempotency-Key",
          location: "header",
          required: true,
        },
      ],
    });
    const values = draft({ idempotencyKey: "idem-retained" });
    const newAttempt = vi.fn();
    renderWorkbench({
      operations: [target],
      controller: controllerFor(target, values, {
        response: response({
          status: 503,
          statusText: "Unavailable",
          ambiguous: true,
        }),
        newAttempt,
      }),
      role: "editor",
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Keep the same idempotency key",
    );
    expect(
      document.querySelector(".play-response")?.hasAttribute("aria-live"),
    ).toBe(false);
    expect(
      document.querySelector('.play-response [role="status"]')?.textContent,
    ).toContain("503");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Idempotency-Key value"]',
      )?.value,
    ).toBe("idem-retained");
    const button = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === "I verified state · New attempt",
    );
    act(() => button?.click());
    expect(newAttempt).toHaveBeenCalledTimes(1);
  });

  it("requires verified-state acknowledgement for a non-idempotent ambiguous mutation", () => {
    const target = operation({
      method: "post",
      path: "/api/v1/tags",
      operationId: "createTag",
      summary: "Create tag",
      requiredRole: "editor",
      requiredScopes: ["write:tags"],
    });
    const newAttempt = vi.fn();
    renderWorkbench({
      operations: [target],
      controller: controllerFor(target, draft(), {
        response: response({ status: 503, ambiguous: true }),
        newAttempt,
      }),
      role: "editor",
    });

    const review = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === "Review exact request",
    );
    expect(review?.disabled).toBe(true);
    const acknowledge = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent === "I verified state · New attempt",
    );
    act(() => acknowledge?.click());
    expect(newAttempt).toHaveBeenCalledTimes(1);
  });

  it("never presents a response-contract failure as a green HTTP success", () => {
    const target = operation();
    renderWorkbench({
      operations: [target],
      controller: controllerFor(target, draft(), {
        response: response({
          status: 201,
          statusText: "Invalid JSON response",
          outcome: "contract",
          ambiguous: true,
        }),
      }),
    });

    const badge = document.querySelector(".play-response-summary .badge");
    expect(badge?.textContent).toContain("201");
    expect(badge?.classList.contains("danger")).toBe(true);
    expect(
      document.querySelector(".play-response-summary")?.textContent,
    ).toContain("contract");
  });

  it("parses one retained JSON response only once across response-tab rerenders", () => {
    const body = '{"items":[1,2,3]}';
    const parse = vi.spyOn(JSON, "parse");
    const target = operation();
    renderWorkbench({
      operations: [target],
      controller: controllerFor(target, draft(), {
        response: response({
          body,
          previewBytes: body.length,
          contentType: "application/json",
        }),
      }),
    });
    const parsesOfResponse = (): number =>
      parse.mock.calls.filter(([value]) => value === body).length;
    expect(parsesOfResponse()).toBe(1);

    const responseTab = (label: string): HTMLButtonElement => {
      const match = Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[role="tablist"][aria-label="Response content"] [role="tab"]',
        ),
      ).find((button) => button.textContent?.startsWith(label));
      if (!match) throw new Error(`Missing response tab ${label}`);
      return match;
    };
    act(() => responseTab("Headers").click());
    act(() => responseTab("Body").click());
    expect(parsesOfResponse()).toBe(1);
  });
});

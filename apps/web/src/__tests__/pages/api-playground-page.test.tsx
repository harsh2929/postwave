// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// /app/developer-reference/playground — driven through the real page against
// a routed fetch stub serving a small OpenAPI 3.1 contract. Assertions are on
// CONSEQUENCES: the contract request, the exact request each verb sends
// (method, URL, headers, body) or does NOT send, the review's copy, what the
// page renders afterwards, and what local history holds.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WHOAMI } from "./_harness";
import { waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({ whoami: vi.fn() }));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => createElement("a", { href, ...rest }, children),
}));

import ApiPlaygroundPage from "@/app/(dashboard)/app/developer-reference/playground/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE = `${WHOAMI.tenant_id}:${WHOAMI.user_id}`;
const HISTORY_KEY = `postwave:api-playground:history:v1:${SCOPE}`;
const FAVORITES_KEY = `postwave:api-playground:favorites:v1:${SCOPE}`;
const HOLD_SENTENCE =
  "Campaign listing is release-held for this workspace until the operator enables it.";
const DELETE_SENTENCE = "Permanent tag deletion is disabled; archive the tag instead.";

// The REAL contract, pruned to four path items (components kept whole so every
// $ref resolves exactly as in production). Execution is pinned to reviewed
// fingerprints of the live contract, so a hand-written fixture could never
// run anything — which is the point of the pin.
const REAL_SPEC = JSON.parse(
  readFileSync(resolve(process.cwd(), "../api/internal/apidocs/openapi.json"), "utf8"),
) as { paths: Record<string, Record<string, { tags?: string[] }>> } & Record<string, unknown>;
const FIXTURE_PATHS = [
  "/api/v1/campaigns", // GET reviewed read; POST not reviewed
  "/api/v1/referrals/payouts", // GET release-held
  "/api/v1/tags", // GET reviewed read; POST reviewed write
  "/api/v1/tags/{id}", // PATCH reviewed write; DELETE reviewed destructive
];
const SPEC = {
  ...REAL_SPEC,
  paths: Object.fromEntries(FIXTURE_PATHS.map((path) => [path, REAL_SPEC.paths[path]])),
};
const SPEC_TEXT = JSON.stringify(SPEC);
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
/** Operations in the served contract matching `where` — counted from the raw document. */
function rawCount(where: (path: string, method: string, tags: string[]) => boolean): number {
  let count = 0;
  for (const [path, item] of Object.entries(SPEC.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (HTTP_METHODS.includes(method) && where(path, method, operation.tags ?? [])) count += 1;
    }
  }
  return count;
}
const TOTAL = rawCount(() => true);

interface Call {
  method: string;
  path: string;
  headers: Headers;
  body: string | undefined;
  credentials: RequestCredentials | undefined;
}

type Responder = (call: Call, init?: RequestInit) => Response | Promise<Response>;

let calls: Call[] = [];
let specResponder: () => Response;
let responder: Responder;
let root: Root | null = null;

function json(status: number, body: unknown, statusText = "") {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://postwave.test");
      const call: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname + url.search,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
        credentials: init?.credentials,
      };
      calls.push(call);
      if (url.pathname === "/api/v1/openapi.json") return specResponder();
      return responder(call, init);
    }),
  );
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function text(): string {
  return document.body.textContent ?? "";
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

async function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  const proto =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

function workbench(): HTMLElement {
  const section = document.querySelector<HTMLElement>('section[aria-label="Request workbench"]');
  if (!section) throw new Error("Request workbench not rendered");
  return section;
}

/** The input a workbench label (`<code>name</code>`) points at. */
function field(name: string): HTMLInputElement {
  const label = Array.from(workbench().querySelectorAll("label")).find(
    (candidate) => candidate.querySelector("code")?.textContent === name,
  );
  const input = label ? document.getElementById(label.htmlFor) : null;
  if (!input) throw new Error(`Field not found: ${name}`);
  return input as HTMLInputElement;
}

async function selectOperation(method: string, path: string): Promise<void> {
  const catalog = document.querySelector('aside[aria-label="Operation catalog"]');
  const match = Array.from(catalog?.querySelectorAll("button") ?? []).find(
    (candidate) =>
      candidate.querySelector("code")?.textContent === path &&
      candidate.textContent?.startsWith(method.toLowerCase()),
  );
  if (!match) throw new Error(`Operation not found: ${method} ${path}`);
  await click(match);
  await waitFor(() => expect(workbench().querySelector("code")?.textContent).toBe(path));
}

async function openTab(label: string): Promise<void> {
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
  if (!tab) throw new Error(`Tab not found: ${label}`);
  await click(tab);
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function sent(method: string, prefix: string): Call[] {
  return calls.filter((call) => call.method === method && call.path.startsWith(prefix));
}

async function render(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(QueryClientProvider, { client }, createElement(ApiPlaygroundPage)),
    );
  });
}

async function renderReady(): Promise<void> {
  await render();
  // The workspace is a next/dynamic chunk; give its first mount a bounded
  // moment before the catalog is read.
  const catalog = () =>
    document.querySelector('aside[aria-label="Operation catalog"]');
  const deadline = Date.now() + 10_000;
  while (catalog() === null && Date.now() < deadline) {
    await act(flush);
  }
  expect(catalog()).not.toBeNull();
}

beforeEach(() => {
  calls = [];
  window.localStorage.clear();
  mocks.whoami.mockResolvedValue(WHOAMI);
  specResponder = () =>
    new Response(SPEC_TEXT, { status: 200, headers: { "content-type": "application/json" } });
  responder = () => json(200, { tags: [{ id: "t1", name: "VIP" }] }, "OK");
  installFetch();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const FLOW_TIMEOUT = { timeout: 20_000 };

describe("API playground — send request (platform-126)", FLOW_TIMEOUT, () => {
  it("loads the live contract once, then sends a read on click with the session and exact query", async () => {
    await renderReady();
    expect(sent("GET", "/api/v1/openapi.json")).toHaveLength(1);
    expect(sent("GET", "/api/v1/openapi.json")[0]!.credentials).toBe("include");

    await selectOperation("GET", "/api/v1/tags");
    await setValue(field("query"), "VIP");
    await click(button("Send request"));

    await waitFor(() => expect(text()).toContain('"name": "VIP"'));
    const [read] = sent("GET", "/api/v1/tags");
    expect(sent("GET", "/api/v1/tags")).toHaveLength(1);
    // include_archived is seeded from the contract's declared default.
    expect(read!.path).toBe("/api/v1/tags?query=VIP&include_archived=false");
    expect(read!.body).toBeUndefined();
    expect(read!.credentials).toBe("include");
    expect(read!.headers.get("authorization")).toBeNull();
    expect(read!.headers.get("x-postwave-client")).toBe("web");
    // History keeps the template and outcome — never the value that was typed.
    const stored = window.localStorage.getItem(HISTORY_KEY) ?? "";
    expect(JSON.parse(stored)).toMatchObject([
      { method: "GET", pathTemplate: "/api/v1/tags", status: 200, outcome: "http" },
    ]);
    expect(stored).not.toContain("query=");
    expect(stored).not.toContain("VIP");
  });

  it("reviews a write before it leaves: cancel sends nothing, confirm sends exactly the reviewed request", async () => {
    responder = (call) =>
      call.method === "POST" ? json(201, { id: "t9", name: "VIP" }, "Created") : json(200, {});
    await renderReady();
    await selectOperation("POST", "/api/v1/tags");
    await setValue(workbench().querySelector("textarea")!, '{"name":"VIP"}');

    await click(button("Review request"));
    await waitFor(() => expect(dialog()).not.toBeNull());
    const review = dialog()!.textContent ?? "";
    expect(review).toContain("This sends one real POST to /api/v1/tags in QA workspace");
    expect(review).toContain("not a dry run");
    expect(review).toContain('{"name":"VIP"}');
    const reviewedKey = /"Idempotency-Key": "([^"]+)"/.exec(review)?.[1];
    expect(reviewedKey).toBeTruthy();

    await click(button("Cancel", dialog()!));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(sent("POST", "/api/v1/tags")).toHaveLength(0);

    await click(button("Review request"));
    await waitFor(() => expect(dialog()).not.toBeNull());
    await click(button("Send POST request", dialog()!));

    await waitFor(() => expect(text()).toContain('"id": "t9"'));
    const posts = sent("POST", "/api/v1/tags");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toBe('{"name":"VIP"}');
    expect(posts[0]!.headers.get("content-type")).toBe("application/json");
    expect(posts[0]!.headers.get("idempotency-key")).toBe(reviewedKey);

    // New attempt mints a fresh key, and the next send carries it.
    await click(button("New attempt"));
    await click(button("Review request"));
    await waitFor(() => expect(dialog()).not.toBeNull());
    await click(button("Send POST request", dialog()!));
    await waitFor(() => expect(sent("POST", "/api/v1/tags")).toHaveLength(2));
    const second = sent("POST", "/api/v1/tags")[1]!.headers.get("idempotency-key");
    expect(second).toBeTruthy();
    expect(second).not.toBe(reviewedKey);
  });

  it("cancels an in-flight write, reports it as ambiguous, and fences the edited request behind a new attempt", async () => {
    responder = (_call, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    await renderReady();
    await selectOperation("POST", "/api/v1/tags");
    await click(button("Review request"));
    await waitFor(() => expect(dialog()).not.toBeNull());
    await click(button("Send POST request", dialog()!));

    await waitFor(() => expect(button("Cancel request")).toBeTruthy());
    expect(button("Request in flight…").disabled).toBe(true);
    await click(button("Cancel request"));

    await waitFor(() => expect(text()).toContain("Outcome may be ambiguous"));
    expect(text()).toContain("Cancelled");
    expect(sent("POST", "/api/v1/tags")).toHaveLength(1);
    expect(button("I verified state · New attempt")).toBeTruthy();

    // The key is now bound to the exact cancelled request; editing the body
    // must not let the same key leave with different content.
    const textarea = workbench().querySelector("textarea")!;
    await setValue(textarea, '{"name":"Changed"}');
    await waitFor(() => expect(button("Review request").disabled).toBe(true));
    expect(text()).toContain("already sent with a different exact request");

    await click(button("I verified state · New attempt"));
    await waitFor(() => expect(button("Review request").disabled).toBe(false));
  });

  it("requires the route typed back before a DELETE leaves", async () => {
    responder = () =>
      json(409, { error: { code: "tag_delete_disabled", message: DELETE_SENTENCE } }, "Conflict");
    await renderReady();
    await selectOperation("DELETE", "/api/v1/tags/{id}");
    await setValue(field("id"), "42");
    await click(button("Review request"));
    await waitFor(() => expect(dialog()).not.toBeNull());

    const confirm = button("Run destructive request", dialog()!);
    expect(confirm.disabled).toBe(true);
    expect(dialog()!.textContent).toContain("Type DELETE /api/v1/tags/42 to confirm");
    const token = dialog()!.querySelector("input")!;
    await setValue(token, "DELETE /api/v1/tags/42");
    await waitFor(() => expect(button("Run destructive request", dialog()!).disabled).toBe(false));
    await click(button("Run destructive request", dialog()!));

    await waitFor(() => expect(sent("DELETE", "/api/v1/tags/")).toHaveLength(1));
    expect(sent("DELETE", "/api/v1/tags/")[0]!.path).toBe("/api/v1/tags/42");
    // The live contract says permanent deletion is disabled: the server's own
    // refusal is what the operator reads.
    await waitFor(() => expect(text()).toContain(DELETE_SENTENCE));
    expect(text()).toContain("The server refused this request");
  });

  it("withholds a write the effective role cannot perform, naming the role, and sends nothing", async () => {
    mocks.whoami.mockResolvedValue({ ...WHOAMI, role: "owner", effective_role: "viewer", viewer_mode: true });
    await renderReady();
    await selectOperation("POST", "/api/v1/tags");
    expect(button("Review request").disabled).toBe(true);
    expect(text()).toContain(
      "Your effective role (viewer) does not meet the editor role this operation requires.",
    );
    expect(sent("POST", "/api/v1/tags")).toHaveLength(0);
  });

  it("renders the server's own sentence for a 503 release hold", async () => {
    responder = () =>
      json(503, { error: { code: "release_held", message: HOLD_SENTENCE } }, "Service Unavailable");
    await renderReady();
    // The first runnable read is selected on arrival.
    expect(workbench().querySelector("code")?.textContent).toBe("/api/v1/campaigns");
    await click(button("Send request"));
    await waitFor(() => expect(text()).toContain(HOLD_SENTENCE));
    expect(text()).toContain("The server withheld this request");
  });

  it("keeps a release-held operation reference-only and names the hold", async () => {
    await renderReady();
    await selectOperation("GET", "/api/v1/referrals/payouts");
    expect(text()).toContain("Release hold: referrals_operational_runtime_held");
    expect(button("Send request").disabled).toBe(true);
    expect(calls.filter((call) => call.path.startsWith("/api/v1/referrals"))).toHaveLength(0);
  });

  it("keeps a write desktop never reviewed reference-only, says so, and sends nothing", async () => {
    await renderReady();
    await selectOperation("POST", "/api/v1/campaigns");
    expect(text()).toContain(
      "Not reviewed for live execution — reference only. Web runs only the operations desktop has reviewed.",
    );
    expect(button("Review request").disabled).toBe(true);
    await click(button("Review request"));
    expect(dialog()).toBeNull();
    expect(sent("POST", "/api/v1/campaigns")).toHaveLength(0);
  });

  it("persists favorites per workspace and principal", async () => {
    await renderReady();
    await click(
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Add DELETE /api/v1/tags/{id} to favorites"]',
      )!,
    );
    expect(JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? "[]")).toEqual([
      "DELETE /api/v1/tags/{id}",
    ]);
    expect(
      document
        .querySelector('button[aria-label="Remove DELETE /api/v1/tags/{id} from favorites"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("formats the JSON body in place", async () => {
    await renderReady();
    await selectOperation("POST", "/api/v1/tags");
    const textarea = workbench().querySelector("textarea")!;
    await setValue(textarea, '{"name":"VIP","color":"gold"}');
    await click(button("Format JSON"));
    await waitFor(() =>
      expect(workbench().querySelector("textarea")!.value).toBe(
        JSON.stringify({ name: "VIP", color: "gold" }, null, 2),
      ),
    );
  });

  it("opens a history entry as a blank draft for the same operation", async () => {
    await renderReady();
    await selectOperation("GET", "/api/v1/tags");
    await setValue(field("query"), "VIP");
    await click(button("Send request"));
    await waitFor(() => expect(text()).toContain('"name": "VIP"'));
    await selectOperation("GET", "/api/v1/campaigns");

    await openTab("History");
    expect(text()).toContain("/api/v1/tags");
    await click(button("Open draft"));
    await waitFor(() => expect(workbench().querySelector("code")?.textContent).toBe("/api/v1/tags"));
    expect(field("query").value).toBe("");
  });

  it("clears local history only after a confirm that names the consequence", async () => {
    await renderReady();
    await click(button("Send request"));
    await waitFor(() => expect(window.localStorage.getItem(HISTORY_KEY)).not.toBeNull());
    await openTab("History");

    await click(button("Clear history"));
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.textContent).toContain(
      "This permanently removes all 1 history entry for this workspace from this browser.",
    );
    expect(window.localStorage.getItem(HISTORY_KEY)).not.toBeNull();
    await click(button("Clear history", dialog()!));

    await waitFor(() => expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull());
    expect(text()).toContain("No playground requests have been sent from this browser");
  });

  it("fails closed on a malformed contract — no runner, the reason rendered", async () => {
    specResponder = () =>
      new Response("{\"openapi\":\"3.0.0\",\"paths\":{}}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await render();
    await waitFor(() => expect(text()).toContain("The API contract is unavailable"));
    expect(text()).toContain("requires an explicit OpenAPI 3.1 document");
    expect(document.querySelector('aside[aria-label="Operation catalog"]')).toBeNull();
  });
});

describe("API playground — reachable from Developer reference", FLOW_TIMEOUT, () => {
  it.each([
    { name: "a viewer", identity: { ...WHOAMI, role: "viewer" as const, effective_role: "viewer" as const } },
    { name: "an owner", identity: WHOAMI },
  ])("links $name to /app/developer-reference/playground", async ({ identity }) => {
    mocks.whoami.mockResolvedValue(identity);
    const { default: DeveloperReferencePage } = await import(
      "@/app/(dashboard)/app/developer-reference/page"
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        createElement(QueryClientProvider, { client }, createElement(DeveloperReferencePage)),
      );
    });
    await waitFor(() => expect(text()).toContain("Open API playground"));
    const link = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent?.trim() === "Open API playground",
    );
    expect(link?.getAttribute("href")).toBe("/app/developer-reference/playground");
  });
});

describe("API playground — browse the reference (platform-127)", FLOW_TIMEOUT, () => {
  it("filters by search, method and tag, clears, and says how many match", async () => {
    await renderReady();
    await openTab("Reference");
    expect(text()).toContain(`${TOTAL} of ${TOTAL} operations`);

    const search = document.querySelector<HTMLInputElement>('input[placeholder^="Path, summary, parameter"]')!;
    await setValue(search, "/api/v1/tags");
    const tagOps = rawCount((path) => path.startsWith("/api/v1/tags"));
    await waitFor(() => expect(text()).toContain(`${tagOps} of ${TOTAL} operations`));

    await click(button("DELETE", document.querySelector('[aria-label="HTTP method"]')!));
    await waitFor(() => expect(text()).toContain(`1 of ${TOTAL} operations`));
    const list = document.querySelector('ul[aria-label="API operations"]')!;
    expect(Array.from(list.querySelectorAll("code")).map((node) => node.textContent)).toEqual([
      "/api/v1/tags/{id}",
    ]);

    await click(button("Clear filters"));
    await waitFor(() => expect(text()).toContain(`${TOTAL} of ${TOTAL} operations`));
    const tag = Array.from(document.querySelectorAll("select")).find((node) =>
      node.textContent?.includes(`All tags (${TOTAL})`),
    )!;
    await setValue(tag, "Referrals");
    const referralOps = rawCount((_path, _method, tags) => tags.includes("Referrals"));
    await waitFor(() => expect(text()).toContain(`${referralOps} of ${TOTAL} operations`));
    expect(text()).toContain("Release hold: referrals_operational_runtime_held");
  });

  it("copies the route, discloses schema and example on demand, and opens the operation in the runner", async () => {
    const writeText = vi.fn(async (_value: string) => undefined);
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: { writeText } });
    await renderReady();
    await openTab("Reference");
    const list = document.querySelector('ul[aria-label="API operations"]')!;
    const post = Array.from(list.querySelectorAll("button")).find(
      (node) => node.querySelector("code")?.textContent === "/api/v1/tags" && node.textContent?.startsWith("post"),
    )!;
    await click(post);
    await waitFor(() => expect(document.querySelector('article[aria-label="POST /api/v1/tags reference"]')).not.toBeNull());

    await click(document.querySelector<HTMLButtonElement>('button[aria-label="Copy route POST /api/v1/tags"]')!);
    expect(writeText).toHaveBeenCalledWith("POST /api/v1/tags");

    expect(text()).not.toContain('"required": [');
    const summary = document.querySelector<HTMLElement>('summary[aria-label="Request schema for request body"]')!;
    await act(async () => {
      const details = summary.parentElement as HTMLDetailsElement;
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      await flush();
    });
    await waitFor(() => expect(text()).toContain('"required": ['));

    await click(button("Open in runner"));
    await waitFor(() => expect(workbench().querySelector("code")?.textContent).toBe("/api/v1/tags"));
    expect(button("Review request")).toBeTruthy();
  });
});

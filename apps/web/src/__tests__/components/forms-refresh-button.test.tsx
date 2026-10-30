// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Forms inventory refresh (desktop Forms.tsx toolbar "Refresh"). One click
// re-issues GET /api/v1/forms — never on mount — and the answer lands under
// the exact cache key forms-list-client.tsx renders from:
//   [...base("forms", tenant, effectiveRole), user_id, viewer_mode, "list"]
// A failure renders the server's sentence.
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FormsRefreshButton } from "@/components/forms/forms-refresh-button";

import {
  button,
  click,
  eventually,
  flush,
  identity,
  json,
  mount,
  stubFetch,
  unmountAll,
  type RecordedCall,
} from "../helpers/forms-extras-harness";

const ME = identity({ role: "owner", effective_role: "editor" });
const LIST_KEY = ["forms", "tenant-1", "editor", "user-1", false, "list"];

let calls: RecordedCall[];
let listStatus: number;
let rows: Array<{ id: string; name: string }>;

function listCalls() {
  return calls.filter((c) => c.method === "GET" && c.path === "/api/v1/forms");
}

beforeEach(() => {
  listStatus = 200;
  rows = [{ id: "f1", name: "One" }];
  ({ calls } = stubFetch((call) => {
    if (call.path === "/api/v1/auth/me") return json(ME);
    if (call.path === "/api/v1/forms" && call.method === "GET") {
      return listStatus === 200
        ? json(rows)
        : json(
            { error: { code: "internal", message: "forms store unavailable" } },
            { status: listStatus, headers: { "retry-after": "0" } },
          );
    }
    return undefined;
  }));
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mount(
    createElement(
      QueryClientProvider,
      { client },
      createElement(FormsRefreshButton),
    ),
  );
  return client;
}

describe("FormsRefreshButton", () => {
  it("re-reads GET /api/v1/forms on click into the list's cache key", async () => {
    const client = render();
    await eventually(() => expect(button("Refresh").disabled).toBe(false));
    await flush();
    expect(listCalls()).toHaveLength(0);

    rows = [
      { id: "f1", name: "One" },
      { id: "f2", name: "Two" },
    ];
    await click(button("Refresh"));

    await eventually(() =>
      expect(document.querySelector('[role="status"]')?.textContent).toBe(
        "Refreshed · 2 forms",
      ),
    );
    expect(listCalls()).toHaveLength(1);
    expect(client.getQueryData(LIST_KEY)).toEqual(rows);
  });

  it("renders the server's sentence when the refresh fails", async () => {
    listStatus = 500;
    render();
    await eventually(() => expect(button("Refresh").disabled).toBe(false));
    await click(button("Refresh"));

    await eventually(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "forms store unavailable",
      ),
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");
  });
});

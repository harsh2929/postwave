// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/store", () => ({ setSection: vi.fn() }));

import { WebhookErrorsTable } from "../../components/deliverability/WebhookErrorsTable";
import { parseWebhookErrors } from "../../pages/deliverability-hub-response-contract";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("deliverability webhook sensitive evidence", () => {
  it("never places URL credentials, raw errors, or controls in rendered DOM", () => {
    const canaries = [
      "live-user",
      "live-password",
      "path-secret-canary",
      "query-secret-canary",
      "error-secret-canary",
      "X-Injected",
    ];
    const rows = parseWebhookErrors({
      items: [
        {
          id: "delivery-1",
          event: "subscriber.created",
          url: "https://live-user:live-password@hooks.example.test/path-secret-canary?token=query-secret-canary",
          error:
            "HTTP 503 Authorization: Bearer error-secret-canary\r\nX-Injected: yes",
          status_code: 503,
          attempt_count: 4,
          last_attempt_at: "2026-07-14T00:00:00Z",
          status: "failed",
        },
      ],
    });
    expect(rows).not.toBeNull();

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(<WebhookErrorsTable rows={rows} loading={false} />);
    });

    expect(container.textContent).toContain("https://hooks.example.test");
    expect(container.textContent).toContain("Receiver returned HTTP 503");
    for (const canary of canaries) {
      expect(container.innerHTML).not.toContain(canary);
    }
  });
});

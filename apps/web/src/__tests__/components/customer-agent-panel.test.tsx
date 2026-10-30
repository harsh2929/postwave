// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Service suite — Customer Agent draft reply (desktop parity messaging-51).
//
// Desktop renders "Generate draft — unavailable" disabled and makes NO
// request; the server answers POST /api/v1/service-suite/agent/draft-reply
// with 409 customer_agent_draft_write_held and the static catalog reports
// customer_agent as held. What must be true on web: the panel reads the
// catalog's capability row, renders desktop's copy with the exact hold code,
// the control is disabled with the reason attached, the transport refuses
// before fetch — and with the catalog simulated as reporting `available`, the
// same panel sends the real POST with the DraftReplyRequest body.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost },
  };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { CustomerAgentPanel } from "@/app/(dashboard)/app/service-suite/customer-agent-panel";
import {
  CustomerAgentDraftHeldError,
  customerAgentDraftAvailable,
  draftCustomerAgentReply,
  getServiceSuiteCatalog,
  type ServiceSuiteCatalog,
} from "@/lib/service-suite-api";
import fixture from "../fixtures/api/service-suite_catalog.json";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function render(catalog: ServiceSuiteCatalog | null): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(CustomerAgentPanel, { catalog }));
  });
  return container;
}

async function flush(turns = 4) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Button "${label}" not found`);
  return found;
}

async function setValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

/**
 * The recorded server catalog, decoded by the page's own transport so the
 * panel is driven by exactly what GET /api/v1/service-suite/catalog sends.
 */
let HELD: ServiceSuiteCatalog;
function heldCatalog(): ServiceSuiteCatalog {
  return HELD;
}

/** The same catalog with the server reporting the draft verb as available. */
function liftedCatalog(): ServiceSuiteCatalog {
  const catalog = heldCatalog();
  return {
    ...catalog,
    capabilities: catalog.capabilities.map((row) =>
      row.key === "customer_agent"
        ? { ...row, status: "available", code: null }
        : row,
    ),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.apiGet.mockResolvedValueOnce(fixture);
  HELD = await getServiceSuiteCatalog();
  expect(mocks.apiGet.mock.calls[0]?.[0]).toBe("/api/v1/service-suite/catalog");
  mocks.apiGet.mockReset();
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("CustomerAgentPanel — held (messaging-51)", () => {
  it("reads the catalog's held status and renders desktop's copy with the hold code", async () => {
    const catalog = heldCatalog();
    expect(customerAgentDraftAvailable(catalog)).toBe(false);
    const container = render(catalog);
    await flush();
    expect(container.getAttribute("data-helpdesk-state")).toBeNull();
    expect(container.querySelector('[data-helpdesk-state="agent-create-held"]')).toBeTruthy();
    expect(container.textContent).toContain("Customer Agent draft");
    expect(container.textContent).toContain("Draft creation unavailable");
    expect(container.textContent).toContain(
      "The non-idempotent create is held before request-body processing or persistence (customer_agent_draft_write_held).",
    );
    expect(container.textContent).toContain(
      "Draft only; no provider or customer mutation is executed, and human review is required.",
    );
    expect(container.textContent).toContain("Deterministic template declaration");
    expect(container.textContent).toContain("None created by this view");

    const control = button("Generate draft — unavailable");
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("title")).toBe(
      "No request will be sent until a replay-safe create contract is available.",
    );
    const reasonId = control.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      "No request will be sent until a replay-safe create contract is available.",
    );
    // No conversation picker, no draft field, no request — even when clicked.
    expect(container.querySelector("input, textarea")).toBeNull();
    await act(async () => {
      control.click();
    });
    await flush();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("treats a missing catalog as held and says guardrail verification is unavailable", async () => {
    const container = render(null);
    await flush();
    expect(container.textContent).toContain("Draft creation unavailable");
    expect(container.textContent).toContain("customer_agent_draft_write_held");
    expect(container.textContent).toContain(
      "Static guardrail verification is unavailable. Treat all Agent capability as held.",
    );
    expect(button("Generate draft — unavailable").disabled).toBe(true);
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("refuses the transport before fetch while the catalog reports held", async () => {
    await expect(
      draftCustomerAgentReply(heldCatalog(), { conversation_id: "conv_1" }),
    ).rejects.toBeInstanceOf(CustomerAgentDraftHeldError);
    await expect(
      draftCustomerAgentReply(heldCatalog(), { conversation_id: "conv_1" }),
    ).rejects.toMatchObject({ code: "customer_agent_draft_write_held", status: 409 });
    await expect(
      draftCustomerAgentReply(null, { conversation_id: "conv_1" }),
    ).rejects.toMatchObject({ code: "customer_agent_draft_write_held" });
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });
});

describe("CustomerAgentPanel — catalog simulated as available", () => {
  it("exposes the conversation field and POSTs the DraftReplyRequest body", async () => {
    mocks.apiPost.mockResolvedValueOnce({
      id: "run_1",
      run_type: "draft_reply",
      status: "drafted",
      draft: "Thanks for reaching out — here is what we can do.",
    });
    const catalog = liftedCatalog();
    expect(customerAgentDraftAvailable(catalog)).toBe(true);
    const container = render(catalog);
    await flush();
    expect(container.querySelector('[data-helpdesk-state="agent-create-ready"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Draft creation unavailable");

    const generate = button("Generate draft");
    // Disabled until a conversation is named; still no request.
    expect(generate.disabled).toBe(true);
    const conversation = container.querySelector<HTMLInputElement>("input")!;
    const prompt = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await setValue(conversation, " conv_42 ");
    await setValue(prompt, "Keep it short.");
    expect(button("Generate draft").disabled).toBe(false);

    await act(async () => {
      button("Generate draft").click();
    });
    await flush(6);

    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(mocks.apiPost.mock.calls[0]?.[0]).toBe("/api/v1/service-suite/agent/draft-reply");
    expect(mocks.apiPost.mock.calls[0]?.[1]).toEqual({
      conversation_id: "conv_42",
      prompt: "Keep it short.",
    });
    expect(mocks.apiPost.mock.calls[0]?.[2]).toMatchObject({ requireOnline: true, maxAttempts: 1 });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Draft created for human review");
    expect(container.textContent).toContain("Thanks for reaching out — here is what we can do.");
    expect(container.textContent).toContain("One draft run returned for review");
  });

  it("renders the server's refusal when the lifted call is still declined", async () => {
    mocks.apiPost.mockRejectedValueOnce(new Error("Draft-run persistence is release-held"));
    const container = render(liftedCatalog());
    await flush();
    await setValue(container.querySelector<HTMLInputElement>("input")!, "conv_1");
    await act(async () => {
      button("Generate draft").click();
    });
    await flush(6);
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith("Draft-run persistence is release-held");
    expect(container.textContent).toContain("None created by this view");
  });
});

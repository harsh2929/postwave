// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
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
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listSequences: vi.fn(),
  listTags: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { listSequences: mocks.listSequences },
  listInboundTriggers: mocks.list,
  listTagsWithQuery: mocks.listTags,
  createInboundTrigger: mocks.create,
  updateInboundTrigger: mocks.update,
  deleteInboundTrigger: mocks.remove,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    success: mocks.success,
    error: mocks.error,
    info: vi.fn(),
  },
}));

import { TriggersPanel } from "../../components/webhooks/TriggersPanel";
import type { InboundTrigger } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const trigger: InboundTrigger = {
  id: "trigger-1",
  tenant_id: "tenant-1",
  webhook_id: "endpoint-1",
  name: "Paid customer",
  active: true,
  match_jsonpath: "$.customer.plan",
  match_operator: "equals",
  match_value: "pro",
  email_jsonpath: "$.customer.email",
  action_type: "add_tag",
  action_target_id: "paid-customer",
  fired_count: 12,
  last_fired_at: "2026-07-23T08:00:00.000Z",
  created_at: "2026-07-22T08:00:00.000Z",
  updated_at: "2026-07-23T08:00:00.000Z",
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue({ data: { items: [trigger] } });
  mocks.update.mockImplementation(
    async (_webhookId: string, _triggerId: string, patch: object) => ({
      data: { ...trigger, ...patch },
    }),
  );
  mocks.create.mockResolvedValue({ data: trigger });
  mocks.remove.mockResolvedValue({ data: { ok: true } });
  mocks.listSequences.mockResolvedValue({
    data: {
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Onboarding",
        },
        {
          id: 42,
          name: "Legacy numeric sequence",
        },
      ],
    },
  });
  mocks.listTags.mockResolvedValue({
    data: { items: [{ id: "tag-1", name: "paid-customer" }] },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function rerender(node: ReactElement): void {
  act(() => root?.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw failure;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

function setControl(
  control: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function openPanel(): void {
  render(
    <TriggersPanel
      webhookId="endpoint-1"
      sampleBody='{"customer":{"email":"ada@example.com","plan":"pro"}}'
    />,
  );
}

describe("inbound trigger maturity", () => {
  it("shows a truthful load error, preserves retry, and recovers", async () => {
    mocks.list
      .mockResolvedValueOnce({ error: { message: "trigger service offline" } })
      .mockResolvedValueOnce({ data: { items: [trigger] } });
    openPanel();

    await waitFor(() => {
      expect(document.body.textContent).toContain("trigger service offline");
      expect(document.body.textContent).not.toContain("Paid customer");
    });
    act(() => button("Retry").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Paid customer");
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("edits and pauses through canonical PATCH without exposing raw IDs in the row", async () => {
    openPanel();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Paid customer");
      expect(document.body.textContent).toContain("Add tag “paid-customer”");
    });

    act(() => button("Edit").click());
    const name = document.querySelector<HTMLInputElement>("#trig-name");
    if (!name) throw new Error("Missing trigger name");
    setControl(name, "VIP customer");
    act(() => button("Save trigger").click());
    await waitFor(() => {
      expect(mocks.update).toHaveBeenCalledWith(
        "endpoint-1",
        "trigger-1",
        expect.objectContaining({
          name: "VIP customer",
          match_jsonpath: "$.customer.plan",
          action_target_id: "paid-customer",
        }),
      );
    });

    act(() => button("Pause").click());
    await waitFor(() => {
      expect(mocks.update).toHaveBeenLastCalledWith("endpoint-1", "trigger-1", {
        active: false,
      });
    });
  });

  it("withholds invalid previews, validates targets, and guards dirty close accessibly", async () => {
    openPanel();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Paid customer");
    });
    act(() => button("Add trigger").click());

    const name = document.querySelector<HTMLInputElement>("#trig-name");
    const path = document.querySelector<HTMLInputElement>("#trig-jp");
    const target = document.querySelector<HTMLInputElement>("#trig-target");
    if (!name || !path || !target) throw new Error("Missing trigger fields");
    setControl(name, "Broken preview");
    setControl(path, "$.customer[");
    setControl(target, "not-a-uuid");

    expect(document.body.textContent).toContain("Invalid path");
    expect(document.body.textContent).toContain("Preview withheld");
    expect(document.body.textContent).not.toContain("Trigger fires");
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "non-UUID sequence record excluded",
      );
      expect(document.body.textContent).toContain(
        "Manual values are checked for syntax only",
      );
    });

    act(() => button("Create trigger").click());
    expect(document.body.textContent).toContain(
      "Array segment is missing its closing ]",
    );
    expect(document.body.textContent).toContain("Enter the target's UUID");
    expect(mocks.create).not.toHaveBeenCalled();

    const accessibility = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      accessibility.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    act(() => button("Cancel").click());
    expect(document.body.textContent).toContain("Discard trigger changes?");
  });

  it("ignores an old save settlement after the detail switches endpoints", async () => {
    let resolveUpdate!: (value: { data: InboundTrigger }) => void;
    mocks.update.mockReturnValue(
      new Promise<{ data: InboundTrigger }>((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const secondTrigger: InboundTrigger = {
      ...trigger,
      id: "trigger-2",
      webhook_id: "endpoint-2",
      name: "Endpoint two rule",
    };
    mocks.list.mockImplementation(async (webhookId: string) => ({
      data: { items: [webhookId === "endpoint-1" ? trigger : secondTrigger] },
    }));

    openPanel();
    await waitFor(() => {
      expect(document.body.textContent).toContain("Paid customer");
    });
    act(() => button("Edit").click());
    const name = document.querySelector<HTMLInputElement>("#trig-name");
    if (!name) throw new Error("Missing trigger name");
    setControl(name, "Stale saved name");
    act(() => button("Save trigger").click());

    rerender(
      <TriggersPanel
        webhookId="endpoint-2"
        sampleBody='{"customer":{"email":"two@example.com","plan":"free"}}'
      />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("Endpoint two rule");
    });
    await act(async () => {
      resolveUpdate({ data: { ...trigger, name: "Stale saved name" } });
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Endpoint two rule");
    expect(document.body.textContent).not.toContain("Stale saved name");
  });
});

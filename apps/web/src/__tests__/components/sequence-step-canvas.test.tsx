// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The sequence canvas on /app/sequences/[id] — desktop parity rows
// automation-63 (add from the palette by click or drag-drop), -64 (reorder by
// buttons, Alt+Arrow and drag handle), -65 (slide-over step editor + Save),
// -67 (add into a condition's Yes/No branch), -68 (A/B test saved on the email
// step) and -71 (retry a failed save, or reload the latest version on a 412).
//
// The real page and the real voice-api transport run; only `api` itself is
// stubbed. Every test asserts the CONSEQUENCE of a verb: the PATCH's path,
// body and If-Match, the GET a reload makes, what renders afterwards — or,
// for a withheld verb, that no request was made.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PatchOptions = {
  headers?: Record<string, string>;
  requireOnline?: boolean;
};
type WireBody = {
  name?: string;
  steps?: Array<Record<string, unknown>>;
  emails?: Array<Record<string, unknown>>;
};

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => ({})),
  patch: vi.fn(
    async (
      _path: string,
      _body?: unknown,
      _opts?: PatchOptions,
    ): Promise<unknown> => ({}),
  ),
  post: vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({})),
  put: vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({})),
  delete: vi.fn(async (_path: string): Promise<unknown> => ({})),
  head: vi.fn(async (_path: string): Promise<unknown> => ({})),
  whoami: vi.fn(),
  editorProps: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      get: mocks.get,
      patch: mocks.patch,
      post: mocks.post,
      put: mocks.put,
      delete: mocks.delete,
      head: mocks.head,
    },
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "seq_1" }) }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  }),
}));
vi.mock("@/components/editor/editor-shell", () => ({
  EditorShell: (props: Record<string, unknown>) => {
    mocks.editorProps = props;
    return createElement("div", { "data-testid": "editor-shell" });
  },
}));
vi.mock("@/components/content-test-send-dialog", () => ({
  ContentTestSendDialog: () => null,
}));
vi.mock("@/components/entity-presence", () => ({
  EntityPresence: () => null,
  entityRefFor: () => "sequence:seq_1",
}));
vi.mock("@/components/copy-entity-link", () => ({
  CopyEntityLink: () => null,
}));
vi.mock("@/components/record-last-viewed", () => ({
  RecordLastViewed: () => null,
}));
vi.mock("@/app/(dashboard)/app/sequences/[id]/sequence-settings-card", () => ({
  SequenceSettingsCard: () => null,
}));
vi.mock(
  "@/app/(dashboard)/app/sequences/[id]/sequence-performance-panel",
  () => ({
    SequencePerformancePanel: () => null,
  }),
);

import { ApiError } from "@/lib/api";
import { STEP_DRAG_MIME } from "@/lib/flow-canvas-model";
import SequenceDetailPage from "@/app/(dashboard)/app/sequences/[id]/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "/api/v1/voice/sequences/seq_1";

function me(role: "owner" | "viewer" = "owner") {
  return {
    user_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    email: "operator@postwave.test",
    role,
    effective_role: role,
    viewer_mode: false,
  };
}

function graphRow(version = 4, overrides: Record<string, unknown> = {}) {
  return {
    id: "seq_1",
    version,
    name: "Welcome",
    status: "draft",
    template_id: "welcome",
    steps: [
      {
        type: "email",
        position: 1,
        email: { subject: "Hello", body: "Body one" },
      },
      {
        type: "delay",
        position: 2,
        delay: { seconds: 86400, value: 1, unit: "days" },
      },
      {
        type: "condition",
        position: 3,
        condition: {
          predicate: "opened_previous",
          yes_branch: [],
          no_branch: [],
        },
      },
      {
        type: "email",
        position: 4,
        email: { subject: "Follow up", body: "Body two" },
      },
    ],
    ...overrides,
  };
}

function emailsOnlyRow() {
  return {
    id: "seq_1",
    version: 4,
    name: "Generated",
    status: "draft",
    template_id: "welcome",
    emails: [
      {
        position: 1,
        subject: "One",
        body: "Body one",
        voice_fidelity_score: 91,
      },
      {
        position: 2,
        subject: "Two",
        body: "Body two",
        delay_seconds: 86400,
        voice_fidelity_score: 82,
      },
    ],
  };
}

let serverVersion = 4;
let stored: Record<string, unknown> = graphRow();

/** The server echo: exact expected+1 revision, the written tree. */
function acceptPatch() {
  mocks.patch.mockImplementation(async (_path: string, body?: unknown) => {
    const wire = body as WireBody;
    serverVersion += 1;
    return {
      id: "seq_1",
      version: serverVersion,
      name: wire.name,
      status: "draft",
      template_id: "welcome",
      ...(wire.steps ? { steps: wire.steps } : { emails: wire.emails }),
    };
  });
}

function render(ui: ReactNode): Root {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

// Time-boxed rather than attempt-counted: the slide-over is a lazy chunk, and
// on a loaded machine its import can outlast a fixed number of ticks.
async function waitFor(assertion: () => void, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() > deadline) throw lastError;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 5));
      });
    }
  }
}

function byLabel<T extends HTMLElement = HTMLButtonElement>(label: string): T {
  const found = document.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`No element labelled "${label}"`);
  return found;
}

function buttonByText(
  text: string,
  root: ParentNode = document,
): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find(
    (button): button is HTMLButtonElement =>
      button instanceof HTMLButtonElement &&
      button.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No button "${text}"`);
  return found;
}

function controlByLabelText<T extends HTMLElement>(text: string): T {
  const label = Array.from(document.querySelectorAll("label")).find(
    (element) => element.textContent?.trim() === text,
  );
  const id = label?.getAttribute("for");
  const control = id ? document.getElementById(id) : null;
  if (!control) throw new Error(`No control labelled "${text}"`);
  return control as T;
}

function node(address: string): HTMLLIElement {
  const found = document.querySelector<HTMLLIElement>(
    `li[data-step-address="${address}"]`,
  );
  if (!found) throw new Error(`No canvas node ${address}`);
  return found;
}

function nodeButton(address: string): HTMLButtonElement {
  const found = node(address).querySelector<HTMLButtonElement>(
    "button[aria-keyshortcuts]",
  );
  if (!found) throw new Error(`No node button on ${address}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

async function setValue(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const prototype = Object.getPrototypeOf(control) as object;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

function stubTransfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return Array.from(data.keys());
    },
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => {
      data.set(type, value);
    },
    dropEffect: "none",
    effectAllowed: "all",
  };
}

async function drag(
  element: Element,
  type: "dragstart" | "dragover" | "drop",
  transfer: ReturnType<typeof stubTransfer>,
): Promise<void> {
  await act(async () => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    element.dispatchEvent(event);
    await flush();
  });
}

function patchCall(index: number): {
  path: string;
  body: WireBody;
  ifMatch?: string;
} {
  const call = mocks.patch.mock.calls[index];
  if (!call) throw new Error(`No PATCH #${index + 1}`);
  const [path, body, opts] = call;
  return { path, body: body as WireBody, ifMatch: opts?.headers?.["If-Match"] };
}

const shape = (steps: WireBody["steps"]) =>
  (steps ?? []).map((step) => {
    const email = step.email as { subject?: string } | undefined;
    return [step.type, step.position, email?.subject ?? null];
  });

async function mount(row: Record<string, unknown> = graphRow()): Promise<Root> {
  stored = row;
  const root = render(createElement(SequenceDetailPage));
  await waitFor(() => {
    expect(nodeButton("Step 1")).toBeTruthy();
  });
  return root;
}

beforeEach(() => {
  serverVersion = 4;
  stored = graphRow();
  mocks.editorProps = null;
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.whoami.mockReset();
  mocks.whoami.mockResolvedValue(me());
  mocks.get.mockImplementation(async (path: string) => {
    if (path === PATH) return stored;
    throw new ApiError("not found", 404);
  });
  acceptPatch();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("automation-63: add a step from the palette", () => {
  it("clicking a tile appends it and saves the whole tree under If-Match", async () => {
    const root = await mount();
    await click(byLabel("Add Delay step at the end"));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const { path, body, ifMatch } = patchCall(0);
    expect(path).toBe(PATH);
    expect(ifMatch).toBe('"4"');
    expect(body.name).toBe("Welcome");
    expect(body.emails).toBeUndefined();
    expect(shape(body.steps)).toEqual([
      ["email", 1, "Hello"],
      ["delay", 2, null],
      ["condition", 3, null],
      ["email", 4, "Follow up"],
      ["delay", 5, null],
    ]);
    expect(body.steps?.[4]).toEqual({
      type: "delay",
      position: 5,
      delay: { seconds: 86400, value: 1, unit: "days" },
    });
    // The new step's editor opens so it can be tuned.
    await waitFor(() => {
      expect(document.body.textContent).toContain("Edit delay step");
      expect(document.body.textContent).toContain("Saved");
    });
    act(() => root.unmount());
  });

  it("holds an incomplete new email locally, then saves it once written", async () => {
    const root = await mount();
    await click(byLabel("Add Email step at the end"));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Not saved yet — Step 5 (Email) needs a subject.",
      );
    });
    expect(mocks.patch).not.toHaveBeenCalled();
    // The new email opened in the main editor.
    expect(node("Step 5").getAttribute("class")).toContain("border-primary");

    await setValue(
      document.getElementById("subject") as HTMLInputElement,
      "Third touch",
    );
    await act(async () => {
      (mocks.editorProps?.onMarkdownChange as (md: string) => void)(
        "Last call",
      );
      await flush();
    });
    await click(byLabel("Save"));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const { body, ifMatch } = patchCall(0);
    expect(ifMatch).toBe('"4"');
    expect(body.steps?.[4]).toEqual({
      type: "email",
      position: 5,
      email: {
        subject: "Third touch",
        body: "Last call",
        body_html: "<p>Last call</p>",
        delay_seconds: 0,
      },
    });
    act(() => root.unmount());
  });

  it("dragging a tile onto a gap inserts it at that exact position", async () => {
    const root = await mount();
    const transfer = stubTransfer();
    await drag(byLabel("Add Exit step at the end"), "dragstart", transfer);
    expect(transfer.getData(STEP_DRAG_MIME)).toBe(
      '{"source":"palette","kind":"exit"}',
    );

    const gap = document.querySelector('[data-drop-gap="1:gap"]');
    if (!gap) throw new Error("gap before step 2 missing");
    await drag(gap, "dragover", transfer);
    // A palette tile only allows "copy"; any other drop effect is refused.
    expect(transfer.dropEffect).toBe("copy");
    await drag(gap, "drop", transfer);

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(shape(patchCall(0).body.steps)).toEqual([
      ["email", 1, "Hello"],
      ["exit", 2, null],
      ["delay", 3, null],
      ["condition", 4, null],
      ["email", 5, "Follow up"],
    ]);
    expect(patchCall(0).body.steps?.[1]).toEqual({ type: "exit", position: 2 });
    act(() => root.unmount());
  });
});

describe("automation-64: reorder steps", () => {
  it("moves by button, Alt+Arrow and drag handle, each save chaining the new version", async () => {
    const root = await mount();

    await click(byLabel("Move Step 2 later"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(patchCall(0).ifMatch).toBe('"4"');
    expect(shape(patchCall(0).body.steps)).toEqual([
      ["email", 1, "Hello"],
      ["condition", 2, null],
      ["delay", 3, null],
      ["email", 4, "Follow up"],
    ]);

    await waitFor(() =>
      expect(byLabel("Move Step 4 earlier").disabled).toBe(false),
    );
    await act(async () => {
      nodeButton("Step 4").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowUp",
          altKey: true,
          bubbles: true,
        }),
      );
      await flush();
    });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(patchCall(1).ifMatch).toBe('"5"');
    expect(shape(patchCall(1).body.steps)).toEqual([
      ["email", 1, "Hello"],
      ["condition", 2, null],
      ["email", 3, "Follow up"],
      ["delay", 4, null],
    ]);
    // Focus follows the moved step to its new slot.
    await waitFor(() =>
      expect(document.activeElement).toBe(nodeButton("Step 3")),
    );

    await waitFor(() =>
      expect(byLabel("Move Step 1 later").disabled).toBe(false),
    );
    const transfer = stubTransfer();
    const handle = node("Step 1").querySelector("span[draggable]");
    if (!handle) throw new Error("drag handle missing");
    await drag(handle, "dragstart", transfer);
    const endGap = document.querySelector('[data-drop-gap="4:gap"]');
    if (!endGap) throw new Error("end gap missing");
    await drag(endGap, "dragover", transfer);
    expect(transfer.dropEffect).toBe("move");
    await drag(endGap, "drop", transfer);
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(3));
    expect(patchCall(2).ifMatch).toBe('"6"');
    expect(shape(patchCall(2).body.steps)).toEqual([
      ["condition", 1, null],
      ["email", 2, "Follow up"],
      ["delay", 3, null],
      ["email", 4, "Hello"],
    ]);
    act(() => root.unmount());
  });

  it("keeps a legacy emails-only draft on the emails path, fidelity intact", async () => {
    const root = await mount(emailsOnlyRow());
    await click(byLabel("Move Step 2 earlier"));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const { body } = patchCall(0);
    expect(body.steps).toBeUndefined();
    expect(
      body.emails?.map((email) => [
        email.position,
        email.subject,
        email.delay_seconds,
        email.voice_fidelity_score,
      ]),
    ).toEqual([
      [1, "Two", 86400, 82],
      [2, "One", 0, 91],
    ]);
    act(() => root.unmount());
  });
});

describe("automation-65: edit a step in the slide-over", () => {
  it("saves a delay's new value and unit", async () => {
    const root = await mount();
    await click(nodeButton("Step 2"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Edit delay step"),
    );

    await setValue(controlByLabelText<HTMLInputElement>("Wait"), "3");
    await setValue(controlByLabelText<HTMLSelectElement>("Wait unit"), "hours");
    await click(buttonByText("Save step"));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(patchCall(0).body.steps?.[1]).toEqual({
      type: "delay",
      position: 2,
      delay: { seconds: 10800, value: 3, unit: "hours" },
    });
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("Edit delay step");
      expect(nodeButton("Step 2").textContent).toContain("Wait 3 hours");
    });
    act(() => root.unmount());
  });

  it("refuses a condition that needs an argument, without a request", async () => {
    const root = await mount();
    await click(nodeButton("Step 3"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Edit condition step"),
    );

    await setValue(
      controlByLabelText<HTMLSelectElement>("Condition"),
      "tag_present",
    );
    await click(buttonByText("Save step"));
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "This condition step needs a condition value.",
      );
    });
    expect(mocks.patch).not.toHaveBeenCalled();

    await setValue(
      controlByLabelText<HTMLInputElement>("Argument (required)"),
      "vip",
    );
    await click(buttonByText("Save step"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(patchCall(0).body.steps?.[2]).toEqual({
      type: "condition",
      position: 3,
      condition: {
        predicate: "tag_present",
        value: "vip",
        yes_branch: [],
        no_branch: [],
      },
    });
    act(() => root.unmount());
  });
});

describe("automation-67: add a step into a condition branch", () => {
  it("adds to No (saved at once) and to Yes (completed in the editor, then saved)", async () => {
    const root = await mount();
    const noGroup = byLabel<HTMLDivElement>(
      "Add a step to the No branch of step 3",
    );
    await setValue(
      noGroup.querySelector("select") as HTMLSelectElement,
      "exit",
    );
    await click(buttonByText("Add to No", noGroup));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(patchCall(0).ifMatch).toBe('"4"');
    expect(patchCall(0).body.steps?.[2]).toEqual({
      type: "condition",
      position: 3,
      condition: {
        predicate: "opened_previous",
        yes_branch: [],
        no_branch: [{ type: "exit", position: 1 }],
      },
    });

    await waitFor(() =>
      expect(
        byLabel<HTMLDivElement>(
          "Add a step to the Yes branch of step 3",
        ).querySelector("button")?.disabled,
      ).toBe(false),
    );
    const yesGroup = byLabel<HTMLDivElement>(
      "Add a step to the Yes branch of step 3",
    );
    await setValue(
      yesGroup.querySelector("select") as HTMLSelectElement,
      "tag_add",
    );
    await click(buttonByText("Add to Yes", yesGroup));
    // A blank tag cannot be saved: it stays local and its editor opens.
    await waitFor(() =>
      expect(document.body.textContent).toContain("Edit add tag step"),
    );
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Not saved yet — Step 3 › Yes › step 1 (Add tag) needs a tag.",
    );

    await setValue(controlByLabelText<HTMLInputElement>("Tag"), "vip");
    await click(buttonByText("Save step"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(patchCall(1).ifMatch).toBe('"5"');
    expect(patchCall(1).body.steps?.[2]).toEqual({
      type: "condition",
      position: 3,
      condition: {
        predicate: "opened_previous",
        yes_branch: [{ type: "tag_add", position: 1, tag: { tag: "vip" } }],
        no_branch: [{ type: "exit", position: 1 }],
      },
    });
    act(() => root.unmount());
  });
});

describe("automation-68: A/B test an email step", () => {
  it("saves the split on the email step through the draft PATCH", async () => {
    const root = await mount();
    await click(buttonByText("A/B test"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("A/B test for email #1"),
    );

    await click(controlByLabelText<HTMLInputElement>("A/B test this email"));
    await waitFor(() =>
      expect(controlByLabelText("Variant B subject")).toBeTruthy(),
    );
    await setValue(
      controlByLabelText<HTMLInputElement>("Variant B subject"),
      "Hello B",
    );

    await click(buttonByText("Add variant"));
    await waitFor(() =>
      expect(
        controlByLabelText<HTMLInputElement>("Variant C weight (%)").value,
      ).toBe("33.33"),
    );
    expect(
      controlByLabelText<HTMLInputElement>("Variant A weight (%)").value,
    ).toBe("33.34");
    await click(buttonByText("Add variant"));
    await waitFor(() =>
      expect(buttonByText("Add variant").disabled).toBe(true),
    );
    await click(byLabel("Remove variant D"));
    await click(byLabel("Remove variant C"));
    await waitFor(() =>
      expect(
        controlByLabelText<HTMLInputElement>("Variant A weight (%)").value,
      ).toBe("50"),
    );

    await setValue(
      controlByLabelText<HTMLInputElement>("Variant A weight (%)"),
      "60",
    );
    await click(buttonByText("Save A/B test"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Variant weights must total 100% (currently 110%).",
      ),
    );
    expect(mocks.patch).not.toHaveBeenCalled();

    await setValue(
      controlByLabelText<HTMLInputElement>("Variant B weight (%)"),
      "40",
    );
    await click(buttonByText("Save A/B test"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const { body, ifMatch } = patchCall(0);
    expect(ifMatch).toBe('"4"');
    expect(body.steps?.[0]).toEqual({
      type: "email",
      position: 1,
      email: {
        subject: "Hello",
        body: "Body one",
        delay_seconds: 0,
        variants: [
          { key: "A", subject: "Hello", body: "Body one", weight_bp: 6000 },
          { key: "B", subject: "Hello B", body: "Body one", weight_bp: 4000 },
        ],
      },
    });
    await waitFor(() =>
      expect(nodeButton("Step 1").textContent).toContain(
        "Hello · A/B 2 variants",
      ),
    );
    act(() => root.unmount());
  });

  it("asks before turning a generated emails-only draft into a step graph", async () => {
    const root = await mount(emailsOnlyRow());
    await click(byLabel("Add Exit step at the end"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Store this draft as a step graph?",
      ),
    );
    expect(document.body.textContent).toContain("those read 0 after this save");
    expect(mocks.patch).not.toHaveBeenCalled();

    await click(buttonByText("Convert and save"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    const { body } = patchCall(0);
    expect(body.emails).toBeUndefined();
    expect(shape(body.steps)).toEqual([
      ["email", 1, "One"],
      ["email", 2, "Two"],
      ["exit", 3, null],
    ]);
    act(() => root.unmount());
  });
});

describe("automation-71: recover a failed save", () => {
  it("retries the same snapshot under the same version after a transient failure", async () => {
    mocks.patch.mockRejectedValueOnce(new ApiError("Service unavailable", 503));
    const root = await mount();
    await click(byLabel("Add Exit step at the end"));

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Draft save needs attention.",
      );
      expect(document.body.textContent).toContain("Service unavailable");
    });
    // The local change is kept, not rolled back.
    expect(nodeButton("Step 5").textContent).toContain("End the journey");

    await click(buttonByText("Retry failed change"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(patchCall(1).ifMatch).toBe('"4"');
    expect(patchCall(1).body).toEqual(patchCall(0).body);
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Draft save needs attention.",
      ),
    );
    act(() => root.unmount());
  });

  it("on a 412 discards the local snapshot behind a confirm and reloads the latest version", async () => {
    mocks.patch.mockRejectedValueOnce(
      new ApiError("version mismatch — reload and retry", 412),
    );
    const root = await mount();
    await click(byLabel("Add Exit step at the end"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "version mismatch — reload and retry",
      ),
    );
    expect(() => buttonByText("Retry failed change")).toThrow();

    // Someone else saved version 7 meanwhile.
    stored = graphRow(7, {
      name: "Welcome (edited elsewhere)",
      steps: [
        {
          type: "email",
          position: 1,
          email: { subject: "Hello again", body: "Body" },
        },
        {
          type: "delay",
          position: 2,
          delay: { seconds: 3600, value: 1, unit: "hours" },
        },
      ],
    });
    serverVersion = 7;
    const getsBefore = mocks.get.mock.calls.filter(
      ([path]) => path === PATH,
    ).length;

    await click(buttonByText("Reload latest version"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Discard the failed change and reload?",
      ),
    );
    await click(buttonByText("Discard and reload"));

    await waitFor(() => {
      expect(
        mocks.get.mock.calls.filter(([path]) => path === PATH).length,
      ).toBe(getsBefore + 1);
      expect(
        (
          document.querySelector(
            'input[aria-label="Sequence name"]',
          ) as HTMLInputElement
        ).value,
      ).toBe("Welcome (edited elsewhere)");
    });
    expect(document.querySelector('li[data-step-address="Step 3"]')).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Draft save needs attention.",
    );

    // The next change is written against the reloaded revision.
    await click(byLabel("Add Exit step at the end"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    expect(patchCall(1).ifMatch).toBe('"7"');
    expect(shape(patchCall(1).body.steps)).toEqual([
      ["email", 1, "Hello again"],
      ["delay", 2, null],
      ["exit", 3, null],
    ]);
    act(() => root.unmount());
  });
});

describe("role gating", () => {
  it("withholds every structural verb from a viewer and sends nothing", async () => {
    mocks.whoami.mockResolvedValue(me("viewer"));
    const root = await mount();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Editing sequences is read-only",
      ),
    );
    expect(
      document.querySelector('[aria-label="Add Delay step at the end"]'),
    ).toBeNull();
    expect(byLabel("Move Step 2 later").disabled).toBe(true);
    expect(byLabel("Delete Step 2").disabled).toBe(true);
    expect(
      byLabel<HTMLDivElement>(
        "Add a step to the Yes branch of step 3",
      ).querySelector("button")?.disabled,
    ).toBe(true);
    await act(async () => {
      nodeButton("Step 2").dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          altKey: true,
          bubbles: true,
        }),
      );
      await flush();
    });
    await click(nodeButton("Step 2"));
    await waitFor(() => expect(buttonByText("Save step").disabled).toBe(true));
    expect(mocks.patch).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

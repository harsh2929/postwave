// @vitest-environment happy-dom

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

const access = vi.hoisted(() => ({ canAdmin: true }));
const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  rotate: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  deliveries: vi.fn(),
}));
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));
const secretLifecycle = vi.hoisted(() => ({
  activate: vi.fn(),
  resolve: vi.fn(),
}));
const identity = vi.hoisted(() => ({ sequence: 0 }));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => access.canAdmin,
}));

vi.mock("../../lib/api-client", () => ({
  LIST_SCOPED_WEBHOOK_EVENTS: ["list.subscriber.added"],
  listListScopedWebhooks: api.list,
  createListScopedWebhook: api.create,
  rotateListScopedWebhookSigningMaterial: api.rotate,
  deleteListScopedWebhook: api.remove,
  testListScopedWebhook: api.test,
  listListScopedWebhookDeliveries: api.deliveries,
}));

vi.mock("../../lib/http-fetch", () => ({
  newUUIDv7: () => `stable-idempotency-${++identity.sequence}`,
}));

vi.mock("../../hooks/usePersistentLifecycleOperation", () => ({
  usePersistentLifecycleOperation: () => ({
    active: false,
    promiseRef: { current: null },
    run: (work: () => Promise<unknown>) => work(),
  }),
}));

vi.mock("../../hooks/useShownOnceSecretLifecycle", () => ({
  useShownOnceSecretLifecycle: () => secretLifecycle,
}));

vi.mock("../../hooks/useSettingsDraftLifecycle", () => ({
  lifecycleOperationError: (_error: unknown, fallback: string) => fallback,
  useDiscardOnlyDraftLifecycle: vi.fn(),
}));

vi.mock("../../components/Toast", () => ({
  toast,
}));

vi.mock("../../components/playground/Copy", () => ({
  CopyButton: ({ value, label }: { value: string; label: string }) => (
    <button type="button" data-secret={value}>
      {label}
    </button>
  ),
}));

import { WebhooksTab } from "../../components/lists/tabs/WebhooksTab";

const LIST_ID = "11111111-1111-4111-8111-111111111111";
const WEBHOOK_ID = "22222222-2222-4222-8222-222222222222";
const list = {
  id: 71,
  postwave_uuid: LIST_ID,
  name: "Customers",
};

function webhook() {
  return {
    id: WEBHOOK_ID,
    url: "https://receiver.example/…?…",
    description: "Membership receiver",
    events: ["list.subscriber.added"],
    active: true,
    url_status: "ready",
    auth_config_status: "ready",
    delivery_policy_status: "ready",
    created_at: "2026-07-23T08:00:00.000Z",
    updated_at: "2026-07-23T08:00:00.000Z",
  };
}

function delivery(id: string, eventType: string, status = "delivered") {
  return {
    id,
    webhook_id: WEBHOOK_ID,
    event_type: eventType,
    status,
    attempt_count: 1,
    last_status_code: 204,
    last_error: null,
    last_response_body_truncated: null,
    delivered_at: "2026-07-23T08:01:00.000Z",
    created_at: "2026-07-23T08:00:00.000Z",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  access.canAdmin = true;
  for (const mock of Object.values(api)) mock.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  toast.success.mockReset();
  secretLifecycle.activate.mockReset();
  secretLifecycle.resolve.mockReset();
  identity.sequence = 0;
  api.list.mockResolvedValue({
    data: { list_id: LIST_ID, webhooks: [webhook()], next_cursor: "" },
  });
  api.deliveries.mockResolvedValue({
    data: { deliveries: [], next_cursor: "" },
  });
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
      await Promise.resolve();
    });
  }
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function button(label: string, occurrence = 0): HTMLButtonElement {
  const matches = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((candidate) => candidate.textContent?.trim() === label);
  const match = matches[occurrence];
  if (!match) throw new Error(`Missing button ${label} at ${occurrence}`);
  return match;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("list WebhooksTab canonical convergence", () => {
  it("does not issue sensitive webhook requests for non-admins", async () => {
    access.canAdmin = false;
    render(<WebhooksTab list={list} />);
    await flush();

    expect(document.body.textContent).toContain("Admin access required");
    expect(document.body.textContent).toContain(
      "No webhook data was requested",
    );
    expect(api.list).not.toHaveBeenCalled();
  });

  it("loads the server-scoped page by Moosewave UUID, never Listmonk id", async () => {
    render(<WebhooksTab list={list} />);
    await flush();

    expect(api.list).toHaveBeenCalledWith(LIST_ID, { limit: 50 });
    expect(JSON.stringify(api.list.mock.calls)).not.toContain('"71"');
    expect(document.body.textContent).toContain("https://receiver.example/…?…");
  });

  it("keeps the one-time signing secret visible until secure storage is acknowledged", async () => {
    api.create.mockResolvedValue({
      data: {
        ...webhook(),
        signing_secret: "pw_list_once_secret",
      },
    });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() => button("Add webhook").click());
    const url = document.querySelector<HTMLInputElement>("#lwt-url");
    expect(url).not.toBeNull();
    act(() => {
      if (!url) return;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(url, "https://receiver.example/hooks/list");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    act(() => button("Add webhook", 1).click());
    await flush();

    expect(api.create).toHaveBeenCalledWith(
      LIST_ID,
      {
        url: "https://receiver.example/hooks/list",
        events: ["list.subscriber.added"],
      },
      {
        idempotencyKey: "stable-idempotency-1",
      },
    );
    expect(document.body.textContent).toContain("pw_list_once_secret");
    expect(document.body.textContent).toContain("shown exactly once");
    expect(secretLifecycle.activate).toHaveBeenCalledTimes(1);
    expect(button("I've stored it securely").disabled).toBe(true);

    const checkbox = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).find((input) => input.checked === false);
    expect(checkbox).not.toBeUndefined();
    act(() => checkbox?.click());
    expect(button("I've stored it securely").disabled).toBe(false);
    act(() => button("I've stored it securely").click());
    expect(document.body.textContent).not.toContain("pw_list_once_secret");
    expect(secretLifecycle.resolve).toHaveBeenCalledTimes(1);
  });

  it("requires explicit confirmation before discarding an unstored secret", async () => {
    api.create.mockResolvedValue({
      data: { ...webhook(), signing_secret: "pw_discard_once" },
    });
    render(<WebhooksTab list={list} />);
    await flush();
    act(() => button("Add webhook").click());
    const url = document.querySelector<HTMLInputElement>("#lwt-url")!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(url, "https://receiver.example/hooks/list");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    act(() => button("Add webhook", 1).click());
    await flush();

    act(() => button("Discard shown secret…").click());
    expect(document.body.textContent).toContain(
      "Discard the shown signing secret?",
    );
    expect(document.body.textContent).toContain("pw_discard_once");
    act(() => button("Keep it open").click());
    expect(document.body.textContent).toContain("pw_discard_once");

    act(() => button("Discard shown secret…").click());
    act(() => button("Discard shown value").click());
    expect(document.body.textContent).not.toContain("pw_discard_once");
    expect(secretLifecycle.resolve).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a filtered probe from a signed HTTP 204 delivery", async () => {
    api.test.mockResolvedValue({
      data: {
        webhook_id: WEBHOOK_ID,
        status_code: 204,
        signed: false,
        signature: "",
        response: "",
        filtered: true,
      },
    });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() => button("Test").click());
    await flush();
    expect(toast.info).toHaveBeenCalledWith(
      "Test did not match the endpoint filter; no request was signed or sent.",
    );
    expect(toast.success).not.toHaveBeenCalledWith("Test fired — 204");
  });

  it("rejects an entire webhook page that overlaps a verified identity", async () => {
    api.list
      .mockResolvedValueOnce({
        data: {
          list_id: LIST_ID,
          webhooks: [webhook()],
          next_cursor: "cGFnZS0y",
        },
      })
      .mockResolvedValueOnce({
        data: {
          list_id: LIST_ID,
          webhooks: [
            webhook(),
            {
              ...webhook(),
              id: "33333333-3333-4333-8333-333333333333",
              url: "https://older.example/…",
            },
          ],
          next_cursor: "",
        },
      });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() => button("Load older webhooks").click());
    await flush();
    expect(api.list).toHaveBeenLastCalledWith(LIST_ID, {
      limit: 50,
      cursor: "cGFnZS0y",
    });
    expect(
      document.body.textContent?.match(/https:\/\/receiver\.example\/…\?…/gu),
    ).toHaveLength(1);
    expect(document.body.textContent).not.toContain("https://older.example/…");
    expect(document.body.textContent).toContain(
      "entire unverified page was rejected",
    );
  });

  it("keeps verified rows visible when a same-list refresh fails", async () => {
    api.list
      .mockResolvedValueOnce({
        data: { list_id: LIST_ID, webhooks: [webhook()], next_cursor: "" },
      })
      .mockResolvedValueOnce({
        error: { message: "refresh unavailable", kind: "network" },
      });
    api.remove.mockResolvedValue({ data: undefined });
    render(<WebhooksTab list={list} />);
    await flush();

    const remove = document.querySelector<HTMLButtonElement>(
      `button[aria-label="Delete webhook https://receiver.example/…?…"]`,
    );
    expect(remove).not.toBeNull();
    act(() => remove?.click());
    setInputValue(
      document.querySelector<HTMLInputElement>('input[placeholder="DELETE"]')!,
      "DELETE",
    );
    act(() => button("Delete webhook").click());
    await flush();

    expect(document.body.textContent).toContain("https://receiver.example/…?…");
    expect(document.body.textContent).toContain("refresh unavailable");
  });

  it("does not present a hard load failure as a truly empty webhook list", async () => {
    api.list
      .mockResolvedValueOnce({
        error: { message: "catalog unavailable", kind: "network" },
      })
      .mockResolvedValueOnce({
        data: { list_id: LIST_ID, webhooks: [], next_cursor: "" },
      });
    render(<WebhooksTab list={list} />);
    await flush();

    expect(document.body.textContent).toContain("catalog unavailable");
    expect(document.body.textContent).not.toContain(
      "No webhooks scoped to this list yet",
    );
    expect(button("Retry")).toBeTruthy();

    act(() => button("Retry").click());
    await flush();
    expect(document.body.textContent).not.toContain("catalog unavailable");
    expect(document.body.textContent).toContain(
      "No webhooks scoped to this list yet",
    );
  });

  it("locks live endpoint actions while retained rows are being reverified", async () => {
    const refresh = deferred<{
      data: {
        list_id: string;
        webhooks: ReturnType<typeof webhook>[];
        next_cursor: string;
      };
    }>();
    api.list
      .mockResolvedValueOnce({
        data: { list_id: LIST_ID, webhooks: [webhook()], next_cursor: "" },
      })
      .mockImplementationOnce(() => refresh.promise);
    api.remove.mockResolvedValue({ data: undefined });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="Delete webhook https://receiver.example/…?…"]`,
        )
        ?.click(),
    );
    setInputValue(
      document.querySelector<HTMLInputElement>('input[placeholder="DELETE"]')!,
      "DELETE",
    );
    act(() => button("Delete webhook").click());
    await flush();

    expect(document.body.textContent).toContain("Refreshing webhooks");
    expect(document.body.textContent).toContain(
      "Wait while Moosewave verifies the current webhook configuration",
    );
    expect(button("Test").getAttribute("aria-disabled")).toBe("true");
    act(() => button("Test").click());
    expect(api.test).not.toHaveBeenCalled();

    refresh.resolve({
      data: { list_id: LIST_ID, webhooks: [webhook()], next_cursor: "" },
    });
    await flush();
    expect(button("Test").getAttribute("aria-disabled")).toBeNull();
  });

  it("deduplicates delivery pages and retains verified history on append failure", async () => {
    const first = delivery(
      "44444444-4444-4444-8444-444444444444",
      "first.delivery",
    );
    const second = delivery(
      "55555555-5555-4555-8555-555555555555",
      "second.delivery",
    );
    api.deliveries
      .mockResolvedValueOnce({
        data: { deliveries: [first], next_cursor: "delivery-page-2" },
      })
      .mockResolvedValueOnce({
        data: {
          deliveries: [second],
          next_cursor: "delivery-page-3",
        },
      })
      .mockResolvedValueOnce({
        error: { message: "older page unavailable", kind: "network" },
      });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() => button("Deliveries").click());
    await flush();
    act(() => button("Load older deliveries").click());
    await flush();

    expect(document.body.textContent?.match(/first\.delivery/gu)).toHaveLength(
      1,
    );
    expect(document.body.textContent).toContain("second.delivery");

    act(() => button("Load older deliveries").click());
    await flush();
    expect(document.body.textContent).toContain("older page unavailable");
    expect(document.body.textContent).toContain(
      "Verified deliveries remain visible",
    );
    expect(document.body.textContent).toContain("first.delivery");
    expect(document.body.textContent).toContain("second.delivery");
  });

  it("fails closed when delivery pagination cycles through an older cursor", async () => {
    api.deliveries
      .mockResolvedValueOnce({
        data: {
          deliveries: [
            delivery("44444444-4444-4444-8444-444444444444", "first.delivery"),
          ],
          next_cursor: "cursor-a",
        },
      })
      .mockResolvedValueOnce({
        data: {
          deliveries: [
            delivery("55555555-5555-4555-8555-555555555555", "second.delivery"),
          ],
          next_cursor: "cursor-b",
        },
      })
      .mockResolvedValueOnce({
        data: {
          deliveries: [
            delivery("66666666-6666-4666-8666-666666666666", "third.delivery"),
          ],
          next_cursor: "cursor-a",
        },
      });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() => button("Deliveries").click());
    await flush();
    act(() => button("Load older deliveries").click());
    await flush();
    act(() => button("Load older deliveries").click());
    await flush();

    expect(document.body.textContent).toContain(
      "Moosewave returned a repeated delivery cursor",
    );
    expect(document.body.textContent).toContain("third.delivery");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) =>
          candidate.textContent?.trim() === "Load older deliveries",
      ),
    ).toBe(false);
  });

  it("ignores a late delivery-page completion after the history is closed", async () => {
    const latePage = deferred<{
      data: { deliveries: ReturnType<typeof delivery>[]; next_cursor: string };
    }>();
    api.deliveries
      .mockResolvedValueOnce({
        data: {
          deliveries: [
            delivery("44444444-4444-4444-8444-444444444444", "first.delivery"),
          ],
          next_cursor: "cursor-late",
        },
      })
      .mockImplementationOnce(() => latePage.promise)
      .mockResolvedValueOnce({
        data: {
          deliveries: [
            delivery("77777777-7777-4777-8777-777777777777", "fresh.delivery"),
          ],
          next_cursor: "",
        },
      });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() => button("Deliveries").click());
    await flush();
    act(() => button("Load older deliveries").click());
    act(() => button("Hide deliveries").click());
    latePage.resolve({
      data: {
        deliveries: [
          delivery("88888888-8888-4888-8888-888888888888", "late.delivery"),
        ],
        next_cursor: "",
      },
    });
    await flush();

    act(() => button("Deliveries").click());
    await flush();
    expect(document.body.textContent).toContain("fresh.delivery");
    expect(document.body.textContent).not.toContain("late.delivery");
  });

  it("reuses create idempotency after ambiguity and replaces it when the draft changes", async () => {
    api.create
      .mockResolvedValueOnce({
        error: { message: "response lost", kind: "network" },
      })
      .mockResolvedValueOnce({
        error: { message: "still ambiguous", kind: "network" },
      })
      .mockResolvedValueOnce({
        data: { ...webhook(), signing_secret: "pw_retry_secret" },
      });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() => button("Add webhook").click());
    const url = document.querySelector<HTMLInputElement>("#lwt-url")!;
    setInputValue(url, "https://receiver.example/hooks/list");
    await flush();
    act(() => button("Add webhook", 1).click());
    await flush();
    act(() => button("Add webhook", 1).click());
    await flush();

    expect(api.create.mock.calls[0]?.[2]).toEqual({
      idempotencyKey: "stable-idempotency-1",
    });
    expect(api.create.mock.calls[1]?.[2]).toEqual({
      idempotencyKey: "stable-idempotency-1",
    });

    setInputValue(url, "https://receiver.example/hooks/changed");
    await flush();
    act(() => button("Add webhook", 1).click());
    await flush();
    expect(api.create.mock.calls[2]?.[2]).toEqual({
      idempotencyKey: "stable-idempotency-2",
    });
    expect(document.body.textContent).toContain("pw_retry_secret");
  });

  it("reuses rotation idempotency across a manual retry and reveals the rotated secret once", async () => {
    api.rotate
      .mockResolvedValueOnce({
        error: { message: "rotation response lost", kind: "network" },
      })
      .mockResolvedValueOnce({
        data: { ...webhook(), signing_secret: "pw_rotated_once" },
      });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() => button("Rotate secret").click());
    expect(document.body.textContent).toContain("24-hour grace window");
    act(() => button("Rotate secret", 1).click());
    await flush();
    act(() => button("Rotate secret", 1).click());
    await flush();

    expect(api.rotate).toHaveBeenNthCalledWith(
      1,
      LIST_ID,
      WEBHOOK_ID,
      undefined,
      { idempotencyKey: "stable-idempotency-1" },
    );
    expect(api.rotate).toHaveBeenNthCalledWith(
      2,
      LIST_ID,
      WEBHOOK_ID,
      undefined,
      { idempotencyKey: "stable-idempotency-1" },
    );
    expect(document.body.textContent).toContain("pw_rotated_once");
    expect(secretLifecycle.activate).toHaveBeenCalledTimes(1);
  });

  it("explains readiness and blocks tests for paused or unready endpoints", async () => {
    api.list.mockResolvedValue({
      data: {
        list_id: LIST_ID,
        webhooks: [
          {
            ...webhook(),
            active: false,
            url_status: "legacy_pending",
          },
        ],
        next_cursor: "",
      },
    });
    render(<WebhooksTab list={list} />);
    await flush();

    expect(document.body.textContent).toContain(
      "Paused · destination legacy pending",
    );
    expect(button("Test").getAttribute("aria-disabled")).toBe("true");
    expect(button("Test").title).toContain("Resume this endpoint");
    act(() => button("Test").click());
    expect(api.test).not.toHaveBeenCalled();
  });

  it("sanitizes retained delivery evidence before exposing a tooltip", async () => {
    api.deliveries.mockResolvedValue({
      data: {
        deliveries: [
          {
            ...delivery(
              "44444444-4444-4444-8444-444444444444",
              "list.subscriber.added",
            ),
            last_error: "Authorization: Bearer super-secret-token",
          },
        ],
        next_cursor: "",
      },
    });
    render(<WebhooksTab list={list} />);
    await flush();

    act(() => button("Deliveries").click());
    await flush();
    const titles = Array.from(document.querySelectorAll<HTMLElement>("[title]"))
      .map((element) => element.title)
      .filter(Boolean);
    expect(titles.some((title) => title.includes("super-secret-token"))).toBe(
      false,
    );
  });
});

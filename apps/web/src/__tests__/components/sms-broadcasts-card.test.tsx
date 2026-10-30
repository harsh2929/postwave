// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  cancel: vi.fn(),
  send: vi.fn(),
  progress: vi.fn(),
  listSenders: vi.fn(),
  listSegments: vi.fn(),
  listTags: vi.fn(),
  whoami: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (profile: { effective_role?: string }) =>
    profile.effective_role,
  whoami: mocks.whoami,
}));
vi.mock("@/lib/sms-api", () => ({
  listSmsBroadcasts: mocks.list,
  createSmsBroadcast: mocks.create,
  updateSmsBroadcast: mocks.update,
  deleteSmsBroadcast: mocks.remove,
  cancelSmsBroadcast: mocks.cancel,
  sendSmsBroadcast: mocks.send,
  getSmsBroadcastProgress: mocks.progress,
  listSmsSenders: mocks.listSenders,
}));
vi.mock("@/lib/segments-api", () => ({ listSegments: mocks.listSegments }));
vi.mock("@/lib/audience-admin-api", () => ({ listTags: mocks.listTags }));
vi.mock("@/lib/api", () => ({
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
  isApiError: () => false,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { SmsBroadcastsCard } from "@/app/(dashboard)/app/sms/sms-broadcasts-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const TENANT = "00000000-0000-0000-0000-000000000001";
const USER = "11111111-1111-4111-8111-111111111111";
const LIST_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LIST_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const SEGMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const DRAFT_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const SCHEDULED_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const SENDING_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const CANCELLED_ID = "cccccccc-cccc-4ccc-8ccc-ccccccccccc4";
const SNAPSHOT = "2026-09-05T10:00:00Z";
const HELD_REASON = "sms_broadcast_dispatch_release_held";
const HELD_SENTENCE =
  "SMS broadcast dispatch is unavailable until the budget, frozen-audience, enqueue and provider reconciliation saga is durable";

const base = {
  body: "Hi there",
  list_ids: [] as string[],
  sent_count: 0,
  failed_count: 0,
  held_count: 0,
  segments_per_message: 1,
  created_at: "2026-09-01T09:00:00Z",
  updated_at: "2026-09-01T09:00:00Z",
};
const draft = {
  ...base,
  id: DRAFT_ID,
  name: "June flash sale",
  status: "draft",
  list_ids: [LIST_A],
  scheduled_at: null,
};
const scheduled = {
  ...base,
  id: SCHEDULED_ID,
  name: "Autumn reminder",
  status: "scheduled",
  segment_id: SEGMENT,
  scheduled_at: "2027-01-01T12:00:00Z",
};
const sending = {
  ...base,
  id: SENDING_ID,
  name: "Live drop",
  status: "sending",
  tag: "vip",
  sent_count: 120,
  failed_count: 3,
  held_count: 7,
  scheduled_at: null,
};
const cancelled = {
  ...base,
  id: CANCELLED_ID,
  name: "Old teaser",
  status: "cancelled",
  tag: "old",
  scheduled_at: null,
};

const lists = [
  { id: LIST_A, name: "VIP texts", description: "", created_at: "", updated_at: "" },
  { id: LIST_B, name: "Launch list", description: "", created_at: "", updated_at: "" },
];

function page(
  items: unknown[],
  extra: Partial<{ nextCursor: string; snapshotAt: string }> = {},
) {
  return {
    tenantId: TENANT,
    items,
    snapshotAt: SNAPSHOT,
    broadcastDispatchAvailable: false,
    broadcastDispatchUnavailableReason: HELD_REASON,
    ...extra,
  };
}

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  mocks.list.mockReset().mockImplementation((input: { cursor?: string }) =>
    Promise.resolve(
      input.cursor
        ? page([cancelled])
        : page([draft, scheduled, sending], { nextCursor: "v1.next" }),
    ),
  );
  mocks.create.mockReset().mockResolvedValue({ ...draft, id: DRAFT_ID });
  mocks.update.mockReset().mockResolvedValue({ ...draft, name: "Renamed" });
  mocks.remove.mockReset().mockResolvedValue({ ok: true });
  mocks.cancel.mockReset().mockResolvedValue({ ...scheduled, status: "cancelled" });
  mocks.send.mockReset().mockResolvedValue({
    broadcast: { ...draft, status: "sending" },
    progress: { status: "sending", sent: 0, failed: 0, held: 0, total: 150 },
    enqueued: 150,
  });
  mocks.progress.mockReset().mockResolvedValue({
    status: "sending",
    sent: 120,
    failed: 3,
    held: 7,
    total: 200,
  });
  mocks.listSenders.mockReset().mockResolvedValue({ items: [] });
  mocks.listSegments.mockReset().mockResolvedValue([
    {
      id: SEGMENT,
      tenantId: TENANT,
      name: "Recent buyers",
      description: "",
      queryAst: { type: "and", children: [] },
      lastCount: 42,
      createdAt: "",
      updatedAt: "",
    },
  ]);
  mocks.listTags.mockReset().mockResolvedValue([]);
  mocks.whoami.mockReset().mockResolvedValue({
    tenant_id: TENANT,
    user_id: USER,
    effective_role: "admin",
    viewer_mode: false,
  });
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(async () => {
  setOnlineStatusForTest("connecting");
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SmsBroadcastsCard
          baseKey={["sms", TENANT, "admin", USER]}
          enabled
          tenantId={TENANT}
          userId={USER}
          lists={lists}
        />
      </QueryClientProvider>,
    );
  });
  await flushUntil(() =>
    Boolean(container.textContent?.includes("June flash sale")),
  );
  return container;
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (button): button is HTMLButtonElement =>
      button instanceof HTMLButtonElement &&
      button.textContent?.trim() === label,
  );
}

function setValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40 && !predicate(); attempt += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(predicate()).toBe(true);
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(element).not.toBeNull();
  return element!;
}

function labelled(label: string): HTMLInputElement | HTMLTextAreaElement {
  const target = Array.from(
    dialog().querySelectorAll<HTMLLabelElement>("label"),
  ).find((element) => element.textContent?.trim() === label);
  expect(target?.htmlFor).toBeTruthy();
  const field = document.getElementById(target!.htmlFor);
  expect(field).not.toBeNull();
  return field as HTMLInputElement | HTMLTextAreaElement;
}

describe("SmsBroadcastsCard (messaging-1, messaging-26)", () => {
  it("is mounted as a lazily loaded Broadcasts tab of the SMS workspace", () => {
    const workspace = readFileSync(
      resolve(process.cwd(), "src/app/(dashboard)/app/sms/sms-workspace.tsx"),
      "utf8",
    );
    expect(workspace).toContain('import("./sms-broadcasts-card")');
    expect(workspace).not.toMatch(
      /^import (?!type )[^;]*from "\.\/sms-broadcasts-card";/m,
    );
    expect(workspace).toContain('<TabsTrigger value="broadcasts">Broadcasts');
    expect(workspace).toContain('<TabsContent value="broadcasts"');
    expect(workspace).toMatch(/TAB_VALUES = \[[^\]]*"broadcasts"/s);
  });

  it("lists one bounded tenant page, renders the server's dispatch verdict verbatim, loads more by cursor, and refreshes", async () => {
    const container = await renderCard();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({
      tenantId: TENANT,
      limit: 50,
      signal: expect.any(AbortSignal),
    });
    expect(container.textContent).toContain(HELD_REASON);
    expect(container.textContent).toContain("does not send or schedule");
    expect(container.textContent).toContain("List: VIP texts");
    expect(container.textContent).toContain("Segment: Recent buyers");
    expect(container.textContent).toContain("Tag: vip");
    expect(container.textContent).toContain("120 accepted · 3 failed · 7 held");
    expect(container.textContent).not.toContain("Old teaser");

    await act(async () => {
      buttons("Load more broadcasts")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() =>
      Boolean(container.textContent?.includes("Old teaser")),
    );
    expect(mocks.list).toHaveBeenLastCalledWith({
      tenantId: TENANT,
      limit: 50,
      cursor: "v1.next",
      signal: expect.any(AbortSignal),
    });
    expect(buttons("Load more broadcasts")).toHaveLength(0);

    await act(async () => {
      buttons("Refresh")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.list.mock.calls.length === 3);
    expect(mocks.list.mock.calls[2]?.[0]).not.toHaveProperty("cursor");
  });

  it("fails loud when a later page comes from a different insertion cutoff", async () => {
    mocks.list.mockImplementation((input: { cursor?: string }) =>
      Promise.resolve(
        input.cursor
          ? page([cancelled], { snapshotAt: "2026-09-05T10:05:00Z" })
          : page([draft], { nextCursor: "v1.next" }),
      ),
    );
    const container = await renderCard();
    await act(async () => {
      buttons("Load more broadcasts")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() =>
      Boolean(container.textContent?.includes("insertion window changed")),
    );
    expect(buttons("Load more broadcasts")).toHaveLength(0);
    expect(buttons("New broadcast")[0]?.disabled).toBe(true);
  });
});

describe("SmsBroadcastsCard composer (messaging-27, messaging-28)", () => {
  it("creates a draft with exactly one audience and the other dimensions cleared", async () => {
    const container = await renderCard();
    await act(async () => {
      buttons("New broadcast")[0]?.click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain("does not send or schedule");
    await flushUntil(() => mocks.listSenders.mock.calls.length === 1);

    setValue(labelled("Name"), "  Welcome offer ");
    setValue(labelled("Message"), "Hi there, 10% off today with code TEN");
    await act(async () => {
      dialog()
        .querySelector<HTMLInputElement>('input[aria-label="Target VIP texts"]')
        ?.click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain("1 segment");

    await act(async () => {
      buttons("Create draft")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.create.mock.calls.length === 1);
    expect(mocks.create).toHaveBeenCalledWith(
      {
        name: "Welcome offer",
        body: "Hi there, 10% off today with code TEN",
        sender_profile_id: "",
        list_ids: [LIST_A],
        segment_id: "",
        tag: "",
        scheduled_at: null,
      },
      expect.any(AbortSignal),
    );
    expect(mocks.whoami).toHaveBeenCalledTimes(1);
    await flushUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Broadcast draft created",
      expect.objectContaining({
        description: expect.stringContaining("Nothing was sent or scheduled"),
      }),
    );
    await flushUntil(() => mocks.list.mock.calls.length >= 2);
    expect(container.textContent).toContain("June flash sale");
  });

  it("blocks an audience-less draft before any request and names the rule", async () => {
    await renderCard();
    await act(async () => {
      buttons("New broadcast")[0]?.click();
      await Promise.resolve();
    });
    setValue(labelled("Name"), "No audience");
    setValue(labelled("Message"), "Hello");
    await act(async () => {
      buttons("Create draft")[0]?.click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain("Pick at least one SMS list.");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.whoami).not.toHaveBeenCalled();
  });

  it("renders the server's refusal sentence verbatim on the field its code names", async () => {
    mocks.create.mockRejectedValueOnce(
      Object.assign(
        new Error("list_ids entries must be canonical lowercase UUIDv4 values"),
        { status: 422, code: "invalid_audience" },
      ),
    );
    await renderCard();
    await act(async () => {
      buttons("New broadcast")[0]?.click();
      await Promise.resolve();
    });
    setValue(labelled("Name"), "Bad audience");
    setValue(labelled("Message"), "Hello");
    await act(async () => {
      dialog()
        .querySelector<HTMLInputElement>('input[aria-label="Target VIP texts"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons("Create draft")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.create.mock.calls.length === 1);
    await flushUntil(() =>
      Boolean(
        dialog().textContent?.includes(
          "list_ids entries must be canonical lowercase UUIDv4 values",
        ),
      ),
    );
    const alert = dialog().querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      "list_ids entries must be canonical lowercase UUIDv4 values",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("edits a draft through PATCH with the row's values prefilled and withholds Edit from sending rows", async () => {
    await renderCard();
    // Draft + scheduled are editable; the sending row must not offer Edit.
    expect(buttons("Edit")).toHaveLength(2);
    await act(async () => {
      buttons("Edit")[0]?.click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain("Edit June flash sale");
    const name = labelled("Name") as HTMLInputElement;
    expect(name.value).toBe("June flash sale");
    expect(
      dialog().querySelector<HTMLInputElement>(
        'input[aria-label="Target VIP texts"]',
      )?.checked,
    ).toBe(true);
    setValue(name, "June flash sale v2");
    await act(async () => {
      buttons("Save changes")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.update.mock.calls.length === 1);
    expect(mocks.update).toHaveBeenCalledWith(
      DRAFT_ID,
      {
        name: "June flash sale v2",
        body: "Hi there",
        sender_profile_id: "",
        list_ids: [LIST_A],
        segment_id: "",
        tag: "",
        scheduled_at: null,
      },
      expect.any(AbortSignal),
    );
    expect(mocks.create).not.toHaveBeenCalled();
    await flushUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Broadcast updated",
      expect.anything(),
    );
  });

  it("sends no write when reauthorization no longer confirms owner/admin authority", async () => {
    mocks.whoami.mockResolvedValue({
      tenant_id: TENANT,
      user_id: USER,
      effective_role: "editor",
      viewer_mode: false,
    });
    await renderCard();
    await act(async () => {
      buttons("New broadcast")[0]?.click();
      await Promise.resolve();
    });
    setValue(labelled("Name"), "Nope");
    setValue(labelled("Message"), "Hello");
    await act(async () => {
      dialog()
        .querySelector<HTMLInputElement>('input[aria-label="Target VIP texts"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons("Create draft")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() =>
      Boolean(dialog().textContent?.includes("no broadcast request was sent")),
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("SmsBroadcastsCard send (messaging-29)", () => {
  const HOLD_COPY =
    "SMS broadcast dispatch is release-held while durable provider reconciliation and budget settlement are unavailable. Drafts remain editable, but no provider send or schedule request can be started.";

  it("disables Send now / Schedule with the exact hold sentence while the list payload holds dispatch, and sends nothing", async () => {
    const container = await renderCard();
    const reason = container.querySelector("#sms-broadcast-dispatch-reason");
    expect(reason?.textContent).toBe(HOLD_COPY);
    // Draft → "Send now"; scheduled-ahead → "Schedule"; the sending row offers neither.
    const sendNow = buttons("Send now");
    const schedule = buttons("Schedule");
    expect(sendNow).toHaveLength(1);
    expect(schedule).toHaveLength(1);
    for (const control of [...sendNow, ...schedule]) {
      expect(control.disabled).toBe(true);
      expect(control.getAttribute("aria-describedby")).toBe(
        "sms-broadcast-dispatch-reason",
      );
      expect(control.title).toBe(HOLD_COPY);
    }
    await act(async () => {
      sendNow[0]?.click();
      schedule[0]?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.whoami).not.toHaveBeenCalled();
  });

  it("with dispatch available, confirms quoting the audience and POSTs …/send, then opens the drilldown", async () => {
    mocks.list.mockImplementation(() =>
      Promise.resolve({
        ...page([draft, scheduled, sending]),
        broadcastDispatchAvailable: true,
        broadcastDispatchUnavailableReason: undefined,
      }),
    );
    const container = await renderCard();
    expect(container.querySelector("#sms-broadcast-dispatch-reason")).toBeNull();
    expect(container.textContent).toContain("Broadcast dispatch is reported available");
    const sendNow = buttons("Send now")[0]!;
    expect(sendNow.disabled).toBe(false);
    expect(sendNow.getAttribute("aria-describedby")).toBeNull();
    await act(async () => {
      sendNow.click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain('Send "June flash sale" now?');
    expect(dialog().textContent).toContain("Audience: List: VIP texts");
    expect(dialog().textContent).toContain("1 billed segment");
    expect(dialog().textContent).toContain("Quiet-hours messages are held");
    expect(mocks.send).not.toHaveBeenCalled();

    await act(async () => {
      buttons("Send now").at(-1)?.click();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.send.mock.calls.length === 1);
    expect(mocks.send).toHaveBeenCalledWith(DRAFT_ID, expect.any(AbortSignal));
    expect(mocks.whoami).toHaveBeenCalledTimes(1);
    await flushUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Sending — 150 messages enqueued",
    );
    await flushUntil(() =>
      Boolean(container.querySelector(`#sms-broadcast-progress-${DRAFT_ID}`)),
    );
    await flushUntil(() => mocks.list.mock.calls.length >= 2);
  });

  it("labels a future-scheduled row Schedule and quotes when it arms", async () => {
    mocks.list.mockImplementation(() =>
      Promise.resolve({
        ...page([scheduled]),
        broadcastDispatchAvailable: true,
        broadcastDispatchUnavailableReason: undefined,
      }),
    );
    mocks.send.mockResolvedValue({
      broadcast: { ...scheduled },
      progress: { status: "scheduled", sent: 0, failed: 0, held: 0, total: 0 },
      enqueued: 0,
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SmsBroadcastsCard
            baseKey={["sms", TENANT, "admin", USER]}
            enabled
            tenantId={TENANT}
            userId={USER}
            lists={lists}
          />
        </QueryClientProvider>,
      );
    });
    await flushUntil(() => Boolean(container.textContent?.includes("Autumn reminder")));
    expect(buttons("Send now")).toHaveLength(0);
    await act(async () => {
      buttons("Schedule")[0]?.click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain('Schedule "Autumn reminder"?');
    expect(dialog().textContent).toContain("Audience: Segment: Recent buyers");
    expect(dialog().textContent).toContain("Armed for");
    await act(async () => {
      buttons("Schedule").at(-1)?.click();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.send.mock.calls.length === 1);
    expect(mocks.send).toHaveBeenCalledWith(SCHEDULED_ID, expect.any(AbortSignal));
    await flushUntil(() => mocks.toastSuccess.mock.calls.length === 1);
    expect(mocks.toastSuccess.mock.calls[0]?.[0]).toMatch(/^Scheduled for /u);
  });
});

describe("SmsBroadcastsCard cancel (messaging-30)", () => {
  it("cancels a scheduled broadcast only through a confirm that names the consequence", async () => {
    await renderCard();
    // Only scheduled|sending rows offer Cancel (the draft does not).
    expect(buttons("Cancel")).toHaveLength(2);
    await act(async () => {
      buttons("Cancel")[0]?.click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain('Cancel "Autumn reminder"?');
    expect(dialog().textContent).toContain("will be marked cancelled");
    expect(mocks.cancel).not.toHaveBeenCalled();

    await act(async () => {
      buttons("Cancel broadcast")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.cancel.mock.calls.length === 1);
    expect(mocks.cancel).toHaveBeenCalledWith(
      SCHEDULED_ID,
      expect.any(AbortSignal),
    );
    await flushUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Broadcast cancelled",
      expect.anything(),
    );
    await flushUntil(() => mocks.list.mock.calls.length >= 2);
  });

  it("renders a server 503 sentence verbatim and claims no outcome", async () => {
    mocks.cancel.mockRejectedValueOnce(
      Object.assign(new Error(HELD_SENTENCE), {
        status: 503,
        code: HELD_REASON,
      }),
    );
    await renderCard();
    await act(async () => {
      buttons("Cancel")[1]?.click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain('Cancel "Live drop"?');
    expect(dialog().textContent).toContain("mid-send");
    await act(async () => {
      buttons("Cancel broadcast")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() =>
      Boolean(dialog().textContent?.includes(HELD_SENTENCE)),
    );
    expect(mocks.cancel).toHaveBeenCalledWith(
      SENDING_ID,
      expect.any(AbortSignal),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
});

describe("SmsBroadcastsCard delete (messaging-31)", () => {
  it("deletes through a confirm and is withheld with the reason while sending", async () => {
    const container = await renderCard();
    const deletes = buttons("Delete");
    expect(deletes).toHaveLength(3);
    expect(deletes[0]?.disabled).toBe(false);
    expect(deletes[1]?.disabled).toBe(false);
    expect(deletes[2]?.disabled).toBe(true);
    expect(container.textContent).toContain(
      "A sending broadcast cannot be deleted; cancel it first.",
    );

    await act(async () => {
      deletes[0]?.click();
      await Promise.resolve();
    });
    expect(dialog().textContent).toContain('Delete "June flash sale"?');
    expect(dialog().textContent).toContain("cannot be undone");
    expect(mocks.remove).not.toHaveBeenCalled();

    await act(async () => {
      buttons("Delete broadcast")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.remove.mock.calls.length === 1);
    expect(mocks.remove).toHaveBeenCalledWith(
      DRAFT_ID,
      expect.any(AbortSignal),
    );
    await flushUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Broadcast deleted");
    await flushUntil(() => mocks.list.mock.calls.length >= 2);
  });

  it("closes the confirm without a request when the operator keeps the broadcast", async () => {
    await renderCard();
    await act(async () => {
      buttons("Delete")[0]?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons("Cancel").at(-1)?.click();
      await Promise.resolve();
    });
    await flushUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.whoami).not.toHaveBeenCalled();
  });
});

describe("SmsBroadcastsCard delivery progress (messaging-32)", () => {
  it("shows the progress route's counters verbatim for a row, mirrors them into the list, and hides on toggle", async () => {
    const container = await renderCard();
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show delivery progress for Live drop"]',
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(mocks.progress).not.toHaveBeenCalled();

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.progress.mock.calls.length === 1);
    expect(mocks.progress).toHaveBeenCalledWith(
      SENDING_ID,
      expect.any(AbortSignal),
    );
    await flushUntil(() =>
      Boolean(container.textContent?.includes("Latest recorded status")),
    );
    const region = container.querySelector(
      `#sms-broadcast-progress-${SENDING_ID}`,
    );
    expect(region?.textContent).toContain("Latest recorded status: sending");
    expect(region?.textContent).toContain("Accepted by provider120");
    expect(region?.textContent).toContain("Recorded failed3");
    expect(region?.textContent).toContain("Held7");
    expect(region?.textContent).toContain("Pending70");
    expect(region?.textContent).toContain("Total200");
    expect(region?.textContent).toContain("62% accepted or failed");
    expect(region?.textContent).toContain("Refreshing every 5 seconds");
    expect(
      container
        .querySelector('button[aria-label="Hide delivery progress for Live drop"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Hide delivery progress for Live drop"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector(`#sms-broadcast-progress-${SENDING_ID}`),
    ).toBeNull();
    // The progress read only ever targeted the expanded row.
    expect(mocks.progress.mock.calls.every(([id]) => id === SENDING_ID)).toBe(
      true,
    );
  });

  it("keeps the last counters visible and names the failure when a refresh fails", async () => {
    mocks.progress.mockRejectedValueOnce(new Error("progress backend down"));
    const container = await renderCard();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Show delivery progress for Autumn reminder"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flushUntil(() =>
      Boolean(container.textContent?.includes("progress backend down")),
    );
    expect(container.textContent).toContain("Progress could not be refreshed");
  });
});

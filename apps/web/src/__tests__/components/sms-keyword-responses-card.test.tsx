// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
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
  createSmsKeywordResponse: mocks.create,
  deleteSmsKeywordResponse: mocks.remove,
  listSmsKeywordResponses: mocks.list,
  updateSmsKeywordResponse: mocks.update,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { SmsKeywordResponsesCard } from "@/app/(dashboard)/app/sms/sms-keyword-responses-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const TENANT = "00000000-0000-0000-0000-000000000001";
const USER = "11111111-1111-4111-8111-111111111111";
const CANONICAL_RESPONSE =
  "You are unsubscribed from SMS marketing messages from this sender.";
const common = {
  response_body: "Hostile\u202E Active",
  response_text: "Hostile\u202E Active",
  enabled: true,
  autoReplyDispatchAvailable: false,
  autoReplyDispatchUnavailableReason:
    "sms_auto_reply_dispatch_release_held" as const,
  opt_in_count: 0,
  created_at: "2026-08-21T09:00:00Z",
  updated_at: "2026-08-21T09:00:00Z",
};

beforeEach(() => {
  mocks.create.mockReset().mockResolvedValue({
    ...common,
    id: "created",
    keyword: "BYE",
    response_body: CANONICAL_RESPONSE,
    response_text: CANONICAL_RESPONSE,
    action: "opt_out",
  });
  mocks.list.mockReset().mockResolvedValue({
    tenantId: TENANT,
    items: [
      { ...common, id: "reply", keyword: "INFO", action: "reply_only" },
      {
        ...common,
        id: "out",
        keyword: "LEAVE",
        response_body: CANONICAL_RESPONSE,
        response_text: CANONICAL_RESPONSE,
        action: "opt_out",
      },
    ],
  });
  mocks.remove.mockReset().mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    id: "out",
  });
  mocks.update.mockReset().mockResolvedValue({
    ...common,
    id: "out",
    keyword: "LEAVE",
    response_body: CANONICAL_RESPONSE,
    response_text: CANONICAL_RESPONSE,
    action: "opt_out",
    enabled: false,
  });
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
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function renderCard(
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  }),
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SmsKeywordResponsesCard
          baseKey={["sms", "tenant"]}
          enabled
          tenantId={TENANT}
          userId={USER}
        />
      </QueryClientProvider>,
    );
  });
  await flushUntil(() => Boolean(container.textContent?.includes("INFO")));
  return container;
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (button): button is HTMLButtonElement =>
      button instanceof HTMLButtonElement &&
      button.textContent?.trim() === label,
  );
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30 && !predicate(); attempt += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  expect(predicate()).toBe(true);
}

async function escapeDialogAndExpectFocus(
  trigger: HTMLButtonElement,
): Promise<void> {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(trigger);

  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
}

describe("SmsKeywordResponsesCard auto-reply hold", () => {
  it("reports typed 4xx create/update refusals as known no-commit outcomes", async () => {
    mocks.create.mockRejectedValueOnce(
      Object.assign(new Error("unsafe create detail"), { status: 422 }),
    );
    const container = await renderCard();
    const input = container.querySelector<HTMLInputElement>("#keyword_word")!;
    await act(async () => {
      setInput(input, "PAUSE");
      input
        .closest("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    await flushUntil(() =>
      mocks.toastError.mock.calls.some(
        ([title, options]) =>
          title === "Could not save keyword opt-out rule" &&
          String(options?.description).includes("no change was committed"),
      ),
    );

    mocks.update.mockRejectedValueOnce(
      Object.assign(new Error("unsafe update detail"), { status: 409 }),
    );
    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Toggle LEAVE"]',
    );
    await flushUntil(() => toggle?.disabled === false);
    await act(async () => toggle?.click());
    await act(async () => {
      buttons("Disable stored rule")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() =>
      mocks.toastError.mock.calls.some(
        ([title, options]) =>
          title === "Could not update keyword" &&
          String(options?.description).includes("no change was committed"),
      ),
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toMatch(
      /unsafe (?:create|update) detail/u,
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "outcome is unknown",
    );
  });

  it("reports an untyped delete failure as outcome unknown and reloads", async () => {
    mocks.remove.mockRejectedValueOnce(new Error("unsafe proxy detail"));
    await renderCard();
    await act(async () => {
      buttons("Delete")[1]?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons("Delete").at(-1)?.click();
      await Promise.resolve();
    });
    await flushUntil(() =>
      mocks.toastError.mock.calls.some(
        ([title, options]) =>
          title === "Could not delete keyword" &&
          String(options?.description).includes("outcome is unknown"),
      ),
    );
    await flushUntil(() => mocks.list.mock.calls.length > 1);
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "unsafe proxy detail",
    );
  });

  it("warns when a refresh fails while earlier private rows remain", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = await renderCard(client);
    mocks.list.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => {
      await client.refetchQueries({
        queryKey: ["sms", "tenant", "keyword-responses"],
        exact: true,
      });
    });
    await flushUntil(() =>
      Boolean(container.textContent?.includes("may be stale")),
    );
    expect(container.textContent).toContain(
      "Rows shown are from an earlier response and may be stale",
    );
    expect(container.textContent).toContain("LEAVE");
    expect(
      container.querySelector<HTMLInputElement>("#keyword_word")?.disabled,
    ).toBe(true);
    expect(buttons("Delete").every((button) => button.disabled)).toBe(true);
    const optOut = container.querySelector<HTMLInputElement>(
      'input[aria-label="Toggle LEAVE"]',
    );
    expect(optOut?.disabled).toBe(true);
    await act(async () => {
      optOut?.click();
      buttons("Delete")[0]?.click();
      await Promise.resolve();
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("serializes confirmations and writes so a second row action cannot overlap", async () => {
    let resolveUpdate: ((value: unknown) => void) | undefined;
    mocks.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const container = await renderCard();
    const optOut = container.querySelector<HTMLInputElement>(
      'input[aria-label="Toggle LEAVE"]',
    );

    await act(async () => optOut?.click());
    expect(buttons("Delete").every((button) => button.disabled)).toBe(true);
    await act(async () => {
      buttons("Disable stored rule")[0]?.click();
      await Promise.resolve();
    });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    buttons("Delete")[0]?.click();
    optOut?.click();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();

    await act(async () => {
      resolveUpdate?.({
        ...common,
        id: "out",
        keyword: "LEAVE",
        response_body: CANONICAL_RESPONSE,
        response_text: CANONICAL_RESPONSE,
        action: "opt_out",
        enabled: false,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushUntil(
      () =>
        mocks.list.mock.calls.length >= 2 &&
        buttons("Delete").every((button) => !button.disabled),
    );
  });

  it("offers only opt-out state mutation and never calls a held reply effect", async () => {
    const container = await renderCard();

    expect(container.textContent).toContain(
      "sms_auto_reply_dispatch_release_held",
    );
    expect(container.textContent).not.toContain("Auto-reply active");
    expect(container.querySelector("#keyword_action")).toBeNull();
    expect(container.querySelector("#keyword_body")).toBeNull();
    const toggles = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(toggles).toHaveLength(2);
    const heldToggle = toggles.find(
      (toggle) => toggle.getAttribute("aria-label") === "Toggle INFO",
    );
    const optOutToggle = toggles.find(
      (toggle) => toggle.getAttribute("aria-label") === "Toggle LEAVE",
    );
    expect(heldToggle?.disabled).toBe(true);
    expect(optOutToggle?.disabled).toBe(false);

    await act(async () => optOutToggle?.click());
    await act(async () => {
      buttons("Disable stored rule")[0]?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flushUntil(() => mocks.update.mock.calls.length === 1);
    expect(mocks.update).toHaveBeenCalledWith(
      "out",
      { action: "opt_out", enabled: false },
      "2026-08-21T09:00:00Z",
      TENANT,
      expect.any(AbortSignal),
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.update.mock.calls)).not.toContain("Hostile");
  });

  it("returns focus to the exact keyword trigger when Escape closes deletion", async () => {
    await renderCard();
    const deleteButtons = buttons("Delete");
    expect(deleteButtons).toHaveLength(2);
    const trigger = deleteButtons[1]!;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('"LEAVE"');
    await escapeDialogAndExpectFocus(trigger);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("reports a confirmed create when identity changes after the receipt", async () => {
    mocks.whoami
      .mockReset()
      .mockResolvedValueOnce({
        tenant_id: TENANT,
        user_id: USER,
        effective_role: "admin",
        viewer_mode: false,
      })
      .mockResolvedValueOnce({
        tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        user_id: USER,
        effective_role: "admin",
        viewer_mode: false,
      });
    const container = await renderCard();
    const input = container.querySelector<HTMLInputElement>("#keyword_word")!;
    await act(async () => {
      setInput(input, "BYE");
      input
        .closest("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    await flushUntil(() =>
      mocks.toastError.mock.calls.some(
        ([title]) =>
          title ===
          "Keyword opt-out rule was created before your identity changed",
      ),
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("reports a confirmed update when identity changes after the receipt", async () => {
    mocks.whoami
      .mockReset()
      .mockResolvedValueOnce({
        tenant_id: TENANT,
        user_id: USER,
        effective_role: "admin",
        viewer_mode: false,
      })
      .mockResolvedValueOnce({
        tenant_id: TENANT,
        user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        effective_role: "admin",
        viewer_mode: false,
      });
    const container = await renderCard();
    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Toggle LEAVE"]',
    );
    await act(async () => toggle?.click());
    await act(async () => {
      buttons("Disable stored rule")[0]?.click();
      await Promise.resolve();
    });

    await flushUntil(() =>
      mocks.toastError.mock.calls.some(
        ([title]) =>
          title ===
          "Keyword rule update was confirmed before your identity changed",
      ),
    );
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("reports a confirmed delete when identity changes after the receipt", async () => {
    mocks.whoami
      .mockReset()
      .mockResolvedValueOnce({
        tenant_id: TENANT,
        user_id: USER,
        effective_role: "admin",
        viewer_mode: false,
      })
      .mockResolvedValueOnce({
        tenant_id: TENANT,
        user_id: USER,
        effective_role: "viewer",
        viewer_mode: false,
      });
    await renderCard();
    await act(async () => {
      buttons("Delete")[1]?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons("Delete").at(-1)?.click();
      await Promise.resolve();
    });

    await flushUntil(() =>
      mocks.toastError.mock.calls.some(
        ([title]) =>
          title ===
          "Keyword rule deletion was confirmed before your identity changed",
      ),
    );
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});

describe("SmsKeywordResponsesCard rename (edit) verb", () => {
  function editButton(keyword: string): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      `button[aria-label="Edit ${keyword}"]`,
    );
  }

  async function openEditorFor(keyword: string): Promise<HTMLInputElement> {
    await flushUntil(() => editButton(keyword)?.disabled === false);
    await act(async () => {
      editButton(keyword)?.click();
      await Promise.resolve();
    });
    await flushUntil(() =>
      Boolean(document.querySelector("#keyword_edit_word")),
    );
    return document.querySelector<HTMLInputElement>("#keyword_edit_word")!;
  }

  async function submitEditor(input: HTMLInputElement, value: string) {
    await act(async () => {
      setInput(input, value);
      await Promise.resolve();
    });
    await act(async () => {
      input
        .closest("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
  }

  it("renames an opt-out rule with the row revision and closes on a confirmed receipt", async () => {
    mocks.update.mockResolvedValue({
      ...common,
      id: "out",
      keyword: "DEPART",
      response_body: CANONICAL_RESPONSE,
      response_text: CANONICAL_RESPONSE,
      action: "opt_out",
      updated_at: "2026-08-21T10:00:00Z",
    });
    await renderCard();
    const input = await openEditorFor("LEAVE");
    expect(input.value).toBe("LEAVE");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "release-held",
    );

    await submitEditor(input, "depart");
    await flushUntil(() => mocks.update.mock.calls.length === 1);
    expect(mocks.update).toHaveBeenCalledWith(
      "out",
      {
        keyword: "depart",
        action: "opt_out",
        response_body: CANONICAL_RESPONSE,
      },
      "2026-08-21T09:00:00Z",
      TENANT,
      expect.any(AbortSignal),
    );
    await flushUntil(() =>
      mocks.toastSuccess.mock.calls.some(
        ([title]) => title === "Opt-out keyword renamed to DEPART",
      ),
    );
    expect(mocks.whoami).toHaveBeenCalledTimes(2);
    await flushUntil(() => document.querySelector("#keyword_edit_word") === null);
    await flushUntil(() => mocks.list.mock.calls.length >= 2);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses reserved and unchanged keywords locally with zero network", async () => {
    const container = await renderCard();
    const input = await openEditorFor("LEAVE");

    await submitEditor(input, "stop");
    await flushUntil(() =>
      Boolean(
        document
          .querySelector('[role="dialog"] [role="alert"]')
          ?.textContent?.includes("carrier compliance keywords are built in"),
      ),
    );
    await submitEditor(input, " leave ");
    await flushUntil(() =>
      Boolean(
        document
          .querySelector('[role="dialog"] [role="alert"]')
          ?.textContent?.includes("already the stored keyword"),
      ),
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.whoami).not.toHaveBeenCalled();

    await act(async () => {
      buttons("Cancel")[0]?.click();
      await Promise.resolve();
    });
    await flushUntil(() => document.querySelector("#keyword_edit_word") === null);
    const createInput =
      container.querySelector<HTMLInputElement>("#keyword_word")!;
    await act(async () => {
      setInput(createInput, "STOP");
      createInput
        .closest("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });
    await flushUntil(() =>
      mocks.toastError.mock.calls.some(([title]) =>
        String(title).includes("carrier compliance keywords are built in"),
      ),
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("withholds rename on held reply-only rows and names the reason", async () => {
    await renderCard();
    const held = editButton("INFO");
    expect(held?.disabled).toBe(true);
    expect(held?.title).toContain("release-held");
    await act(async () => {
      held?.click();
      await Promise.resolve();
    });
    expect(document.querySelector("#keyword_edit_word")).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps the draft and shows a typed server refusal inside the editor", async () => {
    mocks.update.mockRejectedValueOnce(
      Object.assign(new Error("unsafe duplicate detail"), {
        code: "keyword_response_exists",
        status: 409,
      }),
    );
    await renderCard();
    const input = await openEditorFor("LEAVE");
    await submitEditor(input, "DEPART");
    await flushUntil(() =>
      Boolean(
        document
          .querySelector('[role="dialog"] [role="alert"]')
          ?.textContent?.includes("no change was committed"),
      ),
    );
    expect(
      document.querySelector<HTMLInputElement>("#keyword_edit_word")?.value,
    ).toBe("DEPART");
    expect(document.body.textContent).not.toContain("unsafe duplicate detail");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});

describe("SMS policy cards are reachable from the SMS page", () => {
  it("mounts keyword-response and quiet-hours cards on the Audience tab", () => {
    const workspace = readFileSync(
      resolve(process.cwd(), "src/app/(dashboard)/app/sms/sms-workspace.tsx"),
      "utf8",
    );
    const audience = workspace.slice(
      workspace.indexOf('<TabsContent value="audience"'),
      workspace.indexOf('<TabsContent value="campaigns"'),
    );
    expect(audience).toMatch(/<SmsKeywordResponsesCard\b/u);
    expect(audience).toMatch(/<SmsQuietHoursCard\b/u);
    expect(workspace).toContain('import("./sms-keyword-responses-card")');
    expect(workspace).toContain('import("./sms-quiet-hours-card")');
  });
});

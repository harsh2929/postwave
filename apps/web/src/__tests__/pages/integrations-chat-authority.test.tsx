// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { qk } from "@/lib/query-keys";

import { importBeforeTests, waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  deliveries: vi.fn(),
  list: vi.fn(),
  test: vi.fn(),
  update: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: (
    _loader: unknown,
    options?: { loading?: () => ReturnType<typeof createElement> },
  ) =>
    function DeferredStub() {
      return options?.loading?.() ?? null;
    },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/integrations-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/integrations-api")>();
  const api = {
    create: mocks.create,
    delete: mocks.delete,
    deliveries: mocks.deliveries,
    list: mocks.list,
    test: mocks.test,
    update: mocks.update,
  };
  return {
    ...actual,
    discordIntegrationsApi: api,
    slackIntegrationsApi: api,
    teamsIntegrationsApi: api,
  };
});

const ADMIN = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "owner@example.com",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

const WORKSPACE_ADMIN = {
  ...ADMIN,
  role: "admin" as const,
  effective_role: "admin" as const,
};

const ITEM = {
  id: "chat-1",
  tenant_id: "tenant-1",
  channel_hint: "#alerts",
  events: ["campaign.sent"],
  enabled: true,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function buttonNamed(
  name: string,
  root: ParentNode = document,
): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function renderPage(): Promise<{
  client: QueryClient;
  host: HTMLElement;
  root: Root;
}> {
  const Page = (await import("@/app/(dashboard)/app/integrations/page"))
    .default;
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Page)),
    );
    await Promise.resolve();
  });
  return { client, host, root };
}

// The page module these tests import is cold work for vitest's transform
// pipeline; pay it before any test's 5 s clock starts.
importBeforeTests(
  () => import("@/app/(dashboard)/app/integrations/page"),
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(ADMIN);
  mocks.whoamiFresh.mockResolvedValue(ADMIN);
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue(ITEM);
  mocks.update.mockResolvedValue({ ...ITEM, enabled: false });
  mocks.delete.mockResolvedValue({ ok: true });
  mocks.test.mockResolvedValue({ ok: true });
  mocks.deliveries.mockResolvedValue([]);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("team-chat integration authority", () => {
  it.each([
    {
      label: "viewer mode",
      identity: {
        ...ADMIN,
        effective_role: "viewer" as const,
        viewer_mode: true,
      },
    },
    {
      label: "editor",
      identity: {
        ...ADMIN,
        role: "editor" as const,
        effective_role: "editor" as const,
      },
    },
  ])(
    "suppresses protected reads and controls for $label",
    async ({ identity }) => {
      mocks.whoami.mockResolvedValue(identity);
      const { client, host, root } = await renderPage();
      try {
        await waitFor(() => {
          expect(host.textContent).toContain("Admin access required");
          expect(host.textContent).toContain(
            `Current effective role: ${identity.effective_role}`,
          );
        });
        expect(mocks.list).not.toHaveBeenCalled();
        expect(mocks.deliveries).not.toHaveBeenCalled();
        expect(host.textContent).not.toContain("New Slack integration");
        expect(host.textContent).not.toContain("Send test");

        const chatQueries = client
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey.includes("chat"));
        expect(
          chatQueries.every((query) => query.state.data === undefined),
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        client.clear();
      }
    },
  );

  it("uses user/effective-role/viewer-sensitive keys and purges admin data on downgrade", async () => {
    mocks.list.mockResolvedValue([ITEM]);
    const { client, host, root } = await renderPage();
    try {
      await waitFor(() => expect(host.textContent).toContain("#alerts"));
      const adminKey = client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey)
        .find((key) => key.includes("chat"));
      expect(adminKey).toEqual([
        "integrations",
        "tenant-1",
        "owner",
        "chat",
        "slack",
        "user-1",
        "member",
      ]);
      expect(client.getQueryData(adminKey!)).toEqual([ITEM]);

      act(() => {
        client.setQueryData(qk.authMe(), {
          ...ADMIN,
          effective_role: "viewer",
          viewer_mode: true,
        });
      });
      await waitFor(() => {
        expect(host.textContent).toContain("Admin access required");
        expect(client.getQueryData(adminKey!)).toBeUndefined();
      });
      expect(mocks.list).toHaveBeenCalledTimes(1);
      expect(host.textContent).not.toContain("#alerts");
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("never turns a failed protected list read into an empty-state create path", async () => {
    mocks.list
      .mockRejectedValueOnce(new Error("chat list unavailable"))
      .mockResolvedValueOnce([]);
    const { client, host, root } = await renderPage();
    try {
      await waitFor(() => {
        expect(host.textContent).toContain("chat list unavailable");
        expect(host.textContent).toContain(
          "Slack integrations could not be loaded",
        );
      });
      expect(host.textContent).not.toContain("New Slack integration");
      await click(buttonNamed("Try again", host));
      await waitFor(() =>
        expect(host.textContent).toContain("New Slack integration"),
      );
      expect(mocks.list).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("rejects a stale authority immediately before toggle transport", async () => {
    mocks.list.mockResolvedValue([ITEM]);
    mocks.whoamiFresh.mockResolvedValue({
      ...ADMIN,
      effective_role: "viewer",
      viewer_mode: true,
    });
    const { client, host, root } = await renderPage();
    try {
      await waitFor(() => expect(host.textContent).toContain("#alerts"));
      await click(buttonNamed("Enabled", host));
      await waitFor(() =>
        expect(host.textContent).toContain(
          "Workspace identity or authority changed",
        ),
      );
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.update).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("deduplicates same-tick toggles and freezes the confirmed item intent", async () => {
    const mutableItem = { ...ITEM };
    const order: string[] = [];
    let resolveFresh!: (identity: typeof ADMIN) => void;
    mocks.list.mockResolvedValue([mutableItem]);
    mocks.whoamiFresh.mockImplementation(
      () =>
        new Promise((resolve) => {
          order.push("fresh");
          resolveFresh = resolve;
        }),
    );
    mocks.update.mockImplementation(async () => {
      order.push("update");
      return { ...ITEM, enabled: false };
    });
    const { client, host, root } = await renderPage();
    try {
      await waitFor(() => expect(host.textContent).toContain("#alerts"));
      const toggle = buttonNamed("Enabled", host);
      act(() => {
        toggle.click();
        toggle.click();
        mutableItem.id = "mutated-after-click";
      });
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.update).not.toHaveBeenCalled();

      await act(async () => {
        resolveFresh(ADMIN);
        await Promise.resolve();
      });
      await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
      expect(mocks.update).toHaveBeenCalledWith("chat-1", { enabled: false });
      expect(order).toEqual(["fresh", "update"]);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("does not repopulate an admin cache when a mutation resolves after downgrade", async () => {
    let resolveUpdate!: (item: typeof ITEM) => void;
    mocks.list.mockResolvedValue([ITEM]);
    mocks.update.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUpdate = resolve;
        }),
    );
    const { client, host, root } = await renderPage();
    try {
      await waitFor(() => expect(host.textContent).toContain("#alerts"));
      const adminKey = client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey)
        .find((key) => key.includes("chat") && key.includes("tenant-1"));
      expect(adminKey).toBeDefined();

      await click(buttonNamed("Enabled", host));
      await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
      act(() => {
        client.setQueryData(qk.authMe(), {
          ...ADMIN,
          effective_role: "viewer",
          viewer_mode: true,
        });
      });
      await waitFor(() => {
        expect(host.textContent).toContain("Admin access required");
        expect(client.getQueryData(adminKey!)).toBeUndefined();
      });

      await act(async () => {
        resolveUpdate({ ...ITEM, enabled: false });
        await Promise.resolve();
      });
      expect(client.getQueryData(adminKey!)).toBeUndefined();
      expect(host.textContent).not.toContain("#alerts");
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("freshly authorizes create, test, and confirmed delete mutations", async () => {
    mocks.whoami.mockResolvedValue(WORKSPACE_ADMIN);
    mocks.list.mockResolvedValue([ITEM]);
    const order: string[] = [];
    mocks.whoamiFresh.mockImplementation(async () => {
      order.push("fresh");
      return WORKSPACE_ADMIN;
    });
    mocks.test.mockImplementation(async () => {
      order.push("test");
      return { ok: true };
    });
    mocks.delete.mockImplementation(async () => {
      order.push("delete");
      return { ok: true };
    });
    mocks.create.mockImplementation(async () => {
      order.push("create");
      return ITEM;
    });
    const { client, host, root } = await renderPage();
    try {
      await waitFor(() => expect(host.textContent).toContain("#alerts"));

      await click(buttonNamed("History", host));
      await waitFor(() =>
        expect(mocks.deliveries).toHaveBeenCalledWith("chat-1"),
      );
      expect(host.textContent).toContain("No deliveries yet");

      await click(buttonNamed("Send test", host));
      await waitFor(() => expect(mocks.test).toHaveBeenCalledTimes(1));

      await click(buttonNamed("Remove", host));
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).not.toBeNull(),
      );
      const dialog = document.querySelector('[role="dialog"]')!;
      await click(buttonNamed("Remove", dialog));
      await waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1));

      await waitFor(() =>
        expect(host.textContent).toContain("New Slack integration"),
      );
      await click(buttonNamed("New Slack integration", host));
      const url = host.querySelector<HTMLInputElement>(
        "#integration-webhook-url",
      );
      expect(url).not.toBeNull();
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(url, "https://hooks.slack.com/services/T/B/token");
        url?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const form = host.querySelector<HTMLFormElement>(
        'form[aria-label="New Slack integration"]',
      );
      expect(form).not.toBeNull();
      await act(async () => {
        form?.dispatchEvent(
          new SubmitEvent("submit", { bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
      await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));

      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(3);
      expect(order).toEqual([
        "fresh",
        "test",
        "fresh",
        "delete",
        "fresh",
        "create",
      ]);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LandingPageEditor from "@/app/(dashboard)/app/landing-pages/[id]/page";
import LandingPagesPage from "@/app/(dashboard)/app/landing-pages/page";
import { qk } from "@/lib/query-keys";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "page-1" }),
  usePathname: () => "/app/landing-pages",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/landing-pages-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/landing-pages-api")>();
  return {
    ...actual,
    landingPagesApi: {
      ...actual.landingPagesApi,
      archive: mocks.archive,
      create: mocks.create,
      get: mocks.get,
      list: mocks.list,
      update: mocks.update,
    },
  };
});

vi.mock("@/lib/use-app-origin", () => ({
  useAppOrigin: () => "https://pages.example.test",
}));

type Role = "owner" | "admin" | "editor" | "viewer";

function identity(role: Role, overrides: Record<string, unknown> = {}) {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "user@example.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
    ...overrides,
  };
}

const page = {
  id: "page-1",
  tenant_id: "tenant-1",
  slug: "welcome",
  name: "Welcome",
  status: "draft" as const,
  domain: "",
  template: "signup",
  blocks: [],
  seo: {},
  tracking: {},
  metrics: { views: 12, conversions: 3 },
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
  publish_at: null,
  unpublish_at: null,
};

let root: Root | null = null;
let client: QueryClient | null = null;

async function render(
  component: typeof LandingPagesPage | typeof LandingPageEditor,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  client = queryClient;
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(component),
      ),
    );
  });
  await settle();
  return host;
}

async function settle(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(
    host.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

async function openRowMenu(host: HTMLElement): Promise<void> {
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Actions for Welcome"]',
  );
  if (!trigger) throw new Error("Missing landing-page row menu");
  await act(async () => trigger.click());
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  mocks.list.mockResolvedValue([page]);
  mocks.get.mockResolvedValue(page);
  mocks.update.mockResolvedValue({ ...page, status: "published" });
  mocks.create.mockResolvedValue(page);
  mocks.archive.mockResolvedValue({ ok: true });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  client?.clear();
  root = null;
  client = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("landing-page list authority", () => {
  it.each(["editor", "viewer"] as const)(
    "keeps list reads available but every write control disabled for %s",
    async (role) => {
      mocks.whoami.mockResolvedValue(identity(role));
      const host = await render(LandingPagesPage);

      expect(host.textContent).toContain("read-only");
      expect(button(host, "New page").disabled).toBe(true);
      expect(
        Array.from(
          host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
        ).every((checkbox) => checkbox.disabled),
      ).toBe(true);

      await openRowMenu(host);
      expect(button(host, "View details").disabled).toBe(false);
      expect(button(host, "Duplicate").disabled).toBe(true);
      expect(button(host, "Publish").disabled).toBe(true);
      expect(button(host, "Archive").disabled).toBe(true);
      expect(mocks.list).toHaveBeenCalledTimes(1);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it("rechecks a stale admin and blocks status transport", async () => {
    mocks.whoami.mockResolvedValue(identity("admin"));
    mocks.whoamiFresh.mockResolvedValue(identity("editor"));
    const host = await render(LandingPagesPage);
    await openRowMenu(host);

    await act(async () => button(host, "Publish").click());
    await settle();

    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("deduplicates same-tick writes and purges the previous admin cache on downgrade", async () => {
    const opened = identity("admin");
    let releaseFresh!: (value: ReturnType<typeof identity>) => void;
    mocks.whoami.mockResolvedValue(opened);
    mocks.whoamiFresh.mockReturnValue(
      new Promise((resolve) => {
        releaseFresh = resolve;
      }),
    );
    const host = await render(LandingPagesPage);
    await openRowMenu(host);
    const publish = button(host, "Publish");

    await act(async () => {
      publish.click();
      publish.click();
      await Promise.resolve();
    });
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    act(() => releaseFresh(opened));
    await settle();
    expect(mocks.update).toHaveBeenCalledTimes(1);

    const oldKey = [
      "landing-pages",
      "tenant-1",
      "admin",
      "user-1",
      false,
      "list",
    ] as const;
    expect(client?.getQueryData(oldKey)).toBeDefined();
    await act(async () => {
      client?.setQueryData(qk.authMe(), identity("editor"));
    });
    await settle();
    expect(client?.getQueryData(oldKey)).toBeUndefined();
    expect(host.textContent).toContain("read-only");
  });
});

describe("landing-page editor authority", () => {
  it.each(["editor", "viewer"] as const)(
    "renders a truthful read-only editor for %s",
    async (role) => {
      mocks.whoami.mockResolvedValue(identity(role));
      const host = await render(LandingPageEditor);

      expect(host.textContent).toContain("read-only");
      expect(button(host, "Publish").disabled).toBe(true);
      expect(button(host, "Archive").disabled).toBe(true);
      expect(button(host, "Saved").disabled).toBe(true);
      expect(
        host.querySelector<HTMLInputElement>("#hero-heading")?.disabled,
      ).toBe(true);
      expect(
        host.querySelector<HTMLTextAreaElement>("#hero-body")?.disabled,
      ).toBe(true);
      expect(
        host.querySelector('a[href="/app/landing-pages/page-1/submissions"]'),
      ).toBeTruthy();
      expect(mocks.get).toHaveBeenCalledTimes(1);
    },
  );

  it("blocks a save when fresh admin authority has changed", async () => {
    mocks.whoami.mockResolvedValue(identity("admin"));
    mocks.whoamiFresh.mockResolvedValue(identity("editor"));
    const host = await render(LandingPageEditor);
    const heading = host.querySelector<HTMLInputElement>("#hero-heading");
    if (!heading) throw new Error("Missing hero heading");

    await act(async () => setInputValue(heading, "Changed heading"));
    await settle(2);
    const save = button(host, "Save changes");
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    await settle();

    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

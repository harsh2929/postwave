// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Campaign folders and the bulk selection verbs — desktop parity rows
// campaigns-7 (filter by folder), -8 (create folder), -9 (move one), -10 (bulk
// move), -11 (bulk tag), -12 (bulk export CSV).
//
// Each test mounts the real component and asserts the CONSEQUENCE of the verb:
// the exact method + path + body + transport options, what the server's answer
// renders as, and — for a session that may not write, or a list that is only a
// retained snapshot — that the verb is withheld with the reason and no request
// goes out.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => null),
  post: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      null,
  ),
  patch: vi.fn(
    async (_path: string, _body?: unknown, _opts?: unknown): Promise<unknown> =>
      null,
  ),
  whoamiFresh: vi.fn(),
  download: vi.fn(
    (_filename: string, _content: string, _mimeType?: string) => undefined,
  ),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastMessage: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      get: mocks.get,
      post: mocks.post,
      patch: mocks.patch,
      put: vi.fn(),
      delete: vi.fn(),
    },
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: mocks.whoamiFresh,
    whoamiFresh: mocks.whoamiFresh,
  };
});
vi.mock("@/lib/download", () => ({
  downloadTextFile: mocks.download,
  downloadBlobFile: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    message: mocks.toastMessage,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { ApiError } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { CAMPAIGN_READ_ONLY_MESSAGE } from "@/lib/campaign-write-authority";
import type { Campaign } from "@/lib/campaigns-api";
import { qk } from "@/lib/query-keys";
import { BulkTagDialog } from "@/components/campaigns/bulk-tag-dialog";
import { CampaignBulkActions } from "@/components/campaigns/campaign-bulk-actions";
import { CampaignFolderFilter } from "@/components/campaigns/campaign-folder-filter";
import {
  type CampaignMoveOutcome,
  MoveToFolderDialog,
} from "@/components/campaigns/move-to-folder-dialog";
import { CAMPAIGN_STALE_SNAPSHOT_MESSAGE } from "@/components/campaigns/use-campaign-write-gate";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Role = "owner" | "admin" | "editor" | "viewer";

function identity(role: Role = "editor"): MeResponse {
  return {
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "operator@example.com",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
}

const FOLDERS = [
  { id: "f-launch", tenant_id: "tnt_1", name: "Launches", campaign_count: 3 },
  { id: "f-archive", tenant_id: "tnt_1", name: "Archive", campaign_count: 12 },
];

function campaign(
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): Campaign {
  return {
    id,
    tenant_id: "tnt_1",
    name,
    subject: `${name} subject`,
    status: "sent",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...extra,
  } as Campaign;
}

const C1 = campaign("c1", "Spring", { folder_id: "f-launch" });
const C2 = campaign("c2", "Summer");
const C3 = campaign("c3", "Autumn");

let client: QueryClient;
const roots: Root[] = [];

function render(ui: ReactNode): void {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always", gcTime: 0 },
      mutations: { networkMode: "always", retry: false },
    },
  });
  client.setQueryData(qk.authMe(), identity());
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function buttonIn(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error("No dialog is open");
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

function typeInto(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(element: HTMLSelectElement, value: string): void {
  act(() => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function submit(form: HTMLFormElement): Promise<void> {
  return act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
}

function patchPaths(): string[] {
  return mocks.patch.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
  mocks.whoamiFresh.mockReset();
  mocks.download.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  mocks.toastMessage.mockReset();
  mocks.get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/campaigns/folders") return { items: FOLDERS };
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.whoamiFresh.mockResolvedValue(identity());
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// campaigns-7 / campaigns-8 — folder filter + New folder
// ---------------------------------------------------------------------------

describe("CampaignFolderFilter", () => {
  function mount(
    options: {
      me?: MeResponse;
      value?: string;
      stale?: boolean;
      onChange?: (folder: string) => void;
    } = {},
  ) {
    const onChange = options.onChange ?? vi.fn();
    render(
      createElement(CampaignFolderFilter, {
        identity: options.me ?? identity(),
        tenantId: "tnt_1",
        role: "editor",
        value: options.value ?? "",
        onChange,
        snapshotStale: options.stale ?? false,
      }),
    );
    return onChange;
  }

  function filterSelect(): HTMLSelectElement {
    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by folder"]',
    );
    if (!select) throw new Error("folder filter not rendered");
    return select;
  }

  it("lists All folders, Uncategorised, and each folder with its campaign count", async () => {
    mount();
    await waitFor(() =>
      expect(
        Array.from(filterSelect().options).map((o) => [o.value, o.text]),
      ).toEqual([
        ["", "All folders"],
        ["__uncategorised", "Uncategorised"],
        ["f-launch", "Launches (3)"],
        ["f-archive", "Archive (12)"],
      ]),
    );
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/campaigns/folders");
  });

  it("reports the chosen folder as the filter value", async () => {
    const onChange = vi.fn();
    mount({ onChange });
    await waitFor(() => expect(filterSelect().options).toHaveLength(4));
    choose(filterSelect(), "f-archive");
    expect(onChange).toHaveBeenLastCalledWith("f-archive");
    choose(filterSelect(), "__uncategorised");
    expect(onChange).toHaveBeenLastCalledWith("__uncategorised");
  });

  it("renders the server's sentence when folders fail to load, not an empty filter", async () => {
    mocks.get.mockRejectedValue(
      new ApiError("Folder store is unavailable.", 503),
    );
    mount();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Could not load folders. Folder store is unavailable.",
      ),
    );
  });

  it("creates a folder on submit: fresh authority, then POST, then a folder refetch", async () => {
    mocks.post.mockResolvedValue({
      id: "f-q4",
      tenant_id: "tnt_1",
      name: "Q4",
      campaign_count: 0,
    });
    mount();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="New folder name"]',
    )!;
    typeInto(input, "  Q4 ");
    await submit(input.form!);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        "/api/v1/campaigns/folders",
        { name: "Q4" },
        { requireOnline: true },
      ),
    );
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Folder “Q4” created."),
    );
    // The folder list is re-read so the new folder (and its count) appears.
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(input.value).toBe("");
  });

  it("says a repeated name returned the existing folder instead of claiming a new one", async () => {
    mocks.post.mockResolvedValue({
      id: "f-launch",
      name: "Launches",
      campaign_count: 3,
    });
    mount();
    await waitFor(() => expect(filterSelect().options).toHaveLength(4));
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="New folder name"]',
    )!;
    typeInto(input, "Launches");
    await submit(input.form!);
    await waitFor(() =>
      expect(mocks.toastMessage).toHaveBeenCalledWith(
        "A folder named “Launches” already exists.",
      ),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("sends nothing when authority changed since the filter rendered", async () => {
    mocks.whoamiFresh.mockResolvedValue(identity("viewer"));
    mount();
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="New folder name"]',
    )!;
    typeInto(input, "Q4");
    await submit(input.form!);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Your campaign write authority changed while this action was open. Nothing was changed",
      ),
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("withholds New folder from a viewer, with the reason, and sends nothing", async () => {
    mount({ me: identity("viewer") });
    await waitFor(() => expect(filterSelect().options).toHaveLength(4));
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="New folder name"]',
    )!;
    expect(input.disabled).toBe(true);
    expect(document.body.textContent).toContain(CAMPAIGN_READ_ONLY_MESSAGE);
    expect(buttonIn(document.body, "Create folder").disabled).toBe(true);
    await submit(input.form!);
    expect(mocks.post).not.toHaveBeenCalled();
    // Filtering is a read and stays available.
    expect(filterSelect().disabled).toBe(false);
  });

  it("withholds New folder while the list is a stale snapshot", async () => {
    mount({ stale: true });
    await waitFor(() => expect(filterSelect().options).toHaveLength(4));
    expect(
      document.querySelector<HTMLInputElement>(
        'input[aria-label="New folder name"]',
      )!.disabled,
    ).toBe(true);
    expect(document.body.textContent).toContain(CAMPAIGN_STALE_SNAPSHOT_MESSAGE);
  });
});

// ---------------------------------------------------------------------------
// campaigns-9 / campaigns-10 — move one / move the selection
// ---------------------------------------------------------------------------

describe("MoveToFolderDialog", () => {
  function mount(
    campaigns: Campaign[],
    options: { me?: MeResponse; stale?: boolean } = {},
  ) {
    const onOpenChange = vi.fn();
    const onMoved = vi.fn((_outcome: CampaignMoveOutcome) => undefined);
    render(
      createElement(MoveToFolderDialog, {
        identity: options.me ?? identity(),
        tenantId: "tnt_1",
        role: "editor",
        campaigns,
        open: true,
        onOpenChange,
        snapshotStale: options.stale ?? false,
        onMoved,
      }),
    );
    return { onOpenChange, onMoved };
  }

  function folderSelect(): HTMLSelectElement {
    return dialog().querySelector<HTMLSelectElement>("select")!;
  }

  it("moves one campaign: PATCH /campaigns/{id}/folder with the picked folder", async () => {
    mocks.patch.mockResolvedValue({ ok: true, folder_id: "f-archive" });
    const { onOpenChange, onMoved } = mount([C1]);
    await waitFor(() => expect(folderSelect().options).toHaveLength(3));
    // Opens on the campaign's current folder; moving there is a no-op.
    expect(folderSelect().value).toBe("f-launch");
    expect(buttonIn(dialog(), "Move").disabled).toBe(true);
    expect(dialog().textContent).toContain("Move “Spring”");

    choose(folderSelect(), "f-archive");
    await click(buttonIn(dialog(), "Move"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledTimes(1);
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/v1/campaigns/c1/folder",
      { folder_id: "f-archive" },
      { requireOnline: true },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Moved “Spring” to “Archive”.",
    );
    expect(onMoved).toHaveBeenCalledWith({
      movedIds: ["c1"],
      remainingIds: [],
      authorityLost: false,
      folderId: "f-archive",
    });
    // Rows, status counts and folder counts are re-read.
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });

  it("moves back to Uncategorised with an empty folder id", async () => {
    mocks.patch.mockResolvedValue({ ok: true, folder_id: "" });
    mount([C1]);
    await waitFor(() => expect(folderSelect().options).toHaveLength(3));
    choose(folderSelect(), "");
    await click(buttonIn(dialog(), "Move"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({ folder_id: "" });
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Moved “Spring” to “Uncategorised”.",
      ),
    );
  });

  it("bulk-moves the selection one PATCH per campaign, in order", async () => {
    mocks.patch.mockResolvedValue({ ok: true, folder_id: "f-launch" });
    const { onMoved, onOpenChange } = mount([C1, C2, C3]);
    await waitFor(() => expect(folderSelect().options).toHaveLength(3));
    expect(dialog().textContent).toContain("Move 3 campaigns");
    choose(folderSelect(), "f-launch");
    await click(buttonIn(dialog(), "Move"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(patchPaths()).toEqual([
      "/api/v1/campaigns/c1/folder",
      "/api/v1/campaigns/c2/folder",
      "/api/v1/campaigns/c3/folder",
    ]);
    for (const call of mocks.patch.mock.calls) {
      expect(call[1]).toEqual({ folder_id: "f-launch" });
    }
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Moved 3 campaigns to “Launches”.",
    );
    expect(onMoved.mock.calls[0]?.[0].movedIds).toEqual(["c1", "c2", "c3"]);
  });

  it("stops the bulk move on a 403 and reports what did and did not move", async () => {
    mocks.patch
      .mockResolvedValueOnce({ ok: true, folder_id: "f-archive" })
      .mockRejectedValueOnce(
        new ApiError("Viewer role cannot change campaigns.", 403),
      )
      .mockResolvedValue({ ok: true, folder_id: "f-archive" });
    const { onMoved, onOpenChange } = mount([C1, C2, C3]);
    await waitFor(() => expect(folderSelect().options).toHaveLength(3));
    choose(folderSelect(), "f-archive");
    await click(buttonIn(dialog(), "Move"));
    await waitFor(() =>
      expect(dialog().textContent).toContain(
        "Stopped when your campaign write authority changed: 1 campaign moved to “Archive”; 2 campaigns not moved.",
      ),
    );
    expect(dialog().textContent).toContain(
      "Viewer role cannot change campaigns.",
    );
    // c3 was never attempted.
    expect(patchPaths()).toEqual([
      "/api/v1/campaigns/c1/folder",
      "/api/v1/campaigns/c2/folder",
    ]);
    expect(onMoved).toHaveBeenCalledWith({
      movedIds: ["c1"],
      remainingIds: ["c2", "c3"],
      authorityLost: true,
      folderId: "f-archive",
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("stops the bulk move when a fresh identity elsewhere drops write access", async () => {
    mocks.patch.mockImplementationOnce(async () => {
      // Another control on the page re-read identity and found a viewer.
      client.setQueryData(qk.authMe(), identity("viewer"));
      return { ok: true, folder_id: "f-archive" };
    });
    mocks.patch.mockResolvedValue({ ok: true, folder_id: "f-archive" });
    const { onMoved } = mount([C1, C2, C3]);
    await waitFor(() => expect(folderSelect().options).toHaveLength(3));
    choose(folderSelect(), "f-archive");
    await click(buttonIn(dialog(), "Move"));
    await waitFor(() => expect(onMoved).toHaveBeenCalled());
    expect(patchPaths()).toEqual(["/api/v1/campaigns/c1/folder"]);
    expect(onMoved.mock.calls[0]?.[0]).toMatchObject({
      movedIds: ["c1"],
      remainingIds: ["c2", "c3"],
      authorityLost: true,
    });
  });

  it("keeps going past an ordinary refusal and names the server's reason", async () => {
    mocks.patch
      .mockResolvedValueOnce({ ok: true, folder_id: "f-archive" })
      .mockRejectedValueOnce(new ApiError("folder not found for tenant", 422))
      .mockResolvedValueOnce({ ok: true, folder_id: "f-archive" });
    const { onMoved } = mount([C1, C2, C3]);
    await waitFor(() => expect(folderSelect().options).toHaveLength(3));
    choose(folderSelect(), "f-archive");
    await click(buttonIn(dialog(), "Move"));
    await waitFor(() =>
      expect(dialog().textContent).toContain(
        "2 campaigns moved to “Archive”; 1 campaign could not be moved. folder not found for tenant",
      ),
    );
    expect(patchPaths()).toHaveLength(3);
    expect(onMoved.mock.calls[0]?.[0]).toMatchObject({
      movedIds: ["c1", "c3"],
      remainingIds: ["c2"],
      authorityLost: false,
    });
  });

  it("sends nothing when the fresh identity no longer matches the opened one", async () => {
    mocks.whoamiFresh.mockResolvedValue(identity("viewer"));
    const { onMoved } = mount([C2]);
    await waitFor(() => expect(folderSelect().options).toHaveLength(3));
    choose(folderSelect(), "f-launch");
    await click(buttonIn(dialog(), "Move"));
    await waitFor(() =>
      expect(dialog().textContent).toContain(
        "Your campaign write authority changed while this action was open.",
      ),
    );
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("withholds the move from a viewer and from a stale snapshot", async () => {
    mount([C2], { me: identity("viewer") });
    await waitFor(() => expect(folderSelect().options).toHaveLength(3));
    expect(buttonIn(dialog(), "Move").disabled).toBe(true);
    expect(folderSelect().disabled).toBe(true);
    expect(dialog().textContent).toContain(CAMPAIGN_READ_ONLY_MESSAGE);
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";

    mount([C2], { stale: true });
    await waitFor(() => expect(folderSelect().options).toHaveLength(3));
    expect(buttonIn(dialog(), "Move").disabled).toBe(true);
    expect(dialog().textContent).toContain(CAMPAIGN_STALE_SNAPSHOT_MESSAGE);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// campaigns-11 — bulk organization tag
// ---------------------------------------------------------------------------

describe("BulkTagDialog", () => {
  function mount(
    campaigns: Campaign[],
    options: { me?: MeResponse; stale?: boolean } = {},
  ) {
    const onOpenChange = vi.fn();
    const onTagged = vi.fn();
    render(
      createElement(BulkTagDialog, {
        identity: options.me ?? identity(),
        campaigns,
        open: true,
        onOpenChange,
        snapshotStale: options.stale ?? false,
        onTagged,
      }),
    );
    return { onOpenChange, onTagged };
  }

  function tagInput(): HTMLInputElement {
    return dialog().querySelector<HTMLInputElement>("input")!;
  }

  it("POSTs every selected id with the normalized tag and reports already-tagged ones", async () => {
    mocks.post.mockResolvedValue({ ok: true, tag: "launch", tagged: 2 });
    const { onOpenChange, onTagged } = mount([C1, C2, C3]);
    expect(dialog().textContent).toContain("Tag 3 campaigns");
    typeInto(tagInput(), "  Launch ");
    expect(dialog().textContent).toContain("Saved as “launch”.");
    await click(buttonIn(dialog(), "Apply tag"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/campaigns/org-tags/bulk",
      { campaign_ids: ["c1", "c2", "c3"], tag: "launch" },
      { requireOnline: true },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Tagged 2 campaigns with “launch”; 1 campaign already had it.",
    );
    expect(onTagged).toHaveBeenCalledWith({
      tag: "launch",
      tagged: 2,
      ids: ["c1", "c2", "c3"],
    });
  });

  it("renders the server's refusal in the dialog and keeps it open", async () => {
    mocks.post.mockRejectedValue(
      new ApiError("campaign_ids must contain 1..500 entries", 400),
    );
    const { onOpenChange } = mount([C1]);
    typeInto(tagInput(), "launch");
    await click(buttonIn(dialog(), "Apply tag"));
    await waitFor(() =>
      expect(dialog().textContent).toContain(
        "campaign_ids must contain 1..500 entries",
      ),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("refuses a tag the server would cut short, before any request", async () => {
    mount([C1]);
    typeInto(tagInput(), "x".repeat(41));
    expect(buttonIn(dialog(), "Apply tag").disabled).toBe(true);
    await submit(dialog().querySelector("form")!);
    expect(dialog().textContent).toContain("40 characters or fewer");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("withholds tagging from a viewer and from a stale snapshot", async () => {
    mount([C1], { me: identity("viewer") });
    typeInto(tagInput(), "launch");
    expect(buttonIn(dialog(), "Apply tag").disabled).toBe(true);
    expect(dialog().textContent).toContain(CAMPAIGN_READ_ONLY_MESSAGE);
    for (const root of roots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";

    mount([C1], { stale: true });
    expect(buttonIn(dialog(), "Apply tag").disabled).toBe(true);
    expect(dialog().textContent).toContain(CAMPAIGN_STALE_SNAPSHOT_MESSAGE);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// campaigns-10 / 11 / 12 — the bulk toolbar, including Export CSV
// ---------------------------------------------------------------------------

describe("CampaignBulkActions", () => {
  function mount(selected: Campaign[], me: MeResponse = identity()) {
    render(
      createElement(CampaignBulkActions, {
        identity: me,
        tenantId: "tnt_1",
        role: "editor",
        selected,
      }),
    );
  }

  it("exports the selected rows as a formula-guarded CSV download", async () => {
    const risky = campaign("c9", '=HYPERLINK("http://evil","x")', {
      subject: "Hi, friends",
      status: "sent",
      sent_at: "2026-09-02T10:00:00Z",
      open_rate: 0.25,
      click_rate: 0.05,
    });
    const draft = campaign("c10", "Draft", { status: "draft" });
    mount([risky, draft]);
    await click(buttonIn(document.body, "Export CSV"));
    expect(mocks.download).toHaveBeenCalledTimes(1);
    const [filename, content, mime] = mocks.download.mock.calls[0]!;
    expect(filename).toBe("campaigns-export-2.csv");
    expect(mime).toBe("text/csv;charset=utf-8");
    expect(content.split("\r\n")).toEqual([
      "name,subject,status,sent_at,open_rate,click_rate",
      `"'=HYPERLINK(""http://evil"",""x"")","Hi, friends",sent,2026-09-02T10:00:00Z,0.25,0.05`,
      // No rate from the server stays blank — never 0.
      "Draft,Draft subject,draft,,,",
    ]);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Exported 2 campaigns to CSV.",
    );
    // A read: no request of any kind.
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("opens the move and tag dialogs for the whole selection", async () => {
    mount([C1, C2]);
    await click(buttonIn(document.body, "Move to folder"));
    expect(dialog().textContent).toContain("Move 2 campaigns");
    await click(buttonIn(dialog(), "Cancel"));
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    await click(buttonIn(document.body, "Tag"));
    expect(dialog().textContent).toContain("Tag 2 campaigns");
  });

  it("withholds Move and Tag from a viewer but still allows the read-only export", async () => {
    mount([C1], identity("viewer"));
    const move = buttonIn(document.body, "Move to folder");
    const tag = buttonIn(document.body, "Tag");
    expect(move.disabled).toBe(true);
    expect(move.title).toBe(CAMPAIGN_READ_ONLY_MESSAGE);
    expect(tag.disabled).toBe(true);
    expect(buttonIn(document.body, "Export CSV").disabled).toBe(false);
  });

  it("renders nothing without a selection", () => {
    mount([]);
    expect(document.body.textContent).toBe("");
  });
});

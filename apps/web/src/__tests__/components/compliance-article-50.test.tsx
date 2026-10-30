// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Compliance page — EU AI Act Article 50 evidence + the retention-purge ledger
// (desktop parity rows governance-84, governance-28, governance-42).
//
// Every test asserts the CONSEQUENCE of the verb: the exact path the request
// goes to, the bytes and filename handed to the browser's download, the
// server's own sentence when it refuses — or, for a role that may not see
// tenant-confidential evidence, that NO request left the page at all.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  head: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  postRaw: vi.fn(),
  put: vi.fn(),
  putRaw: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  fetchBlobAuthed: vi.fn(),
  downloadBlobFile: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      head: mocks.head,
      get: mocks.get,
      post: mocks.post,
      postRaw: mocks.postRaw,
      put: mocks.put,
      putRaw: mocks.putRaw,
      patch: mocks.patch,
      delete: mocks.delete,
    },
    fetchBlobAuthed: mocks.fetchBlobAuthed,
  };
});
vi.mock("@/lib/download", () => ({
  downloadBlobFile: mocks.downloadBlobFile,
  downloadTextFile: vi.fn(),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami, whoamiFresh: mocks.whoami };
});

import { ApiError, contentDispositionFilename } from "@/lib/api";
import CompliancePage from "@/app/(dashboard)/app/compliance/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Frozen so the 30-day window is a literal in the expectation rather than the
// same arithmetic the implementation does, which would assert nothing.
const NOW = new Date("2026-09-05T13:45:20.500Z");
const EXPECTED_SINCE = "2026-08-06T00:00:00.000Z";
const STATS_PATH = `/api/v1/audit/stats?actor_type=agent&since=${encodeURIComponent(
  EXPECTED_SINCE,
)}`;
const RETENTION_PATH = "/api/v1/audit/retention-activity?limit=200";
const BUNDLE_PATH = "/api/v1/audit/ai-session/sess%2Fone/aivs-bundle";

const PROGRAMS = {
  programs: [
    {
      framework: "hipaa",
      status: "unsupported",
      notes: "No BAA is offered and PHI workloads are prohibited.",
    },
  ],
};

const PURGE_EVENT = {
  id: 91,
  tenant_id: "22222222-2222-4222-8222-222222222222",
  action: "audit.retention.purge",
  deleted_id_range: "[1001,1400]",
  deleted_count: 400,
  retention_days: 365,
  before_root_hash: "abcdef0123456789abcdef",
  at: "2026-09-01T02:00:00Z",
};

function me(role: "owner" | "viewer" = "owner") {
  return {
    user_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    email: "operator@example.com",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Evidence workspace",
    workspace_slug: "evidence",
  };
}

function render(): Root {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CompliancePage),
      ),
    );
  });
  return root;
}

async function flush(turns = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush(1);
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function sessionField(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>("#aivs-session-id");
  if (!found) throw new Error("session id field not found");
  return found;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(me());
  mocks.get.mockImplementation((path: string) => {
    if (path === "/api/v1/compliance/programs") return Promise.resolve(PROGRAMS);
    if (path.startsWith("/api/v1/audit/stats")) {
      return Promise.resolve({
        totalEvents: 12,
        byActorType: [{ label: "agent", count: 12 }],
        topActions: [],
        daily: [],
      });
    }
    if (path.startsWith("/api/v1/audit/retention-activity")) {
      return Promise.resolve({
        events: [PURGE_EVENT],
        count: 1,
        total_purged_last_30d: 4200,
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("compliance · Article 50 transparency (governance-84)", () => {
  it("counts agent activity over the trailing 30 days and renders the number it got", async () => {
    const root = render();
    try {
      await waitFor(() => {
        expect(mocks.get).toHaveBeenCalledWith(STATS_PATH, {
          signal: expect.anything(),
        });
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Agent activity observed in the last 30 days",
        );
        expect(document.body.textContent).toContain(
          `12 agent-actor events since ${EXPECTED_SINCE}`,
        );
      });
      // The other four rows must never read as verified tenant checks.
      expect(document.body.textContent).toContain(
        "platform capability, not a tenant check",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("says the check could not be run instead of implying zero agent activity", async () => {
    mocks.get.mockImplementation((path: string) => {
      if (path === "/api/v1/compliance/programs")
        return Promise.resolve(PROGRAMS);
      if (path.startsWith("/api/v1/audit/stats")) {
        return Promise.reject(
          new ApiError("audit statistics are unavailable", 503),
        );
      }
      return Promise.resolve({
        events: [],
        count: 0,
        total_purged_last_30d: 0,
      });
    });
    const root = render();
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "The agent-activity check could not be run, so nothing is claimed about it.",
        );
        expect(document.body.textContent).toContain(
          "audit statistics are unavailable",
        );
      });
      expect(document.body.textContent).not.toContain("0 agent-actor events");
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("compliance · AIVS proof bundle (governance-28)", () => {
  it("downloads the session's bundle and saves it under the server's filename", async () => {
    const blob = new Blob([new Uint8Array([31, 139, 8, 0])], {
      type: "application/gzip",
    });
    mocks.fetchBlobAuthed.mockResolvedValue({
      blob,
      filename: "postwave-aivs-sess_one-20260905-134520.tar.gz",
    });
    const root = render();
    try {
      await waitFor(() => sessionField());
      // Withheld until there is something to send.
      expect(button("Download AIVS bundle").disabled).toBe(true);

      await type(sessionField(), "sess/one");
      expect(button("Download AIVS bundle").disabled).toBe(false);
      await click(button("Download AIVS bundle"));

      await waitFor(() => {
        expect(mocks.fetchBlobAuthed).toHaveBeenCalledWith(BUNDLE_PATH, {
          accept: "application/gzip",
          signal: undefined,
        });
      });
      await waitFor(() => {
        expect(mocks.downloadBlobFile).toHaveBeenCalledWith(
          "postwave-aivs-sess_one-20260905-134520.tar.gz",
          blob,
        );
        expect(document.body.textContent).toContain(
          "Downloaded postwave-aivs-sess_one-20260905-134520.tar.gz.",
        );
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("names the bundle itself when the response carried no Content-Disposition", async () => {
    const blob = new Blob(["bundle"], { type: "application/gzip" });
    mocks.fetchBlobAuthed.mockResolvedValue({ blob, filename: null });
    const root = render();
    try {
      await waitFor(() => sessionField());
      await type(sessionField(), "sess/one");
      await click(button("Download AIVS bundle"));

      await waitFor(() => {
        expect(mocks.downloadBlobFile).toHaveBeenCalledWith(
          "postwave-aivs-sess_one.tar.gz",
          blob,
        );
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows the server's refusal and saves nothing when the session has no agent events", async () => {
    mocks.fetchBlobAuthed.mockRejectedValue(
      new ApiError("no agent events found for this session_id", 404, undefined, {
        code: "no_agent_events",
      }),
    );
    const root = render();
    try {
      await waitFor(() => sessionField());
      await type(sessionField(), "sess/one");
      await click(button("Download AIVS bundle"));

      await waitFor(() => {
        expect(document.body.textContent).toContain("No bundle was downloaded");
        expect(document.body.textContent).toContain(
          "no agent events found for this session_id",
        );
      });
      expect(mocks.downloadBlobFile).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("refuses to send an over-long session id and says why", async () => {
    const root = render();
    try {
      await waitFor(() => sessionField());
      await type(sessionField(), "s".repeat(129));

      expect(button("Download AIVS bundle").disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "A session ID is at most 128 characters; this one is 129.",
      );
      expect(mocks.fetchBlobAuthed).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("compliance · retention activity ledger (governance-42)", () => {
  it("reads the purge ledger at its contracted path and renders each batch", async () => {
    const root = render();
    try {
      await waitFor(() => {
        expect(mocks.get).toHaveBeenCalledWith(RETENTION_PATH, {
          signal: expect.anything(),
        });
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain("Rows purged (last 30d)");
        expect(document.body.textContent).toContain("4,200");
        expect(document.body.textContent).toContain("[1001,1400]");
        expect(document.body.textContent).toContain("365d");
        // Truncated pre-purge Merkle root, not the whole hash.
        expect(document.body.textContent).toContain("abcdef012345…");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not present an unreadable ledger as an empty one, and retries", async () => {
    let attempts = 0;
    mocks.get.mockImplementation((path: string) => {
      if (path === "/api/v1/compliance/programs")
        return Promise.resolve(PROGRAMS);
      if (path.startsWith("/api/v1/audit/stats")) {
        return Promise.resolve({
          totalEvents: 0,
          byActorType: [],
          topActions: [],
          daily: [],
        });
      }
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new ApiError("retention ledger is offline", 502));
      }
      return Promise.resolve({
        events: [PURGE_EVENT],
        count: 1,
        total_purged_last_30d: 4200,
      });
    });
    const root = render();
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "An unreadable ledger is not an empty one.",
        );
        expect(document.body.textContent).toContain(
          "retention ledger is offline",
        );
      });
      expect(document.body.textContent).not.toContain(
        "No retention-purge events have been recorded",
      );

      await click(button("Retry"));
      await waitFor(() => {
        expect(attempts).toBe(2);
        expect(document.body.textContent).toContain("[1001,1400]");
      });
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("the filename a downloaded bundle is saved under", () => {
  it("takes the server's name and strips anything that is not one", () => {
    expect(
      contentDispositionFilename(
        'attachment; filename="postwave-aivs-sess-20260905.tar.gz"',
      ),
    ).toBe("postwave-aivs-sess-20260905.tar.gz");
    expect(contentDispositionFilename("attachment; filename=bundle.tar.gz")).toBe(
      "bundle.tar.gz",
    );
    expect(
      contentDispositionFilename(
        "attachment; filename*=UTF-8''postwave%2Daivs%2Dse%C3%9Fion.tar.gz",
      ),
    ).toBe("postwave-aivs-seßion.tar.gz");
    // A path in the header must never become a path on disk.
    expect(
      contentDispositionFilename('attachment; filename="../../etc/passwd"'),
    ).toBe("passwd");
    expect(
      contentDispositionFilename('attachment; filename="C:\\\\Windows\\\\evil"'),
    ).toBe("evil");
    expect(contentDispositionFilename('attachment; filename=".."')).toBeNull();
    expect(contentDispositionFilename("attachment")).toBeNull();
    expect(contentDispositionFilename(null)).toBeNull();
  });
});

describe("compliance · evidence stays behind the page's own gate", () => {
  it("asks for no agent evidence at all in a viewer session", async () => {
    mocks.whoami.mockResolvedValue(me("viewer"));
    const root = render();
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Owner or admin access required",
        );
      });
      await flush(4);

      const paths = mocks.get.mock.calls.map((call) => call[0] as string);
      expect(paths.filter((path) => path.startsWith("/api/v1/audit"))).toEqual(
        [],
      );
      expect(document.body.textContent).not.toContain("Retention activity");
      expect(document.body.textContent).not.toContain(
        "Article 50 transparency",
      );
      expect(document.querySelector("#aivs-session-id")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});

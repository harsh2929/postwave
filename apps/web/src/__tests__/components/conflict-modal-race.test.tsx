// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Regression: ConflictModal fetched the server copy in an effect with no
// cancellation. Resolving conflict A against a slow endpoint, closing it, then
// opening conflict B against a fast one let A's response land LAST and overwrite
// serverVersion — so the dialog showed B's method/path in its header next to A's
// JSON in the "Server version" pane.
//
// That is a data-loss vector, not a cosmetic glitch: the operator picks
// "Keep mine" or "Keep server" after comparing their pending write against what
// they believe is the current server state.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConflictModal } from "@/components/conflict-modal";
import type { OfflineMutation } from "@/lib/offline-store";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

function mutation(id: string, path: string): OfflineMutation {
  return {
    id,
    method: "PATCH",
    path,
    body: { name: `local-${id}` },
    idempotencyKey: `idem-${id}`,
    queuedAt: "2026-07-01T00:00:00.000Z",
    attempts: 1,
    status: "conflict",
    conflictStatus: 412,
  } as OfflineMutation;
}

/** A fetch stub whose responses resolve only when the test says so. */
function deferredFetch() {
  const pending = new Map<string, (body: unknown) => void>();
  const stub = vi.fn((path: string) => {
    return new Promise((resolve) => {
      pending.set(path, (body: unknown) =>
        resolve({ ok: true, json: async () => body } as Response),
      );
    });
  });
  return {
    stub,
    resolve(path: string, body: unknown) {
      const settle = pending.get(path);
      if (!settle) throw new Error(`no pending fetch for ${path}`);
      settle(body);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): {
  root: Root;
  rerender: (next: ReactNode) => void;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    root,
    rerender: (next: ReactNode) => act(() => root.render(next)),
  };
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${name}`);
  }
  return match;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("ConflictModal stale-response race", () => {
  it("ignores a superseded conflict's server copy", async () => {
    const fetcher = deferredFetch();
    vi.stubGlobal("fetch", fetcher.stub);

    const itemA = mutation("a", "/api/v1/lists/AAA");
    const itemB = mutation("b", "/api/v1/lists/BBB");

    const noop = () => undefined;
    const view = (item: OfflineMutation) =>
      createElement(ConflictModal, {
        open: true,
        item,
        onClose: noop,
        onKeepMine: noop,
        onKeepServer: noop,
      });

    const { root, rerender } = render(view(itemA));
    // Switch to conflict B while A's request is still in flight.
    rerender(view(itemB));

    try {
      // B answers first, then the superseded A answers.
      fetcher.resolve("/api/v1/lists/BBB", { server: "version-B" });
      await flush();
      fetcher.resolve("/api/v1/lists/AAA", { server: "version-A" });
      await flush();

      const text = document.body.textContent ?? "";
      // The header names B, so the Server version pane must be B's.
      expect(text).toContain("/api/v1/lists/BBB");
      expect(text).toContain("version-B");
      expect(text).not.toContain("version-A");
    } finally {
      act(() => root.unmount());
    }
  });

  it("aborts the superseded request rather than leaving it running", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise(() => {
          /* never settles */
        });
      }),
    );

    const noop = () => undefined;
    const view = (item: OfflineMutation) =>
      createElement(ConflictModal, {
        open: true,
        item,
        onClose: noop,
        onKeepMine: noop,
        onKeepServer: noop,
      });

    const { root, rerender } = render(view(mutation("a", "/api/v1/lists/AAA")));
    rerender(view(mutation("b", "/api/v1/lists/BBB")));

    try {
      expect(signals).toHaveLength(2);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("prevents a blind resolution while the server copy is loading", async () => {
    const fetcher = deferredFetch();
    vi.stubGlobal("fetch", fetcher.stub);
    const noop = () => undefined;
    const { root } = render(
      createElement(ConflictModal, {
        open: true,
        item: mutation("a", "/api/v1/lists/AAA"),
        onClose: noop,
        onKeepMine: noop,
        onKeepServer: noop,
      }),
    );

    try {
      expect(button("Keep server").disabled).toBe(true);
      expect(button("Keep mine").disabled).toBe(true);

      fetcher.resolve("/api/v1/lists/AAA", { server: "loaded" });
      await flush();

      expect(button("Keep server").disabled).toBe(false);
      expect(button("Keep mine").disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("names a failed server read and requires a successful retry", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ server: "recovered" }),
      } as Response);
    vi.stubGlobal("fetch", fetcher);
    const noop = () => undefined;
    const { root } = render(
      createElement(ConflictModal, {
        open: true,
        item: mutation("a", "/api/v1/lists/AAA"),
        onClose: noop,
        onKeepMine: noop,
        onKeepServer: noop,
      }),
    );

    try {
      await flush();
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "HTTP 503",
      );
      expect(button("Keep server").disabled).toBe(true);
      expect(button("Keep mine").disabled).toBe(true);

      act(() => button("Retry server version").click());
      await flush();

      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("recovered");
      expect(button("Keep server").disabled).toBe(false);
      expect(button("Keep mine").disabled).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not mislabel a collection response as the version of a conflicting create", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const item = {
      ...mutation("create", "/api/v1/forms"),
      method: "POST",
      conflictStatus: 409,
      lastError: "slug already exists (409)",
    } as OfflineMutation;
    const noop = () => undefined;
    const { root } = render(
      createElement(ConflictModal, {
        open: true,
        item,
        onClose: noop,
        onKeepMine: noop,
        onKeepServer: noop,
      }),
    );

    try {
      expect(fetcher).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Conflict context");
      expect(document.body.textContent).toContain(
        "no comparable server version",
      );
      expect(button("Discard queued change").disabled).toBe(false);
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) => candidate.textContent?.trim() === "Keep mine",
        ),
      ).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
});

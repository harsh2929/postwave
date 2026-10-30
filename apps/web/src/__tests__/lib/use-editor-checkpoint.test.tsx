// @vitest-environment happy-dom
//
// Autosave + resume for a durable draft checkpoint (lib/use-editor-checkpoint).
//
// The server side of ECO-03 shipped complete and unreachable: nothing on web,
// desktop or mobile had ever written a checkpoint, so the "authoritative
// checkpoint" a person is promised on their second device did not exist. These
// drive the real hook through React's own lifecycle, because the properties
// that matter are behavioural, not computational — opening OFFERS the draft
// instead of applying it, typing writes one, and a refused save shows both
// versions rather than picking one.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { load, save, discard } = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  discard: vi.fn(),
}));

// `@/lib/api` is mocked so importing the real client module (for the genuine
// `isNewerThanRecord`) does not drag the whole fetch/offline stack in.
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  isApiError: () => false,
}));

vi.mock("@/lib/editor-checkpoint-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/editor-checkpoint-api")>();
  return {
    ...actual,
    loadCheckpoint: (...args: unknown[]) => load(...args),
    saveCheckpoint: (...args: unknown[]) => save(...args),
    discardCheckpoint: (...args: unknown[]) => discard(...args),
  };
});

const { useEditorCheckpoint } = await import("../../lib/use-editor-checkpoint");

interface Draft {
  subject: string;
}

const RECORD_SAVED_AT = "2026-08-04T10:00:00Z";
const NEWER = "2026-08-04T10:05:00Z";
const OLDER = "2026-08-04T09:55:00Z";

function checkpoint(over: Partial<{ subject: string; version: number; updated_at: string }> = {}) {
  return {
    entity_key: "campaign",
    entity_id: "cmp_1",
    content: { subject: over.subject ?? "from the phone" } satisfies Draft,
    version: over.version ?? 3,
    updated_at: over.updated_at ?? NEWER,
  };
}

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useEditorCheckpoint<Draft>> | undefined;
const restored: Draft[] = [];

function Probe({
  content,
  canEdit = true,
  recordUpdatedAt = RECORD_SAVED_AT,
}: {
  content: Draft | null;
  canEdit?: boolean;
  recordUpdatedAt?: string | undefined;
}) {
  latest = useEditorCheckpoint<Draft>({
    entityKey: "campaign",
    entityId: "cmp_1",
    content,
    recordUpdatedAt,
    canEdit,
    onRestore: (value) => {
      restored.push(value);
    },
  });
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  load.mockResolvedValue({ status: "absent" });
  save.mockResolvedValue({
    status: "saved",
    checkpoint: checkpoint({ version: 1 }),
  });
  discard.mockResolvedValue(true);
  restored.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function mount(props: {
  content: Draft | null;
  canEdit?: boolean;
  recordUpdatedAt?: string | undefined;
}) {
  await act(async () => {
    root.render(<Probe {...props} />);
  });
}

async function tick(ms = 2_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("arriving on the second device", () => {
  it("offers a draft newer than the record instead of applying it", async () => {
    load.mockResolvedValue({ status: "found", checkpoint: checkpoint() });
    await mount({ content: null });

    expect(load).toHaveBeenCalledWith("campaign", "cmp_1");
    expect(latest?.offer?.content).toEqual({ subject: "from the phone" });
    expect(
      restored,
      "the draft was applied without being offered — the person cannot tell what they are about to save over",
    ).toEqual([]);
  });

  it("applies it only when the person asks", async () => {
    load.mockResolvedValue({ status: "found", checkpoint: checkpoint() });
    await mount({ content: null });
    await act(async () => {
      latest?.resume();
    });
    expect(restored).toEqual([{ subject: "from the phone" }]);
    expect(latest?.offer).toBeNull();
  });

  it("drops the draft on an explicit discard", async () => {
    load.mockResolvedValue({ status: "found", checkpoint: checkpoint() });
    await mount({ content: null });
    await act(async () => {
      latest?.dismiss();
    });
    expect(discard).toHaveBeenCalledWith("campaign", "cmp_1");
    expect(latest?.offer).toBeNull();
    expect(restored).toEqual([]);
  });

  it("does not offer — or delete — a draft the record already outlives", async () => {
    // Older than the saved record, so it cannot be unsaved work; but "very
    // likely superseded" is not a reason to destroy someone's only copy.
    load.mockResolvedValue({
      status: "found",
      checkpoint: checkpoint({ updated_at: OLDER }),
    });
    await mount({ content: null });
    expect(latest?.offer).toBeNull();
    expect(discard).not.toHaveBeenCalled();
  });

  it("offers nothing when the server holds nothing", async () => {
    load.mockResolvedValue({ status: "absent" });
    await mount({ content: null });
    expect(latest?.offer).toBeNull();
    expect(latest?.refusal).toBeNull();
  });
});

describe("autosaving the open editor", () => {
  it("writes the draft after the debounce, carrying the loaded version", async () => {
    load.mockResolvedValue({
      status: "found",
      checkpoint: checkpoint({ version: 3, updated_at: OLDER }),
    });
    const draft: Draft = { subject: "half written" };
    await mount({ content: draft });

    expect(save, "wrote before the debounce elapsed").not.toHaveBeenCalled();
    await tick();
    expect(save).toHaveBeenCalledWith("campaign", "cmp_1", draft, 3);
    expect(latest?.lastSavedAt).toBe(NEWER);
  });

  it("never writes a pristine editor", async () => {
    // A checkpoint of the untouched record would be offered on the next open as
    // if it were unsaved work.
    await mount({ content: null });
    await tick();
    expect(save).not.toHaveBeenCalled();
  });

  it("never writes from a review-only surface", async () => {
    await mount({ content: { subject: "typed" }, canEdit: false });
    await tick();
    expect(save).not.toHaveBeenCalled();
  });

  it("does not re-send an unchanged draft", async () => {
    const draft: Draft = { subject: "half written" };
    await mount({ content: draft });
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("holds off while a resume offer is unanswered", async () => {
    // Writing here would overwrite the very draft being offered.
    load.mockResolvedValue({ status: "found", checkpoint: checkpoint() });
    await mount({ content: { subject: "typed on this device" } });
    expect(latest?.offer).not.toBeNull();
    await tick();
    expect(save).not.toHaveBeenCalled();
  });

  it("discards the checkpoint once the record is saved", async () => {
    const draft: Draft = { subject: "half written" };
    await mount({ content: draft });
    await tick();
    expect(save).toHaveBeenCalledTimes(1);

    // The editor goes clean — the page saved the campaign.
    await act(async () => {
      root.render(<Probe content={null} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(discard).toHaveBeenCalledWith("campaign", "cmp_1");
  });
});

describe("another device saved newer work", () => {
  const theirs = checkpoint({ version: 7, subject: "from the phone" });

  async function reachConflict() {
    save.mockResolvedValue({
      status: "stale",
      current: theirs,
      message: "a newer draft was saved from another device",
    });
    await mount({ content: { subject: "stale laptop buffer" } });
    await tick();
  }

  it("surfaces the conflict with both drafts and stops writing", async () => {
    await reachConflict();
    expect(latest?.conflict?.current?.content).toEqual({
      subject: "from the phone",
    });
    expect(save).toHaveBeenCalledTimes(1);
    await tick();
    expect(
      save,
      "kept autosaving into a conflict — every tick is another refusal",
    ).toHaveBeenCalledTimes(1);
  });

  it("picks no winner on its own", async () => {
    await reachConflict();
    expect(restored, "adopted the other draft without asking").toEqual([]);
    expect(latest?.conflict).not.toBeNull();
  });

  it("loads the other device's draft when the person chooses it", async () => {
    await reachConflict();
    save.mockClear();
    await act(async () => {
      latest?.useTheirs();
    });
    expect(restored).toEqual([{ subject: "from the phone" }]);
    expect(latest?.conflict).toBeNull();
    expect(save, "wrote over the draft it had just adopted").not.toHaveBeenCalled();
  });

  it("overwrites at the other version only when the person chooses this one", async () => {
    await reachConflict();
    save.mockClear();
    save.mockResolvedValue({
      status: "saved",
      checkpoint: checkpoint({ version: 8 }),
    });
    await act(async () => {
      latest?.keepMine();
    });
    expect(save).toHaveBeenCalledWith(
      "campaign",
      "cmp_1",
      { subject: "stale laptop buffer" },
      7,
    );
    expect(latest?.conflict).toBeNull();
  });
});

describe("a draft the server will not take", () => {
  it("says so and stops the loop", async () => {
    save.mockResolvedValue({
      status: "refused",
      code: "content_too_large",
      message: "a draft checkpoint is limited to 256 KiB",
    });
    await mount({ content: { subject: "x" } });
    await tick();
    expect(latest?.refusal).toBe("a draft checkpoint is limited to 256 KiB");
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("tries again once the draft actually changes", async () => {
    save.mockResolvedValue({
      status: "refused",
      code: "content_too_large",
      message: "a draft checkpoint is limited to 256 KiB",
    });
    await mount({ content: { subject: "x" } });
    await tick();
    expect(latest?.refusal).not.toBeNull();

    save.mockResolvedValue({
      status: "saved",
      checkpoint: checkpoint({ version: 1 }),
    });
    await act(async () => {
      root.render(<Probe content={{ subject: "shorter" }} />);
    });
    expect(latest?.refusal).toBeNull();
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("stays quiet about a transient failure and retries the same draft", async () => {
    save.mockResolvedValue({ status: "unavailable", message: "offline" });
    await mount({ content: { subject: "x" } });
    await tick();
    expect(latest?.refusal).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    // A re-render with a new draft object restarts the debounce; the same
    // content is retried because it was never accepted.
    await act(async () => {
      root.render(<Probe content={{ subject: "x" }} />);
    });
    await tick();
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe("leaving the editor", () => {
  it("flushes the debounce window when the tab is hidden", async () => {
    await mount({ content: { subject: "half written" } });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(
      save,
      "closing the laptop inside the debounce window lost the work",
    ).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
  });

  it("flushes when the editor unmounts", async () => {
    await mount({ content: { subject: "half written" } });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<></>);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment happy-dom
//
// Tests for the desktop autosave/resume hook behind the durable draft
// checkpoint (ECO-03).
//
// The clause this satisfies is "close one client during a supported task, open
// another, see the exact authoritative checkpoint, and either resume safely or
// receive a precise explanation of why only review mode is available." Each of
// those four verbs is a test here:
//
//   close   — leaving flushes, including through the desktop lifecycle
//             protocol (close-window / quit / sign-out), which is where a
//             ported `visibilitychange` listener would have found nothing;
//   open    — a stored draft is OFFERED, never applied;
//   exact   — the version the server holds is tracked even for a draft we do
//             not offer, so the first keystroke is not a spurious conflict;
//   or else — a stale 409 shows BOTH drafts and picks neither, and a draft
//             this surface cannot open says so instead of pretending.

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CheckpointLoad,
  CheckpointSave,
  EditorCheckpointClient,
} from "../../lib/editor-checkpoint-api";
import {
  CHECKPOINT_DEBOUNCE_MS,
  type CheckpointResumability,
  type EditorCheckpointState,
  useEditorCheckpoint,
} from "../../lib/use-editor-checkpoint";
import {
  inspectLifecycle,
  type LifecycleIntent,
  prepareLifecycle,
  resetLifecycleCoordinatorForTests,
} from "../../lib/lifecycle-coordinator";

interface Draft {
  subject: string;
}

const RECORD_AT = "2026-08-04T09:00:00Z";
const RECORD: Draft = { subject: "saved" };

function checkpoint(content: Draft, version = 1, updatedAt = "2026-08-04T10:00:00Z") {
  return {
    entity_key: "campaign",
    entity_id: "cam_1",
    content,
    version,
    updated_at: updatedAt,
  };
}

/**
 * `load`/`save` are generic in the stored content type, which a `vi.fn()` stub
 * cannot express. The seam is narrowed here rather than the production
 * interface being loosened to accommodate a test double.
 */
type ClientOverrides = Partial<Record<keyof EditorCheckpointClient, unknown>>;

function stubClient(overrides: ClientOverrides = {}) {
  const load = vi.fn(
    async (): Promise<CheckpointLoad<Draft>> => ({ status: "absent" }),
  );
  const save = vi.fn(
    async (
      _key: string,
      _id: string,
      content: Draft,
      version: number,
    ): Promise<CheckpointSave<Draft>> => ({
      status: "saved",
      checkpoint: checkpoint(content, version + 1),
    }),
  );
  const discard = vi.fn(async () => true);
  return { load, save, discard, ...overrides } as unknown as
    EditorCheckpointClient & {
      load: typeof load;
      save: typeof save;
      discard: typeof discard;
    };
}

const EXIT_INTENT: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "",
  confirmLabel: "Quit",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let seen: EditorCheckpointState<Draft> | null = null;
let restored: Draft[] = [];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  restored = [];
  seen = null;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  resetLifecycleCoordinatorForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function Harness({
  client,
  content,
  canEdit = true,
  inspectContent,
  entityId = "cam_1",
}: {
  client: EditorCheckpointClient;
  content: Draft | null;
  canEdit?: boolean;
  inspectContent?: (content: Draft) => CheckpointResumability;
  entityId?: string;
}): ReactElement {
  seen = useEditorCheckpoint<Draft>({
    entityKey: "campaign",
    entityId,
    content,
    recordContent: RECORD,
    recordUpdatedAt: RECORD_AT,
    canEdit,
    onRestore: (value) => restored.push(value),
    inspectContent,
    client,
  });
  return <div />;
}

async function mount(props: Parameters<typeof Harness>[0]): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Harness {...props} />);
  });
}

async function rerender(props: Parameters<typeof Harness>[0]): Promise<void> {
  await act(async () => {
    root?.render(<Harness {...props} />);
  });
}

/** Advance past the debounce and let the queued write settle. */
async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS + 1);
  });
}

describe("arriving on the second device", () => {
  it("treats found:false as an ordinary clean open — no offer, no noise", async () => {
    // `found:false` is a 200. Nothing is offered, nothing is reported, and
    // autosave still arms: the absence is the START of a checkpoint, not a
    // failure to read one.
    const client = stubClient();
    await mount({ client, content: null });
    expect(client.load).toHaveBeenCalledWith("campaign", "cam_1");
    expect(seen?.offer).toBeNull();
    expect(seen?.refusal).toBeNull();
    expect(seen?.unsupported).toBeNull();

    await rerender({ client, content: { subject: "typing" } });
    await tick();
    expect(client.save).toHaveBeenCalledTimes(1);
    // Version 0 — "I hold no checkpoint" — which the server accepts only when
    // it holds none either, so two fresh devices cannot clobber each other.
    expect(client.save.mock.calls[0]![3]).toBe(0);
  });

  it("OFFERS a newer draft and does not apply it", async () => {
    const client = stubClient({
      load: vi.fn(async () => ({
        status: "found" as const,
        checkpoint: checkpoint({ subject: "from the laptop" }, 4),
      })),
    });
    await mount({ client, content: null });
    expect(seen?.offer?.content).toEqual({ subject: "from the laptop" });
    // Applied only on an explicit action: a draft that appears in the fields
    // unasked is indistinguishable from the record.
    expect(restored).toEqual([]);

    act(() => seen?.resume());
    expect(restored).toEqual([{ subject: "from the laptop" }]);
    expect(seen?.offer).toBeNull();
  });

  it("does not offer a draft that merely duplicates the saved record", async () => {
    // Desktop's exit path can run "save the campaign" and "flush the
    // checkpoint" in one transition with no render between them, so a
    // checkpoint one tick newer than the record it duplicates is normal here.
    // Offering it is the "restore a draft that is already the saved state"
    // the server's own header warns trains people to dismiss the prompt.
    const client = stubClient({
      load: vi.fn(async () => ({
        status: "found" as const,
        checkpoint: checkpoint({ ...RECORD }, 7),
      })),
    });
    await mount({ client, content: null });
    expect(seen?.offer).toBeNull();

    // The version is still adopted: writing from 0 over an existing row is a
    // guaranteed 409 on the first keystroke.
    await rerender({ client, content: { subject: "typing" } });
    await tick();
    expect(client.save.mock.calls[0]![3]).toBe(7);
  });

  it("explains review mode instead of resuming what this surface cannot open", async () => {
    // The clause's second branch: "or receive a precise explanation of why
    // only review mode is available."
    const client = stubClient({
      load: vi.fn(async () => ({
        status: "found" as const,
        checkpoint: checkpoint({ subject: "blocks" }, 2),
      })),
    });
    await mount({
      client,
      content: null,
      inspectContent: () => ({
        resumable: false,
        reason: "That draft's body was composed from blocks.",
      }),
    });
    expect(seen?.offer).not.toBeNull();
    expect(seen?.offerBlockedReason).toBe(
      "That draft's body was composed from blocks.",
    );
    act(() => seen?.resume());
    expect(restored).toEqual([]);
  });

  it("keeps the draft visible on a review-only surface and never writes", async () => {
    const client = stubClient({
      load: vi.fn(async () => ({
        status: "found" as const,
        checkpoint: checkpoint({ subject: "from the laptop" }, 4),
      })),
    });
    await mount({ client, content: { subject: "local" }, canEdit: false });
    expect(seen?.offer).not.toBeNull();
    await tick();
    expect(client.save).not.toHaveBeenCalled();
  });

  it("never writes from a review-only surface, on ANY path", async () => {
    // No offer, no conflict, nothing blocking — the ONLY thing between a
    // read-only viewer and a write is `canEdit`. The exit path has to honour it
    // too: a sent or cancelled campaign must not gain a draft because someone
    // had it open when they quit.
    const client = stubClient();
    await mount({ client, content: { subject: "looking, not typing" }, canEdit: false });
    expect(seen?.offer).toBeNull();
    await tick();
    await act(async () => {
      await prepareLifecycle(EXIT_INTENT);
    });
    await act(async () => {
      root?.unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
    root = null;
    expect(client.save).not.toHaveBeenCalled();
  });

  it("reports a session-only refusal as unsupported, not as a bad draft", async () => {
    const client = stubClient({
      load: vi.fn(async () => ({
        status: "unsupported" as const,
        message: "needs a signed-in session",
      })),
    });
    await mount({ client, content: { subject: "typing" } });
    expect(seen?.unsupported).toBe("needs a signed-in session");
    expect(seen?.refusal).toBeNull();
    await tick();
    // No point retrying every two seconds against an auth mode that cannot work.
    expect(client.save).not.toHaveBeenCalled();
  });
});

describe("a stale save", () => {
  async function conflicted(current: ReturnType<typeof checkpoint> | null) {
    const client = stubClient({
      save: vi.fn(async () => ({
        status: "stale" as const,
        current,
        message: "a newer draft was saved from another device",
      })),
    });
    await mount({ client, content: { subject: "mine" } });
    await tick();
    return client;
  }

  it("shows BOTH drafts and picks neither", async () => {
    const theirs = checkpoint({ subject: "theirs" }, 9);
    const client = await conflicted(theirs);
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(seen?.conflict?.current).toEqual(theirs);
    // Nothing has been applied and nothing overwritten.
    expect(restored).toEqual([]);
  });

  it("stops autosaving until the person resolves it", async () => {
    // Retrying at the server's version is exactly the silent overwrite the 409
    // exists to prevent, and retrying at ours is another 409 every two seconds.
    const client = await conflicted(checkpoint({ subject: "theirs" }, 9));
    await tick();
    await tick();
    expect(client.save).toHaveBeenCalledTimes(1);
  });

  it("loads the other device's draft when the person chooses theirs", async () => {
    await conflicted(checkpoint({ subject: "theirs" }, 9));
    act(() => seen?.useTheirs());
    expect(restored).toEqual([{ subject: "theirs" }]);
    expect(seen?.conflict).toBeNull();
  });

  it("re-writes at the adopted version when the person keeps this device's draft", async () => {
    const theirs = checkpoint({ subject: "theirs" }, 9);
    const client = stubClient({
      save: vi
        .fn()
        .mockResolvedValueOnce({
          status: "stale",
          current: theirs,
          message: "conflict",
        })
        .mockResolvedValue({
          status: "saved",
          checkpoint: checkpoint({ subject: "mine" }, 10),
        }),
    });
    await mount({ client, content: { subject: "mine" } });
    await tick();
    expect(seen?.conflict?.current).toEqual(theirs);

    await act(async () => {
      seen?.keepMine();
      await vi.advanceTimersByTimeAsync(0);
    });
    // Written at the version just adopted, so the overwrite is the one a person
    // chose after being shown both — the only way it is acceptable.
    expect(client.save).toHaveBeenCalledTimes(2);
    expect(client.save.mock.calls[1]![3]).toBe(9);
  });

  it("offers no resolution it cannot honour when the server withheld `current`", async () => {
    const client = await conflicted(null);
    expect(seen?.conflict).toEqual({ current: null, blockedReason: null });
    act(() => seen?.useTheirs());
    expect(restored).toEqual([]);
    act(() => seen?.keepMine());
    expect(client.save).toHaveBeenCalledTimes(1);
  });

  it("marks the other draft review-only when this surface cannot open it", async () => {
    const theirs = checkpoint({ subject: "blocks" }, 9);
    const client = stubClient({
      save: vi.fn(async () => ({
        status: "stale" as const,
        current: theirs,
        message: "conflict",
      })),
    });
    await mount({
      client,
      content: { subject: "mine" },
      inspectContent: () => ({ resumable: false, reason: "block-composed" }),
    });
    await tick();
    expect(seen?.conflict?.blockedReason).toBe("block-composed");
    act(() => seen?.useTheirs());
    expect(restored).toEqual([]);
  });
});

describe("a refused draft", () => {
  it("stops autosave and says so, then retries once the draft changes", async () => {
    const client = stubClient({
      save: vi
        .fn()
        .mockResolvedValueOnce({
          status: "refused",
          code: "content_too_large",
          message: "A draft checkpoint is limited to 256 KiB.",
        })
        .mockResolvedValue({
          status: "saved",
          checkpoint: checkpoint({ subject: "smaller" }, 1),
        }),
    });
    await mount({ client, content: { subject: "huge" } });
    await tick();
    expect(seen?.refusal).toBe("A draft checkpoint is limited to 256 KiB.");

    await tick();
    expect(client.save).toHaveBeenCalledTimes(1);

    await rerender({ client, content: { subject: "smaller" } });
    expect(seen?.refusal).toBeNull();
    await tick();
    expect(client.save).toHaveBeenCalledTimes(2);
  });

  it("stays quiet and retries the same draft after a transient failure", async () => {
    const client = stubClient({
      save: vi
        .fn()
        .mockResolvedValueOnce({ status: "unavailable", message: "offline" })
        .mockResolvedValue({
          status: "saved",
          checkpoint: checkpoint({ subject: "typing" }, 1),
        }),
    });
    await mount({ client, content: { subject: "typing" } });
    await tick();
    expect(seen?.refusal).toBeNull();
    expect(seen?.unsupported).toBeNull();

    // The next render re-arms the debounce. `sentRef` was deliberately left
    // alone by the transient failure, so the SAME draft is retried rather than
    // being treated as already delivered.
    await rerender({ client, content: { subject: "typing" } });
    await tick();
    expect(client.save).toHaveBeenCalledTimes(2);
  });
});

describe("leaving", () => {
  it("flushes through the desktop lifecycle protocol, not a tab event", async () => {
    // close-window / quit-app / sign-out / workspace-switch / update-restart /
    // os-shutdown all run every guard's `prepare`. A ported
    // `visibilitychange` listener would fire on window blur and miss quit.
    const client = stubClient();
    await mount({ client, content: { subject: "unflushed" } });
    expect(client.save).not.toHaveBeenCalled();

    await act(async () => {
      await prepareLifecycle(EXIT_INTENT);
    });
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.save.mock.calls[0]![2]).toEqual({ subject: "unflushed" });
  });

  it("never adds a second voice to the exit dialog", async () => {
    // The campaign editor already raises the unsaved-changes concern. A guard
    // that also reported one would make the exit review argue with itself.
    const client = stubClient();
    await mount({ client, content: { subject: "unflushed" } });
    await expect(inspectLifecycle(EXIT_INTENT)).resolves.toEqual([]);
  });

  it("does not write at an unknown version when the load has not answered", async () => {
    // On desktop the leave path is the COMMON path — closing the slide-over or
    // quitting is how most edits end — so a flush can easily precede the load.
    // Writing then means writing at version 0 over a row that may exist: a
    // guaranteed 409 surfaced as "another device saved newer work", when in
    // fact this device had not finished reading its own draft.
    let answer: (() => void) | null = null;
    const client = stubClient({
      load: vi.fn(
        () =>
          new Promise<CheckpointLoad<Draft>>((resolve) => {
            answer = () => resolve({ status: "absent" });
          }),
      ),
    });
    await mount({ client, content: { subject: "unflushed" } });
    await act(async () => {
      await prepareLifecycle(EXIT_INTENT);
    });
    expect(client.save).not.toHaveBeenCalled();

    await act(async () => {
      answer?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await prepareLifecycle(EXIT_INTENT);
    });
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.save.mock.calls[0]![3]).toBe(0);
  });

  it("flushes when the editor closes", async () => {
    const client = stubClient();
    await mount({ client, content: { subject: "unflushed" } });
    await act(async () => {
      root?.unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
    root = null;
    expect(client.save).toHaveBeenCalledTimes(1);
  });

  it("releases its lifecycle guard when the editor closes", async () => {
    const client = stubClient();
    await mount({ client, content: { subject: "unflushed" } });
    await act(async () => {
      root?.unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
    root = null;
    await expect(inspectLifecycle(EXIT_INTENT)).resolves.toEqual([]);
    // A released guard cannot flush again; a leaked one would write a draft
    // for a campaign nobody has open.
    await act(async () => {
      await prepareLifecycle(EXIT_INTENT);
    });
    expect(client.save).toHaveBeenCalledTimes(1);
  });
});

describe("the record being saved", () => {
  it("discards the checkpoint once the draft is no longer unsaved work", async () => {
    // Leaving it behind makes the next open offer a draft that is already the
    // saved state, which reads as a bug and trains people to dismiss it.
    const client = stubClient();
    await mount({ client, content: { subject: "typing" } });
    await tick();
    expect(client.save).toHaveBeenCalledTimes(1);

    await rerender({ client, content: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.discard).toHaveBeenCalledWith("campaign", "cam_1");
  });

  it("never writes a draft byte-identical to the saved record", async () => {
    // Autosaving the record back to itself mints a checkpoint newer than the
    // record for work that does not exist.
    const client = stubClient();
    await mount({ client, content: { ...RECORD } });
    await tick();
    expect(client.save).not.toHaveBeenCalled();
  });

  it("drops the offered draft on an explicit dismiss", async () => {
    const client = stubClient({
      load: vi.fn(async () => ({
        status: "found" as const,
        checkpoint: checkpoint({ subject: "from the laptop" }, 4),
      })),
    });
    await mount({ client, content: null });
    act(() => seen?.dismiss());
    expect(client.discard).toHaveBeenCalledWith("campaign", "cam_1");
    expect(seen?.offer).toBeNull();
  });
});

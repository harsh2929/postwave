/**
 * Autosave + resume for a durable draft checkpoint, driven through React's own
 * lifecycle (hooks/useEditorCheckpoint).
 *
 * The properties that matter here are behavioural, not computational, so these
 * run the REAL hook and the REAL api/editorCheckpoint client against a mocked
 * transport: what goes on the wire, when, and what the screen is told about it.
 *
 * Three of them are mobile's alone and are the reason this port exists:
 *
 *   - a flush when the app leaves the foreground. On a phone that — not
 *     unmount — is how someone leaves an editor, and without it the two-second
 *     debounce window is the common case rather than the edge case;
 *   - a write MERGES over what the server holds, so a four-field sheet cannot
 *     delete a laptop's body draft;
 *   - the auto-delete is vetoed for a checkpoint this surface could not have
 *     written.
 */
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  online: true,
  appStateListener: null as ((next: string) => void) | null,
}));

const rawRequest = vi.hoisted(() => vi.fn());

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (next: string) => void) => {
      state.appStateListener = listener;
      return { remove: () => (state.appStateListener = null) };
    },
  },
}));

vi.mock("@/api/request", () => ({
  rawRequest: (...args: unknown[]) => rawRequest(...args),
}));

vi.mock("@/lib/connectivity", () => ({
  isProbablyOnline: () => state.online,
}));

const { useEditorCheckpoint } = await import("./useEditorCheckpoint");

interface Draft {
  subject?: string;
  body_html?: string;
}

const RECORD_SAVED_AT = "2026-08-04T10:00:00Z";
const NEWER = "2026-08-04T10:05:00Z";
const OLDER = "2026-08-04T09:55:00Z";
const PATH = "/api/v1/editor/checkpoints/campaign/cmp_1";

function checkpoint(
  over: Partial<{ content: Draft; version: number; updated_at: string }> = {},
) {
  return {
    entity_key: "campaign",
    entity_id: "cmp_1",
    content: over.content ?? { subject: "from the laptop" },
    version: over.version ?? 3,
    updated_at: over.updated_at ?? NEWER,
  };
}

/** Per-method canned answers, overridable per test. */
let answers: {
  GET: () => unknown;
  PUT: (body: unknown) => unknown;
  DELETE: () => unknown;
};

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];

const puts = () => calls.filter((c) => c.method === "PUT");

let latest: ReturnType<typeof useEditorCheckpoint<Draft>> | undefined;
const restored: Draft[] = [];
let renderer: TestRenderer.ReactTestRenderer | undefined;

function Probe({
  content,
  canEdit = true,
  recordUpdatedAt,
  merge,
  canDiscard,
}: {
  content: Draft | null;
  canEdit?: boolean;
  recordUpdatedAt: string | undefined;
  merge?: (held: Draft | null, draft: Draft) => Draft;
  canDiscard?: (held: Draft | null) => boolean;
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
    ...(merge ? { mergeWithHeld: merge } : {}),
    ...(canDiscard ? { canDiscardHeld: canDiscard } : {}),
  });
  return null;
}

/**
 * `recordUpdatedAt` is defaulted by the harness rather than by Probe's own
 * destructuring: a destructuring default also fires for an EXPLICIT undefined,
 * which would make "the record has not loaded yet" untestable.
 */
type ProbeProps = Omit<Parameters<typeof Probe>[0], "recordUpdatedAt"> & {
  recordUpdatedAt?: string | undefined;
};

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  restored.length = 0;
  latest = undefined;
  renderer = undefined;
  state.online = true;
  state.appStateListener = null;
  answers = {
    GET: () => ({ found: false }),
    // Echoes the stored content and bumps the version, as the server's
    // RETURNING clause does. A stub that answered with something else would
    // hide the fact that the hook tracks what the server now HOLDS — which is
    // exactly what the merge and the delete veto are decided from.
    PUT: (body) => {
      const sent = body as { content: Draft; version: number };
      return checkpoint({
        content: sent.content,
        version: (sent.version ?? 0) + 1,
        updated_at: NEWER,
      });
    },
    DELETE: () => ({ discarded: true }),
  };
  rawRequest.mockImplementation(
    async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      const answer =
        method === "PUT"
          ? answers.PUT(body)
          : method === "DELETE"
            ? answers.DELETE()
            : answers.GET();
      if (answer && typeof answer === "object" && "__error" in answer) {
        return { data: null, error: (answer as { __error: unknown }).__error };
      }
      return { data: answer, error: null };
    },
  );
});

afterEach(() => {
  if (renderer) act(() => renderer?.unmount());
  vi.useRealTimers();
  vi.clearAllMocks();
});

const errored = (error: Record<string, unknown>) => ({ __error: error });

async function mount(props: ProbeProps) {
  await act(async () => {
    renderer = TestRenderer.create(
      <Probe recordUpdatedAt={RECORD_SAVED_AT} {...props} />,
    );
  });
}

async function update(props: ProbeProps) {
  await act(async () => {
    renderer?.update(<Probe recordUpdatedAt={RECORD_SAVED_AT} {...props} />);
  });
}

async function tick(ms = 2_000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function background(next = "background") {
  await act(async () => {
    state.appStateListener?.(next);
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("arriving on the second device", () => {
  it("offers a draft newer than the record instead of applying it", async () => {
    answers.GET = () => ({ found: true, checkpoint: checkpoint() });
    await mount({ content: null });
    expect(latest?.offer?.content).toEqual({ subject: "from the laptop" });
    expect(restored).toEqual([]);
  });

  it("applies it only when the person asks", async () => {
    answers.GET = () => ({ found: true, checkpoint: checkpoint() });
    await mount({ content: null });
    await act(async () => latest?.resume());
    expect(restored).toEqual([{ subject: "from the laptop" }]);
    expect(latest?.offer).toBeNull();
  });

  it("drops the draft on an explicit discard", async () => {
    answers.GET = () => ({ found: true, checkpoint: checkpoint() });
    await mount({ content: null });
    await act(async () => latest?.dismiss());
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([
      { method: "DELETE", path: PATH },
    ]);
  });

  it("does not offer a draft the record already outlives", async () => {
    answers.GET = () => ({
      found: true,
      checkpoint: checkpoint({ updated_at: OLDER, version: 7 }),
    });
    await mount({ content: null });
    expect(latest?.offer).toBeNull();
    // …but it still writes at that row's version: starting from 0 would be
    // refused on the first keystroke and turn a non-event into a conflict.
    await update({ content: { subject: "typed" } });
    await tick();
    expect(puts()[0]?.body).toMatchObject({ version: 7 });
  });

  it("offers nothing when the server holds nothing", async () => {
    await mount({ content: null });
    expect(latest?.offer).toBeNull();
  });

  it("does not read a draft before the saved record's timestamp exists", async () => {
    // Without it there is no way to tell whether a checkpoint is unsaved work,
    // and offering on a guess is the silent apply this exists to avoid.
    await mount({ content: null, recordUpdatedAt: undefined });
    expect(calls).toEqual([]);
  });
});

describe("autosaving the open editor", () => {
  it("writes the draft after the debounce, carrying the loaded version", async () => {
    answers.GET = () => ({
      found: true,
      checkpoint: checkpoint({ updated_at: OLDER, version: 4 }),
    });
    await mount({ content: null });
    await update({ content: { subject: "typed on the phone" } });
    expect(puts()).toHaveLength(0);
    await tick();
    expect(puts()).toEqual([
      {
        method: "PUT",
        path: PATH,
        body: { content: { subject: "typed on the phone" }, version: 4 },
      },
    ]);
  });

  it("never writes a pristine editor", async () => {
    await mount({ content: null });
    await tick();
    expect(puts()).toHaveLength(0);
  });

  it("never writes from a review-only surface", async () => {
    await mount({ content: { subject: "typed" }, canEdit: false });
    await tick();
    expect(puts()).toHaveLength(0);
  });

  it("does not re-send an unchanged draft", async () => {
    await mount({ content: null });
    const draft = { subject: "typed" };
    await update({ content: draft });
    await tick();
    expect(puts()).toHaveLength(1);
    await update({ content: { ...draft } });
    await tick();
    expect(puts()).toHaveLength(1);
  });

  it("does not re-send the checkpoint it just loaded", async () => {
    // A subset surface merges over what the server holds, so an untouched
    // screen would otherwise re-PUT a byte-identical body on every open.
    const held = { subject: "from the laptop", body_html: "<p>x</p>" };
    answers.GET = () => ({
      found: true,
      checkpoint: checkpoint({ content: held, updated_at: OLDER }),
    });
    await mount({
      content: null,
      merge: (h, d) => ({ ...(h ?? {}), ...d }),
    });
    await update({
      content: { subject: "from the laptop" },
      merge: (h, d) => ({ ...(h ?? {}), ...d }),
    });
    await tick();
    expect(puts()).toHaveLength(0);
  });

  it("holds off while a resume offer is unanswered", async () => {
    answers.GET = () => ({ found: true, checkpoint: checkpoint() });
    await mount({ content: null });
    await update({ content: { subject: "typed" } });
    await tick();
    expect(puts()).toHaveLength(0);
    await act(async () => latest?.resume());
    await update({ content: { subject: "typed more" } });
    await tick();
    expect(puts()).toHaveLength(1);
  });
});

describe("what a phone surface may delete", () => {
  it("discards the checkpoint once there is nothing unsaved", async () => {
    await mount({ content: null });
    await update({ content: { subject: "typed" } });
    await tick();
    await update({ content: null });
    await tick(0);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("stops reporting a kept draft once it has deleted it", async () => {
    // `lastSavedAt` is what a surface renders as "draft kept <when>". Leaving
    // it set past the DELETE would go on promising a draft that no longer
    // exists — the one lie a durable-draft indicator must not tell.
    await mount({ content: null });
    await update({ content: { subject: "typed" } });
    await tick();
    expect(latest?.lastSavedAt).toBe(NEWER);
    await update({ content: null });
    await tick(0);
    expect(latest?.lastSavedAt).toBeNull();
  });

  it("keeps reporting a kept draft when the veto stopped the delete", async () => {
    // The mirror of the above, and the reason the clear sits BELOW the veto:
    // here the draft really does survive, so the promise is still true.
    const held = { subject: "from the laptop", body_html: "<p>three paras</p>" };
    answers.GET = () => ({
      found: true,
      checkpoint: checkpoint({ content: held, updated_at: OLDER }),
    });
    const props = {
      merge: (h: Draft | null, d: Draft) => ({ ...(h ?? {}), ...d }),
      canDiscard: (h: Draft | null) => !h || !("body_html" in h),
    };
    await mount({ content: null, ...props });
    await update({ content: { subject: "typed on the phone" }, ...props });
    await tick();
    await update({ content: null, ...props });
    await tick(0);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(latest?.lastSavedAt).toBe(NEWER);
  });

  it("refuses to delete a draft holding work this surface cannot show", async () => {
    // The whole point of the veto. Closing a four-field sheet says nothing
    // about the body someone typed on a laptop, and the checkpoint is one row
    // per person per campaign — deleting it destroys the only copy.
    const held = { subject: "from the laptop", body_html: "<p>three paras</p>" };
    answers.GET = () => ({
      found: true,
      checkpoint: checkpoint({ content: held, updated_at: OLDER }),
    });
    const props = {
      merge: (h: Draft | null, d: Draft) => ({ ...(h ?? {}), ...d }),
      canDiscard: (h: Draft | null) => !h || !("body_html" in h),
    };
    await mount({ content: null, ...props });
    await update({ content: { subject: "typed on the phone" }, ...props });
    await tick();
    await update({ content: null, ...props });
    await tick(0);
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("dismissing an offer it cannot fully show keeps the draft, and only clears the offer", async () => {
    // The one path by which this surface could destroy the laptop's work.
    //
    // Web skips the veto on an explicit dismiss, and there the reasoning holds:
    // its editor renders the whole draft, so "keep what is saved" is a choice
    // made with the draft in view. This sheet shows a banner and a relative
    // time — the body is never rendered — so the same tap would delete three
    // paragraphs the person was never shown. Dismissing the OFFER and deleting
    // the DRAFT are different requests, and only the first one was made.
    const held = { subject: "from the laptop", body_html: "<p>three paras</p>" };
    answers.GET = () => ({
      found: true,
      checkpoint: checkpoint({ content: held, updated_at: NEWER }),
    });
    const props = {
      merge: (h: Draft | null, d: Draft) => ({ ...(h ?? {}), ...d }),
      canDiscard: (h: Draft | null) => !h || !("body_html" in h),
    };
    await mount({ content: null, ...props });
    await tick();
    expect(latest?.offer).not.toBeNull();

    latest?.dismiss();
    await tick(0);

    expect(latest?.offer).toBeNull();
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("dismissing an offer it can fully show does delete the draft", async () => {
    // The other half, so the veto cannot be over-applied into a dismiss that
    // never deletes anything: when the held draft is entirely fields this sheet
    // displays, the person really did choose against what they were shown.
    const held = { subject: "from the phone" };
    answers.GET = () => ({
      found: true,
      checkpoint: checkpoint({ content: held, updated_at: NEWER }),
    });
    const props = {
      merge: (h: Draft | null, d: Draft) => ({ ...(h ?? {}), ...d }),
      canDiscard: (h: Draft | null) => !h || !("body_html" in h),
    };
    await mount({ content: null, ...props });
    await tick();
    expect(latest?.offer).not.toBeNull();

    latest?.dismiss();
    await tick(0);

    expect(calls.filter((c) => c.method === "DELETE")).toEqual([
      { method: "DELETE", path: PATH },
    ]);
  });

  it("does not discard a draft while its offer is still on screen unanswered", async () => {
    // Reachable, and it deletes someone else's work.
    //
    // The banner is showing "you have an unsaved draft from another device".
    // The person opens the sheet WITHOUT tapping Resume, types something, then
    // reverts or closes it. Content goes null, the discard effect runs — and
    // without this guard it DELETEs the other device's draft while the offer to
    // resume it is still on screen.
    //
    // The subset veto catches the case where the held draft carries a body this
    // surface cannot show. It does NOT catch this one: a draft holding only the
    // four fields the sheet displays is still someone's unanswered work, and
    // "I did not tap Resume" is not "throw it away".
    const held = { subject: "from the laptop" };
    answers.GET = () => ({
      found: true,
      checkpoint: checkpoint({ content: held, updated_at: NEWER }),
    });
    await mount({ content: null });
    await tick();
    expect(latest?.offer).not.toBeNull();

    // Typed here, then reverted — without ever answering the offer.
    await update({ content: { subject: "typed but not kept" } });
    await tick();
    await update({ content: null });
    await tick(0);

    expect(latest?.offer).not.toBeNull();
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("merges its fields over the held draft rather than replacing it", async () => {
    const held = { subject: "from the laptop", body_html: "<p>three paras</p>" };
    answers.GET = () => ({
      found: true,
      checkpoint: checkpoint({ content: held, updated_at: OLDER, version: 2 }),
    });
    const merge = (h: Draft | null, d: Draft) => ({ ...(h ?? {}), ...d });
    await mount({ content: null, merge });
    await update({ content: { subject: "typed on the phone" }, merge });
    await tick();
    expect(puts()[0]?.body).toEqual({
      content: { subject: "typed on the phone", body_html: "<p>three paras</p>" },
      version: 2,
    });
  });
});

describe("another device saved newer work", () => {
  const theirs = checkpoint({
    content: { subject: "theirs" },
    version: 9,
    updated_at: NEWER,
  });

  beforeEach(() => {
    answers.PUT = () =>
      errored({
        status: 409,
        code: "stale_checkpoint",
        message: "a newer draft was saved from another device",
        payload: { error: { code: "stale_checkpoint", current: theirs } },
      });
  });

  it("surfaces the conflict with both drafts and stops writing", async () => {
    await mount({ content: null });
    await update({ content: { subject: "mine" } });
    await tick();
    expect(latest?.conflict?.current?.content).toEqual({ subject: "theirs" });
    await update({ content: { subject: "mine again" } });
    await tick();
    expect(puts()).toHaveLength(1);
  });

  it("picks no winner on its own", async () => {
    await mount({ content: null });
    await update({ content: { subject: "mine" } });
    await tick();
    expect(restored).toEqual([]);
    expect(puts()).toHaveLength(1);
  });

  it("loads the other device's draft when the person chooses it", async () => {
    await mount({ content: null });
    await update({ content: { subject: "mine" } });
    await tick();
    await act(async () => latest?.useTheirs());
    expect(restored).toEqual([{ subject: "theirs" }]);
    expect(latest?.conflict).toBeNull();
  });

  it("overwrites at the other version only when the person chooses this one", async () => {
    await mount({ content: null });
    await update({ content: { subject: "mine" } });
    await tick();
    answers.PUT = () => checkpoint({ content: { subject: "mine" }, version: 10 });
    await act(async () => latest?.keepMine());
    await tick(0);
    expect(puts()).toHaveLength(2);
    expect(puts()[1]?.body).toMatchObject({ version: 9 });
  });

  it("does not call its own retried write another device", async () => {
    // The SDK retries a PUT after a network fault: the first attempt commits,
    // its response is lost, the retry is refused with the content we sent.
    //
    // THE ECHO IS jsonb-ORDERED, not byte-identical, because that is what the
    // real server returns. PostgreSQL stores jsonb keys sorted by length then
    // bytes, so a payload sent as {subject, preview_text, from_name, reply_to}
    // comes back as {subject, reply_to, from_name, preview_text} — verified
    // against the live database. A mock that echoed the exact bytes it was
    // handed would pass over a client comparing raw JSON.stringify, which is
    // precisely the bug this test now exists to catch: on a FIRST write the
    // comparison always fails, and the person on the train is shown a conflict
    // naming a second device they do not have.
    const mine = {
      subject: "mine",
      preview_text: "peek",
      from_name: "Ada",
      reply_to: "ada@example.test",
    };
    answers.PUT = () =>
      errored({
        status: 409,
        code: "stale_checkpoint",
        message: "a newer draft was saved from another device",
        payload: {
          error: {
            code: "stale_checkpoint",
            current: checkpoint({ content: asJsonbWouldReturn(mine), version: 5 }),
          },
        },
      });
    await mount({ content: null });
    await update({ content: mine });
    await tick();
    expect(latest?.conflict).toBeNull();
    expect(latest?.lastSavedAt).toBe(NEWER);
  });
});

/**
 * Re-spell an object the way PostgreSQL jsonb hands it back: keys ordered by
 * length, then bytewise. Same value, different bytes — which is the whole
 * point, since anything comparing serialized forms across that boundary has to
 * be canonical rather than literal.
 */
function asJsonbWouldReturn<T extends Record<string, unknown>>(value: T): T {
  const keys = Object.keys(value).sort((a, b) =>
    a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length,
  );
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = value[key];
  return out as T;
}

describe("a draft the server will not take", () => {
  it("says so and stops the loop", async () => {
    answers.PUT = () =>
      errored({
        status: 413,
        code: "content_too_large",
        message: "a draft checkpoint is limited to 256 KiB",
      });
    await mount({ content: null });
    await update({ content: { subject: "too big" } });
    await tick();
    expect(latest?.refusal).toBe("a draft checkpoint is limited to 256 KiB");
    await tick();
    expect(puts()).toHaveLength(1);
  });

  it("tries again once the draft actually changes", async () => {
    answers.PUT = () =>
      errored({ status: 413, code: "content_too_large", message: "too big" });
    await mount({ content: null });
    await update({ content: { subject: "too big" } });
    await tick();
    expect(latest?.refusal).toBe("too big");
    answers.PUT = () => checkpoint({ version: 1 });
    await update({ content: { subject: "smaller" } });
    await tick();
    expect(latest?.refusal).toBeNull();
    expect(puts()).toHaveLength(2);
  });

  it("stays quiet about a transient failure and retries the same draft", async () => {
    answers.PUT = () => errored({ status: 500, message: "later" });
    await mount({ content: null });
    const draft = { subject: "typed" };
    await update({ content: draft });
    await tick();
    expect(latest?.refusal).toBeNull();
    expect(latest?.conflict).toBeNull();
    await update({ content: { ...draft } });
    await tick();
    expect(puts()).toHaveLength(2);
  });

  it("says nothing at all when this credential cannot own a draft", async () => {
    // A shared API key: the route is per-person and answers 403
    // `session_required`. That is the API behaving correctly, so it must not
    // raise the "this draft is not being kept" banner — and it must not keep
    // hammering the endpoint every two seconds either.
    answers.PUT = () =>
      errored({ status: 403, code: "session_required", message: "…" });
    await mount({ content: null });
    await update({ content: { subject: "typed" } });
    await tick();
    expect(latest?.refusal).toBeNull();
    await update({ content: { subject: "typed more" } });
    await tick();
    expect(puts()).toHaveLength(1);
  });

  it("does not send a versioned write while the phone is offline", async () => {
    state.online = false;
    await mount({ content: null });
    await update({ content: { subject: "typed on the train" } });
    await tick();
    expect(puts()).toHaveLength(0);
    expect(latest?.refusal).toBeNull();
  });
});

describe("leaving the editor", () => {
  it("flushes the debounce window when the app goes to the background", async () => {
    await mount({ content: null });
    await update({ content: { subject: "mid-sentence" } });
    // Nowhere near the debounce — this is the window the work is lost in.
    await tick(200);
    expect(puts()).toHaveLength(0);
    await background();
    expect(puts()).toEqual([
      {
        method: "PUT",
        path: PATH,
        body: { content: { subject: "mid-sentence" }, version: 0 },
      },
    ]);
  });

  it("flushes on `inactive` too, which is where an interrupted phone goes first", async () => {
    await mount({ content: null });
    await update({ content: { subject: "mid-sentence" } });
    await tick(200);
    await background("inactive");
    expect(puts()).toHaveLength(1);
  });

  it("does not flush when the app merely comes back", async () => {
    await mount({ content: null });
    await update({ content: { subject: "mid-sentence" } });
    await tick(200);
    await background("active");
    expect(puts()).toHaveLength(0);
  });

  it("flushes when the editor unmounts", async () => {
    await mount({ content: null });
    await update({ content: { subject: "mid-sentence" } });
    await tick(200);
    await act(async () => {
      renderer?.unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
    renderer = undefined;
    expect(puts()).toHaveLength(1);
  });
});

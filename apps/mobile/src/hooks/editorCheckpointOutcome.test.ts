/**
 * The checkpoint DECISIONS, with no React in the room
 * (hooks/editorCheckpointOutcome).
 *
 * These are the properties the lifecycle test next door cannot isolate: it
 * drives the real hook through a mocked transport, so a wrong answer there
 * shows up as a missing PUT three renders later. Here each answer the server
 * can give is handed in directly and the reported move is read straight back.
 *
 * The expectations below are written out literally — versions, timestamps and
 * kinds spelled by hand — rather than recomputed from the module, so a change
 * of behaviour cannot quietly rewrite the thing it is being checked against.
 */
import { describe, expect, it } from "vitest";

import {
  canonicalJSON,
  classifyLoadOutcome,
  classifySaveOutcome,
  heldFromOutcome,
  mayDiscardHeld,
  outcomeMeansServerHolds,
} from "./editorCheckpointOutcome";

interface Draft {
  subject?: string;
  reply_to?: string;
}

const RECORD_AT = "2026-08-04T10:00:00Z";
const NEWER = "2026-08-04T10:05:00Z";
const OLDER = "2026-08-04T09:55:00Z";

function checkpoint(over: {
  content?: Draft;
  version?: number;
  updated_at?: string;
}) {
  return {
    entity_key: "campaign",
    entity_id: "cmp_1",
    content: over.content ?? { subject: "from the laptop" },
    version: over.version ?? 3,
    updated_at: over.updated_at ?? NEWER,
  };
}

describe("classifyLoadOutcome", () => {
  it("offers a draft newer than the saved record, and tracks its version", () => {
    const opening = classifyLoadOutcome<Draft>(
      { status: "found", checkpoint: checkpoint({ version: 7 }) },
      RECORD_AT,
    );
    expect(opening.held).toEqual({
      version: 7,
      content: { subject: "from the laptop" },
    });
    expect(opening.offer?.updated_at).toBe(NEWER);
    expect(opening.sent).toBe('{"subject":"from the laptop"}');
  });

  it("tracks a draft OLDER than the record without offering it", () => {
    const opening = classifyLoadOutcome<Draft>(
      { status: "found", checkpoint: checkpoint({ version: 4, updated_at: OLDER }) },
      RECORD_AT,
    );
    // Held, so the next write lands on version 4 rather than being refused at
    // 0; not offered, because it cannot be unsaved work.
    expect(opening.held?.version).toBe(4);
    expect(opening.offer).toBeNull();
  });

  it("reports nothing held when the server holds no draft", () => {
    expect(classifyLoadOutcome<Draft>({ status: "absent" }, RECORD_AT)).toEqual({
      held: null,
      sent: null,
      offer: null,
    });
  });

  it("reports nothing held when the load failed", () => {
    const opening = classifyLoadOutcome<Draft>(
      { status: "unavailable", message: "offline" },
      RECORD_AT,
    );
    expect(opening.held).toBeNull();
    expect(opening.offer).toBeNull();
  });
});

describe("classifySaveOutcome", () => {
  it("accepts a save and reports the version and timestamp to adopt", () => {
    const outcome = classifySaveOutcome<Draft>(
      {
        status: "saved",
        checkpoint: checkpoint({ version: 9, updated_at: NEWER }),
      },
      { subject: "from the laptop" },
    );
    expect(outcome).toEqual({
      kind: "accepted",
      held: { version: 9, content: { subject: "from the laptop" } },
      savedAt: NEWER,
    });
  });

  it("treats a 409 carrying OUR OWN content as accepted, even re-keyed by jsonb", () => {
    // What went out, and what PostgreSQL hands back: same value, keys sorted by
    // length then bytes. A byte comparison would call this another device.
    const sent = { subject: "a", reply_to: "d" };
    const outcome = classifySaveOutcome<Draft>(
      {
        status: "stale",
        current: checkpoint({
          content: { reply_to: "d", subject: "a" },
          version: 12,
          updated_at: NEWER,
        }),
        message: "stale",
      },
      sent,
    );
    expect(outcome.kind).toBe("accepted");
    expect(heldFromOutcome(outcome)).toEqual({
      version: 12,
      content: { reply_to: "d", subject: "a" },
    });
  });

  it("raises a conflict when the other device's draft really differs", () => {
    const theirs = checkpoint({ content: { subject: "theirs" }, version: 12 });
    const outcome = classifySaveOutcome<Draft>(
      { status: "stale", current: theirs, message: "stale" },
      { subject: "mine" },
    );
    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") throw new Error("expected a conflict");
    // Both halves matter: the version is adopted so a chosen overwrite can be
    // written, and `current` is the newer work the dialog has to show.
    expect(outcome.held).toEqual({ version: 12, content: { subject: "theirs" } });
    expect(outcome.current).toBe(theirs);
  });

  it("raises an unresolvable conflict when the server could not re-read its row", () => {
    const outcome = classifySaveOutcome<Draft>(
      { status: "stale", current: null, message: "unreadable" },
      { subject: "mine" },
    );
    expect(outcome).toEqual({ kind: "conflict", held: null, current: null });
    expect(heldFromOutcome(outcome)).toBeNull();
  });

  it("passes a refusal's message through", () => {
    const outcome = classifySaveOutcome<Draft>(
      { status: "refused", code: "content_too_large", message: "Too big." },
      { subject: "mine" },
    );
    expect(outcome).toEqual({ kind: "refused", message: "Too big." });
  });

  it("reports unsupported without a message", () => {
    expect(
      classifySaveOutcome<Draft>(
        { status: "unsupported", code: "session_required" },
        { subject: "mine" },
      ),
    ).toEqual({ kind: "unsupported" });
  });

  it("reports a transient failure as unavailable", () => {
    expect(
      classifySaveOutcome<Draft>(
        { status: "unavailable", message: "offline" },
        { subject: "mine" },
      ),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("outcomeMeansServerHolds", () => {
  it("is true for the answers that leave a row behind", () => {
    expect(
      outcomeMeansServerHolds<Draft>({
        kind: "accepted",
        held: { version: 1, content: {} },
        savedAt: NEWER,
      }),
    ).toBe(true);
    expect(
      outcomeMeansServerHolds<Draft>({
        kind: "conflict",
        held: null,
        current: null,
      }),
    ).toBe(true);
  });

  it("is false for the answers that wrote nothing", () => {
    expect(
      outcomeMeansServerHolds<Draft>({ kind: "refused", message: "no" }),
    ).toBe(false);
    expect(outcomeMeansServerHolds<Draft>({ kind: "unsupported" })).toBe(false);
    expect(outcomeMeansServerHolds<Draft>({ kind: "unavailable" })).toBe(false);
  });
});

describe("mayDiscardHeld", () => {
  it("allows the delete when the surface holds the whole draft", () => {
    expect(mayDiscardHeld<Draft>(undefined, { subject: "x" })).toBe(true);
  });

  it("defers to a subset surface's veto", () => {
    const guard = (held: Draft | null) => held?.reply_to === undefined;
    expect(mayDiscardHeld(guard, { subject: "x" })).toBe(true);
    expect(mayDiscardHeld(guard, { subject: "x", reply_to: "d" })).toBe(false);
  });
});

describe("canonicalJSON", () => {
  it("is blind to key order at every depth", () => {
    expect(canonicalJSON({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("never reorders array elements, whose order is meaningful", () => {
    expect(canonicalJSON([{ b: 1, a: 2 }, "z", "y"])).toBe(
      '[{"a":2,"b":1},"z","y"]',
    );
  });

  it("passes undefined through, as JSON.stringify does", () => {
    expect(canonicalJSON(undefined)).toBeUndefined();
  });
});

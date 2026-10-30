/**
 * WHAT CHANGED HERE, AND WHY — 2026-08, AUTOMATION#5 + AUTOMATION#15.
 *
 * This file used to encode a product decision that has since been REVERSED by
 * the product owner: that mobile does not create sequences at all. Two of its
 * assertions were written to keep that true —
 *
 *   expect(list).not.toContain("executeSequenceCreate");
 *   // (and the surrounding "the shipped mobile UI source is mutation-free")
 *
 * — and both now contradict an approved decision. Creating a sequence from the
 * phone is APPROVED and shipped (the header's "New" action → the create sheet →
 * `OFFLINE_MUTATION_KEYS.sequenceCreate`), and so is drafting a whole sequence
 * with AI (the header's "AI draft" action → `POST /voice/sequences/draft` →
 * a reviewed save through `POST /voice/sequences`).
 *
 * They are REPLACED, not deleted. The negative assertion is now a POSITIVE one:
 * the list screen must actually reach both create paths, because "the affordance
 * silently disappeared" is a regression this cluster has had before and no test
 * would have caught. A capability flag with no test is exactly how the old
 * decision drifted out of sync with the code in the first place.
 *
 * WHAT CHANGED SINCE, and why the paragraph that used to sit here is gone:
 * `MOBILE_SEQUENCE_AUTHORING_AVAILABLE` was flipped to true under GATE#3. It
 * still does not gate "can mobile make a sequence"; it gates editing the steps
 * of one. The pieces it does NOT restore are unchanged and still asserted
 * below: `StepPalette` was deleted, so there is no way to ADD a step from the
 * phone, and the long-press drag layer was deleted, so reorder is the explicit
 * up/down control. What the flag opens is editing, reordering and deleting
 * steps that already exist — on a DRAFT, because the server refuses a PATCH on
 * any other status (409, sequences.go:892-895) and that refusal is now a term
 * in the client's gate rather than a surprise at save time.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MOBILE_SEQUENCE_AUTHORING_AVAILABLE,
  MOBILE_SEQUENCE_RUNTIME_AVAILABLE,
  mobileSequenceStatusPresentation,
  mobileSequenceStepsEditable,
} from "./sequenceCapabilities";

describe("mobile sequence capability boundary", () => {
  it("keeps EXECUTION closed, because that one is the server's answer", () => {
    // A SERVER fact, and the reason this half does not move with the other:
    // services/voice/.../sequences.go:1239 answers that live statuses are
    // unavailable while the execution runtime is unqualified, so no client flag
    // can turn it on and flipping this would build a UI the server rejects.
    expect(MOBILE_SEQUENCE_RUNTIME_AVAILABLE).toBe(false);
  });

  it("opens AUTHORING, whose two blockers were re-checked rather than inherited", () => {
    // GATE#3. The flag's original note named two missing pieces. The execution
    // runtime is still missing and still gates the flag above. The other — "a
    // complete mobile conflict-recovery workflow" — has since been built:
    // useSequenceCanvasSave holds and CHAINS the row version, clears it on an
    // authority error so the next attempt fails closed rather than replaying
    // against a version it no longer owns, and surfaces "This draft moved on."
    expect(MOBILE_SEQUENCE_AUTHORING_AVAILABLE).toBe(true);
  });

  it("keeps the two flags independent, which is the point of having two", () => {
    // Their states differ, so nothing may collapse them into one boolean: the
    // day someone writes `AUTHORING && RUNTIME` as a single gate, the honest
    // distinction between "you may edit a draft" and "the server can run it"
    // disappears.
    expect(MOBILE_SEQUENCE_AUTHORING_AVAILABLE).not.toBe(
      MOBILE_SEQUENCE_RUNTIME_AVAILABLE,
    );
  });

  it.each(["active", "running", "ACTIVE"])(
    "never presents %s as a healthy live state",
    (status) => {
      expect(mobileSequenceStatusPresentation(status)).toEqual({
        label: "Legacy active label",
        tone: "warning",
        draft: false,
        readOnly: true,
      });
    },
  );

  it("makes readOnly the SERVER's draft-only rule instead of a constant true", () => {
    // sequences.go:892-895 answers 409 — "only draft sequences are editable" —
    // for any stored status that is not `draft`, so this bit is exactly
    // `!draft`. It used to be the literal `true` in all five branches, which
    // made it both constant and dead: no call site read it, and the detail
    // canvas gated its step verbs on the authoring FLAG alone. With the flag
    // open that put Edit / Delete / Move on archived and paused journeys.
    expect(mobileSequenceStatusPresentation("draft")).toMatchObject({
      label: "Draft",
      draft: true,
      readOnly: false,
    });
    // An unrecognised status must NOT be treated as editable: this term now
    // decides whether a write is offered, and "we don't know" is not evidence
    // the server will take one.
    expect(mobileSequenceStatusPresentation("corrupted-value")).toMatchObject({
      label: "Unverified · read-only",
      draft: false,
      readOnly: true,
    });
    // Nothing may collapse back to a constant. Both values must occur.
    const seen = new Set(
      ["draft", "active", "running", "archived", "paused", "nonsense"].map(
        (s) => mobileSequenceStatusPresentation(s).readOnly,
      ),
    );
    expect(seen).toEqual(new Set([true, false]));
  });

  describe("mobileSequenceStepsEditable", () => {
    it("opens only for a draft, which is the only status the server will PATCH", () => {
      expect(mobileSequenceStepsEditable("draft")).toBe(true);
      expect(mobileSequenceStepsEditable(" Draft ")).toBe(true);
      expect(mobileSequenceStepsEditable("DRAFT")).toBe(true);
    });

    it.each(["active", "running", "archived", "paused"])(
      "refuses %s, which the server answers 409 for every client",
      (status) => {
        expect(mobileSequenceStepsEditable(status)).toBe(false);
      },
    );

    it("fails closed on the statuses that mean 'we do not know yet'", () => {
      // "" is what the detail screen reads while the fetch is in flight and
      // from a stored projection that carries no status; an unrecognised value
      // is what a drifted server or a stale vault blob yields. Neither is
      // evidence that a save would be accepted.
      for (const raw of ["", "   ", undefined, "nonsense", "Draft-ish"]) {
        expect(mobileSequenceStepsEditable(raw)).toBe(false);
      }
    });

    it("still consults the release flag, not just the status", () => {
      // If the flag were dropped from the composition this would be the only
      // thing left to notice. Tied to the flag's own value so it moves with a
      // deliberate re-close rather than pinning `true` forever.
      expect(mobileSequenceStepsEditable("draft")).toBe(
        MOBILE_SEQUENCE_AUTHORING_AVAILABLE,
      );
    });
  });

  it("keeps an empty or missing status read-only, which is the loading case", () => {
    // The detail screen derives its gate from `detail?.status ?? ""` before the
    // fetch resolves, and from a stored projection that carries no status at
    // all. Both must fail closed.
    for (const raw of ["", "   ", undefined]) {
      expect(mobileSequenceStatusPresentation(raw).readOnly).toBe(true);
    }
  });

  it.each(["paused", "PAUSED", " Paused "])(
    "labels %s as paused rather than as a data-integrity warning",
    (status) => {
      expect(mobileSequenceStatusPresentation(status)).toEqual({
        label: "Paused",
        tone: "warning",
        draft: false,
        readOnly: true,
      });
    },
  );

  it("drives canvas, editor AND persistence from ONE composed authoring gate", () => {
    const detail = readFileSync(
      join(process.cwd(), "app/(tabs)/sequences/[id].tsx"),
      "utf8",
    );

    expect(detail).toMatch(/<StepCanvas[\s\S]*?readOnly/);
    // No palette exists to render — see the header note. Asserting its absence
    // keeps a half-restored authoring surface from creeping back one piece at
    // a time, which is how this file's subject got into its current state.
    expect(detail).not.toContain("<StepPalette");

    // ONE EXPRESSION, THREE CONSUMERS. This assertion used to pin the flag
    // itself at each site. That was the right shape while the flag was the
    // only term, and the wrong shape the moment a second, SERVER-derived term
    // was needed: `readOnly={!MOBILE_SEQUENCE_AUTHORING_AVAILABLE}` shipped
    // Edit / Delete / Move on archived and paused journeys the server answers
    // with 409 (sequences.go:892-895). It is NOT loosened here — it is pinned
    // harder, because the persistence hook is now inside the same gate, and a
    // term added later reaches all three at once instead of two of the three.
    expect(detail).toContain("readOnly={!stepsEditable}");
    expect(detail).toContain("visible={stepsEditable && editorOpen}");
    expect(detail).toContain("stepsEditable,");
    // And it must come from the shared composition rather than being
    // re-derived here — a second derivation is a second thing to keep in sync,
    // and this screen already proved that a gate applied at two of its three
    // consumers reads as "gated" while the third keeps writing.
    expect(detail).toContain(
      "const stepsEditable = mobileSequenceStepsEditable(sequenceStatus);",
    );
    // A bare `readOnly` prop (shorthand `true`) beside the gate would be a
    // second, independent gate again: a read-only canvas never calls
    // onEditStep, so `editorOpen` could not become true even with the gate
    // open, and 600 lines of StepEditor would go unreachable by a means
    // nobody was tracking.
    expect(detail).not.toMatch(/<StepCanvas[\s\S]{0,200}?\breadOnly\n/);
  });

  it("refuses to ENQUEUE a save the server would answer 409, not just to show the button", () => {
    // Hiding the affordance is not the whole fix. `save.mutate` writes to the
    // offline queue, so a save accepted against a non-draft row survives a
    // restart and replays hours later into a 409 whose toast lands on a screen
    // nobody is looking at. The guard has to sit beside the flag check in the
    // hook, not only in the render.
    const hook = readFileSync(
      join(process.cwd(), "src/hooks/useSequenceCanvasSave.ts"),
      "utf8",
    );
    expect(hook).toContain("if (!MOBILE_SEQUENCE_AUTHORING_AVAILABLE) return;");
    expect(hook).toContain("if (!stepsEditable) return;");
    // Read from the caller rather than re-derived here: this hook has no
    // access to the fetched detail, and a second derivation is a second thing
    // to keep in sync.
    expect(hook).toContain("stepsEditable: boolean;");
  });

  it("reaches BOTH approved create paths from the list screen", () => {
    const list = readFileSync(
      join(process.cwd(), "app/(tabs)/sequences/index.tsx"),
      "utf8",
    );
    // AUTOMATION#5 — name an empty draft. Gated on `canCreateSequence`, which
    // deliberately has no `online` term: the create is offline-queued.
    expect(list).toContain("<SequenceCreateSheet");
    expect(list).toContain("canCreateSequence({");
    // AUTOMATION#15 — draft the whole sequence with a model, then review it.
    // Gated on `canDraftSequenceWithAI`, which DOES have an `online` term.
    expect(list).toContain("<SequenceDraftFlow");
    expect(list).toContain("canDraftSequenceWithAI({");
    // Both verbs reach the header through one composed slot. Asserting the
    // wiring here and the BUTTONS in the chrome file is what stops "the
    // affordance quietly disappeared" from passing unnoticed — the failure
    // mode that let this cluster ship a create path with no call site at all.
    expect(list).toContain("<SequenceListActions");
    expect(list).toContain("onCreate={openCreate}");
    expect(list).toContain("onDraft={openDraft}");
    const actions = readFileSync(
      join(process.cwd(), "src/components/sequences/SequenceDraftChrome.tsx"),
      "utf8",
    );
    expect(actions).toContain("<SequenceDraftAction onPress={onDraft} />");
    expect(actions).toContain("<SequenceCreateAction onPress={onCreate} />");
    // Still not a runtime: nothing on this screen may claim live enrollment.
    expect(list).not.toMatch(/active_runs\s*[>}]/);
    // The boundary copy moved into the shared chrome module so the list and
    // the detail screen cannot drift apart on the one statement that has to be
    // identical. The list must still RENDER it.
    expect(list).toContain("<SequenceChromeBoundary />");
    const chrome = readFileSync(
      join(process.cwd(), "src/components/sequences/SequenceChrome.tsx"),
      "utf8",
    );
    expect(chrome).toContain("Draft designer · live runtime unavailable");
    expect(chrome).toContain("Draft preview only");
  });

  it("never lets an AI draft reach the workspace unreviewed", () => {
    const flow = readFileSync(
      join(process.cwd(), "src/components/sequences/SequenceDraftFlow.tsx"),
      "utf8",
    );
    const review = readFileSync(
      join(process.cwd(), "src/components/sequences/SequenceDraftReview.tsx"),
      "utf8",
    );
    // The ONLY call that persists a generated sequence must be the one the
    // review sheet's Save button drives. An auto-save on draft success would
    // be a model writing to the tenant with nobody in the loop.
    expect(flow).toContain("onSave={(input) => {");
    expect(flow.match(/createSequence\(/gu)).toHaveLength(1);
    expect(flow).not.toMatch(/onSuccess:[\s\S]{0,400}?createSequence\(/u);
    // Article 50(1): the disclosure is the shared gateway-mirrored constant,
    // rendered verbatim rather than paraphrased per surface.
    expect(review).toContain('from "@postwave/ai-disclosure"');
    expect(review).toContain("disclosure={AI_DISCLOSURE_TEXT}");
    // Never `status: "active"` — and the save path cannot invent one, because
    // it goes through `createSequence`, which sends only name + steps.
    expect(flow).not.toContain('status: "active"');
  });

  it("shows exactly one explanation for an empty sequences screen", () => {
    const list = readFileSync(
      join(process.cwd(), "app/(tabs)/sequences/index.tsx"),
      "utf8",
    );
    // The runtime boundary must be conditional. Rendering it unconditionally
    // stacked "the runtime is off" on top of "this deployment hasn't enabled
    // the endpoint" / the reconnect notice — two competing explanations for
    // one empty screen, which is worse than either alone.
    expect(list).toContain("{showBoundary ? <SequenceChromeBoundary /> : null}");
    expect(list).toMatch(
      /const showBoundary =\s*\n?\s*!unavailable && !sequenceGateNotice && !loadFailed && !seqs\.isLoading;/,
    );
  });
});

describe("what actually shipped with sequence authoring (completeness pass, item 16)", () => {
  /**
   * Three audit findings disagreed about this flag's preconditions, and two of
   * them were factually wrong about the same file:
   *
   *   one said the blocker was a missing step PALETTE plus a missing reorder
   *   GESTURE;
   *   another said `StepCanvas` was "already measuring rects", i.e. the gesture
   *   was half-built and waiting;
   *   a third wanted the flag's stated blocker asserted.
   *
   * Reading StepCanvas settles it: its header says "NO DRAG LAYER … measured
   * row rects [and] a drop-target resolver … was deleted", and reorder is now
   * an explicit `onMoveStep(id, "up" | "down")` control. So the second claim is
   * simply false, and the first describes a design that was deliberately
   * replaced rather than a blocker that remains.
   *
   * These assertions pin the facts so the disagreement cannot recur, and so
   * that a future restoration of the drag layer is a deliberate act rather than
   * something that creeps back one side at a time — which is the failure the
   * header warns about: "Half a gesture protocol is worse than none."
   */
  const canvasSource = readFileSync(
    join(__dirname, "..", "components", "sequence-builder", "StepCanvas.tsx"),
    "utf8",
  );
  // COMMENTS STRIPPED FIRST. The file's header NAMES the deleted drag helpers
  // in order to explain why they are gone, so a raw substring check matches the
  // explanation and reports the opposite of the truth. Checking code-only is
  // the difference between asserting the drag layer is absent and asserting
  // that nobody mentions it.
  const canvas = canvasSource
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "");

  it("reads the real file, and the strip leaves real code behind", () => {
    expect(canvasSource.length).toBeGreaterThan(2_000);
    expect(canvas.length).toBeGreaterThan(1_000);
    expect(canvas).toContain("export function StepCanvas");
    // The header must still SAY why the drag layer went, even though the
    // assertions below deliberately ignore it.
    expect(canvasSource).toContain("NO DRAG LAYER");
  });

  it("authoring is open", () => {
    expect(MOBILE_SEQUENCE_AUTHORING_AVAILABLE).toBe(true);
  });

  it("keeps the drag layer deleted rather than half-restored", () => {
    for (const fragment of ["beginDrag", "updateDrag", "endDrag", "applyDropToSteps"]) {
      expect(
        canvas.includes(fragment),
        `StepCanvas has regrown ${fragment}. Restore the whole drag protocol behind a deliberate decision, or none of it — half a gesture protocol is worse than none.`,
      ).toBe(false);
    }
  });

  it("reorders through an explicit control, not a measured gesture", () => {
    expect(canvas).toContain("onMoveStep");
  });

  it("ships no step palette, and authoring does not depend on one", () => {
    // Recorded because an audit named the missing palette as the flag's
    // blocker. Authoring shipped without it; the palette was a design that was
    // dropped, not a precondition that is outstanding.
    expect(
      existsSync(
        join(__dirname, "..", "components", "sequence-builder", "StepPalette.tsx"),
      ),
    ).toBe(false);
  });
});

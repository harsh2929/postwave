import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const ownerPaths = [
  "components/sequence/StepEditor.tsx",
  "components/sequence/StepCanvas.tsx",
  "components/InboundWebhookDetailSlideover.tsx",
  "components/OutboundWebhookDeliveriesSlideover.tsx",
] as const;

describe("DUX-009/022 overlay convergence wave 3 source contract", () => {
  it("removes all four bespoke roles and mouse-only dismissors", () => {
    const owners = ownerPaths.map((path) => source(path));
    for (const contents of owners) {
      expect(contents).not.toMatch(/role=["'](?:dialog|alertdialog)["']/u);
      expect(contents).not.toMatch(/onMouseDown=\{(?:onClose|onCancel)\}/u);
      expect(contents).not.toContain("useSlideoverBehavior");
    }
    expect(owners.join("\n")).not.toContain('className="slideover-overlay"');
  });

  it("pins each rendered owner to exactly one shared behavior contract", () => {
    const stepEditor = source(ownerPaths[0]);
    const stepCanvas = source(ownerPaths[1]);
    const inbound = source(ownerPaths[2]);
    const outbound = source(ownerPaths[3]);

    expect(stepEditor.match(/<SlideoverShell\b/gu)).toHaveLength(1);
    expect(inbound.match(/<SlideoverShell\b/gu)).toHaveLength(1);
    expect(outbound.match(/<SlideoverShell\b/gu)).toHaveLength(1);
    expect(stepCanvas.match(/<ConfirmModal\b/gu)).toHaveLength(2);
    expect(stepCanvas).toContain("danger");
    expect(stepCanvas).toContain('confirmLabel="Delete step"');
    expect(stepCanvas).toContain('confirmLabel="Discard and reload"');
  });

  it("keeps step deletion single-owned and dirty editing explicitly guarded", () => {
    const editor = source(ownerPaths[0]);
    const canvas = source(ownerPaths[1]);

    expect(editor).not.toContain("confirmDelete");
    expect(editor).toContain("onDeleteRequest={() => onDelete(step.id)}");
    expect(editor).toContain("Discard unsaved step changes?");
    expect(editor).toContain("closeOnBackdrop={!draftDirty && !operationBusy}");
    expect(canvas).toMatch(
      /onDelete=\{\(id\) => \{\s*setPendingDeleteId\(id\);\s*\}\}/u,
    );
    expect(canvas).not.toMatch(
      /onDelete=\{\(id\)[\s\S]{0,100}setEditingId\(null\)/u,
    );
  });

  it("requires request ownership, thrown cleanup, and honest retry states", () => {
    const editor = source(ownerPaths[0]);
    const inbound = source(ownerPaths[2]);
    const outbound = source(ownerPaths[3]);

    expect(editor).toContain("regeneratingRef.current");
    expect(editor).toContain("previewLoadingRef.current");
    expect(editor).toContain("requestEpochRef.current");
    expect(editor).toContain("finally");
    expect(inbound).toContain("eventsRequestRef.current");
    expect(inbound).toContain("deleteOperationRef.current");
    expect(inbound).toContain("replayOperationRef.current");
    expect(inbound).toContain("Retry loading events");
    expect(outbound).toContain("loadSequenceRef.current");
    expect(outbound).toContain("loadControllerRef.current");
    expect(outbound).toContain("replayFlightRef.current");
    expect(outbound).toContain("controller.signal.aborted");
    expect(outbound).toContain("Replay this live delivery?");
    expect(outbound).toContain("Retry loading deliveries");
  });

  it("keeps shared shell bodies as the only scroll owner and reflows rows", () => {
    const outbound = source(ownerPaths[3]);
    const sequenceStyles = source("styles-sequences-v2.css");
    const webhookStyles = source("styles-webhooks.css");

    expect(outbound).not.toMatch(/maxHeight|overflowY/u);
    expect(sequenceStyles).not.toContain(".step-delete-confirm");
    expect(sequenceStyles).not.toContain(".step-editor-slideover");
    expect(sequenceStyles).toMatch(
      /@media \(max-width: 700px\)[\s\S]*\.step-regenerate-diff/u,
    );
    expect(webhookStyles).toContain(".wh-inbound-event-row");
    expect(webhookStyles).toContain(".wh-delivery-row");
    expect(webhookStyles).toMatch(
      /@media \(max-width: 700px\)[\s\S]*\.wh-delivery-row/u,
    );
  });
});

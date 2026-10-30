// @vitest-environment happy-dom
//
// The banner is where ECO-03 becomes visible, and the whole reason the server
// answers a stale save with a 409 that CARRIES the other checkpoint and two
// distinct 409 codes is so a client can keep these states apart. Collapsing any
// pair of them tells someone something false about their own work.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DraftCheckpointBanner } from "../../components/campaigns/DraftCheckpointBanner";
import type { EditorCheckpointState } from "../../lib/use-editor-checkpoint";

interface Draft {
  subject: string;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const IDLE: EditorCheckpointState<Draft> = {
  offer: null,
  offerBlockedReason: null,
  conflict: null,
  refusal: null,
  unsupported: null,
  saving: false,
  lastSavedAt: null,
  resume: vi.fn(),
  dismiss: vi.fn(),
  keepMine: vi.fn(),
  useTheirs: vi.fn(),
};

function checkpoint(subject: string, version = 1) {
  return {
    entity_key: "campaign",
    entity_id: "cam_1",
    content: { subject },
    version,
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  };
}

function render(
  state: Partial<EditorCheckpointState<Draft>>,
  canEdit = true,
  busy = false,
): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <DraftCheckpointBanner
        state={{ ...IDLE, ...state }}
        canEdit={canEdit}
        busy={busy}
      />,
    );
  });
  return container;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
  if (!match) throw new Error(`no button labelled ${label}`);
  return match;
}

describe("DraftCheckpointBanner", () => {
  it("renders nothing when there is nothing to say", () => {
    // The common case is a clean open with no draft anywhere. A banner that is
    // always present is a banner nobody reads.
    expect(render({}).textContent).toBe("");
  });

  it("OFFERS a draft with both answers, and applies neither by itself", () => {
    const resume = vi.fn();
    const dismiss = vi.fn();
    const host = render({ offer: checkpoint("from the laptop"), resume, dismiss });
    const panel = host.querySelector('[data-testid="checkpoint-offer"]')!;
    expect(panel.getAttribute("role")).toBe("status");
    expect(panel.textContent).toContain("unsaved draft from another device");
    expect(panel.textContent).toContain("5m ago");

    act(() => button(host, "Resume this draft").click());
    expect(resume).toHaveBeenCalledTimes(1);
    act(() => button(host, "Discard it and keep the saved version").click());
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("gives review mode a precise reason instead of a dead Resume button", () => {
    // The clause's second branch. An offered draft with no way to open it and
    // no explanation is worse than no offer at all.
    const host = render({
      offer: checkpoint("blocks"),
      offerBlockedReason: "That draft's body was composed from blocks.",
    });
    const panel = host.querySelector('[data-testid="checkpoint-offer"]')!;
    expect(panel.textContent).toContain("composed from blocks");
    expect(panel.querySelectorAll("button")).toHaveLength(0);
  });

  it("explains a non-editable campaign rather than hiding the draft", () => {
    const host = render({ offer: checkpoint("late") }, false);
    const panel = host.querySelector('[data-testid="checkpoint-offer"]')!;
    expect(panel.textContent).toContain("can only be viewed");
    expect(panel.querySelectorAll("button")).toHaveLength(0);
  });

  it("names BOTH drafts on a conflict and lets the person pick", () => {
    const keepMine = vi.fn();
    const useTheirs = vi.fn();
    const host = render({
      conflict: { current: checkpoint("theirs", 9), blockedReason: null },
      keepMine,
      useTheirs,
    });
    const panel = host.querySelector('[data-testid="checkpoint-conflict"]')!;
    expect(panel.getAttribute("role")).toBe("alert");
    expect(panel.textContent).toContain("Nothing has been overwritten");

    act(() => button(host, "Use the newer draft").click());
    expect(useTheirs).toHaveBeenCalledTimes(1);
    act(() => button(host, "Keep what is on this device").click());
    expect(keepMine).toHaveBeenCalledTimes(1);
  });

  it("offers no resolution it cannot honour when the server withheld the other draft", () => {
    const host = render({ conflict: { current: null, blockedReason: null } });
    const panel = host.querySelector('[data-testid="checkpoint-conflict"]')!;
    expect(panel.textContent).toContain("could not read the newer draft");
    expect(panel.querySelectorAll("button")).toHaveLength(0);
  });

  it("drops only the un-honourable half when the other draft is review-only", () => {
    const host = render({
      conflict: { current: checkpoint("blocks", 9), blockedReason: "block-composed" },
    });
    expect(host.textContent).toContain("block-composed");
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Keep what is on this device",
    ]);
  });

  it("disables — never hides — the answers while the campaign is saving", () => {
    // `useCampaignEditorController` refuses openEdit/setDraft mid-save, so a
    // Resume accepted now would clear the offer and apply nothing: the draft
    // from the other device would appear to vanish. Hiding the buttons would
    // say the same false thing more quietly.
    const resume = vi.fn();
    const host = render(
      { offer: checkpoint("from the laptop"), resume },
      true,
      true,
    );
    const action = button(host, "Resume this draft");
    expect(action.disabled).toBe(true);
    act(() => action.click());
    expect(resume).not.toHaveBeenCalled();
    expect(host.textContent).toContain("unsaved draft from another device");
  });

  it("says plainly when a draft is NOT being checkpointed", () => {
    // The difference between "your work is safe" and a person believing it
    // while it is not.
    const host = render({ refusal: "A draft checkpoint is limited to 256 KiB." });
    const panel = host.querySelector('[data-testid="checkpoint-refusal"]')!;
    expect(panel.getAttribute("role")).toBe("alert");
    expect(panel.textContent).toContain("256 KiB");
    expect(panel.textContent).toContain("will not survive closing it");
  });

  it("keeps an unsupported sign-in distinct from a bad draft", () => {
    // Nothing about the draft is wrong and no edit to it will help, so it must
    // not wear the refusal's language.
    const host = render({ unsupported: "needs a signed-in session" });
    expect(host.querySelector('[data-testid="checkpoint-refusal"]')).toBeNull();
    const panel = host.querySelector('[data-testid="checkpoint-unsupported"]')!;
    expect(panel.textContent).toContain("needs a signed-in session");
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The visible half of ECO-03. The program's bar is that someone who opens a
// second client either "resumes safely OR receives a precise explanation of why
// only review mode is available" — so the review-mode wording is not decoration,
// it is half the requirement, and a banner that silently hides itself on a sent
// campaign fails the bar just as surely as one that silently applies the draft.

import { act, createElement } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

import { DraftCheckpointBanner } from "@/components/campaigns/draft-checkpoint-banner";
import type { EditorCheckpointState } from "@/lib/use-editor-checkpoint";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountRoots();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
}

interface Draft {
  subject: string;
}

function state(
  over: Partial<EditorCheckpointState<Draft>> = {},
): EditorCheckpointState<Draft> {
  return {
    offer: null,
    conflict: null,
    refusal: null,
    saving: false,
    lastSavedAt: null,
    resume: vi.fn(),
    dismiss: vi.fn(),
    keepMine: vi.fn(),
    useTheirs: vi.fn(),
    ...over,
  };
}

const draftCheckpoint = {
  entity_key: "campaign",
  entity_id: "cmp_1",
  content: { subject: "from the phone" },
  version: 3,
  updated_at: "2026-08-04T10:05:00Z",
};

describe("nothing to say", () => {
  it("renders nothing on a clean open", () => {
    render(createElement(DraftCheckpointBanner<Draft>, { state: state(), canEdit: true }));
    expect(document.body.textContent).toBe("");
  });
});

describe("an offered draft", () => {
  it("offers to resume or discard, and applies neither by itself", () => {
    const resume = vi.fn();
    const dismiss = vi.fn();
    render(
      createElement(DraftCheckpointBanner<Draft>, {
        state: state({ offer: draftCheckpoint, resume, dismiss }),
        canEdit: true,
      }),
    );
    expect(document.body.textContent).toContain(
      "You have an unsaved draft from another device",
    );
    const resumeButton = buttonByText("Resume this draft");
    expect(resumeButton).toBeDefined();
    expect(resume).not.toHaveBeenCalled();

    act(() => {
      resumeButton?.click();
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("explains why a review-only surface cannot resume it, instead of hiding it", () => {
    render(
      createElement(DraftCheckpointBanner<Draft>, {
        state: state({ offer: draftCheckpoint }),
        canEdit: false,
      }),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("You have an unsaved draft from another device");
    expect(text).toContain("can no longer be edited");
    expect(
      buttonByText("Resume this draft"),
      "offered to resume a draft into an editor that cannot save",
    ).toBeUndefined();
  });
});

describe("a conflict", () => {
  it("names both drafts and leaves the choice to the person", () => {
    const keepMine = vi.fn();
    const useTheirs = vi.fn();
    render(
      createElement(DraftCheckpointBanner<Draft>, {
        state: state({
          conflict: { current: draftCheckpoint },
          keepMine,
          useTheirs,
        }),
        canEdit: true,
      }),
    );
    expect(document.body.textContent).toContain(
      "Another device saved a newer draft",
    );
    expect(document.body.textContent).toContain("Nothing has been overwritten");
    expect(buttonByText("Use the newer draft")).toBeDefined();
    expect(buttonByText("Keep what is on this device")).toBeDefined();
    expect(keepMine).not.toHaveBeenCalled();
    expect(useTheirs).not.toHaveBeenCalled();
  });

  it("offers no resolution it cannot honour", () => {
    // The server refused but could not re-read its own row. Both resolutions
    // need the other version; a button that silently does nothing is worse than
    // no button.
    render(
      createElement(DraftCheckpointBanner<Draft>, {
        state: state({ conflict: { current: null } }),
        canEdit: true,
      }),
    );
    expect(document.body.textContent).toContain(
      "Another device saved a newer draft",
    );
    expect(buttonByText("Use the newer draft")).toBeUndefined();
    expect(buttonByText("Keep what is on this device")).toBeUndefined();
  });
});

describe("a refusal", () => {
  it("says the draft is NOT being kept, using the server's own reason", () => {
    render(
      createElement(DraftCheckpointBanner<Draft>, {
        state: state({ refusal: "a draft checkpoint is limited to 256 KiB" }),
        canEdit: true,
      }),
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("This draft is not being checkpointed");
    expect(text).toContain("a draft checkpoint is limited to 256 KiB");
    expect(text).toContain("will not survive closing it");
  });
});

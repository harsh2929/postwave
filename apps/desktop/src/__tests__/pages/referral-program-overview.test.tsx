// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ReferralProgram } from "../../lib/api-client";
import { ReferralProgramOverview } from "../../pages/referrals/ReferralProgramOverview";
import type { ReferralProgramState } from "../../pages/referrals/useReferralProgramController";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function program(): ReferralProgram {
  return {
    id: "program-1",
    active: true,
    updatedAt: "2026-07-16T09:00:00.000Z",
    milestones: [
      {
        count: 5,
        reward_label: "[swag] Hoodie",
        reward_kind: "swag",
      },
    ],
  };
}

function state(
  overrides: Partial<ReferralProgramState> = {},
): ReferralProgramState {
  return {
    empty: false,
    error: null,
    loading: false,
    program: program(),
    ...overrides,
  };
}

function renderOverview({
  canMutate = true,
  value = state(),
}: {
  canMutate?: boolean;
  value?: ReferralProgramState;
} = {}): {
  onCreate: ReturnType<typeof vi.fn>;
  onEdit: ReturnType<typeof vi.fn>;
  onRemove: ReturnType<typeof vi.fn>;
} {
  const onCreate = vi.fn();
  const onEdit = vi.fn();
  const onRemove = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <ReferralProgramOverview
        canMutate={canMutate}
        milestones={value.program?.milestones ?? []}
        onCreate={onCreate}
        onEdit={onEdit}
        onRemove={onRemove}
        state={value}
      />,
    ),
  );
  return { onCreate, onEdit, onRemove };
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return button;
}

describe("ReferralProgramOverview", () => {
  it("fails closed on an unknown program instead of offering overwrite", () => {
    renderOverview({
      value: state({
        error: "database unavailable",
        program: null,
      }),
    });

    expect(document.body.textContent).toContain("Program unavailable");
    expect(document.body.textContent).toContain("never overwritten");
    expect(document.body.textContent).not.toContain("Create program");
  });

  it("renders a true 404 empty state with writer-only creation", () => {
    const actions = renderOverview({
      value: state({ empty: true, program: null }),
    });
    const createButtons = Array.from(
      document.querySelectorAll("button"),
    ).filter((candidate) => candidate.textContent?.trim() === "Create program");
    expect(createButtons.length).toBeGreaterThan(0);
    act(() => createButtons[0]!.click());
    expect(actions.onCreate).toHaveBeenCalledTimes(1);
  });

  it("cleans legacy label prefixes and keeps guarded viewer actions discoverable", () => {
    const actions = renderOverview({ canMutate: false });

    expect(document.body.textContent).toContain("Hoodie");
    expect(document.body.textContent).not.toContain("[swag]");
    const edit = buttonByLabel("Edit milestone at 5 referrals");
    const remove = buttonByLabel("Remove milestone at 5 referrals");
    expect(edit.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(edit.getAttribute("aria-describedby")).toBeTruthy();
    expect(remove.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Program changes require workspace-admin access and a currently verified program response",
    );
    act(() => {
      edit.click();
      remove.click();
    });
    expect(actions.onEdit).not.toHaveBeenCalled();
    expect(actions.onRemove).not.toHaveBeenCalled();
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
  });
});
